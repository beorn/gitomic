// @failure CAS races could clobber a winner, create merge commits, or double-apply an acknowledged write.
// @level l1
// @consumer concurrent gitomic writers

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

import { Conflict, createShellBackend, open } from "../src/index.js"
import type { GitomicBackend } from "../src/index.js"
import { createBareRepo, git } from "./helpers/git.js"

const crashBeforePublish = fileURLToPath(new URL("fixtures/crash-before-publish.ts", import.meta.url))
const writerOpen = fileURLToPath(new URL("fixtures/writer-open.ts", import.meta.url))

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitForLine(child: ReturnType<typeof spawn>): Promise<string> {
  return await new Promise<string>((resolveLine, rejectLine) => {
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => rejectLine(new Error(`child did not reach crash point: ${stderr}`)), 10_000)
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk
      const newline = stdout.indexOf("\n")
      if (newline < 0) return
      clearTimeout(timer)
      resolveLine(stdout.slice(0, newline))
    })
    child.once("error", (error) => {
      clearTimeout(timer)
      rejectLine(error)
    })
    child.once("exit", (code) => {
      if (stdout.includes("\n")) return
      clearTimeout(timer)
      rejectLine(new Error(`child exited ${code ?? 1} before crash point: ${stderr}`))
    })
  })
}

async function runChild(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn("bun", args, { stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk
  })
  const code = await new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit)
    child.once("close", (exitCode) => resolveExit(exitCode ?? 1))
  })
  return { code, stdout, stderr }
}

