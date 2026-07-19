// @failure Malformed identity, retry exhaustion, or unusual Git paths could corrupt deduplication or escape CAS semantics.
// @level l1
// @consumer all gitomic callers

import { describe, expect, test } from "vitest"

import { open, RetriesExhausted } from "../src/index.js"
import type { GitomicBackend } from "../src/index.js"
import { createMemBackend } from "../src/mem.js"
import { createBareRepo } from "./helpers/git.js"

describe("public contract guards", () => {
  test("rejects a writer that could forge commit trailers", async () => {
    const backend = createMemBackend()
    await expect(open({ repo: "bad-writer", ref: "main", writer: "worker\nGitomic-Seq: 9", backend })).rejects.toThrow(
      TypeError,
    )
  })

  test("bounds retries and reports the observed CAS failures", async () => {
    const mem = createMemBackend()
    const backend: GitomicBackend = { ...mem, compareAndSwap: async () => false }
    const store = await open({
      repo: "retry-limit",
      ref: "main",
      writer: "worker",
      backend,
    })
    let attempts = 0

    const result = store.transact(async (map) => {
      attempts += 1
      map.set("value", String(attempts))
    }, "never lands")

    await expect(result).rejects.toMatchObject({ name: "RetriesExhausted", retries: 10 })
    await expect(result).rejects.toBeInstanceOf(RetriesExhausted)
    expect(attempts).toBe(10)
  })

  test("queues same-store calls and assigns each writer sequence exactly once", async () => {
    const backend = createMemBackend()
    const store = await open({ repo: "local-queue", ref: "main", writer: "one-writer", backend })

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.transact(async (map) => {
          map.set(`operations/${index}`, "done")
          map.set("count", String(Number((await map.get("count")) ?? "0") + 1))
        }, `operation ${index}`),
      ),
    )

    expect(await store.at().get("count")).toBe("20")
    expect(await store.at().keys("operations/")).toHaveLength(20)
    const tip = await store.head()
    const commits = await Promise.all(
      Array.from({ length: 20 }, (_, index) => backend.findTransaction("local-queue", tip, "one-writer", index + 1)),
    )
    expect(new Set(commits)).toHaveLength(20)
  })

  test("round-trips and deletes Git-valid tabs and newlines in a path", async () => {
    const fixture = await createBareRepo()
    try {
      const store = await open({ repo: fixture.repo, ref: "main", writer: "worker" })
      const path = "unusual/tab\tand\nnewline.txt"
      await store.transact(async (map) => map.set(path, "content"), "add unusual path")
      expect(await store.at().get(path)).toBe("content")
      await store.transact(async (map) => map.delete(path), "delete unusual path")
      expect(await store.at().has(path)).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })
})
