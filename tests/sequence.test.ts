/**
 * @failure  A refused middle step leaks edits, or a multi-commit sequence publishes more than once.
 * @level    l2
 * @consumer 25694 grouped state mutation publication
 * @testonly none
 */
import { describe, expect, test, vi } from "vitest"
import { open } from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import { createMemBackend } from "../src/mem.js"
import { createShellBackend } from "../src/shell.js"
import type { GitomicBackend } from "../src/types.js"
import { createBareRepo } from "./helpers/git.js"

describe("Store.transactSequence", () => {
  test("shell, iso and mem keep three attributed steps in one publication", async () => {
    const shell = await createBareRepo()
    const iso = await createBareRepo()
    const targets: { repo: string; backend: GitomicBackend }[] = [
      { repo: shell.repo, backend: createShellBackend() },
      { repo: iso.repo, backend: createIsoBackend() },
      { repo: "sequence-parity-mem", backend: createMemBackend() },
    ]
    try {
      for (const { repo, backend } of targets) {
        const publish = vi.spyOn(backend, "publish")
        const store = await open({ repo, ref: "main", backend, writer: "sequence", clock: () => 1_700_000_000 })
        const parent = await store.head()
        const landed = await store.transactSequence(
          async (attempt) => {
            const steps = []
            for (let index = 1; index <= 3; index++) {
              steps.push(
                await attempt.step(async (map) => map.set(`step-${index}.md`, String(index)), `step ${index}`, {
                  author: { name: `Actor ${index}`, email: `actor${index}@example.test` },
                  provenance: { actor: `actor-${index}`, session: "sequence-test", generation: index },
                }),
              )
            }
            return steps
          },
          { beside: ({ next }) => [{ ref: "refs/sequence/parity", expect: null, oid: next }] },
        )
        expect(publish).toHaveBeenCalledTimes(1)
        let previous = parent
        for (const [index, step] of landed.value.entries()) {
          const meta = await backend.readCommit(repo, step.oid)
          expect(meta.parent).toBe(previous)
          expect(meta.author.name).toBe(`Actor ${index + 1}`)
          expect(meta.provenance?.actor).toBe(`actor-${index + 1}`)
          previous = step.oid
        }
        expect(landed.oid).toBe(previous)
      }
    } finally {
      await shell.cleanup()
      await iso.cleanup()
    }
  })
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

  test("a lost lease replays the whole chain with stable step receipts", async () => {
    const backend = createMemBackend()
    const repo = "sequence-replay"
    const store = await open({ repo, ref: "main", backend, writer: "sequence" })
    const rival = await open({ repo, ref: "main", backend, writer: "rival" })
    const attempts: string[][] = []
    let intruded = false
    const landed = await store.transactSequence(
      async (attempt) => {
        const first = await attempt.step(async (map) => map.set("one.md", "one"), "first")
        const second = await attempt.step(async (map) => map.set("two.md", "two"), "second")
        attempts.push([first.oid, second.oid])
        return { first, second }
      },
      {
        beside: async ({ next }) => {
          if (!intruded) {
            intruded = true
            await rival.transact(async (map) => map.set("rival.md", "rival"), "rival advances")
          }
          return [{ ref: "refs/sequence/replay", expect: null, oid: next }]
        },
      },
    )
    expect(landed.retries).toBe(1)
    expect(attempts).toHaveLength(2)
    const first = attempts[0]
    const replay = attempts[1]
    if (
      first === undefined ||
      replay === undefined ||
      first[0] === undefined ||
      first[1] === undefined ||
      replay[0] === undefined ||
      replay[1] === undefined
    ) {
      throw new Error("both attempts must write both commits")
    }
    expect((await backend.readCommit(repo, first[0])).seq).toBe((await backend.readCommit(repo, replay[0])).seq)
    expect((await backend.readCommit(repo, first[1])).seq).toBe((await backend.readCommit(repo, replay[1])).seq)
    expect(await store.at(landed.oid).get("rival.md")).toBe("rival")
    expect(await store.at(landed.oid).get("one.md")).toBe("one")
    expect(await store.at(landed.oid).get("two.md")).toBe("two")
  })

  test("a lost publication acknowledgement resolves the final receipt without replay", async () => {
    const backend = createMemBackend()
    let publications = 0
    const flaky: GitomicBackend = {
      ...backend,
      async publish(repo, updates, remote) {
        publications++
        await backend.publish?.(repo, updates, remote)
        throw new Error("acknowledgement lost")
      },
    }
    const store = await open({ repo: "sequence-unknown", ref: "main", backend: flaky, writer: "sequence" })
    let runs = 0
    const landed = await store.transactSequence(
      async (attempt) => {
        runs++
        await attempt.step(async (map) => map.set("one.md", "one"), "first")
        return attempt.step(async (map) => map.set("two.md", "two"), "second")
      },
      { beside: ({ next }) => [{ ref: "refs/sequence/unknown", expect: null, oid: next }] },
    )
    expect(publications).toBe(1)
    expect(runs).toBe(1)
    expect(landed.oid).toBe(await store.head())
    expect(await store.at(landed.oid).get("one.md")).toBe("one")
    expect(await store.at(landed.oid).get("two.md")).toBe("two")
  })
})
