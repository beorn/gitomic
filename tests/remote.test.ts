// @failure Separate repositories could overwrite an origin winner instead of replaying under its ref lock.
// @level l1
// @consumer remote-arbitrated gitomic writers

import { describe, expect, test, vi } from "vitest"
import fs from "node:fs"
import { chmod, readFile, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { createShellBackend, open, openReader, openRemoteRepository, RetriesExhausted } from "../src/index.js"
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
      const repository = openRemoteRepository(source)
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

  test("failed clone cleans its allocation and preserves a simultaneous cleanup failure", async () => {
    const fixture = await createBareRepo()
    const source = pathToFileURL(join(fixture.repo, "missing.git")).href
    const remove = vi.spyOn(fs, "rmSync")
    try {
      expect(() => openRemoteRepository(source)).toThrow(/git clone/)
      const firstParent = String(remove.mock.calls[0]?.[0])
      expect(firstParent).not.toBe("undefined")
      expect(fs.existsSync(firstParent)).toBe(false)

      const cleanupFailure = new Error("cleanup permission denied")
      remove.mockImplementationOnce(() => {
        throw cleanupFailure
      })
      let observed: unknown
      try {
        openRemoteRepository(source)
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
      const repository = openRemoteRepository(fixture.repo)
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
  // AC2: mocked remote reads cannot detect shell.fetchRemote rewinding an ahead application ref.
  test.each(["caller-owned", "URL-owned"])(
    "reader preserves an unpublished %s branch while observing origin",
    async (kind) => {
      const fixture = await createRemoteRepos()
      const repository = kind === "URL-owned" ? openRemoteRepository(pathToFileURL(fixture.remote).href) : undefined
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
            const landed = await shell.compareAndSwapRemote!(repo, ref, next, expected, remote)
            if (!landed) return false
            landedOid = next
            await other.transact(async (map) => map.set("later", "winner"), "advance after receipt")
            if (acknowledgement === "throw") throw new Error("accepted; acknowledgement lost")
            return false
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
