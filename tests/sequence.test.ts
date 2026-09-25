/**
 * @failure  A refused middle step leaks edits, or a multi-commit sequence publishes more than once.
 * @level    l2
 * @consumer 25694 grouped state mutation publication
 * @testonly none
 */
import { describe, expect, test, vi } from "vitest"
import { open } from "../src/index.js"
import { createMemBackend } from "../src/mem.js"

describe("Store.transactSequence", () => {
  test("keeps each accepted step, discards a refused step, and publishes once", async () => {
    const backend = createMemBackend()
    const publish = vi.spyOn(backend, "publish")
    const store = await open({ repo: "sequence-steps", ref: "main", backend, writer: "sequence" })
    const start = await store.head()
    const landed = await store.transactSequence(
      async (attempt) => {
        const first = await attempt.step(async (map) => map.set("one.md", "one"), "first")
        let refusedBase: string | undefined
        try {
          await attempt.step(async (map) => map.set("discard.md", "discard"), "refused", {
            candidate: async ({ base }) => {
              refusedBase = base
              return { refuse: ["refused"] }
            },
          })
        } catch (error) {
          expect(error).toMatchObject({ name: "CandidateRefused" })
        }
        const third = await attempt.step(async (map, base) => {
          expect(base).toBe(first.oid)
          expect(await map.get("discard.md")).toBeUndefined()
          map.set("three.md", "three")
        }, "third")
        return { first, third, refusedBase }
      },
      { beside: ({ next }) => [{ ref: "refs/sequence/log", expect: null, oid: next }] },
    )
    expect(landed.value.first.committed).toBe(true)
    expect(landed.value.third.committed).toBe(true)
    expect(landed.value.refusedBase).toBe(landed.value.first.oid)
    expect(landed.oid).toBe(landed.value.third.oid)
    expect((await backend.readCommit("sequence-steps", landed.value.first.oid)).parent).toBe(start)
    expect((await backend.readCommit("sequence-steps", landed.oid)).parent).toBe(landed.value.first.oid)
    expect(await store.at(landed.oid).get("discard.md")).toBeUndefined()
    expect(await store.at(landed.oid).get("one.md")).toBe("one")
    expect(await store.at(landed.oid).get("three.md")).toBe("three")
    expect(publish).toHaveBeenCalledTimes(1)
  })
})
