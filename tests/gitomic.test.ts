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
      expect(body).toMatch(/Gitomic-Instance: [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n/)
      expect(body).toContain("Gitomic-Seq: 0")
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

  test("records each explicit per-call provenance on one reused store", async () => {
    const fixture = await createBareRepo()
    try {
      const store = await open({ repo: fixture.repo, ref: "main", writer: "executor" })
      const first = await store.transact(async (map) => map.set("first", "1"), "first original actor", {
        provenance: {
          actor: "actor-a",
          session: "0198b5e8-cdd2-7a63-8a81-2fdc8144e6a4",
          generation: 7,
          run: "run-a",
        },
      })
      const second = await store.transact(async (map) => map.set("second", "2"), "second original actor", {
        provenance: {
          actor: "actor-b",
          session: "0198b5e8-cdd2-7a63-8a81-2fdc8144e6a5",
          generation: 8,
        },
      })
      const backend = createShellBackend()

      await expect(backend.readCommit(fixture.repo, first.oid)).resolves.toMatchObject({
        writer: "executor",
        provenance: {
          actor: "actor-a",
          session: "0198b5e8-cdd2-7a63-8a81-2fdc8144e6a4",
          generation: 7,
          run: "run-a",
        },
      })
      await expect(backend.readCommit(fixture.repo, second.oid)).resolves.toMatchObject({
        writer: "executor",
        provenance: {
          actor: "actor-b",
          session: "0198b5e8-cdd2-7a63-8a81-2fdc8144e6a5",
          generation: 8,
        },
      })
    } finally {
      await fixture.cleanup()
    }
  })

  test("captures queued-call provenance when the public transaction is submitted", async () => {
    const fixture = await createBareRepo()
    try {
      const store = await open({ repo: fixture.repo, ref: "main", writer: "executor" })
      let releaseFirst: (() => void) | undefined
      let enteredFirst: (() => void) | undefined
      const firstEntered = new Promise<void>((resolve) => {
        enteredFirst = resolve
      })
      const first = store.transact(async (map) => {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
          enteredFirst?.()
        })
        map.set("first", "1")
      }, "hold the queue")
      await firstEntered

      const provenance = {
        actor: "actor-a",
        session: "0198b5e8-cdd2-7a63-8a81-2fdc8144e6a4",
        generation: 7,
      }
      const second = store.transact(async (map) => map.set("second", "1"), "capture at public entry", { provenance })
      provenance.actor = "actor-b"
      if (releaseFirst === undefined) throw new Error("first transaction did not reach its queue barrier")
      releaseFirst()

      const [, committed] = await Promise.all([first, second])
      await expect(createShellBackend().readCommit(fixture.repo, committed.oid)).resolves.toMatchObject({
        provenance: { actor: "actor-a", session: provenance.session, generation: provenance.generation },
      })
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
