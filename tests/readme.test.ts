// @failure The documented default could require a bare gitdir or mutate the user's checkout.
// @level l1
// @consumer README example users

import { access } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, test } from "vitest"

import { Conflict, open } from "../src/index.js"
import type { GitMap } from "../src/index.js"
import { createMemBackend } from "../src/mem.js"
import { createWorktreeRepo, gitFrom } from "./helpers/git.js"

describe("README example", () => {
  test("accepts any directory inside a checkout and writes only to Git objects", async () => {
    const fixture = await createWorktreeRepo()
    try {
      const store = await open({ repo: fixture.nested, ref: "main", writer: "worker-3" })
      const before = store.at()

      await store.transact(async (map) => {
        map.set("notes/milk.md", "buy milk")
        map.set("index.md", ((await map.get("index.md")) ?? "") + "milk\n")
      }, "add note")

      expect(await before.keys()).toEqual([])
      expect(await store.at().get("notes/milk.md")).toBe("buy milk")
      expect(await gitFrom(fixture.repo, "show", "main:notes/milk.md")).toBe("buy milk")
      await expect(access(join(fixture.repo, "notes", "milk.md"))).rejects.toMatchObject({ code: "ENOENT" })
      expect(await gitFrom(fixture.repo, "status", "--short")).toContain("notes/milk.md")
    } finally {
      await fixture.cleanup()
    }
  })

  test("defers an invalid commit failure until a pinned snapshot is read", async () => {
    const fixture = await createWorktreeRepo()
    try {
      const store = await open({ repo: fixture.repo, ref: "main", writer: "worker-3" })
      const invalid = store.at("0000000000000000000000000000000000000000")
      await expect(invalid.keys()).rejects.toThrow()
    } finally {
      await fixture.cleanup()
    }
  })

  test("runs the archive loop as one atomic move", async () => {
    const store = await open({
      repo: "readme-archive",
      ref: "main",
      writer: "worker-3",
      backend: createMemBackend(),
    })
    await store.transact(async (map) => {
      map.set("inbox/one.md", "one")
      map.set("inbox/two.md", "two")
      map.set("archive/two.md", "already archived")
    }, "seed inbox")

    await store.transact(async (map) => {
      for (const path of await map.keys("inbox/")) {
        const dest = path.replace("inbox/", "archive/")
        if (await map.has(dest)) continue
        const content = await map.get(path)
        if (content === undefined) throw new Conflict(`missing ${path}`)
        map.set(dest, content)
        map.delete(path)
      }
    }, "archive inbox")

    expect(await store.at().get("archive/one.md")).toBe("one")
    expect(await store.at().get("archive/two.md")).toBe("already archived")
    expect(await store.at().get("inbox/one.md")).toBeUndefined()
    expect(await store.at().get("inbox/two.md")).toBe("two")
  })

  test("runs the deploy-lock Conflict demo with exactly one winner", async () => {
    const backend = createMemBackend()
    const workers = await Promise.all(
      ["worker-3", "worker-4"].map((writer) => open({ repo: "readme-lock", ref: "main", writer, backend })),
    )
    const takeLock =
      (worker: string) =>
      async (map: GitMap): Promise<void> => {
        const owner = await map.get("locks/deploy")
        if (owner && owner !== worker) throw new Conflict(`taken by ${owner}`)
        map.set("locks/deploy", worker)
      }

    const results = await Promise.allSettled([
      workers[0]!.transact(takeLock("worker-3"), "take deploy lock"),
      workers[1]!.transact(takeLock("worker-4"), "take deploy lock"),
    ])

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    const rejected = results.find((result) => result.status === "rejected")
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(Conflict)
    expect(["worker-3", "worker-4"]).toContain(await workers[0]!.at().get("locks/deploy"))
  })
})
