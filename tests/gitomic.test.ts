// @failure Public transactions could touch a checkout, lose multi-file atomicity, or expose stale reads.
// @level l1
// @consumer gitomic package users

import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, test } from "vitest"

import { createShellBackend, open } from "../src/index.js"
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
      const committed = await store.transact(
        async (map) => {
          map.set("notes/milk.md", "buy milk")
          map.set("index.md", ((await map.get("index.md")) ?? "") + "milk\n")
          expect(await map.has("notes/milk.md")).toBe(true)
        },
        "add note",
        {
          author: { name: "@dev/1", email: "dev1@localhost" },
          trailers: [
            ["Actor-Session", "session-a"],
            ["Actor-Generation", "7"],
          ],
        },
      )

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
      expect(body).not.toContain("Gitomic-Writer:")
      expect(body).not.toContain("Gitomic-Actor")
      expect(body).toContain("Actor-Session: session-a\nActor-Generation: 7\n")
      expect(body).toMatch(/Gitomic-Instance: [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n/)
      expect(body).toContain("Gitomic-Seq: 0")
      await expect(createShellBackend().readCommit(fixture.repo, committed.oid)).resolves.toMatchObject({
        author: { name: "@dev/1", email: "dev1@localhost" },
        trailers: [
          ["Actor-Session", "session-a"],
          ["Actor-Generation", "7"],
        ],
        provenance: null,
      })
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

  test("refuses legacy provenance at the public write boundary", async () => {
    const fixture = await createBareRepo()
    try {
      const store = await open({ repo: fixture.repo, ref: "main", writer: "executor" })
      let called = false
      await expect(
        store.transact(
          async (map) => {
            called = true
            map.set("must-not-write", "1")
          },
          "legacy attribution",
          {
            provenance: { actor: "actor", session: "session", generation: 1 },
          } as never,
        ),
      ).rejects.toThrow("ADR-0020")
      expect(called).toBe(false)
      expect(await store.head()).toBe(fixture.initial)
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

      const catFileStarts = async (): Promise<number> =>
        (await readFile(trace, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { event?: string; argv?: string[] })
          .filter((event) => event.event === "start" && event.argv?.includes("cat-file")).length
      const snapshot = store.at(committed.oid)
      // The listing alone answers keys: no blob is read for it.
      expect(await snapshot.keys()).toEqual(["first.md", "second.md"])
      expect(await catFileStarts()).toBe(0)
      // Two values asked for together are one cat-file --batch.
      expect(await Promise.all([snapshot.get("first.md"), snapshot.get("second.md")])).toEqual(["first", "second"])
      expect(await catFileStarts()).toBe(1)
    } finally {
      if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT
      else process.env.GIT_TRACE2_EVENT = previousTrace
      await fixture.cleanup()
    }
  })
})
