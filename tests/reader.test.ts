// @failure Read-only branch consumers could write to the repository, observe moving snapshots, or leak ref-watch timers.
// @level l1
// @consumer read-only Git snapshot consumers

import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { describe, expect, test, vi } from "vitest"

import { createShellBackend, open, openReader } from "../src/index.js"
import type { GitomicBackend } from "../src/index.js"
import { isPublicPath } from "../src/path.js"
import { createBareRepo, git, gitWithInput, perCommitReads } from "./helpers/git.js"
import { createMemBackend } from "../src/mem.js"

describe("read-only reader", () => {
  test("opens without writing to the repository and reads an exact pinned snapshot", async () => {
    const backend = createMemBackend()
    const writer = await open({ repo: "reader-snapshot", ref: "main", writer: "writer", backend })
    const first = await writer.transact(async (map) => map.set("notes/one.md", "one\n"), "write one")
    let mutations = 0
    const readerBackend: GitomicBackend = {
      ...backend,
      writeCommit: async () => {
        mutations += 1
        throw new Error("reader must not write an object")
      },
      compareAndSwap: async () => {
        mutations += 1
        throw new Error("reader must not move a ref")
      },
    }

    const reader = await openReader({ repo: "reader-snapshot", ref: "main", backend: readerBackend })
    const snapshot = reader.at(first.oid)
    const second = await writer.transact(async (map) => map.set("notes/two.md", "two\n"), "write two")

    expect(mutations).toBe(0)
    expect(await snapshot.keys()).toEqual(["notes/one.md"])
    expect(await snapshot.get("notes/one.md")).toBe("one\n")
    expect(await snapshot.get("notes/two.md")).toBeUndefined()
    expect(await reader.at().keys()).toEqual(["notes/one.md", "notes/two.md"])
    expect((await reader.log({ from: second.oid, limit: 2 })).map(({ oid }) => oid)).toEqual([second.oid, first.oid])
    expect(await reader.diff(first.oid, second.oid)).toEqual([
      { path: "notes/two.md", from: null, to: await writer.at(second.oid).oid("notes/two.md") },
    ])
    expect(mutations).toBe(0)
  })

  test("pins one log start, defaults to fifty and reads only the requested first-parent range", async () => {
    const mem = createMemBackend()
    const repo = "reader-history"
    const writer = await open({ repo, ref: "main", backend: mem })
    const initial = await writer.head()
    const commits: string[] = []
    for (let index = 0; index < 55; index += 1) {
      commits.push((await writer.transact(async (map) => map.set("count", `${index}`), `write ${index}`)).oid)
    }
    let heads = 0
    const reads: string[] = []
    let advance = true
    // No readHistory: this pins the per-commit fallback a third-party backend gets.
    // The batched path is pinned by the next test.
    const backend: GitomicBackend = {
      ...perCommitReads(mem),
      head: async (name, ref) => {
        heads += 1
        return mem.head(name, ref)
      },
      readCommit: async (name, oid) => {
        reads.push(oid)
        if (advance) {
          advance = false
          await writer.transact(async (map) => map.set("late", "not in pinned history"), "advance during log")
        }
        return mem.readCommit(name, oid)
      },
    }
    const reader = await openReader({ repo, backend })
    heads = 0

    const recent = await reader.log()
    expect(recent.map(({ oid }) => oid)).toEqual(commits.slice(-50).reverse())
    expect(reads).toEqual(commits.slice(-50).reverse())
    expect(heads).toBe(1)
    reads.length = 0
    expect((await reader.log({ from: commits[2] as string, limit: 2 })).map(({ oid }) => oid)).toEqual([
      commits[2],
      commits[1],
    ])
    expect(reads).toEqual([commits[2], commits[1]])
    expect(heads).toBe(1)
    expect(await reader.log({ from: initial, limit: 1_024 })).toEqual([
      {
        oid: initial,
        parent: null,
        parents: [],
        trailers: [],
        message: "initial\n",
        writer: null,
        instance: null,
        seq: null,
        provenance: null,
        author: { name: "gitomic", email: "gitomic@localhost" },
        committer: { name: "gitomic", email: "gitomic@localhost" },
        timestamp: 946_684_800,
      },
    ])
  })

  test("with a batched backend, log is one pinned readHistory call over exactly the requested range", async () => {
    const mem = createMemBackend()
    const repo = "reader-batched-history"
    const writer = await open({ repo, ref: "main", backend: mem })
    const commits: string[] = []
    for (let index = 0; index < 55; index += 1) {
      commits.push((await writer.transact(async (map) => map.set("count", `${index}`), `write ${index}`)).oid)
    }
    let heads = 0
    const calls: Array<{ tips: readonly string[]; limit: number | undefined }> = []
    let advance = true
    const backend: GitomicBackend = {
      ...mem,
      head: async (name, ref) => {
        heads += 1
        return mem.head(name, ref)
      },
      readCommit: async () => {
        throw new Error("a batched log must not fall back to per-commit reads")
      },
      readHistory: async (name, tips, options) => {
        calls.push({ tips, limit: options?.limit })
        if (advance) {
          advance = false
          await writer.transact(async (map) => map.set("late", "not in pinned history"), "advance during log")
        }
        return (await mem.readHistory?.(name, tips, options)) ?? []
      },
    }
    const reader = await openReader({ repo, backend })
    heads = 0
    const recent = await reader.log()
    expect(recent.map(({ oid }) => oid)).toEqual(commits.slice(-50).reverse())
    expect(heads).toBe(1)
    expect(calls).toEqual([{ tips: [commits.at(-1)], limit: 50 }])
    calls.length = 0
    expect((await reader.log({ from: commits[2] as string, limit: 2 })).map(({ oid }) => oid)).toEqual([
      commits[2],
      commits[1],
    ])
    expect(calls).toEqual([{ tips: [commits[2]], limit: 2 }])
  })

  test.each(["batched", "per-commit"])("log %s IDs do not retain whole history backing storage", async (mode) => {
    const { stdout, stderr } = await promisify(execFile)(
      "bun",
      [
        "-e",
        `
          import { Buffer } from "node:buffer";
          import { heapStats } from "bun:jsc";
          import { openReader } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
          import { createMemBackend } from ${JSON.stringify(new URL("../src/mem.ts", import.meta.url).href)};
          const mem = createMemBackend();
          const repo = "reader-owned-history";
          const reader = await openReader({ repo, backend: mem });
          const template = await mem.readCommit(repo, await reader.head());
          const tip = "a".repeat(40);
          const parent = "b".repeat(40);
          const mergeParent = "c".repeat(40);
          function readCommit(oid) {
            const history = Buffer.from("x".repeat(8 * 1024 * 1024) + "\\0" +
              [oid, ...(oid === tip ? [parent, mergeParent] : [])].join("\\0"), "utf8").toString("utf8");
            const ids = history.split("\\0").slice(1);
            return { ...template, oid: ids[0], parent: ids[1] ?? null, parents: ids.slice(1) };
          }
          const backend = {
            ...mem,
            readCommit: async (_repo, oid) => readCommit(oid),
            readHistory: ${JSON.stringify(mode)} === "batched"
              ? async () => [readCommit(tip), readCommit(parent)]
              : undefined,
          };
          const logReader = await openReader({ repo, backend });
          Bun.gc(true);
          const baseline = heapStats().extraMemorySize;
          // A history consumer caches identities, while message/author metadata has its own lifetime.
          globalThis.retainedIds = (await logReader.log({ from: tip, limit: 2 }))
            .map(({ oid, parent, parents }) => ({ oid, parent, parents }));
          await new Promise(resolve => setTimeout(resolve, 0));
          Bun.gc(true);
          console.log(JSON.stringify({
            ids: globalThis.retainedIds,
            retainedBytes: heapStats().extraMemorySize - baseline,
          }));
        `,
      ],
      { encoding: "utf8", timeout: 10_000 },
    )
    expect(stderr).toBe("")
    const result = JSON.parse(stdout) as {
      ids: Array<{ oid: string; parent: string | null; parents: string[] }>
      retainedBytes: number
    }
    expect(result.ids).toEqual([
      { oid: "a".repeat(40), parent: "b".repeat(40), parents: ["b".repeat(40), "c".repeat(40)] },
      { oid: "b".repeat(40), parent: null, parents: [] },
    ])
    expect(result.retainedBytes).toBeLessThan(4 * 1024 * 1024)
  })

  test("diff sorts add/remove/modify identities and respects the backend's diff projection", async () => {
    const mem = createMemBackend()
    const repo = "reader-projected-diff"
    const writer = await open({ repo, ref: "main", backend: mem })
    const first = await writer.transact(async (map) => {
      map.set("visible/remove", "gone")
      map.set("visible/change", "before")
      map.set("hidden/noise", "before")
    }, "before")
    const second = await writer.transact(async (map) => {
      map.delete("visible/remove")
      map.set("visible/change", "after")
      map.set("visible/add", "new")
      map.set("hidden/noise", "after")
    }, "after")
    // A backend that projects its listing projects its diff too: diff reads the change, never either listing.
    const readTree = vi.fn(mem.readTree)
    const readTreeDiff = vi.fn(async (name: string, from: string, to: string) =>
      (await mem.readTreeDiff(name, from, to)).filter(({ path }) => path.startsWith("visible/")),
    )
    const reader = await openReader({ repo, backend: { ...mem, readTree, readTreeDiff } })
    expect(await reader.diff(first.oid, second.oid)).toEqual([
      { path: "visible/add", from: null, to: await writer.at(second.oid).oid("visible/add") },
      {
        path: "visible/change",
        from: await writer.at(first.oid).oid("visible/change"),
        to: await writer.at(second.oid).oid("visible/change"),
      },
      { path: "visible/remove", from: await writer.at(first.oid).oid("visible/remove"), to: null },
    ])
    expect(readTreeDiff).toHaveBeenCalledTimes(1)
    expect(readTree).not.toHaveBeenCalled()
    expect(await reader.diff(second.oid, second.oid)).toEqual([])
  })

  test("diff values do not retain the backing storage of the backend's change read", async () => {
    // The accepted lifetime contract concerns Bun's sliced strings, even when Vitest runs on Node.
    // Keep all three changed identities alive across GC: equality tests cannot detect their backing storage.
    const { stdout, stderr } = await promisify(execFile)(
      "bun",
      [
        "-e",
        `
          import { Buffer } from "node:buffer";
          import { heapStats } from "bun:jsc";
          import { openReader } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)};
          import { createMemBackend } from ${JSON.stringify(new URL("../src/mem.ts", import.meta.url).href)};
          const before = "a".repeat(40);
          const after = "b".repeat(40);
          const oldOid = "c".repeat(40);
          const newOid = "d".repeat(40);
          const backend = {
            ...createMemBackend(),
            async readTreeDiff() {
              const records = [
                ["notes/add-é.md", "", newOid],
                ["notes/change-雪.md", oldOid, newOid],
                ["notes/remove-🦊.md", oldOid, ""],
              ];
              const read = Buffer.from("x".repeat(8 * 1024 * 1024) + "\\0" +
                records.map((fields) => fields.join("\\t")).join("\\0"), "utf8").toString("utf8");
              return read.split("\\0").slice(1).map(record => {
                const [path, fromOid, toOid] = record.split("\\t");
                return {
                  path,
                  from: fromOid === "" ? undefined : { oid: fromOid, mode: "100644" },
                  to: toOid === "" ? undefined : { oid: toOid, mode: "100644" },
                };
              });
            },
          };
          const reader = await openReader({ repo: "reader-owned-diff", backend });
          Bun.gc(true);
          const baseline = heapStats().extraMemorySize;
          globalThis.retainedChanges = await reader.diff(before, after);
          await new Promise(resolve => setTimeout(resolve, 0));
          Bun.gc(true);
          console.log(JSON.stringify({
            changes: globalThis.retainedChanges,
            retainedBytes: heapStats().extraMemorySize - baseline,
          }));
        `,
      ],
      { encoding: "utf8", timeout: 10_000 },
    )
    expect(stderr).toBe("")
    const result = JSON.parse(stdout) as {
      changes: Array<{ path: string; from: string | null; to: string | null }>
      retainedBytes: number
    }
    expect(result.changes).toEqual([
      { path: "notes/add-é.md", from: null, to: "d".repeat(40) },
      { path: "notes/change-雪.md", from: "c".repeat(40), to: "d".repeat(40) },
      { path: "notes/remove-🦊.md", from: "c".repeat(40), to: null },
    ])
    // Allow runtime noise far beyond these few hundred bytes, but never the 8 MiB read.
    expect(result.retainedBytes).toBeLessThan(4 * 1024 * 1024)
  })

  test("diff requires both endpoints to exist, including equal missing endpoints", async () => {
    const backend = createMemBackend()
    const reader = await openReader({ repo: "reader-missing-diff", backend })
    const present = await reader.head()
    const missing = "f".repeat(40)

    for (const [from, to] of [
      [missing, present],
      [present, missing],
      [missing, missing],
    ] as const) {
      await expect(reader.diff(from, to)).rejects.toThrow(missing)
    }
  })

  test.each(["120000", "160000"] as const)(
    "diff refuses a changed entry with unsupported mode %s by name; an unchanged one is not exposed",
    async (mode) => {
      const fixture = await createBareRepo()
      try {
        const { repo } = fixture
        const blob = (text: string) => gitWithInput(repo, text, "hash-object", "-w", "--stdin")
        const commit = async (entries: string) =>
          git(repo, "commit-tree", await gitWithInput(repo, entries, "mktree", "-z"), "-m", "fixture")
        const type = mode === "160000" ? "commit" : "blob"
        const emptyTree = await gitWithInput(repo, "", "mktree")
        const [target, other] =
          mode === "160000"
            ? [fixture.initial, await git(repo, "commit-tree", emptyTree, "-m", "other")]
            : [await blob("target"), await blob("other")]
        const before = await blob("before\n")
        const after = await blob("after\n")
        const unsupported = (oid: string) => `${mode} ${type} ${oid}\tunsupported\0`
        const first = await commit(`100644 blob ${before}\tchanged\0` + unsupported(target))
        const second = await commit(`100644 blob ${after}\tchanged\0` + unsupported(target))
        const moved = await commit(`100644 blob ${after}\tchanged\0` + unsupported(other))
        const without = await commit(`100644 blob ${after}\tchanged\0`)
        const reader = await openReader({ repo, backend: createShellBackend() })
        const reason = `unsupported Git tree mode ${mode} at "unsupported"`

        // 27226: a verb validates the entries it EXPOSES. An unchanged entry is not in the diff, so it is not exposed.
        expect(await reader.diff(first, second)).toEqual([{ path: "changed", from: before, to: after }])
        expect(await reader.diff(second, second)).toEqual([])
        // A changed entry is exposed: moved on both sides, or present on the one side that adds or deletes it.
        await expect(reader.diff(second, moved)).rejects.toThrow(reason)
        await expect(reader.diff(without, second)).rejects.toThrow(reason)
        await expect(reader.diff(second, without)).rejects.toThrow(reason)
      } finally {
        await fixture.cleanup()
      }
    },
  )

  test("diff answers what comparing the two whole listings answered, on the reader fixtures", async () => {
    // The answer diff gave before #29809 C2, from two whole listings, kept as the oracle the one tree diff must equal.
    const listingDiff = async (backend: GitomicBackend, repo: string, from: string, to: string) => {
      const [before, after] = await Promise.all([backend.readTree(repo, from), backend.readTree(repo, to)])
      return [...new Set([...before.keys(), ...after.keys()])]
        .filter(isPublicPath)
        .sort()
        .flatMap((path) => {
          const fromOid = before.get(path)?.oid ?? null
          const toOid = after.get(path)?.oid ?? null
          return fromOid === toOid ? [] : [{ path, from: fromOid, to: toOid }]
        })
    }
    const fixture = await createBareRepo()
    try {
      const backends: readonly { repo: string; backend: GitomicBackend }[] = [
        { repo: "reader-equivalence", backend: createMemBackend() },
        { repo: fixture.repo, backend: createShellBackend() },
      ]
      for (const { repo, backend } of backends) {
        const writer = await open({ repo, ref: "main", backend })
        const initial = await writer.head()
        const one = await writer.transact(async (map) => map.set("notes/one.md", "one\n"), "write one")
        const two = await writer.transact(async (map) => map.set("notes/two.md", "two\n"), "write two")
        const first = await writer.transact(async (map) => {
          map.set("visible/remove", "gone")
          map.set("visible/change", "before")
          map.set("hidden/noise", "before")
        }, "before")
        const second = await writer.transact(async (map) => {
          map.delete("visible/remove")
          map.set("visible/change", "after")
          map.set("visible/add", "new")
          map.set("hidden/noise", "after")
          map.delete("notes/one.md")
        }, "after")
        const reader = await openReader({ repo, backend })
        const commits = [initial, one.oid, two.oid, first.oid, second.oid]
        for (const from of commits) {
          for (const to of commits) {
            expect(await reader.diff(from, to)).toEqual(await listingDiff(backend, repo, from, to))
          }
        }
      }
      // A mode-only change: the listings compared oids only, so it was no Change, and it is none now.
      const { repo } = fixture
      const script = await gitWithInput(repo, "#!/bin/sh\n", "hash-object", "-w", "--stdin")
      const plain = await git(
        repo,
        "commit-tree",
        await gitWithInput(repo, `100644 blob ${script}\trun.sh\0`, "mktree", "-z"),
        "-m",
        "plain",
      )
      const executable = await git(
        repo,
        "commit-tree",
        await gitWithInput(repo, `100755 blob ${script}\trun.sh\0`, "mktree", "-z"),
        "-m",
        "x",
      )
      const reader = await openReader({ repo, backend: createShellBackend() })
      expect(await reader.diff(plain, executable)).toEqual([])
      expect(await listingDiff(createShellBackend(), repo, plain, executable)).toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  test("defaults to main and validates refs before invoking the backend", async () => {
    const mem = createMemBackend()
    const observedRefs: string[] = []
    const backend: GitomicBackend = {
      ...mem,
      head: async (repo, ref) => {
        observedRefs.push(ref)
        return await mem.head(repo, ref)
      },
    }

    await openReader({ repo: "reader-default-ref", backend })

    expect(observedRefs).toEqual(["refs/heads/main"])
    await expect(openReader({ repo: "reader-invalid-ref", ref: "main\nprepare\ncommit", backend })).rejects.toThrow(
      "invalid Git ref",
    )
    expect(observedRefs).toEqual(["refs/heads/main"])
  })

  test("refreshes a configured remote instead of trusting a local ref", async () => {
    const mem = createMemBackend()
    const expected = await mem.head("reader-remote", "refs/heads/main")
    const fetchRemote = vi.fn(async () => expected)
    const backend: GitomicBackend = { ...mem, fetchRemote }

    const reader = await openReader({ repo: "reader-remote", ref: "main", remote: "origin", backend })

    expect(await reader.head()).toBe(expected)
    expect(fetchRemote).toHaveBeenCalledTimes(2)
    expect(fetchRemote).toHaveBeenNthCalledWith(1, "reader-remote", "refs/heads/main", "origin")
  })

  test("fails loudly when the selected backend cannot refresh a remote", async () => {
    await expect(
      openReader({ repo: "reader-unsupported-remote", remote: "origin", backend: createMemBackend() }),
    ).rejects.toThrow("this backend cannot refresh a remote")
  })

  test("streams ref-tip changes and releases promptly when aborted", async () => {
    const backend = createMemBackend()
    const writer = await open({ repo: "reader-watch", ref: "main", writer: "writer", backend })
    const reader = await openReader({ repo: "reader-watch", backend })
    const initial = await reader.head()
    const controller = new AbortController()
    const changes = reader
      .watch({ after: initial, signal: controller.signal, pollIntervalMs: 1 })
      [Symbol.asyncIterator]()
    const pending = changes.next()

    const committed = await writer.transact(async (map) => map.set("changed.md", "yes\n"), "advance tip")

    await expect(pending).resolves.toEqual({
      done: false,
      value: { from: initial, to: committed.oid },
    })
    controller.abort()
    await expect(changes.next()).resolves.toEqual({ done: true, value: undefined })
  })

  test("does not inspect the ref when watch starts already aborted", async () => {
    const mem = createMemBackend()
    let headCalls = 0
    const backend: GitomicBackend = {
      ...mem,
      head: async (repo, ref) => {
        headCalls += 1
        return await mem.head(repo, ref)
      },
    }
    const reader = await openReader({ repo: "reader-aborted", backend })
    const after = await reader.head()
    const callsBeforeWatch = headCalls
    const controller = new AbortController()
    controller.abort()

    const result = await reader
      .watch({ after, signal: controller.signal, pollIntervalMs: 1 })
      [Symbol.asyncIterator]()
      .next()

    expect(result).toEqual({ done: true, value: undefined })
    expect(headCalls).toBe(callsBeforeWatch)
  })

  test("settles a watch aborted during an in-flight ref refresh", async () => {
    const mem = createMemBackend()
    const initial = await mem.head("reader-in-flight-abort", "refs/heads/main")
    let headCalls = 0
    const backend: GitomicBackend = {
      ...mem,
      head: async () => {
        headCalls += 1
        if (headCalls === 1) return initial
        return await new Promise<string>(() => undefined)
      },
    }
    const reader = await openReader({ repo: "reader-in-flight-abort", backend })
    const controller = new AbortController()
    const changes = reader
      .watch({ after: initial, signal: controller.signal, pollIntervalMs: 1 })
      [Symbol.asyncIterator]()
    const pending = changes.next()
    await vi.waitFor(() => expect(headCalls).toBe(2))

    controller.abort()
    const timedOut = new Promise<"timed out">((resolve) => {
      AbortSignal.timeout(50).addEventListener("abort", () => resolve("timed out"), { once: true })
    })

    expect(await Promise.race([pending, timedOut])).toEqual({ done: true, value: undefined })
  })
})
