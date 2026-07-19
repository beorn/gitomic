// @failure CAS races could clobber a winner, create merge commits, or double-apply an acknowledged write.
// @level l1
// @consumer concurrent gitomic writers

import { describe, expect, test } from "vitest"

import { Conflict, createShellBackend, open } from "../src/index.js"
import type { GitomicBackend } from "../src/index.js"
import { createBareRepo, git } from "./helpers/git.js"

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
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

  test("recognizes an acknowledged transaction when the CAS result is lost", async () => {
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

      const result = await store.transact(async (map) => map.set("once", "only once"), "deduplicate me")

      expect(result.retries).toBe(1)
      expect(result.oid).toBe(await store.head())
      expect(await store.at().get("once")).toBe("only once")
      expect(await git(fixture.repo, "rev-list", "--count", "main")).toBe("2")
      const operations = await git(fixture.repo, "log", "--format=%(trailers:key=Gitomic-Seq,valueonly)", "main")
      expect(operations.split("\n").filter((line) => line === "1")).toHaveLength(1)
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
