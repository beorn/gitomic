// @failure A reader answering one path paid for the whole tree: get/oid/has ran a full `ls-tree -r`, so a session naming n paths paid n whole-tree listings and every read carried the whole tree's cost (27226 part 2, @cto 0f5c2039).
// @level l1
// @consumer every gitomic reader — km's STATE rail reads one path per write, gitomic apply reads a batch of authored paths, and both went through the same whole-tree listing.
/**
 * @reach fs-walk <fixture-only: createBareRepo's mkdtempSync repo; the shell backend reads only that fixture>
 * @testonly none: every symbol under test is the production Snapshot and backend surface.
 */

import { afterEach, describe, expect, test } from "vitest"

import { open } from "../src/index.js"
import type { GitomicBackend, Oid, Snapshot } from "../src/index.js"
import { objectOid } from "../src/git-object.js"
import { createIsoBackend } from "../src/iso.js"
import { createMemBackend } from "../src/mem.js"
import { createShellBackend } from "../src/shell.js"
import { createBareRepo, git, gitWithInput } from "./helpers/git.js"

type Recorded = {
  backend: GitomicBackend
  /** Every `readTree` call's prefix, in order: the whole-listing entry point. */
  treeCalls: (string | undefined)[]
  /** Every `readTreeExact` call's path, in order: the exact-path entry point. */
  exactCalls: string[]
  reset(): void
}

/** Record the two tree entry points without changing what they answer. */
function recordReads(source: GitomicBackend): Recorded {
  const treeCalls: (string | undefined)[] = []
  const exactCalls: string[] = []
  return {
    treeCalls,
    exactCalls,
    reset: () => {
      treeCalls.length = 0
      exactCalls.length = 0
    },
    backend: {
      ...source,
      readTree: (repo, commit, prefix) => {
        treeCalls.push(prefix)
        return source.readTree(repo, commit, prefix)
      },
      readTreeExact: (repo, commit, path) => {
        exactCalls.push(path)
        return source.readTreeExact(repo, commit, path)
      },
    },
  }
}

type Context = {
  /** A FRESH lazy snapshot of the same commit, so each row's read counts start from zero. */
  fresh(): Snapshot
  recorded: Recorded
  /** The expected blob oid of a path this context holds. */
  oid(path: string): Oid | undefined
  /** Every path this context holds. */
  all: string[]
  /** What `keys()` answers, sorted. */
  keys: string[]
}

