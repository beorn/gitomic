// @failure A transaction decodes every blob of the base tree before its update runs, so a write costs the whole vault (0.9 s and 175 MB on a 19,670-blob STATE root) instead of the handful of paths it names; the base is whole-tree strict on SHAPE but must be lazy on VALUES (25346).
// @level l1
// @consumer every gitomic writer on a large tree — km's STATE rail, the agent-rig's bead-id and receipt stores, the yrd queue

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "vitest"

import { apply, open } from "../src/index.js"
import type { GitomicBackend, Oid } from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import { createMemBackend } from "../src/mem.js"
import { createShellBackend } from "../src/shell.js"
import { createBareRepo, git, gitWithInput } from "./helpers/git.js"

/** A byte sequence no UTF-8 decoder accepts, standing in for a real image. */
const BINARY = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80)

type Recorded = {
  backend: GitomicBackend
  /** Every `readBlobs` call: the oids it asked for, in order. */
  blobCalls: Oid[][]
  /** Every `readTree` call: the commit it listed. */
  treeCalls: Oid[]
  reset(): void
}

/** Record the two lazy-base primitives without changing what they answer. */
function recordReads(source: GitomicBackend): Recorded {
  const blobCalls: Oid[][] = []
  const treeCalls: Oid[] = []
  return {
    blobCalls,
    treeCalls,
    reset: () => {
      blobCalls.length = 0
      treeCalls.length = 0
    },
    backend: {
      ...source,
      readTree: (repo, commit, prefix) => {
        treeCalls.push(commit)
        return source.readTree(repo, commit, prefix)
      },
      readBlobs: (repo, oids) => {
        blobCalls.push([...oids])
        return source.readBlobs(repo, oids)
      },
    },
  }
}

const fetched = (calls: readonly Oid[][]): number => calls.reduce((count, call) => count + call.length, 0)
const distinct = (calls: readonly Oid[][]): number => new Set(calls.flat()).size

const notePath = (index: number): string => `notes/${String(index).padStart(5, "0")}.md`

async function seedNotes(store: Awaited<ReturnType<typeof open>>, count: number): Promise<Oid> {
  const seeded = await store.transact(async (map) => {
    for (let index = 0; index < count; index += 1) map.set(notePath(index), `note ${index}\n`)
  }, `seed ${count} notes`)
  return seeded.oid
}

