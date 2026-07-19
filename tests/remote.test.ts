// @failure Separate repositories could overwrite an origin winner instead of replaying under its ref lock.
// @level l1
// @consumer remote-arbitrated gitomic writers

import { describe, expect, test } from "vitest"

import { open } from "../src/index.js"
import { createRemoteRepos, git } from "./helpers/git.js"

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("remote arbitration", () => {
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
})