/** The rows the ruling names, shared so mem, shell and iso run the same ones. */
async function rows(context: Context): Promise<void> {
  const { recorded, oid } = context

  // A one-path read: one scoped lookup, no whole listing. A repeat of the SAME path costs nothing, across all
  // three verbs.
  let snapshot = context.fresh()
  recorded.reset()
  expect(await snapshot.oid("pm/@i/x.md")).toBe(oid("pm/@i/x.md"))
  expect(recorded.exactCalls).toEqual(["pm/@i/x.md"])
  expect(recorded.treeCalls).toEqual([])
  expect(await snapshot.has("pm/@i/x.md")).toBe(true)
  expect(await snapshot.oid("pm/@i/x.md")).toBe(oid("pm/@i/x.md"))
  expect(await snapshot.get("pm/@i/x.md")).toBe("inner\n")
  expect(recorded.exactCalls).toEqual(["pm/@i/x.md"])
  expect(recorded.treeCalls).toEqual([])

  // A missing exact path answers undefined with no whole listing.
  snapshot = context.fresh()
  recorded.reset()
  expect(await snapshot.oid("pm/@i/gone.md")).toBeUndefined()
  expect(await snapshot.has("pm/@i/gone.md")).toBe(false)
  expect(await snapshot.get("pm/@i/gone.md")).toBeUndefined()
  expect(recorded.exactCalls).toEqual(["pm/@i/gone.md"])
  expect(recorded.treeCalls).toEqual([])

  // A directory is absent, not refused — the whole listing recurses trees away, so the exact lookup does too.
  snapshot = context.fresh()
  recorded.reset()
  expect(await snapshot.oid("pm/@i")).toBeUndefined()
  expect(await snapshot.has("pm/@i")).toBe(false)
  expect(await snapshot.get("pm/@i")).toBeUndefined()
  expect(recorded.exactCalls).toEqual(["pm/@i"])
  expect(recorded.treeCalls).toEqual([])

  // The three-file fixture under keys("pm/@i"): `pm/@i.md` and `pm/@ii/y.md` both startsWith it, while Git's
  // pathspec `pm/@i` names only the directory — this is the contract pushing the prefix into Git would change.
  // A get after that keys spawns nothing: the one listing answers the exact path too.
  snapshot = context.fresh()
  recorded.reset()
  expect(await snapshot.keys("pm/@i")).toEqual(["pm/@i.md", "pm/@i/x.md", "pm/@ii/y.md"])
  expect(recorded.treeCalls).toEqual([undefined])
  expect(recorded.exactCalls).toEqual([])
  expect(await snapshot.get("pm/@i/x.md")).toBe("inner\n")
  expect(recorded.treeCalls).toEqual([undefined])
  expect(recorded.exactCalls).toEqual([])

  // A keys after three gets takes the one full listing and no scoped child afterwards.
  snapshot = context.fresh()
  recorded.reset()
  expect(await snapshot.oid("pm/@i.md")).toBe(oid("pm/@i.md"))
  expect(await snapshot.oid("pm/@i/x.md")).toBe(oid("pm/@i/x.md"))
  expect(await snapshot.oid("pm/@ii/y.md")).toBe(oid("pm/@ii/y.md"))
  expect(recorded.exactCalls.length).toBe(3)
  expect(await snapshot.keys()).toEqual(context.keys)
  expect(recorded.treeCalls).toEqual([undefined])
  expect(recorded.exactCalls.length).toBe(3)

  // The bulk caller's shape — it already knows its paths, so it loads the listing once and reads them all.
  snapshot = context.fresh()
  recorded.reset()
  await snapshot.keys()
  for (const path of context.all) expect(await snapshot.oid(path)).toBe(oid(path))
  expect(recorded.treeCalls).toEqual([undefined])
  expect(recorded.exactCalls).toEqual([])
}

type Fixture = {
  repo: string
  commit: Oid
  oids: { indexNote: Oid; innerNote: Oid; otherNote: Oid; inside: Oid }
  cleanup(): Promise<void>
}

/**
 * A bare repo holding `pm/@i.md`, `pm/@i/x.md`, `pm/@ii/y.md`, `dir/inside.md`, and — with `symlink` — a symlink
 * `link`. The symlink lives in its own fixture because `keys()` exposes every path through the one
 * `assertRegularBlob`, so a tree holding one refuses `keys()` as a whole (that row is asserted on its own below).
 */
async function createFixture(options: { symlink?: boolean } = {}): Promise<Fixture> {
  const fixture = await createBareRepo()
  const blob = (content: string): Promise<string> => gitWithInput(fixture.repo, content, "hash-object", "-w", "--stdin")
  const indexNote = await blob("index\n")
  const innerNote = await blob("inner\n")
  const otherNote = await blob("other\n")
  const inside = await blob("inside\n")
  const link = options.symlink === true ? await blob("pm/@i.md") : undefined
  const innerTree = await gitWithInput(fixture.repo, `100644 blob ${innerNote}\tx.md\0`, "mktree", "-z")
  const otherTree = await gitWithInput(fixture.repo, `100644 blob ${otherNote}\ty.md\0`, "mktree", "-z")
  const pmTree = await gitWithInput(
    fixture.repo,
    `040000 tree ${innerTree}\t@i\0` + `100644 blob ${indexNote}\t@i.md\0` + `040000 tree ${otherTree}\t@ii\0`,
    "mktree",
    "-z",
  )
  const dirTree = await gitWithInput(fixture.repo, `100644 blob ${inside}\tinside.md\0`, "mktree", "-z")
  const rootTree = await gitWithInput(
    fixture.repo,
    `040000 tree ${dirTree}\tdir\0` +
      (link === undefined ? "" : `120000 blob ${link}\tlink\0`) +
      `040000 tree ${pmTree}\tpm\0`,
    "mktree",
    "-z",
  )
  const commit = await git(
    fixture.repo,
    "commit-tree",
    rootTree,
    "-p",
    fixture.initial,
    "-m",
    "seed the exact-path fixture",
  )
  await git(fixture.repo, "update-ref", "refs/heads/main", commit, fixture.initial)
  return { repo: fixture.repo, commit, oids: { indexNote, innerNote, otherNote, inside }, cleanup: fixture.cleanup }
}

