// @failure Separate repositories could overwrite an origin winner instead of replaying under its ref lock.
// @level l1
// @consumer remote-arbitrated gitomic writers

import { describe, expect, test, vi } from "vitest"
import fs from "node:fs"
import { chmod, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

import { open, openReader, openRemoteRepository } from "../src/index.js"
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