describe("semantic CAS replay", () => {
  test("replays a loser on the winner and surfaces a semantic delete conflict", async () => {
    const fixture = await createBareRepo()
    try {
      const seed = await open({ repo: fixture.repo, ref: "main", writer: "seed" })
      await seed.transact(async (map) => map.set("claims/one", "open"), "seed claim")

      const entered = deferred()
      const release = deferred()
      let attempts = 0
      const writerA = await open({ repo: fixture.repo, ref: "main", writer: "writer-a" })
      const writerB = await open({ repo: fixture.repo, ref: "main", writer: "writer-b" })
      const losing = writerA.transact(async (map) => {
        attempts += 1
        const value = await map.get("claims/one")
        if (value === undefined) throw new Conflict("claim was deleted")
        if (attempts === 1) {
          entered.resolve()
          await release.promise
        }
        map.set("claims/one", `${value}+writer-a`)
      }, "extend claim")

      await entered.promise
      await writerB.transact(async (map) => map.delete("claims/one"), "delete claim")
      release.resolve()

      await expect(losing).rejects.toThrow(Conflict)
      expect(attempts).toBe(2)
      expect(await writerA.at().has("claims/one")).toBe(false)
      expect(await git(fixture.repo, "rev-list", "--count", "main")).toBe("3")
      expect(await git(fixture.repo, "log", "--format=%s", "main")).not.toContain("extend claim")
    } finally {
      await fixture.cleanup()
    }
  })

  test.each(["false", "throw"])(
    "recognizes a landed local transaction after a %s acknowledgement",
    async (acknowledgement) => {
      const fixture = await createBareRepo()
      try {
        const shell = createShellBackend()
        let hideFirstAcknowledgement = true
        const backend: GitomicBackend = {
          ...shell,
          async compareAndSwap(repo, ref, next, expected) {
            const landed = await shell.compareAndSwap(repo, ref, next, expected)
            if (landed && hideFirstAcknowledgement) {
              hideFirstAcknowledgement = false
              if (acknowledgement === "throw") throw new Error("local CAS acknowledgement lost")
              return false
            }
            return landed
          },
        }
        const store = await open({
          repo: fixture.repo,
          ref: "main",
          writer: "writer-a",
          backend,
        })

        let updates = 0
        const result = await store.transact(async (map) => {
          updates += 1
          map.set("count", String(Number((await map.get("count")) ?? "0") + 1))
        }, "deduplicate me")

        expect(result.retries).toBe(acknowledgement === "false" ? 1 : 0)
        expect(result.oid).toBe(await store.head())
        expect(updates).toBe(1)
        expect(await store.at().get("count")).toBe("1")
        expect(await git(fixture.repo, "rev-list", "--count", "main")).toBe("2")
        const operations = await git(fixture.repo, "log", "--format=%(trailers:key=Gitomic-Seq,valueonly)", "main")
        expect(operations.split("\n").filter((line) => line === "0")).toHaveLength(1)
      } finally {
        await fixture.cleanup()
      }
    },
  )

  test("carries an unpublished commit through a default gc without writing a ref to protect it", async () => {
    const fixture = await createBareRepo()
    try {
      const shell = createShellBackend()
      let inspected = false
      const backend: GitomicBackend = {
        ...shell,
        async compareAndSwap(repo, ref, next, expected) {
          // Mid-flight: the commit exists but nothing references it.
          expect(await git(repo, "for-each-ref", "refs/gitomic")).toBe("")
          // Default gc grace is 2 weeks, so a commit written milliseconds ago survives.
          await git(repo, "gc", "--quiet")
          expect(await git(repo, "cat-file", "-t", next)).toBe("commit")
          inspected = true
          return await shell.compareAndSwap(repo, ref, next, expected)
        },
      }
      const store = await open({ repo: fixture.repo, ref: "main", writer: "gc-window-writer", backend })

      const committed = await store.transact(async (map) => map.set("value", "survived"), "survive a default gc")

      expect(inspected).toBe(true)
      expect(await git(fixture.repo, "cat-file", "-t", committed.oid)).toBe("commit")
      expect(await store.at().get("value")).toBe("survived")
      expect(await git(fixture.repo, "for-each-ref", "refs/gitomic")).toBe("")
    } finally {
      await fixture.cleanup()
    }
  }, 30_000)

  test("fails loudly, not silently, if an aggressive prune reclaims a commit mid-flight", async () => {
    // This is the RESIDUAL RISK of writing no pin ref, asserted rather than
    // assumed: `--prune=now` concurrent with a transaction can reclaim the
    // unreferenced commit. The contract is that the publish then refuses —
    // it must never move the ref to a missing object. If gitomic ever pins
    // again, this test should be replaced, not deleted quietly.
    const fixture = await createBareRepo()
    try {
      const shell = createShellBackend()
      const backend: GitomicBackend = {
        ...shell,
        async compareAndSwap(repo, ref, next, expected) {
          await git(repo, "prune", "--expire=now")
          return await shell.compareAndSwap(repo, ref, next, expected)
        },
      }
      const store = await open({ repo: fixture.repo, ref: "main", writer: "pruned-writer", backend })

      await expect(store.transact(async (map) => map.set("value", "pruned"), "pruned mid-flight")).rejects.toThrow(
        /nonexistent object/u,
      )
      expect(await git(fixture.repo, "rev-parse", "main")).toBe(fixture.initial)
    } finally {
      await fixture.cleanup()
    }
  }, 30_000)

  test("leaves no trace behind when a writer is hard-killed before publishing", async () => {
    const fixture = await createBareRepo()
    const child = spawn("bun", [crashBeforePublish, fixture.repo], { stdio: ["ignore", "pipe", "pipe"] })
    try {
      const line = await waitForLine(child)
      const { next } = JSON.parse(line) as { next: string }

      child.kill("SIGKILL")
      await new Promise<void>((resolveExit) => child.once("close", () => resolveExit()))

      // The killed process left no ref and no tree entry to clean up, and the
      // public ref never moved.
      expect(await git(fixture.repo, "for-each-ref", "refs/gitomic")).toBe("")
      expect(await git(fixture.repo, "rev-parse", "main")).toBe(fixture.initial)
      // Its unreferenced commit still survives a default gc, so a supervisor can
      // still inspect what the dead writer had built.
      await git(fixture.repo, "gc", "--quiet")
      expect(await git(fixture.repo, "cat-file", "-t", next)).toBe("commit")
      expect(await git(fixture.repo, "show", `${next}:crash/value`)).toBe("still reachable")
    } finally {
      child.kill("SIGKILL")
      await fixture.cleanup()
    }
  }, 30_000)

  test("lands both processes that share one writer label, each under its own identity", async () => {
    const fixture = await createBareRepo()
    const holding = spawn("bun", [writerOpen, fixture.repo, "one-role", "hold"], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    try {
      expect(await waitForLine(holding)).toBe("opened")

      // No lease, so a second live process under the same label is admitted…
      const concurrent = await runChild([writerOpen, fixture.repo, "one-role", "write"])
      expect(concurrent).toMatchObject({ code: 0 })
      // …and so is a successor after the first is hard-killed, with no stale
      // record to reclaim and no recycled pid to misjudge.
      holding.kill("SIGKILL")
      await new Promise<void>((resolveExit) => holding.once("close", () => resolveExit()))
      const successor = await runChild([writerOpen, fixture.repo, "one-role", "write"])
      expect(successor).toMatchObject({ code: 0 })

      expect(await git(fixture.repo, "for-each-ref", "refs/gitomic/writers")).toBe("")
      const body = await git(fixture.repo, "log", "--format=%B%x00", "main")
      const receipts = body
        .split("\0")
        .map((message) => /Gitomic-Instance: ([^\n]+)\nGitomic-Seq: (\d+)/.exec(message))
        .filter((match): match is RegExpExecArray => match !== null)
      // Same label, same sequence number, different identities: no collision.
      expect(receipts).toHaveLength(2)
      expect(new Set(receipts.map((match) => match[1]))).toHaveLength(2)
      expect(receipts.map((match) => match[2])).toEqual(["0", "0"])
      expect(await git(fixture.repo, "log", "--format=%s", "main")).toContain("one-role: concurrent write")
    } finally {
      holding.kill("SIGKILL")
      await fixture.cleanup()
    }
  }, 30_000)

  test("keeps the reserved tree namespace empty of gitomic's own bookkeeping", async () => {
    const fixture = await createBareRepo()
    try {
      const store = await open({ repo: fixture.repo, ref: "main", writer: "bookkeeping-free" })

      await store.transact(async (map) => map.set("value", "one"), "first write")
      await store.transact(async (map) => map.set("value", "two"), "second write")

      // Identity lives in the commit message; nothing rides in the tree.
      expect(await git(fixture.repo, "ls-tree", "-r", "--name-only", "main")).toBe("value")
      expect(await store.at().keys()).toEqual(["value"])
    } finally {
      await fixture.cleanup()
    }
  })

  test("keeps concurrent writers strictly linear with every increment exactly once", async () => {
    const fixture = await createBareRepo()
    try {
      const writers = await Promise.all(
        ["writer-a", "writer-b", "writer-c"].map((writer) => open({ repo: fixture.repo, ref: "main", writer })),
      )

      await Promise.all(
        writers.flatMap((store) =>
          Array.from({ length: 3 }, (_, index) =>
            store.transact(
              async (map) => {
                const count = Number((await map.get("count")) ?? "0")
                map.set("count", String(count + 1))
              },
              `increment ${index + 1}`,
            ),
          ),
        ),
      )

      expect(await writers[0]!.at().get("count")).toBe("9")
      expect(await git(fixture.repo, "rev-list", "--count", "main")).toBe("10")
      const history = await git(fixture.repo, "rev-list", "--parents", "main")
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
})
