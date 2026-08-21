// @failure Malformed identity, retry exhaustion, or unusual Git paths could corrupt deduplication or escape CAS semantics.
// @level l1
// @consumer all gitomic callers

import { describe, expect, test } from "vitest"

import { open, RetriesExhausted } from "../src/index.js"
import type { CommitInput, GitomicBackend } from "../src/index.js"
import { createMemBackend } from "../src/mem.js"
import { createBareRepo } from "./helpers/git.js"

describe("public contract guards", () => {
  test("rejects invalid ref syntax before it reaches a backend protocol", async () => {
    await expect(
      open({
        repo: "bad-ref",
        ref: "main\nprepare\ncommit",
        writer: "worker",
        backend: createMemBackend(),
      }),
    ).rejects.toThrow("invalid Git ref")
  })

  test("reserves Gitomic's internal ref namespace from public stores", async () => {
    await expect(
      open({
        repo: "reserved-ref",
        ref: "refs/gitomic/inflight/public-collision",
        writer: "worker",
        backend: createMemBackend(),
      }),
    ).rejects.toThrow("refs/gitomic/ is reserved")
  })

  test("rejects a writer that could forge commit trailers", async () => {
    const backend = createMemBackend()
    await expect(open({ repo: "bad-writer", ref: "main", writer: "worker\nGitomic-Seq: 9", backend })).rejects.toThrow(
      TypeError,
    )
  })

  test("opens without a writer label and still names itself in the audit trail", async () => {
    const mem = createMemBackend()
    let written: CommitInput | undefined
    const backend: GitomicBackend = {
      ...mem,
      writeCommit: async (repo, input) => {
        written = input
        return await mem.writeCommit(repo, input)
      },
    }
    const store = await open({ repo: "unlabelled", ref: "main", backend })

    await store.transact(async (map) => map.set("value", "one"), "write without a label")

    expect(written?.writer).toBe("gitomic")
    expect(written?.instance).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test("rejects commit messages Git cannot encode before a backend diverges", async () => {
    const backend = createMemBackend()
    const store = await open({ repo: "bad-message", ref: "main", writer: "worker", backend })

    await expect(store.transact(async (map) => map.set("value", "one"), "contains\0nul")).rejects.toThrow(
      "message cannot contain NUL",
    )
    await expect(store.transact(async (map) => map.set("value", "one"), "unpaired \ud800 surrogate")).rejects.toThrow(
      "valid UTF-8",
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

  test("queues same-store calls and assigns each sequence exactly once from zero", async () => {
    const mem = createMemBackend()
    const instances: string[] = []
    const backend: GitomicBackend = {
      ...mem,
      writeCommit: async (repo, input) => {
        instances.push(input.instance)
        return await mem.writeCommit(repo, input)
      },
    }
    const initial = await mem.head("local-queue", "refs/heads/main")
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
    const instance = instances[0]
    expect(instance).toBeDefined()
    expect(new Set(instances)).toEqual(new Set([instance]))
    const tip = await store.head()
    const commits = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        backend.findTransaction("local-queue", tip, initial, instance as string, index),
      ),
    )
    expect(new Set(commits)).toHaveLength(20)
    expect(commits).not.toContain(undefined)
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

  test("normalizes public paths and prefixes to NFC", async () => {
    const backend = createMemBackend()
    const store = await open({ repo: "normalized-paths", ref: "main", writer: "worker", backend })
    const decomposed = "notes/cafe\u0301.md"
    const composed = "notes/caf\u00e9.md"

    await store.transact(async (map) => map.set(decomposed, "canonical"), "write normalized path")

    expect(await store.at().get(decomposed)).toBe("canonical")
    expect(await store.at().has(composed)).toBe(true)
    expect(await store.at().keys("notes/cafe\u0301")).toEqual([composed])

    await store.transact(async (map) => map.delete(decomposed), "delete normalized path")
    expect(await store.at().has(composed)).toBe(false)
  })

  test("rejects strings that cannot round-trip through UTF-8", async () => {
    const backend = createMemBackend()
    const store = await open({ repo: "invalid-utf8-string", ref: "main", writer: "worker", backend })

    await expect(
      store.transact(async (map) => map.set("invalid.txt", "unpaired \ud800 surrogate"), "reject invalid string"),
    ).rejects.toThrow("valid UTF-8")
    await expect(
      store.transact(async (map) => map.set("invalid-\ud800.txt", "value"), "reject invalid path"),
    ).rejects.toThrow("valid UTF-8")
    await expect(open({ repo: "invalid-writer", ref: "main", writer: "worker-\ud800", backend })).rejects.toThrow(
      "valid UTF-8",
    )
    expect(await store.at().keys()).toEqual([])
  })

  test("rejects malformed and option-shaped object ids before Git plumbing", async () => {
    const backend = createMemBackend()
    const store = await open({ repo: "oid-guard", ref: "main", writer: "worker", backend })
    const edgeCases = [
      "",
      "0".repeat(39),
      "0".repeat(41),
      "0".repeat(63),
      "0".repeat(65),
      "A".repeat(40),
      "g".repeat(40),
      `-${"0".repeat(39)}`,
      `${"0".repeat(39)}\n`,
    ]
    let seed = 0x21553
    for (let index = 0; index < 128; index += 1) {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0
      const length = seed % 70
      const alphabet = "0123456789abcdefABCDEF-g \n"
      let value = ""
      for (let offset = 0; offset < length; offset += 1) {
        seed = (seed * 1_664_525 + 1_013_904_223) >>> 0
        value += alphabet[seed % alphabet.length]
      }
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) edgeCases.push(value)
    }

    for (const oid of edgeCases) {
      expect(() => store.at(oid), JSON.stringify(oid)).toThrow("invalid Git object id")
    }

    const invalidHead: GitomicBackend = { ...createMemBackend(), head: async () => "not-an-oid" }
    await expect(open({ repo: "invalid-head", ref: "main", writer: "worker", backend: invalidHead })).rejects.toThrow(
      "backend returned an invalid Git object id",
    )
  })
})
