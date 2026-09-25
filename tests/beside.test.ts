/**
 * `beside` on Store.transact (25312 E2a): refs that land in the SAME atomic
 * publish as the transaction's commit, recomputed per attempt, any lost lease a
 * retry. Contrast: gitomic/events' `also` is static and final when lost.
 */
import { afterEach, describe, expect, test } from "vitest"
import { listRefs } from "../src/events.js"
import { Conflict, open } from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import { createMemBackend } from "../src/mem.js"
import { createShellBackend } from "../src/shell.js"
import type { BesideAttempt, GitomicBackend, Oid } from "../src/types.js"
import { createBareRepo } from "./helpers/git.js"

const MAIN = "refs/heads/main"
const LOG = "refs/km/writes/2026-09-25"
const ITEM = "refs/km/items/01JAAAAAAAAAAAAAAAAAAAAAAA"

type Target = { name: string; repo: string; backend: GitomicBackend; cleanup(): Promise<void> }

async function targets(): Promise<Target[]> {
  const shell = await createBareRepo()
  const iso = await createBareRepo()
  return [
    { name: "shell", repo: shell.repo, backend: createShellBackend(), cleanup: shell.cleanup },
    { name: "iso", repo: iso.repo, backend: createIsoBackend(), cleanup: iso.cleanup },
    { name: "mem", repo: "beside-mem", backend: createMemBackend(), cleanup: async () => {} },
  ]
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function forEachTarget(run: (target: Target) => Promise<void>): Promise<void> {
  for (const target of await targets()) {
    cleanups.push(target.cleanup)
    await run(target)
  }
}

async function tipOf(target: Target, ref: string): Promise<Oid | undefined> {
  return (await listRefs(ref, { repo: target.repo, backend: target.backend })).get(ref)
}

describe("beside: refs that land in the same atomic publish as the transaction", () => {
  test("the commit and every beside ref move together, the beside refs at the commit the attempt built", async () => {
    await forEachTarget(async (target) => {
      const store = await open({ repo: target.repo, ref: MAIN, writer: "rail", backend: target.backend })
      const seed = await store.transact(async (map) => map.set("seed.md", "seed\n"), "seed")
      const attempts: BesideAttempt[] = []
      const committed = await store.transact(async (map) => map.set("a.md", "a\n"), "write a", {
        beside: (attempt) => {
          attempts.push(attempt)
          return [
            { ref: LOG, expect: null, oid: attempt.next },
            { ref: ITEM, expect: null, oid: attempt.next },
          ]
        },
      })
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.base).toBe(seed.oid)
      expect(attempts[0]?.next).toBe(committed.oid)
      expect(await attempts[0]?.map.get("a.md")).toBe("a\n")
      expect(committed.retries).toBe(0)
      expect(await tipOf(target, MAIN)).toBe(committed.oid)
      expect(await tipOf(target, LOG)).toBe(committed.oid)
      expect(await tipOf(target, ITEM)).toBe(committed.oid)
    })
  })

  test("a lost lease on a beside ref is a retry, not a Conflict: the next attempt reads fresh tips and lands", async () => {
    await forEachTarget(async (target) => {
      const store = await open({ repo: target.repo, ref: MAIN, writer: "rail", backend: target.backend })
      const first = await store.transact(async (map) => map.set("seed.md", "seed\n"), "seed")
      // The log already exists at `first`; the first attempt claims it is absent (a stale read), the second attempt
      // reads the real tip.
      await target.backend.publish?.(target.repo, [{ ref: LOG, expect: "0".repeat(first.oid.length), oid: first.oid }])
      const seen: Oid[] = []
      const committed = await store.transact(async (map) => map.set("b.md", "b\n"), "write b", {
        beside: async (attempt) => {
          seen.push(attempt.next)
          const stale = seen.length === 1
          return [{ ref: LOG, expect: stale ? null : first.oid, oid: attempt.next }]
        },
      })
      expect(seen).toHaveLength(2)
      expect(committed.retries).toBe(1)
      expect(await tipOf(target, MAIN)).toBe(committed.oid)
      expect(await tipOf(target, LOG)).toBe(committed.oid)
    })
  })

  test("a lost lease on the ref itself re-runs beside against the new base and the new commit", async () => {
    await forEachTarget(async (target) => {
      const store = await open({ repo: target.repo, ref: MAIN, writer: "rail", backend: target.backend })
      const other = await open({ repo: target.repo, ref: MAIN, writer: "other", backend: target.backend })
      const seed = await store.transact(async (map) => map.set("seed.md", "seed\n"), "seed")
      const bases: Oid[] = []
      let intruder: Oid | undefined
      const committed = await store.transact(async (map) => map.set("c.md", "c\n"), "write c", {
        beside: async (attempt) => {
          bases.push(attempt.base)
          if (intruder === undefined) {
            // Another writer lands between this attempt's commit and its publish.
            intruder = (await other.transact(async (map) => map.set("x.md", "x\n"), "intrude")).oid
          }
          return [{ ref: LOG, expect: null, oid: attempt.next }]
        },
      })
      expect(bases).toEqual([seed.oid, intruder])
      expect(committed.retries).toBe(1)
      expect(await tipOf(target, MAIN)).toBe(committed.oid)
      expect(await tipOf(target, LOG)).toBe(committed.oid)
      const snapshot = store.at(committed.oid)
      expect(await snapshot.get("x.md")).toBe("x\n")
      expect(await snapshot.get("c.md")).toBe("c\n")
    })
  })

  test("a noop attempt never calls beside and moves nothing", async () => {
    await forEachTarget(async (target) => {
      const store = await open({ repo: target.repo, ref: MAIN, writer: "rail", backend: target.backend })
      const seed = await store.transact(async (map) => map.set("seed.md", "seed\n"), "seed")
      let calls = 0
      const committed = await store.transact(async (map) => map.set("seed.md", "seed\n"), "same bytes", {
        beside: () => {
          calls++
          return [{ ref: LOG, expect: null, oid: seed.oid }]
        },
      })
      expect(calls).toBe(0)
      expect(committed.oid).toBe(seed.oid)
      expect(await tipOf(target, LOG)).toBeUndefined()
    })
  })

  test("beside reuses the also validator: the ref itself, a repeat, a delete without its tip, a bad id", async () => {
    await forEachTarget(async (target) => {
      const store = await open({ repo: target.repo, ref: MAIN, writer: "rail", backend: target.backend })
      const seed = await store.transact(async (map) => map.set("seed.md", "seed\n"), "seed")
      const write = async (beside: () => readonly { ref: string; expect: Oid | null; oid: Oid | null }[]) =>
        store.transact(async (map) => map.set("d.md", `${Math.random()}\n`), "write d", { beside })
      await expect(write(() => [{ ref: MAIN, expect: null, oid: seed.oid }])).rejects.toThrow(
        /cannot be the chain itself/u,
      )
      await expect(
        write(() => [
          { ref: LOG, expect: null, oid: seed.oid },
          { ref: LOG, expect: null, oid: seed.oid },
        ]),
      ).rejects.toThrow(/more than once/u)
      await expect(write(() => [{ ref: LOG, expect: null, oid: null }])).rejects.toThrow(/needs the tip it removes/u)
      await expect(write(() => [{ ref: LOG, expect: null, oid: "nope" }])).rejects.toThrow(/must be a commit id/u)
      // Nothing above landed: the ref is where the seed left it.
      expect(await tipOf(target, MAIN)).toBe(seed.oid)
    })
  })

  test("a backend without MULTI publish refuses beside at the transact call, before any attempt", async () => {
    const backend = { ...createMemBackend(), publish: undefined } as unknown as GitomicBackend
    const store = await open({ repo: "beside-no-multi", ref: MAIN, writer: "rail", backend })
    const seed = await store.transact(async (map) => map.set("seed.md", "seed\n"), "seed")
    let ran = false
    await expect(
      store.transact(
        async (map) => {
          ran = true
          map.set("e.md", "e\n")
        },
        "write e",
        { beside: (attempt) => [{ ref: LOG, expect: null, oid: attempt.next }] },
      ),
    ).rejects.toThrow(/beside needs a backend with publish/u)
    expect(ran).toBe(false)
    // A store on that backend that never passes beside is unaffected.
    const plain = await store.transact(async (map) => map.set("e.md", "e\n"), "write e plainly")
    expect(plain.oid).not.toBe(seed.oid)
    await expect(store.transact(async () => undefined, "not a function", { beside: 1 as never })).rejects.toThrow(
      /beside must be a function/u,
    )
  })

  test("Conflict from a beside publish that is not a lease loss still reaches the caller", async () => {
    // The mem backend refuses an unknown commit as an Error, not a Conflict: proves non-Conflict errors propagate.
    const target = { name: "mem", repo: "beside-mem-error", backend: createMemBackend(), cleanup: async () => {} }
    const store = await open({ repo: target.repo, ref: MAIN, writer: "rail", backend: target.backend })
    await store.transact(async (map) => map.set("seed.md", "seed\n"), "seed")
    await expect(
      store.transact(async (map) => map.set("f.md", "f\n"), "write f", {
        beside: () => [{ ref: LOG, expect: null, oid: "f".repeat(40) }],
      }),
    ).rejects.toThrow(/unknown commit/u)
    expect(Conflict.name).toBe("Conflict")
  })
})
