// @failure A test backend could weaken transaction semantics or emit histories that differ from real Git.
// @level l1
// @consumer gitomic unit tests and backend conformance

import { describe, expect, test } from "vitest"

import { open } from "../src/index.js"
import { createMemBackend } from "../src/mem.js"

describe("mem backend", () => {
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
  })

  test("lands 3 writers x 100 operations exactly once on one linear tip", async () => {
    const backend = createMemBackend()
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
    const tip = await writers[0]!.head()
    const commits = await Promise.all(
      ["writer-a", "writer-b", "writer-c"].flatMap((writer) =>
        Array.from({ length: 100 }, (_, index) => backend.findTransaction("stress", tip, writer, index + 1)),
      ),
    )
    expect(new Set(commits)).toHaveLength(300)
    expect(commits).not.toContain(undefined)
  }, 30_000)
})