describe("transact reads only the base values it names (mem, 20,000 entries)", () => {
  test("a transact reading and writing 3 paths with a candidate reading 2 more fetches exactly 5 blobs", async () => {
    const recorded = recordReads(createMemBackend())
    const store = await open({ repo: "lazy", ref: "main", writer: "worker", backend: recorded.backend })
    const parent = await seedNotes(store, 20_000)
    recorded.reset()

    const committed = await store.transact(
      async (map) => {
        for (const index of [1, 2, 3]) {
          const path = notePath(index)
          map.set(path, `${await map.get(path)}edited\n`)
        }
      },
      "edit three notes",
      {
        candidate: async ({ readBase }) => {
          await readBase(notePath(10))
          await readBase(notePath(11))
          return undefined
        },
      },
    )

    expect(committed.retries).toBe(0)
    expect(recorded.treeCalls).toEqual([parent])
    expect(distinct(recorded.blobCalls)).toBe(5)
    expect(fetched(recorded.blobCalls)).toBe(5)
    // Each `await map.get` inside the update is one dependent read wave; the candidate's two reads are two more.
    expect(recorded.blobCalls.length).toBeLessThanOrEqual(5)
    expect(await store.at(committed.oid).get(notePath(2))).toBe("note 2\nedited\n")
  })

  test("apply prefetches every edit path in ONE readBlobs call", async () => {
    const recorded = recordReads(createMemBackend())
    const store = await open({ repo: "lazy-apply", ref: "main", writer: "worker", backend: recorded.backend })
    const parent = await seedNotes(store, 20_000)
    const snapshot = store.at(parent)
    const expects = await Promise.all([4, 5, 6].map((index) => snapshot.oid(notePath(index))))
    recorded.reset()

    const committed = await apply(
      store,
      parent,
      [
        { kind: "put", path: notePath(4), content: "four\n", expect: expects[0] as Oid },
        { kind: "rm", path: notePath(5), expect: expects[1] as Oid },
        { kind: "mv", from: notePath(6), to: "notes/moved.md", expect: expects[2] as Oid },
      ],
      "apply three edits",
    )

    expect(committed.retries).toBe(0)
    expect(recorded.blobCalls.length).toBe(1)
    expect(new Set(recorded.blobCalls[0])).toEqual(new Set(expects))
    expect(await store.at(committed.oid).get("notes/moved.md")).toBe("note 6\n")
    expect(await store.at(committed.oid).has(notePath(5))).toBe(false)
  })

  test("one CAS loss rebuilds the base on the new parent, reads 10 blobs in total and carries no memoised value", async () => {
    const mem = createMemBackend()
    const recorded = recordReads(mem)
    let armed = false
    let lostOnce = false
    const contended: GitomicBackend = {
      ...recorded.backend,
      compareAndSwap: async (repo, ref, next, expected) => {
        if (armed && !lostOnce) {
          lostOnce = true
          // Another writer lands on the same ref between this attempt's read and its publish.
          const other = await open({ repo, ref, writer: "other", backend: mem })
          await other.transact(async (map) => map.set(notePath(1), "moved by the other writer\n"), "move under it")
          return false
        }
        return recorded.backend.compareAndSwap(repo, ref, next, expected)
      },
    }
    const store = await open({ repo: "lazy-replay", ref: "main", writer: "worker", backend: contended })
    const parent = await seedNotes(store, 20_000)
    recorded.reset()
    armed = true
    const seen: Array<string | undefined> = []

    const committed = await store.transact(
      async (map) => {
        seen.push(await map.get(notePath(1)))
        for (const index of [2, 3]) {
          const path = notePath(index)
          map.set(path, `${await map.get(path)}edited\n`)
        }
      },
      "edit under contention",
      {
        candidate: async ({ readBase }) => {
          await readBase(notePath(10))
          await readBase(notePath(11))
          return undefined
        },
      },
    )

    expect(committed.retries).toBe(1)
    expect(recorded.treeCalls.length).toBe(2)
    expect(recorded.treeCalls[0]).toBe(parent)
    expect(recorded.treeCalls[1]).not.toBe(parent)
    // The second attempt was built on the other writer's commit, which is the landed commit's parent.
    expect(recorded.treeCalls[1]).toBe((await mem.readCommit("lazy-replay", committed.oid)).parent)
    expect(fetched(recorded.blobCalls)).toBe(10)
    // The second attempt saw the other writer's value: nothing memoised crossed from the lost attempt.
    expect(seen).toEqual(["note 1\n", "moved by the other writer\n"])
  })

  test("a backend that loses a blob makes the read fail naming the PATH that asked", async () => {
    const mem = createMemBackend()
    const store = await open({
      repo: "lazy-missing",
      ref: "main",
      writer: "worker",
      backend: { ...mem, readBlobs: async () => new Map() },
    })
    await expect(
      store.transact(async (map) => {
        map.set("a.md", "one\n")
      }, "seed"),
    ).resolves.toBeDefined()
    await expect(
      store.transact(async (map) => {
        await map.get("a.md")
      }, "read a lost blob"),
    ).rejects.toThrow(/"a\.md"/)
  })
})

