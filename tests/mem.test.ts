// @failure A test backend could weaken transaction semantics or emit histories that differ from real Git.
// @level l1
// @consumer gitomic unit tests and backend conformance

import { describe, expect, test } from "vitest"

import { open } from "../src/index.js"
import type { CommitInput, GitomicBackend } from "../src/index.js"
import { createMemBackend } from "../src/mem.js"

/** Record the receipt every transaction was written under, replays included. */
function recordReceipts(backend: GitomicBackend): {
  backend: GitomicBackend
  receipts: Array<Pick<CommitInput, "instance" | "seq">>
} {
  const receipts: Array<Pick<CommitInput, "instance" | "seq">> = []
  return {
    receipts,
    backend: {
      ...backend,
      writeCommit: async (repo, input) => {
        receipts.push({ instance: input.instance, seq: input.seq })
        return await backend.writeCommit(repo, input)
      },
    },
  }
}

describe("mem backend", () => {
  test("admits two live stores under one writer label and keeps their receipts apart", async () => {
    const memory = createMemBackend()
    const { backend, receipts } = recordReceipts(memory)
    const first = await open({ repo: "shared-label", ref: "main", writer: "worker-a", backend })
    const second = await open({ repo: "shared-label", ref: "main", writer: "worker-a", backend })

    await first.transact(async (map) => map.set("first.txt", "one\n"), "first store writes")
    await second.transact(async (map) => map.set("second.txt", "two\n"), "second store writes")

    expect(new Set(receipts.map((receipt) => receipt.instance))).toHaveLength(2)
    expect(receipts.map((receipt) => receipt.seq)).toEqual([0, 0])
    expect(await first.at().keys()).toEqual(["first.txt", "second.txt"])
  })

  test("runs without a repository or git process and emits real Git object ids", async () => {
    const backend = createMemBackend()
    const store = await open({ repo: "unit-test", ref: "main", writer: "worker-a", backend })
    const initial = await store.head()

    expect(initial).toMatch(/^[0-9a-f]{40}$/)
    expect(await store.at().keys()).toEqual([])
    const committed = await store.transact(async (map) => {
      map.set("hello.txt", "hello\n")
    }, "say hello")

    expect(committed.oid).toMatch(/^[0-9a-f]{40}$/)
    expect(committed.oid).not.toBe(initial)
    expect(await store.at(committed.oid).get("hello.txt")).toBe("hello\n")
    await expect(backend.readFiles("unit-test", committed.oid, "hello")).resolves.toEqual(
      new Map([["hello.txt", "hello\n"]]),
    )
    await expect(backend.readFiles("unit-test", committed.oid, "missing/")).rejects.toThrow(
      /prefix "missing\/" matched no files.+repository "unit-test".+commit/iu,
    )
  })

  test("lands 3 writers x 100 operations exactly once on one linear tip", async () => {
    const memory = createMemBackend()
    const { backend, receipts } = recordReceipts(memory)
    const initial = await memory.head("stress", "refs/heads/main")
    const writers = await Promise.all(
      ["writer-a", "writer-b", "writer-c"].map((writer) => open({ repo: "stress", ref: "main", writer, backend })),
    )

    await Promise.all(
      writers.flatMap((store, writerIndex) =>
        Array.from({ length: 100 }, (_, operationIndex) =>
          store.transact(async (map) => {
            const count = Number((await map.get("count")) ?? "0")
            map.set("count", String(count + 1))
            map.set(`operations/${writerIndex}/${operationIndex}`, "landed")
          }, `operation ${operationIndex}`),
        ),
      ),
    )

    const snapshot = writers[0]!.at()
    expect(await snapshot.get("count")).toBe("300")
    expect(await snapshot.keys("operations/")).toHaveLength(300)
    const distinct = [...new Map(receipts.map((receipt) => [`${receipt.instance}:${receipt.seq}`, receipt])).values()]
    expect(distinct).toHaveLength(300)
    expect(new Set(distinct.map((receipt) => receipt.instance))).toHaveLength(3)
    const tip = await writers[0]!.head()
    const commits = await Promise.all(
      distinct.map((receipt) => backend.findTransaction("stress", tip, initial, receipt.instance, receipt.seq)),
    )
    expect(new Set(commits)).toHaveLength(300)
    expect(commits).not.toContain(undefined)
  }, 30_000)

  test("fails loudly when a receipt search runs past its horizon without reaching its base", async () => {
    const backend = createMemBackend()
    const initial = await backend.head("receipt-horizon", "refs/heads/main")
    const store = await open({ repo: "receipt-horizon", ref: "main", writer: "history-writer", backend })
    for (let index = 0; index < 1_025; index += 1) {
      await store.transact(async (map) => map.set("count", String(index + 1)), `history ${index + 1}`)
    }

    await expect(
      backend.findTransaction("receipt-horizon", await store.head(), initial, "missing-instance", 1),
    ).rejects.toThrow("exceeded 1024 first-parent commits")
  })

  test("stops a receipt search at its base instead of walking older history", async () => {
    const backend = createMemBackend()
    const store = await open({ repo: "receipt-base", ref: "main", writer: "history-writer", backend })
    for (let index = 0; index < 1_025; index += 1) {
      await store.transact(async (map) => map.set("count", String(index + 1)), `history ${index + 1}`)
    }
    const tip = await store.head()

    await expect(backend.findTransaction("receipt-base", tip, tip, "missing-instance", 1)).resolves.toBeUndefined()
  })
})
