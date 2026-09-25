/**
 * `beside` on Store.transact (25312 E2a): refs that land in the SAME atomic
 * publish as the transaction's commit, recomputed per attempt, any lost lease a
 * retry. Contrast: gitomic/events' `also` is static and final when lost.
 */
import childProcess from "node:child_process"
import { afterEach, describe, expect, test, vi } from "vitest"
import { listRefs, openEvents } from "../src/events.js"
import { Conflict, open } from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import { createMemBackend } from "../src/mem.js"
import { createShellBackend } from "../src/shell.js"
import type { BesideAttempt, GitomicBackend, Oid } from "../src/types.js"
import { createBareRepo, createRemoteRepos } from "./helpers/git.js"

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
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function fetchSpawns(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((call) => call[0] === "git" && (call[1] as string[]).includes("fetch")).length
}

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

  test("fetch: every attempt reads the named refs in the SAME fetch as the store's ref and hands beside their tips", async () => {
    const fixture = await createRemoteRepos()
    cleanups.push(fixture.cleanup)
    const backend = createShellBackend()
    // ITEM exists on the remote (published from the right clone); LOG does not exist yet.
    const seeded = await open({ repo: fixture.right, ref: MAIN, writer: "right", backend, remote: "origin" })
    const itemTip = (await seeded.transact(async (map) => map.set("item.md", "item\n"), "seed item")).oid
    await backend.publish?.(fixture.right, [{ ref: ITEM, expect: "0".repeat(40), oid: itemTip }], "origin")
    const store = await open({ repo: fixture.left, ref: MAIN, writer: "left", backend, remote: "origin" })
    const spy = vi.spyOn(childProcess, "spawn")
    const seen: ReadonlyMap<string, Oid>[] = []
    const committed = await store.transact(async (map) => map.set("a.md", "a\n"), "write a", {
      fetch: [LOG, ITEM],
      beside: (attempt) => {
        seen.push(attempt.tips)
        return [
          { ref: LOG, expect: attempt.tips.get(LOG) ?? null, oid: attempt.next },
          { ref: ITEM, expect: attempt.tips.get(ITEM) ?? null, oid: attempt.next },
        ]
      },
    })
    expect(committed.retries).toBe(0)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.has(LOG)).toBe(false)
    expect(seen[0]?.get(LOG)).toBeUndefined()
    expect(seen[0]?.get(ITEM)).toBe(itemTip)
    // One attempt, one fetch process: the store's ref and both named refs together, the absent one tolerated.
    expect(fetchSpawns(spy)).toBe(1)
    const remoteTips = await listRefs("refs/km/", { repo: fixture.left, backend, remote: "origin" })
    expect(remoteTips.get(LOG)).toBe(committed.oid)
    expect(remoteTips.get(ITEM)).toBe(committed.oid)
    // The next write reads LOG's new tip through the same one fetch.
    const again = await store.transact(async (map) => map.set("b.md", "b\n"), "write b", {
      fetch: [LOG],
      beside: (attempt) => [{ ref: LOG, expect: attempt.tips.get(LOG) ?? null, oid: attempt.next }],
    })
    expect(again.retries).toBe(0)
    expect(fetchSpawns(spy)).toBe(2)
    expect((await listRefs("refs/km/", { repo: fixture.left, backend, remote: "origin" })).get(LOG)).toBe(again.oid)
  })

  test("fetch on a local store reads the repository's own tips; tips is empty when nothing was asked for", async () => {
    const backend = createMemBackend()
    const store = await open({ repo: "beside-fetch-mem", ref: MAIN, writer: "rail", backend })
    const seed = await store.transact(async (map) => map.set("seed.md", "seed\n"), "seed")
    await backend.publish?.("beside-fetch-mem", [{ ref: ITEM, expect: "0".repeat(40), oid: seed.oid }])
    let tips: ReadonlyMap<string, Oid> | undefined
    await store.transact(async (map) => map.set("a.md", "a\n"), "write a", {
      fetch: [LOG, ITEM],
      beside: (attempt) => {
        tips = attempt.tips
        return []
      },
    })
    expect(tips?.get(LOG)).toBeUndefined()
    expect(tips?.get(ITEM)).toBe(seed.oid)
    let plain: ReadonlyMap<string, Oid> | undefined
    await store.transact(async (map) => map.set("b.md", "b\n"), "write b", {
      beside: (attempt) => {
        plain = attempt.tips
        return []
      },
    })
    expect(plain?.size).toBe(0)
  })

  test("fetch refuses at the call: the store's ref, a name outside refs/, a repeat, or a backend that cannot read", async () => {
    const backend = createMemBackend()
    const store = await open({ repo: "beside-fetch-refuse", ref: MAIN, writer: "rail", backend })
    const write = (fetch: readonly string[]) =>
      store.transact(async (map) => map.set("x.md", `${Math.random()}\n`), "write x", { fetch })
    await expect(write([MAIN])).rejects.toThrow(/cannot be the store's own ref/u)
    await expect(write(["main"])).rejects.toThrow(/full refs\/ name/u)
    await expect(write([LOG, LOG])).rejects.toThrow(/more than once/u)
    const blind = { ...createMemBackend(), listRefs: undefined } as unknown as GitomicBackend
    const blindStore = await open({ repo: "beside-fetch-blind", ref: MAIN, writer: "rail", backend: blind })
    let ran = false
    await expect(
      blindStore.transact(
        async (map) => {
          ran = true
          map.set("x.md", "x\n")
        },
        "write x",
        { fetch: [LOG] },
      ),
    ).rejects.toThrow(/needs a backend with listRefs/u)
    expect(ran).toBe(false)
  })

  test("events({ at }) reads a chain at a tip a store's fetch list handed over, without a remote round trip", async () => {
    const fixture = await createRemoteRepos()
    cleanups.push(fixture.cleanup)
    const backend = createShellBackend()
    // Two log entries land on the remote from the right clone; the left store reads the chain at the fetched tip.
    const log = await openEvents({ repo: fixture.right, ref: LOG, backend, remote: "origin" })
    const first = await log.append([{ type: "km.write", title: "one" }], { expect: null })
    const second = await log.append([{ type: "km.write", title: "two" }], { expect: first.head })
    const store = await open({ repo: fixture.left, ref: MAIN, writer: "left", backend, remote: "origin" })
    const spy = vi.spyOn(childProcess, "spawn")
    let titles: string[] | undefined
    await store.transact(async (map) => map.set("a.md", "a\n"), "write a", {
      fetch: [LOG],
      beside: async (attempt) => {
        const at = attempt.tips.get(LOG)
        if (at === undefined) throw new Error("the log tip was fetched")
        const reader = await openEvents({ repo: fixture.left, ref: LOG, backend })
        titles = (await reader.events({ at })).map((event) => event.title ?? "")
        return [{ ref: LOG, expect: at, oid: attempt.next }]
      },
    })
    expect(titles).toEqual(["one", "two"])
    expect(second.head).not.toBeNull()
    // The read inside beside spawned no fetch and no ls-remote: one fetch for the attempt, one push.
    const remoteCalls = spy.mock.calls.filter(
      (call) =>
        call[0] === "git" && ((call[1] as string[]).includes("fetch") || (call[1] as string[]).includes("ls-remote")),
    )
    expect(remoteCalls).toHaveLength(1)
  })

  test("absence is tolerated for the listed refs only: the store's own ref missing on the remote still fails the refresh", async () => {
    const fixture = await createRemoteRepos()
    cleanups.push(fixture.cleanup)
    const backend = createShellBackend()
    const FEATURE = "refs/heads/feature"
    const seedStore = await open({ repo: fixture.left, ref: MAIN, writer: "left", backend, remote: "origin" })
    const tip = (await seedStore.transact(async (map) => map.set("f.md", "f\n"), "seed")).oid
    // The store's ref exists on the remote and locally when the store opens...
    await backend.publish?.(fixture.left, [{ ref: FEATURE, expect: "0".repeat(40), oid: tip }], "origin")
    await backend.publish?.(fixture.left, [{ ref: FEATURE, expect: "0".repeat(40), oid: tip }])
    const store = await open({ repo: fixture.left, ref: FEATURE, writer: "left", backend, remote: "origin" })
    // ...and the remote loses it before the write. A listed absent ref would be fine; this is not.
    await backend.publish?.(fixture.left, [{ ref: FEATURE, expect: tip, oid: null }], "origin")
    let ran = false
    await expect(
      store.transact(
        async (map, _base, attempt) => {
          ran = true
          expect(attempt?.tips.get(LOG)).toBeUndefined()
          map.set("g.md", "g\n")
        },
        "write g",
        { fetch: [LOG] },
      ),
    ).rejects.toThrow(/origin does not have refs\/heads\/feature/u)
    expect(ran).toBe(false)
  })

  test("update sees the same tips the attempt read, so an idempotency check can read a fetched tail before the commit", async () => {
    const backend = createMemBackend()
    const store = await open({ repo: "beside-update-tips", ref: MAIN, writer: "rail", backend })
    const seed = await store.transact(async (map) => map.set("seed.md", "seed\n"), "seed")
    await backend.publish?.("beside-update-tips", [{ ref: LOG, expect: "0".repeat(40), oid: seed.oid }])
    const fromUpdate: (Oid | undefined)[] = []
    const fromBeside: (Oid | undefined)[] = []
    await store.transact(
      async (map, _base, attempt) => {
        fromUpdate.push(attempt?.tips.get(LOG))
        map.set("h.md", "h\n")
      },
      "write h",
      {
        fetch: [LOG, ITEM],
        beside: (attempt) => {
          fromBeside.push(attempt.tips.get(LOG), attempt.tips.get(ITEM))
          return []
        },
      },
    )
    expect(fromUpdate).toEqual([seed.oid])
    expect(fromBeside).toEqual([seed.oid, undefined])
  })
})
