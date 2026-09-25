// @failure Separate repositories could overwrite an origin winner instead of replaying under its ref lock.
// @level l1
// @consumer remote-arbitrated gitomic writers

import { describe, expect, test, vi } from "vitest"
import fs from "node:fs"
import { chmod, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import {
  createShellBackend,
  open,
  openReader,
  openRemoteRepository,
  refreshKeptCopy,
  RetriesExhausted,
} from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import type { GitMap, GitomicBackend } from "../src/index.js"
import { createBareRepo, createRemoteRepos, git } from "./helpers/git.js"

type TraceEvent = {
  event?: string
  argv?: string[]
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("owned remote repositories", () => {
  test.each(["URL", "path"])("opens a %s in private storage shared by readers and writers", async (kind) => {
    const fixture = await createBareRepo()
    try {
      const source = kind === "URL" ? pathToFileURL(fixture.repo).href : fixture.repo
      const repository = await openRemoteRepository(source)
      const parent = dirname(repository.repo)
      try {
        expect(repository.repo).not.toBe(fixture.repo)
        expect(repository.remote).toBe("origin")
        expect(await git(repository.repo, "rev-parse", "--is-bare-repository")).toBe("true")
        const options = { ...repository, ref: "main" }
        const store = await open(options)
        const result = await store.transact(async (map) => map.set("note.md", "remote-owned\n"), "write")
        const reader = await openReader(options)
        expect(await reader.at(result.oid).get("note.md")).toBe("remote-owned\n")
        expect(await git(fixture.repo, "show", "main:note.md")).toBe("remote-owned")
      } finally {
        repository[Symbol.dispose]()
      }
      expect(fs.existsSync(parent)).toBe(false)
      expect(() => repository[Symbol.dispose]()).not.toThrow()
      expect(fs.existsSync(fixture.repo)).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  /**
   * @failure 186 /tmp/gitomic-remote-* clones outlived their processes on hh's host (hh 25615); a surviving
   *          temporary clone must never start a background gc on storage nobody owns.
   */
  test("a temporary clone sets gc.auto=0 so a surviving one never collects garbage", async () => {
    const fixture = await createBareRepo()
    try {
      const repository = await openRemoteRepository(pathToFileURL(fixture.repo).href)
      try {
        expect(await git(repository.repo, "config", "--get", "gc.auto")).toBe("0")
      } finally {
        repository[Symbol.dispose]()
      }
    } finally {
      await fixture.cleanup()
    }
  })

  test("failed clone cleans its allocation and preserves a simultaneous cleanup failure", async () => {
    const fixture = await createBareRepo()
    const source = pathToFileURL(join(fixture.repo, "missing.git")).href
    const remove = vi.spyOn(fs, "rmSync")
    try {
      await expect(openRemoteRepository(source)).rejects.toThrow(/git clone/)
      const firstParent = String(remove.mock.calls[0]?.[0])
      expect(firstParent).not.toBe("undefined")
      expect(fs.existsSync(firstParent)).toBe(false)

      const cleanupFailure = new Error("cleanup permission denied")
      remove.mockImplementationOnce(() => {
        throw cleanupFailure
      })
      let observed: unknown
      try {
        await openRemoteRepository(source)
      } catch (error) {
        observed = error
      }
      expect(observed).toBeInstanceOf(AggregateError)
      const errors = (observed as AggregateError).errors as Error[]
      expect(errors).toHaveLength(2)
      expect(errors[0]?.message).toContain(source)
      expect(errors[0]?.message).toContain("git clone")
      expect(errors[0]?.message).toMatch(/exit \d+/)
      expect(errors[1]).toBe(cleanupFailure)
    } finally {
      const parents = remove.mock.calls.map(([path]) => path)
      remove.mockRestore()
      for (const parent of parents) fs.rmSync(parent, { recursive: true, force: true })
      await fixture.cleanup()
    }
  })

  test("failed disposal stays observable and can be retried", async () => {
    const fixture = await createBareRepo()
    try {
      const repository = await openRemoteRepository(fixture.repo)
      const parent = dirname(repository.repo)
      const remove = vi.spyOn(fs, "rmSync").mockImplementationOnce(() => {
        throw new Error("cleanup denied")
      })
      try {
        expect(() => repository[Symbol.dispose]()).toThrow("cleanup denied")
        expect(fs.existsSync(parent)).toBe(true)
      } finally {
        remove.mockRestore()
        repository[Symbol.dispose]()
      }
      expect(fs.existsSync(parent)).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("remote arbitration", () => {
  test("default Store still fetches before open and transact", async () => {
    const fixture = await createRemoteRepos()
    try {
      const shell = createShellBackend()
      const fetchRemote = vi.fn(shell.fetchRemote!)
      const store = await open({
        repo: fixture.left,
        ref: "main",
        remote: "origin",
        backend: { ...shell, fetchRemote },
      })
      await store.transact(async (map) => map.set("default", "fresh"), "default policy")
      expect(fetchRemote).toHaveBeenCalledTimes(2)
    } finally {
      await fixture.cleanup()
    }
  })

  // #25693: the first write must not pay for a fetch; only a lost lease can make the kept ref stale.
  test.each([
    ["shell", createShellBackend],
    ["iso", createIsoBackend],
  ] as const)(
    "%s opt-in store uses one push per uncontended write and refreshes after rejection",
    async (_name, backendFactory) => {
      const fixture = await createRemoteRepos()
      try {
        const base = backendFactory()
        const fetchRemote = vi.fn(base.fetchRemote!)
        const compareAndSwapRemote = vi.fn(base.compareAndSwapRemote!)
        const store = await open({
          repo: fixture.left,
          ref: "main",
          remote: "origin",
          refresh: "on-rejection",
          backend: { ...base, fetchRemote, compareAndSwapRemote },
        })
        await store.transact(async (map) => map.set("count", "1"), "first")
        await store.transact(async (map) => map.set("count", "2"), "second")
        expect(fetchRemote).toHaveBeenCalledTimes(0)
        expect(compareAndSwapRemote).toHaveBeenCalledTimes(2)
        expect(await base.head(fixture.left, "refs/heads/main")).toBe(await git(fixture.remote, "rev-parse", "main"))

        const rival = await open({ repo: fixture.right, ref: "main", remote: "origin" })
        await rival.transact(async (map) => map.set("rival", "landed"), "rival")
        let attempts = 0
        const result = await store.transact(async (map) => {
          attempts += 1
          map.set("count", String(Number((await map.get("count")) ?? "0") + 1))
        }, "replay")
        expect(result.retries).toBe(1)
        expect(attempts).toBe(2)
        expect(fetchRemote).toHaveBeenCalledTimes(1)
        expect(compareAndSwapRemote).toHaveBeenCalledTimes(4)
        expect(await git(fixture.remote, "show", "main:rival")).toBe("landed")
        expect(await git(fixture.remote, "show", "main:count")).toBe("3")

        const newer = await rival.transact(async (map) => map.set("newer", "remote"), "newer remote tip")
        expect(await store.head()).toBe(result.oid)
        expect(await store.head()).not.toBe(newer.oid)
        expect(fetchRemote).toHaveBeenCalledTimes(1)
      } finally {
        await fixture.cleanup()
      }
    },
  )

  test.each(["false", "throw"])(
    "on-rejection store refreshes before searching a %s acknowledgement receipt",
    async (acknowledgement) => {
      const fixture = await createRemoteRepos()
      try {
        const shell = createShellBackend()
        const fetchRemote = vi.fn(shell.fetchRemote!)
        const backend: GitomicBackend = {
          ...shell,
          fetchRemote,
          async compareAndSwapRemote(...args) {
            expect((await shell.compareAndSwapRemote!(...args)).landed).toBe(true)
            if (acknowledgement === "throw") throw new Error("accepted; acknowledgement lost")
            return { landed: false }
          },
        }
        const store = await open({
          repo: fixture.left,
          ref: "main",
          remote: "origin",
          refresh: "on-rejection",
          backend,
        })
        const update = vi.fn(async (map: GitMap) => map.set("receipt", "once"))
        const result = await store.transact(update, "receipt")
        expect(result.oid).toBe(await git(fixture.remote, "rev-parse", "main"))
        expect(update).toHaveBeenCalledTimes(1)
        expect(fetchRemote).toHaveBeenCalledTimes(1)
      } finally {
        await fixture.cleanup()
      }
    },
  )

  test.each([
    ["shell", createShellBackend],
    ["iso", createIsoBackend],
  ] as const)("%s accepted MULTI publish advances the kept local ref", async (_name, backendFactory) => {
    const fixture = await createRemoteRepos()
    try {
      const base = backendFactory()
      const fetchRemote = vi.fn(base.fetchRemote!)
      const publish = vi.fn(base.publish!)
      const backend = { ...base, fetchRemote, publish }
      const store = await open({
        repo: fixture.left,
        ref: "main",
        remote: "origin",
        refresh: "on-rejection",
        backend,
      })
      const result = await store.transact(async (map) => map.set("multi", "landed"), "multi", {
        beside: ({ next }) => [{ ref: "refs/heads/companion", expect: null, oid: next }],
      })
      expect(await backend.head(fixture.left, "refs/heads/main")).toBe(result.oid)
      expect(await git(fixture.left, "for-each-ref", "refs/heads/companion")).toBe("")
      expect(await git(fixture.remote, "rev-parse", "main")).toBe(result.oid)
      await store.transact(async (map) => map.set("following", "one push"), "following")
      expect(fetchRemote).toHaveBeenCalledTimes(0)
      expect(publish).toHaveBeenCalledTimes(1)
    } finally {
      await fixture.cleanup()
    }
  })

  test("on-rejection open names a missing kept ref instead of fetching it", async () => {
    const fixture = await createRemoteRepos()
    try {
      await git(fixture.left, "update-ref", "-d", "refs/heads/main")
      const shell = createShellBackend()
      const fetchRemote = vi.fn(shell.fetchRemote!)
      await expect(
        open({
          repo: fixture.left,
          ref: "main",
          remote: "origin",
          refresh: "on-rejection",
          backend: { ...shell, fetchRemote },
        }),
      ).rejects.toThrow(`cannot read local ref refs/heads/main in ${JSON.stringify(fixture.left)}`)
      expect(fetchRemote).toHaveBeenCalledTimes(0)
      expect(await git(fixture.remote, "rev-parse", "main")).toBe(fixture.initial)
    } finally {
      await fixture.cleanup()
    }
  })

  test("on-rejection open names an unreadable kept commit object", async () => {
    const fixture = await createRemoteRepos()
    try {
      const shell = createShellBackend()
      const fetchRemote = vi.fn(shell.fetchRemote!)
      const backend: GitomicBackend = {
        ...shell,
        fetchRemote,
        async readCommit(repo, oid) {
          if (oid === fixture.initial) throw new Error("object missing")
          return shell.readCommit(repo, oid)
        },
      }
      await expect(
        open({ repo: fixture.left, ref: "main", remote: "origin", refresh: "on-rejection", backend }),
      ).rejects.toThrow(`cannot read local ref refs/heads/main in ${JSON.stringify(fixture.left)}`)
      expect(fetchRemote).toHaveBeenCalledTimes(0)
    } finally {
      await fixture.cleanup()
    }
  })

  /**
   * @failure hh 25615: km's on-rejection Store and the gitomic CLI (refresh "always") shared one kept copy; when the
   *          CLI moved the kept ref between km's accepted push and its local check, a write that LANDED on origin
   *          was reported "publication … unknown … local cache moved" (review2: 2 of 900). @cto's rule: a
   *          publication whose lease the remote accepted is applied whatever the kept copy did afterward; the kept
   *          copy is derived state, re-read on the next attempt, never reported as a failure.
   */
  describe("an on-rejection Store sharing its kept copy with an always writer (hh 25615)", () => {
    /** Another process's write through the same kept copy, as the CLI makes it. */
    async function otherWriterMoves(repo: string, path: string): Promise<void> {
      const other = await open({ repo, ref: "main", remote: "origin", writer: "cli" })
      await other.transact(async (map) => map.set(path, "from the other writer\n"), `other ${path}`)
    }

    test("an accepted push stands when the other writer moves the kept ref before the local check", async () => {
      const fixture = await createRemoteRepos()
      try {
        const shell = createShellBackend()
        const fetchRemote = vi.fn(shell.fetchRemote!)
        let armed = true
        const backend: GitomicBackend = {
          ...shell,
          fetchRemote,
          async compareAndSwapRemote(...args) {
            const landed = await shell.compareAndSwapRemote!(...args)
            if (landed && armed) {
              armed = false
              await otherWriterMoves(fixture.left, "cli.md")
            }
            return landed
          },
        }
        const store = await open({
          repo: fixture.left,
          ref: "main",
          remote: "origin",
          refresh: "on-rejection",
          backend,
        })
        await store.transact(async (map) => map.set("km.md", "from km\n"), "km write")
        // Accepted is landed: no "unknown" publication, so no receipt search re-fetches origin.
        expect(fetchRemote).toHaveBeenCalledTimes(0)
        expect(await git(fixture.remote, "show", "main:km.md")).toBe("from km")
        expect(await git(fixture.remote, "show", "main:cli.md")).toBe("from the other writer")
        // The next attempt re-reads the kept copy and lands on top of the other writer.
        await store.transact(async (map) => map.set("km2.md", "again\n"), "km write 2")
        expect(await git(fixture.remote, "show", "main:km2.md")).toBe("again")
      } finally {
        await fixture.cleanup()
      }
    })

    test("an accepted MULTI stands when the other writer moves the kept ref before the cache update", async () => {
      const fixture = await createRemoteRepos()
      try {
        const shell = createShellBackend()
        const fetchRemote = vi.fn(shell.fetchRemote!)
        let armed = true
        const backend: GitomicBackend = {
          ...shell,
          fetchRemote,
          async publish(...args) {
            const published = await shell.publish!(...args)
            if (armed) {
              armed = false
              await otherWriterMoves(fixture.left, "cli.md")
            }
            return published
          },
        }
        const store = await open({
          repo: fixture.left,
          ref: "main",
          remote: "origin",
          refresh: "on-rejection",
          backend,
        })
        await store.transact(async (map) => map.set("km.md", "from km\n"), "km multi", {
          beside: ({ next }) => [{ ref: "refs/heads/companion", expect: null, oid: next }],
        })
        expect(fetchRemote).toHaveBeenCalledTimes(0)
        expect(await git(fixture.remote, "show", "main:km.md")).toBe("from km")
        expect(await git(fixture.remote, "show", "main:cli.md")).toBe("from the other writer")
      } finally {
        await fixture.cleanup()
      }
    })

    test("a refresh proceeds when the other writer moves the kept ref under the cache update", async () => {
      const fixture = await createRemoteRepos()
      try {
        // Origin moves first through another clone, so this Store's kept base is stale and its lease is refused.
        await otherWriterMoves(fixture.right, "ahead.md")
        const shell = createShellBackend()
        let armed = true
        const backend: GitomicBackend = {
          ...shell,
          async compareAndSwap(...args) {
            if (armed) {
              armed = false
              await otherWriterMoves(fixture.left, "cli.md")
            }
            return shell.compareAndSwap(...args)
          },
        }
        const store = await open({
          repo: fixture.left,
          ref: "main",
          remote: "origin",
          refresh: "on-rejection",
          backend,
        })
        await store.transact(async (map) => map.set("km.md", "from km\n"), "km write")
        for (const [path, content] of [
          ["ahead.md", "from the other writer"],
          ["cli.md", "from the other writer"],
          ["km.md", "from km"],
        ]) {
          expect(await git(fixture.remote, "show", `main:${path}`)).toBe(content)
        }
      } finally {
        await fixture.cleanup()
      }
    })
  })

  // hh 25615 (@cto): an accepted publication is landed whatever the kept copy did afterward; no receipt search.
  test("an accepted MULTI stands when its local cache CAS loses, with no receipt search", async () => {
    const fixture = await createRemoteRepos()
    try {
      const shell = createShellBackend()
      const fetchRemote = vi.fn(shell.fetchRemote!)
      let denyCacheOnce = true
      const backend: GitomicBackend = {
        ...shell,
        fetchRemote,
        async compareAndSwap(...args) {
          if (denyCacheOnce) {
            denyCacheOnce = false
            return "moved"
          }
          return shell.compareAndSwap(...args)
        },
      }
      const store = await open({ repo: fixture.left, ref: "main", remote: "origin", refresh: "on-rejection", backend })
      const update = vi.fn(async (map: GitMap) => map.set("multi", "once"))
      const result = await store.transact(update, "multi", {
        beside: ({ next }) => [{ ref: "refs/heads/companion", expect: null, oid: next }],
      })
      expect(result.oid).toBe(await git(fixture.remote, "rev-parse", "main"))
      expect(result.kept).toBe("moved")
      expect(update).toHaveBeenCalledTimes(1)
      expect(fetchRemote).toHaveBeenCalledTimes(0)
    } finally {
      await fixture.cleanup()
    }
  })

  // hh 25615 (review2 P3, @cto bb1f7b51): a git process killed mid-update-ref leaves the kept ref's lock behind, and
  // nobody can move that ref again. The write it was refreshing for stands and says so; the next refresh names the
  // lock instead of absorbing it into a refused lease and a fetch on every later write.
  test("a stale lock on the kept ref is named at the next refresh; the write before it stands", async () => {
    const fixture = await createRemoteRepos()
    try {
      const store = await open({ repo: fixture.left, ref: "main", remote: "origin", refresh: "on-rejection" })
      await writeFile(join(fixture.left, "refs/heads/main.lock"), "")
      const first = await store.transact(async (map) => map.set("first", "landed"), "first")
      expect(first.oid).toBe(await git(fixture.remote, "rev-parse", "main"))
      expect(first.kept).toBe("locked")
      await expect(store.transact(async (map) => map.set("second", "refused"), "second")).rejects.toThrow(
        "refs/heads/main.lock in its git directory is held; if no git process is running there, remove it",
      )
      expect(await git(fixture.remote, "rev-parse", "main")).toBe(first.oid)
    } finally {
      await fixture.cleanup()
    }
  })

  // @cto 3d3de4f6: the one kept-copy refresh is public, so a caller keeping its own copy calls it instead of a second
  // implementation. It is the same function a remote Store's refresh runs.
  test("refreshKeptCopy advances a kept copy to the remote tip and answers the tip", async () => {
    const fixture = await createRemoteRepos()
    try {
      const writer = await open({ repo: fixture.right, ref: "main", remote: "origin" })
      const landed = await writer.transact(async (map) => map.set("ahead", "origin moved"), "move origin")
      expect(await refreshKeptCopy({ repo: fixture.left, ref: "main", remote: "origin" })).toBe(landed.oid)
      expect(await git(fixture.left, "rev-parse", "main")).toBe(landed.oid)
    } finally {
      await fixture.cleanup()
    }
  })

  test("refreshKeptCopy names a stale lock on the kept ref and leaves it for the caller to remove", async () => {
    const fixture = await createRemoteRepos()
    try {
      const writer = await open({ repo: fixture.right, ref: "main", remote: "origin" })
      await writer.transact(async (map) => map.set("ahead", "origin moved"), "move origin")
      const lock = join(fixture.left, "refs/heads/main.lock")
      await writeFile(lock, "")
      await expect(refreshKeptCopy({ repo: fixture.left, ref: "main", remote: "origin" })).rejects.toThrow(
        "refs/heads/main.lock in its git directory is held; if no git process is running there, remove it",
      )
      expect(fs.existsSync(lock)).toBe(true)
      expect(await git(fixture.left, "rev-parse", "main")).toBe(fixture.initial)
    } finally {
      await fixture.cleanup()
    }
  })

  // @cto bb1f7b51: `kept` is the same fact in the default refresh mode, never hidden there.
  test("a default-refresh Store reports its kept ref after a landed push", async () => {
    const fixture = await createRemoteRepos()
    try {
      const store = await open({ repo: fixture.left, ref: "main", remote: "origin" })
      const landed = await store.transact(async (map) => map.set("always", "landed"), "always")
      expect(landed.kept).toBe("advanced")
      expect(await git(fixture.left, "rev-parse", "main")).toBe(landed.oid)
    } finally {
      await fixture.cleanup()
    }
  })

  // A live holder releases its lock within milliseconds: the refresh waits it out, and the write lands.
  test("a kept-ref lock released inside the refresh window costs a pause, never a failure", async () => {
    const fixture = await createRemoteRepos()
    try {
      const lock = join(fixture.left, "refs/heads/main.lock")
      const shell = createShellBackend()
      let releaseOnLocked = false
      const backend: GitomicBackend = {
        ...shell,
        async compareAndSwap(...args) {
          const swapped = await shell.compareAndSwap(...args)
          if (swapped === "locked" && releaseOnLocked) await unlink(lock)
          return swapped
        },
      }
      const store = await open({ repo: fixture.left, ref: "main", remote: "origin", refresh: "on-rejection", backend })
      await writeFile(lock, "")
      await store.transact(async (map) => map.set("first", "landed"), "first")
      releaseOnLocked = true
      const second = await store.transact(async (map) => map.set("second", "landed too"), "second")
      expect(await git(fixture.remote, "show", "main:second")).toBe("landed too")
      expect(second.kept).toBe("advanced")
    } finally {
      await fixture.cleanup()
    }
  })

  // AC2: mocked remote reads cannot detect shell.fetchRemote rewinding an ahead application ref.
  test.each(["caller-owned", "URL-owned"])(
    "reader preserves an unpublished %s branch while observing origin",
    async (kind) => {
      const fixture = await createRemoteRepos()
      const repository =
        kind === "URL-owned" ? await openRemoteRepository(pathToFileURL(fixture.remote).href) : undefined
      const repo = repository?.repo ?? fixture.left
      try {
        const local = await open({ repo, ref: "main" })
        const ahead = await local.transact(async (map) => map.set("unpublished", "keep"), "local only")
        const reader = await openReader({ repo, ref: "main", remote: "origin" })
        expect(await git(repo, "rev-parse", "main")).toBe(ahead.oid)
        expect(await reader.head()).toBe(fixture.initial)
        const pinned = reader.at()
        expect(await pinned.has("published")).toBe(false)

        const writer = await open({ repo: fixture.right, ref: "main", remote: "origin" })
        const published = await writer.transact(async (map) => map.set("published", "remote"), "advance origin")
        expect(await reader.head()).toBe(published.oid)
        expect(await reader.at().get("published")).toBe("remote")
        expect((await reader.log()).map((commit) => commit.oid)).toEqual([published.oid, fixture.initial])
        const controller = new AbortController()
        const changes = reader.watch({ after: fixture.initial, signal: controller.signal })[Symbol.asyncIterator]()
        try {
          expect(await changes.next()).toEqual({ done: false, value: { from: fixture.initial, to: published.oid } })
        } finally {
          controller.abort()
          await changes.return?.()
        }
        expect(await pinned.has("published")).toBe(false)
        expect(await reader.at(ahead.oid).get("unpublished")).toBe("keep")
        expect(await git(repo, "rev-parse", "main")).toBe(ahead.oid)
        expect(await git(fixture.remote, "rev-parse", "main")).toBe(published.oid)
        expect(await git(repo, "for-each-ref", "refs/gitomic/fetch")).toBe("")

        // Store retains the documented origin-cache replacement, including ahead local tips.
        const store = await open({ repo, ref: "main", remote: "origin" })
        expect(await store.head()).toBe(published.oid)
        expect(await store.at().get("published")).toBe("remote")
      } finally {
        repository?.[Symbol.dispose]()
        await fixture.cleanup()
      }
    },
  )

  // AC3/4: real accepted pushes, a non-idempotent update and a later winner expose replay or wrong receipt identity.
  test.each([
    { acknowledgement: "false", contention: false },
    { acknowledgement: "throw", contention: false },
    { acknowledgement: "false", contention: true },
    { acknowledgement: "throw", contention: true },
  ])(
    "recovers $acknowledgement acknowledgement with prior contention=$contention",
    async ({ acknowledgement, contention }) => {
      const fixture = await createRemoteRepos()
      try {
        const shell = createShellBackend()
        const other = await open({ repo: fixture.right, ref: "main", remote: "origin" })
        let publishes = 0
        let landedOid: string | undefined
        const findTransaction = vi.fn(shell.findTransaction)
        const backend: GitomicBackend = {
          ...shell,
          findTransaction,
          async compareAndSwapRemote(repo, ref, next, expected, remote) {
            publishes += 1
            if (contention && publishes === 1) {
              await other.transact(async (map) => map.set("earlier", "winner"), "win first race")
            }
            const pushed = await shell.compareAndSwapRemote!(repo, ref, next, expected, remote)
            if (!pushed.landed) return pushed
            landedOid = next
            await other.transact(async (map) => map.set("later", "winner"), "advance after receipt")
            if (acknowledgement === "throw") throw new Error("accepted; acknowledgement lost")
            return { landed: false }
          },
        }
        const store = await open({ repo: fixture.left, ref: "main", remote: "origin", backend })
        let updates = 0
        const result = await store.transact(async (map) => {
          updates += 1
          map.set("count", String(Number((await map.get("count")) ?? "0") + 1))
        }, "increment once")

        expect(result.oid).toBe(landedOid)
        expect(result.oid).not.toBe(await git(fixture.remote, "rev-parse", "main"))
        expect(result.retries).toBe(Number(contention) + Number(acknowledgement === "false"))
        expect(updates).toBe(1 + Number(contention))
        expect(publishes).toBe(updates)
        expect(findTransaction).toHaveBeenCalledTimes(publishes)
        expect(await git(fixture.remote, "show", "main:count")).toBe("1")
        expect(await store.at(result.oid).has("later")).toBe(false)
        expect(await git(fixture.remote, "rev-list", "--count", "main")).toBe(String(3 + Number(contention)))
      } finally {
        await fixture.cleanup()
      }
    },
  )

  // AC3: a real post-push cache failure is also an uncertain publish, not just an injected lost acknowledgement.
  test("recovers a remote publication when its local cache update throws", async () => {
    const fixture = await createRemoteRepos()
    try {
      const shell = createShellBackend()
      const hook = join(fixture.left, "hooks", "reference-transaction")
      let cacheFailure: unknown
      const backend: GitomicBackend = {
        ...shell,
        async compareAndSwapRemote(...args) {
          await writeFile(
            hook,
            '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/main ]; then echo "cache update denied" >&2; exit 1; fi\ndone\n',
            { flag: "wx", mode: 0o755 },
          )
          try {
            return await shell.compareAndSwapRemote!(...args)
          } catch (error) {
            cacheFailure = error
            throw error
          } finally {
            await unlink(hook)
          }
        },
      }
      const store = await open({ repo: fixture.left, ref: "main", remote: "origin", backend })
      const update = vi.fn(async (map: GitMap) => {
        map.set("count", String(Number((await map.get("count")) ?? "0") + 1))
      })
      const result = await store.transact(update, "increment despite cache failure")
      expect(cacheFailure).toBeInstanceOf(Error)
      expect((cacheFailure as Error).message).toContain("cache update denied")
      expect(result).toEqual({ oid: await git(fixture.remote, "rev-parse", "main"), retries: 0 })
      expect(update).toHaveBeenCalledTimes(1)
      expect(await store.head()).toBe(result.oid)
      expect(await store.at().get("count")).toBe("1")
    } finally {
      await fixture.cleanup()
    }
  })

  // AC3: absence of a receipt is uncertainty, and verification failure must not erase the publication cause.
  test.each(["no receipt", "refresh failure", "lookup failure", "undefined cause"])(
    "does not replay an uncertain publication: %s",
    async (failure) => {
      const fixture = await createRemoteRepos()
      try {
        const shell = createShellBackend()
        const publicationError = failure === "undefined cause" ? undefined : new Error("publication connection lost")
        const verificationError = new Error("receipt verification unavailable")
        let published = false
        const backend: GitomicBackend = {
          ...shell,
          async compareAndSwapRemote() {
            published = true
            throw publicationError
          },
          async fetchRemote(repo, ref, remote) {
            if (published && failure === "refresh failure") throw verificationError
            return shell.fetchRemote!(repo, ref, remote)
          },
          async findTransaction(...args) {
            if (failure === "lookup failure") throw verificationError
            return shell.findTransaction(...args)
          },
        }
        const store = await open({ repo: fixture.left, ref: "main", remote: "origin", backend })
        const update = vi.fn(async (map: GitMap) => {
          map.set("count", String(Number((await map.get("count")) ?? "0") + 1))
        })
        const outcome = store.transact(update, "uncertain increment")
        await expect(outcome).rejects.toThrow(/publication.*unknown/i)
        await expect(outcome).rejects.toThrow(/do not blindly retry/i)
        await expect(outcome).rejects.not.toBeInstanceOf(RetriesExhausted)
        if (failure === "refresh failure" || failure === "lookup failure") {
          await expect(outcome).rejects.toBeInstanceOf(AggregateError)
          await expect(outcome).rejects.toHaveProperty("errors", [publicationError, verificationError])
        } else {
          await expect(outcome).rejects.toHaveProperty("cause", publicationError)
        }
        expect(update).toHaveBeenCalledTimes(1)
        expect(await git(fixture.remote, "rev-parse", "main")).toBe(fixture.initial)
      } finally {
        await fixture.cleanup()
      }
    },
  )

  test("fetches through a transaction-private ref instead of shared FETCH_HEAD", async () => {
    const fixture = await createRemoteRepos()
    const previousTrace = process.env.GIT_TRACE2_EVENT
    try {
      const trace = join(fixture.left, "fetch-trace.json")
      process.env.GIT_TRACE2_EVENT = trace

      await open({ repo: fixture.left, ref: "main", writer: "fetch-isolation", remote: "origin" })

      const events = (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as TraceEvent)
      const fetch = events.find((event) => event.event === "start" && event.argv?.includes("fetch"))
      expect(fetch?.argv).toContain("--no-write-fetch-head")
      expect(
        fetch?.argv?.some((argument) => /^refs\/heads\/main:refs\/gitomic\/fetch\/[0-9a-f-]+$/.test(argument)),
      ).toBe(true)
      expect(await git(fixture.left, "for-each-ref", "refs/gitomic/fetch")).toBe("")
    } finally {
      if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT
      else process.env.GIT_TRACE2_EVENT = previousTrace
      await fixture.cleanup()
    }
  })

  test("replays a rejected lease on the origin winner without a merge", async () => {
    const fixture = await createRemoteRepos()
    try {
      const left = await open({
        repo: fixture.left,
        ref: "main",
        writer: "left",
        remote: "origin",
      })
      const right = await open({
        repo: fixture.right,
        ref: "main",
        writer: "right",
        remote: "origin",
      })
      const entered = deferred()
      const release = deferred()
      let leftAttempts = 0
      const losing = left.transact(async (map) => {
        leftAttempts += 1
        const count = Number((await map.get("count")) ?? "0")
        if (leftAttempts === 1) {
          entered.resolve()
          await release.promise
        }
        map.set("count", String(count + 1))
      }, "left increment")

      await entered.promise
      await right.transact(async (map) => {
        map.set("count", String(Number((await map.get("count")) ?? "0") + 1))
      }, "right increment")
      release.resolve()
      const leftResult = await losing

      expect(leftResult.retries).toBe(1)
      expect(leftAttempts).toBe(2)
      expect(await left.at().get("count")).toBe("2")
      expect(await git(fixture.remote, "show", "main:count")).toBe("2")
      const history = await git(fixture.remote, "rev-list", "--parents", "main")
      expect(
        history
          .split("\n")
          .slice(0, -1)
          .every((line) => line.split(" ").length === 2),
      ).toBe(true)
      expect(history.split("\n").at(-1)?.split(" ")).toHaveLength(1)
    } finally {
      await fixture.cleanup()
    }
  }, 30_000)

  test("propagates a remote policy rejection without replaying it as contention", async () => {
    const fixture = await createRemoteRepos()
    try {
      const store = await open({
        repo: fixture.left,
        ref: "main",
        writer: "policy-test",
        remote: "origin",
      })
      const hook = join(fixture.remote, "hooks", "pre-receive")
      await writeFile(hook, '#!/bin/sh\necho "policy denied" >&2\nexit 1\n', "utf8")
      await chmod(hook, 0o755)
      let attempts = 0

      await expect(
        store.transact(async (map) => {
          attempts += 1
          map.set("blocked", "write")
        }, "blocked by policy"),
      ).rejects.toThrow("policy denied")
      expect(attempts).toBe(1)
    } finally {
      await fixture.cleanup()
    }
  })
})
