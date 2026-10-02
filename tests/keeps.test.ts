/**
 * `keeps` on Store.transact (27166; @cto 7f9589c5): the commits a transaction keeps become extra parents after
 * the base, so one leased, gated write can be a merge.
 *
 * @failure A merge of a foreign commit would need a second writer outside gitomic's lease and candidate gate, or a retry could write the same merge twice.
 * @level l1
 * @consumer a host's replicator that merges a commit made elsewhere into its own repository through one gated write
 * @testonly none
 */
import { afterEach, describe, expect, test } from "vitest"
import { AlreadyKept, open } from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import { createMemBackend } from "../src/mem.js"
import { createShellBackend } from "../src/shell.js"
import type { GitomicBackend, Oid, Store } from "../src/types.js"
import { createBareRepo } from "./helpers/git.js"

const MAIN = "refs/heads/main"
const SIDE = "refs/heads/side"

type Target = { name: string; repo: string; backend: GitomicBackend; cleanup(): Promise<void> }

async function targets(): Promise<Target[]> {
  const shell = await createBareRepo()
  const iso = await createBareRepo()
  return [
    { name: "shell", repo: shell.repo, backend: createShellBackend(), cleanup: shell.cleanup },
    { name: "iso", repo: iso.repo, backend: createIsoBackend(), cleanup: iso.cleanup },
    { name: "mem", repo: "keeps-mem", backend: createMemBackend(), cleanup: async () => {} },
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

/** main with one seed commit, and a side line one commit past the seed: the commit a merge keeps. */
async function diverged(target: Target): Promise<{ store: Store; seed: Oid; side: Oid }> {
  const store = await open({ repo: target.repo, ref: MAIN, writer: "main", backend: target.backend })
  const seed = (await store.transact(async (map) => map.set("seed.md", "seed\n"), "seed")).oid
  await target.backend.publish?.(target.repo, [{ ref: SIDE, expect: "0".repeat(seed.length), oid: seed }])
  const sideStore = await open({ repo: target.repo, ref: SIDE, writer: "side", backend: target.backend })
  const side = (await sideStore.transact(async (map) => map.set("side.md", "made elsewhere\n"), "a foreign write")).oid
  return { store, seed, side }
}

describe("keeps: a transaction that is a merge", () => {
  test("the kept commit is the second parent, after the base, and the tree change lands with it", async () => {
    await forEachTarget(async (target) => {
      const { store, side } = await diverged(target)
      const base = (await store.transact(async (map) => map.set("a.md", "a\n"), "a local write")).oid

      const merged = await store.transact(
        async (map) => map.set("side.md", "made elsewhere\n"),
        "merge the side line",
        {
          keeps: [side],
        },
      )

      const meta = await target.backend.readCommit(target.repo, merged.oid)
      expect(meta.parents, target.name).toEqual([base, side])
      expect(await store.head()).toBe(merged.oid)
      expect(await store.at(merged.oid).get("side.md")).toBe("made elsewhere\n")
      expect(await store.at(merged.oid).get("a.md")).toBe("a\n")
    })
  })

  test("with keeps an unchanged tree still commits: the parents are the change", async () => {
    await forEachTarget(async (target) => {
      const { store, side } = await diverged(target)
      const base = await store.head()

      const merged = await store.transact(async () => {}, "keep the side line, take none of it", { keeps: [side] })

      expect(merged.oid, target.name).not.toBe(base)
      expect((await target.backend.readCommit(target.repo, merged.oid)).parents).toEqual([base, side])
      expect(await store.at(merged.oid).has("side.md")).toBe(false)
      // Without keeps the same update is the no-op it always was.
      const noop = await store.transact(async () => {}, "nothing")
      expect(noop.oid).toBe(merged.oid)
    })
  })

  test("a keep the base already contains is refused by name and nothing is written", async () => {
    await forEachTarget(async (target) => {
      const { store, seed, side } = await diverged(target)
      const merged = await store.transact(async () => {}, "merge", { keeps: [side] })

      for (const kept of [side, seed, merged.oid]) {
        const again = store.transact(async (map) => map.set("b.md", "b\n"), "merge again", { keeps: [kept] })
        await expect(again, `${target.name} ${kept}`).rejects.toBeInstanceOf(AlreadyKept)
        await expect(again).rejects.toThrow(/already kept/u)
      }
      expect(await store.head()).toBe(merged.oid)
    })
  })

  test("a retry on a tip that gained the kept commit refuses instead of merging it twice", async () => {
    await forEachTarget(async (target) => {
      const { store, side } = await diverged(target)
      const rival = await open({ repo: target.repo, ref: MAIN, writer: "rival", backend: target.backend })
      let intruded: Oid | undefined
      let updates = 0

      const late = store.transact(
        async (map) => {
          updates += 1
          // The rival lands the same merge while this attempt is being built.
          if (intruded === undefined) {
            intruded = (await rival.transact(async () => {}, "rival merge", { keeps: [side] })).oid
          }
          map.set("late.md", "late\n")
        },
        "merge, late",
        { keeps: [side] },
      )

      await expect(late, target.name).rejects.toBeInstanceOf(AlreadyKept)
      expect(updates).toBe(1)
      expect(await store.head()).toBe(intruded)
      expect((await target.backend.readCommit(target.repo, intruded as Oid)).parents[1]).toBe(side)
    })
  })

  test("refused at the call: a repeat, a value that is no object id, a backend that cannot check ancestry", async () => {
    await forEachTarget(async (target) => {
      const { store, side } = await diverged(target)
      const head = await store.head()
      const write = async (): Promise<void> => {}

      await expect(store.transact(write, "repeat", { keeps: [side, side] })).rejects.toThrow(/more than once/u)
      await expect(store.transact(write, "not an id", { keeps: ["main"] })).rejects.toThrow(/invalid kept commit id/u)
      const { isAncestor: _none, ...without } = target.backend
      const blind = await open({ repo: target.repo, ref: MAIN, writer: "blind", backend: without })
      await expect(blind.transact(write, "no ancestry", { keeps: [side] })).rejects.toThrow(
        /needs a backend with isAncestor/u,
      )
      // An empty list is no keeps at all: the ordinary no-op.
      expect((await store.transact(write, "empty", { keeps: [] })).oid).toBe(head)
      expect(await store.head()).toBe(head)
    })
  })

  test("a keep that is not a commit in this repository is refused before update runs", async () => {
    await forEachTarget(async (target) => {
      const { store } = await diverged(target)
      const head = await store.head()
      let ran = false

      const unknown = store.transact(
        async () => {
          ran = true
        },
        "keep a commit nobody has",
        { keeps: ["1".repeat(head.length)] },
      )

      await expect(unknown, target.name).rejects.toThrow()
      expect(ran).toBe(false)
      expect(await store.head()).toBe(head)
    })
  })

  test("beside refs land in the same publish as the merge", async () => {
    await forEachTarget(async (target) => {
      const { store, side } = await diverged(target)
      const KEPT = "refs/heads/kept/side"

      const merged = await store.transact(async () => {}, "merge and mark", {
        keeps: [side],
        beside: () => [{ ref: KEPT, expect: null, oid: side }],
      })

      const refs = await target.backend.listRefs?.(target.repo, "refs/heads/")
      expect(refs?.get(KEPT), target.name).toBe(side)
      expect(refs?.get(MAIN)).toBe(merged.oid)
    })
  })
})
