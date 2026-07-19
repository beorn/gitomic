// @failure Public transactions could touch a checkout, lose multi-file atomicity, or expose stale reads.
// @level l1
// @consumer gitomic package users

import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, test } from "vitest"

import { open } from "../src/index.js"
import { createBareRepo, git } from "./helpers/git.js"

describe("gitomic public transaction contract", () => {
  test("lands a multi-path update object-side and returns a pinned snapshot", async () => {
    const fixture = await createBareRepo()
    try {
      const store = await open({
        repo: fixture.repo,
        ref: "main",
        writer: "worker-a",
      })

      expect(await store.head()).toBe(fixture.initial)
      const committed = await store.transact(async (map) => {
        map.set("notes/milk.md", "buy milk")
        map.set("index.md", ((await map.get("index.md")) ?? "") + "milk\n")
        expect(await map.has("notes/milk.md")).toBe(true)
      }, "add note")

      expect(committed).toEqual({ oid: await store.head(), retries: 0 })
      const snapshot = store.at(committed.oid)
      expect(await snapshot.get("notes/milk.md")).toBe("buy milk")
      expect(await snapshot.get("index.md")).toBe("milk\n")
      expect(await snapshot.keys()).toEqual(["index.md", "notes/milk.md"])
      expect(await snapshot.keys("notes/")).toEqual(["notes/milk.md"])

      const parents = await git(fixture.repo, "show", "-s", "--format=%P", committed.oid)
      expect(parents).toBe(fixture.initial)
      const body = await git(fixture.repo, "show", "-s", "--format=%B", committed.oid)
      expect(body).toContain("worker-a: add note")
      expect(body).toContain("Gitomic-Writer: worker-a")
      expect(body).toContain("Gitomic-Seq: 1")
    } finally {
      await fixture.cleanup()
    }
  })

  test("returns the current oid without committing an empty overlay", async () => {
    const fixture = await createBareRepo()
    try {
      const store = await open({ repo: fixture.repo, ref: "main", writer: "worker-a" })
      const result = await store.transact(async (map) => {
        expect(await map.keys()).toEqual([])
      }, "inspect only")

      expect(result).toEqual({ oid: fixture.initial, retries: 0 })
      expect(await git(fixture.repo, "rev-list", "--count", "main")).toBe("1")
    } finally {
      await fixture.cleanup()
    }
  })

  test("batches object reads into one cat-file process per snapshot", async () => {
    const fixture = await createBareRepo()
    const previousTrace = process.env.GIT_TRACE2_EVENT
    try {
      const store = await open({ repo: fixture.repo, ref: "main", writer: "worker-a" })
      const committed = await store.transact(async (map) => {
        map.set("first.md", "first")
        map.set("second.md", "second")
      }, "add two files")
      const trace = join(fixture.repo, "gitomic-trace.json")
      process.env.GIT_TRACE2_EVENT = trace

      expect(await store.at(committed.oid).keys()).toEqual(["first.md", "second.md"])

      const events = (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event?: string; argv?: string[] })
      const catFileStarts = events.filter((event) => event.event === "start" && event.argv?.includes("cat-file"))
      expect(catFileStarts).toHaveLength(1)
    } finally {
      if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT
      else process.env.GIT_TRACE2_EVENT = previousTrace
      await fixture.cleanup()
    }
  })
})