describe("the shell backend on a 2,000-file tree", () => {
  let traceDir: string | undefined
  afterEach(async () => {
    delete process.env.GIT_TRACE
    if (traceDir !== undefined) await rm(traceDir, { recursive: true, force: true })
    traceDir = undefined
  })

  test("an apply lists the tree once and cat-files only the touched blobs; keys and has still see every path", async () => {
    const fixture = await createBareRepo()
    try {
      const recorded = recordReads(createShellBackend())
      const store = await open({ repo: fixture.repo, ref: "main", writer: "worker", backend: recorded.backend })
      const parent = await seedNotes(store, 2_000)
      const snapshot = store.at(parent)
      const expects = await Promise.all([7, 8].map((index) => snapshot.oid(notePath(index))))
      recorded.reset()
      traceDir = await mkdtemp(join(tmpdir(), "gitomic-trace-"))
      const trace = join(traceDir, "git-trace.log")
      process.env.GIT_TRACE = trace

      let keysSeen = 0
      let hasSeen = false
      const committed = await apply(
        store,
        parent,
        [
          { kind: "put", path: notePath(7), content: "seven\n", expect: expects[0] as Oid },
          { kind: "rm", path: notePath(8), expect: expects[1] as Oid },
        ],
        "touch two of two thousand",
        {
          candidate: async ({ map }) => {
            keysSeen = (await map.keys("notes/")).length
            hasSeen = await map.has(notePath(1_999))
            return undefined
          },
        },
      )
      delete process.env.GIT_TRACE

      expect(committed.retries).toBe(0)
      expect(recorded.treeCalls).toEqual([parent])
      expect(recorded.blobCalls.length).toBe(1)
      expect(new Set(recorded.blobCalls[0])).toEqual(new Set(expects))
      // 2,000 paths minus the removed one; the overlay answers from the listing, not from decoded values.
      expect(keysSeen).toBe(1_999)
      expect(hasSeen).toBe(true)
      const traced = await readFile(trace, "utf8")
      const catFileBatches = traced.split("\n").filter((line) => line.includes("cat-file --batch")).length
      expect(catFileBatches).toBe(1)
    } finally {
      await fixture.cleanup()
    }
  })

  test("a Snapshot lists by prefix and reads a blob only for get: oid, has and keys never fetch one", async () => {
    const fixture = await createBareRepo()
    try {
      const recorded = recordReads(createShellBackend())
      const store = await open({ repo: fixture.repo, ref: "main", writer: "worker", backend: recorded.backend })
      const parent = await seedNotes(store, 2_000)
      recorded.reset()
      const snapshot = store.at(parent)
      expect((await snapshot.keys("notes/")).length).toBe(2_000)
      expect(await snapshot.has(notePath(1_500))).toBe(true)
      const oid = await snapshot.oid(notePath(42))
      expect(oid).toMatch(/^[0-9a-f]{40}$/)
      expect(recorded.blobCalls).toEqual([])
      expect(await snapshot.get(notePath(42))).toBe("note 42\n")
      expect(recorded.blobCalls).toEqual([[oid]])
      // The whole-prefix listing served every later read: one readTree for "notes/", none for the paths under it.
      expect(recorded.treeCalls).toEqual([parent])
    } finally {
      await fixture.cleanup()
    }
  })

  test("a tree entry whose blob the repository does not hold fails the read naming the PATH, through transact and at() (review2 09d0f178)", async () => {
    const fixture = await createBareRepo()
    try {
      const present = await gitWithInput(fixture.repo, "here\n", "hash-object", "-w", "--stdin")
      const lost = "0123456789abcdef0123456789abcdef01234567"
      const tree = await gitWithInput(
        fixture.repo,
        `100644 blob ${present}\there.md\0` + `100644 blob ${lost}\tlost.md\0`,
        "mktree",
        "-z",
        "--missing",
      )
      const tip = await git(fixture.repo, "commit-tree", tree, "-p", fixture.initial, "-m", "a lost blob")
      await git(fixture.repo, "update-ref", "refs/heads/main", tip, fixture.initial)
      const store = await open({ repo: fixture.repo, ref: "main", writer: "worker", backend: createShellBackend() })
      const pathAndOid = /"lost\.md" \(0123456789abcdef0123456789abcdef01234567\)/u
      await expect(
        store.transact(async (map) => {
          await map.get("lost.md")
        }, "read a lost blob"),
      ).rejects.toThrow(pathAndOid)
      await expect(store.at(tip).get("lost.md")).rejects.toThrow(pathAndOid)
      // The backend's own refusal rides along as the cause, and the present blob still reads.
      await expect(store.at(tip).get("lost.md")).rejects.toMatchObject({
        cause: expect.objectContaining({ message: expect.stringContaining("missing") }),
      })
      expect(await store.at(tip).get("here.md")).toBe("here\n")
    } finally {
      await fixture.cleanup()
    }
  })

  test("readBlobs deduplicates its oids and refuses a missing one loudly", async () => {
    const fixture = await createBareRepo()
    try {
      const backend = createShellBackend()
      const one = await gitWithInput(fixture.repo, "one\n", "hash-object", "-w", "--stdin")
      const two = await gitWithInput(fixture.repo, "two\n", "hash-object", "-w", "--stdin")
      const read = await backend.readBlobs(fixture.repo, [one, two, one])
      expect([...read.keys()].sort()).toEqual([one, two].sort())
      expect(read.get(one)).toBe("one\n")
      const missing = "0123456789abcdef0123456789abcdef01234567"
      await expect(backend.readBlobs(fixture.repo, [one, missing])).rejects.toThrow(missing)
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("the listing keeps the tree strict on shape and the read strict on value", () => {
  async function createMixedRepo(): Promise<{
    repo: string
    tip: string
    binaryOid: string
    cleanup(): Promise<void>
  }> {
    const fixture = await createBareRepo()
    const binaryOid = await gitWithInput(fixture.repo, BINARY, "hash-object", "-w", "--stdin")
    const noteOid = await gitWithInput(fixture.repo, "# note\n", "hash-object", "-w", "--stdin")
    const assets = await gitWithInput(fixture.repo, `100644 blob ${binaryOid}\tscreenshot.png\0`, "mktree", "-z")
    const notes = await gitWithInput(fixture.repo, `100644 blob ${noteOid}\tfirst.md\0`, "mktree", "-z")
    const tree = await gitWithInput(
      fixture.repo,
      `040000 tree ${assets}\tassets\0` + `040000 tree ${notes}\tnotes\0`,
      "mktree",
      "-z",
    )
    const tip = await git(fixture.repo, "commit-tree", tree, "-p", fixture.initial, "-m", "text beside an image")
    await git(fixture.repo, "update-ref", "refs/heads/main", tip, fixture.initial)
    return { repo: fixture.repo, tip, binaryOid, cleanup: fixture.cleanup }
  }

  const backends = [
    { name: "shell", backend: () => createShellBackend() },
    { name: "iso", backend: () => createIsoBackend() },
  ] as const

  for (const { name, backend } of backends) {
    test(`${name}: a touched binary blob is refused through apply, transact and at(); an untouched one lands byte-identical`, async () => {
      const mixed = await createMixedRepo()
      try {
        const store = await open({ repo: mixed.repo, ref: "main", writer: "worker", backend: backend() })
        await expect(store.at(mixed.tip).get("assets/screenshot.png")).rejects.toThrow(/screenshot\.png/)
        await expect(
          store.transact(async (map) => {
            await map.get("assets/screenshot.png")
          }, "read the image"),
        ).rejects.toThrow(/screenshot\.png/)
        await expect(
          apply(store, mixed.tip, [{ kind: "append", path: "assets/screenshot.png", content: "x" }], "append to it"),
        ).rejects.toThrow(/screenshot\.png/)

        const committed = await store.transact(async (map) => {
          map.set("notes/second.md", "# second\n")
        }, "write beside the image")
        expect(await store.at(committed.oid).oid("assets/screenshot.png")).toBe(mixed.binaryOid)
        expect(await git(mixed.repo, "rev-parse", `${committed.oid}:assets/screenshot.png`)).toBe(mixed.binaryOid)
      } finally {
        await mixed.cleanup()
      }
    })
  }

  test("a gitlink or symlink in the listing refuses the transaction before any value is read", async () => {
    const fixture = await createBareRepo()
    try {
      const noteOid = await gitWithInput(fixture.repo, "# note\n", "hash-object", "-w", "--stdin")
      const tree = await gitWithInput(
        fixture.repo,
        `100644 blob ${noteOid}\tnote.md\0` + `160000 commit ${"a".repeat(40)}\tvendor\0`,
        "mktree",
        "-z",
        "--missing",
      )
      const tip = await git(fixture.repo, "commit-tree", tree, "-p", fixture.initial, "-m", "a gitlink")
      await git(fixture.repo, "update-ref", "refs/heads/main", tip, fixture.initial)
      const recorded = recordReads(createShellBackend())
      const store = await open({ repo: fixture.repo, ref: "main", writer: "worker", backend: recorded.backend })
      await expect(
        store.transact(async (map) => {
          map.set("other.md", "x\n")
        }, "write beside a gitlink"),
      ).rejects.toThrow(/unsupported Git tree mode 160000/)
      expect(recorded.blobCalls).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("readTree and readBlobs agree across backends", () => {
  test("shell, iso and mem list mode and oid per path and return each blob by oid", async () => {
    const fixture = await createBareRepo()
    try {
      const plain = await gitWithInput(fixture.repo, "plain\n", "hash-object", "-w", "--stdin")
      const script = await gitWithInput(fixture.repo, "#!/bin/sh\n", "hash-object", "-w", "--stdin")
      const tree = await gitWithInput(
        fixture.repo,
        `100644 blob ${plain}\tplain.md\0` + `100755 blob ${script}\trun.sh\0`,
        "mktree",
        "-z",
      )
      const tip = await git(fixture.repo, "commit-tree", tree, "-p", fixture.initial, "-m", "two modes")
      await git(fixture.repo, "update-ref", "refs/heads/main", tip, fixture.initial)
      for (const backend of [createShellBackend(), createIsoBackend()]) {
        const listing = await backend.readTree(fixture.repo, tip)
        expect([...listing].map(([path, entry]) => [path, entry.mode, entry.oid])).toEqual([
          ["plain.md", "100644", plain],
          ["run.sh", "100755", script],
        ])
        const scoped = await backend.readTree(fixture.repo, tip, "run")
        expect([...scoped.keys()]).toEqual(["run.sh"])
        const blobs = await backend.readBlobs(fixture.repo, [script, plain])
        expect(blobs.get(plain)).toBe("plain\n")
        expect(blobs.get(script)).toBe("#!/bin/sh\n")
      }
      const mem = createMemBackend()
      const store = await open({ repo: "modes", ref: "main", writer: "worker", backend: mem })
      const committed = await store.transact(async (map) => map.set("plain.md", "plain\n"), "one file")
      const listing = await mem.readTree("modes", committed.oid)
      expect(listing.get("plain.md")).toEqual({ mode: "100644", oid: plain })
      expect((await mem.readBlobs("modes", [plain])).get(plain)).toBe("plain\n")
    } finally {
      await fixture.cleanup()
    }
  })
})