const backends: readonly { name: string; backend: GitomicBackend }[] = [
  { name: "shell", backend: createShellBackend() },
  { name: "iso", backend: createIsoBackend() },
]

const fixtures: Fixture[] = []
afterEach(async () => {
  while (fixtures.length > 0) await fixtures.pop()?.cleanup()
})

describe.each(backends)("snapshot exact-path reads ($name)", ({ name, backend }) => {
  test("the six rows, over a real Git tree", async () => {
    const recorded = recordReads(backend)
    const fixture = await createFixture()
    fixtures.push(fixture)
    const store = await open({ repo: fixture.repo, ref: "main", writer: `exact-${name}`, backend: recorded.backend })
    const oids = new Map<string, Oid>([
      ["pm/@i.md", fixture.oids.indexNote],
      ["pm/@i/x.md", fixture.oids.innerNote],
      ["pm/@ii/y.md", fixture.oids.otherNote],
      ["dir/inside.md", fixture.oids.inside],
    ])
    await rows({
      fresh: () => store.at(fixture.commit),
      recorded,
      oid: (path) => oids.get(path),
      all: ["dir/inside.md", "pm/@i.md", "pm/@i/x.md", "pm/@ii/y.md"],
      keys: ["dir/inside.md", "pm/@i.md", "pm/@i/x.md", "pm/@ii/y.md"],
    })
  })

  test("the one assertRegularBlob refuses a symlink at both entry points", async () => {
    const recorded = recordReads(backend)
    const fixture = await createFixture({ symlink: true })
    fixtures.push(fixture)
    const store = await open({
      repo: fixture.repo,
      ref: "main",
      writer: `exact-link-${name}`,
      backend: recorded.backend,
    })
    const snapshot = store.at(fixture.commit)
    recorded.reset()
    const refusal = /unsupported Git tree mode 120000 at "link"/
    await expect(snapshot.get("link")).rejects.toThrow(refusal)
    await expect(snapshot.oid("link")).rejects.toThrow(refusal)
    expect(recorded.treeCalls).toEqual([])
    await expect(snapshot.keys()).rejects.toThrow(refusal)
  })
})

describe("snapshot exact-path reads (mem)", () => {
  test("the rows mem can carry, over a seeded in-memory repo", async () => {
    const recorded = recordReads(createMemBackend())
    const store = await open({ repo: "exact-mem", ref: "main", writer: "exact-mem", backend: recorded.backend })
    const seeded = await store.transact(async (map) => {
      map.set("pm/@i.md", "index\n")
      map.set("pm/@i/x.md", "inner\n")
      map.set("pm/@ii/y.md", "other\n")
      map.set("dir/inside.md", "inside\n")
    }, "seed the exact-path rows")
    const oidOf = (content: string): Oid => objectOid("blob", Buffer.from(content, "utf8"))
    const oids = new Map<string, Oid>([
      ["pm/@i.md", oidOf("index\n")],
      ["pm/@i/x.md", oidOf("inner\n")],
      ["pm/@ii/y.md", oidOf("other\n")],
      ["dir/inside.md", oidOf("inside\n")],
    ])
    await rows({
      fresh: () => store.at(seeded.oid),
      recorded,
      oid: (path) => oids.get(path),
      all: [...oids.keys()],
      keys: ["dir/inside.md", "pm/@i.md", "pm/@i/x.md", "pm/@ii/y.md"],
    })
  })
})
