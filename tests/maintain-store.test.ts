/**
 * maintainStore (hh 28530, @cto 24f0006f): the owner's non-pruning upkeep of a store whose auto gc is off.
 *
 * @failure With gc.auto=0 and maintenance.auto=false (hh 27525) nothing kept the kept copy's commit-graph current:
 *   its chain was last written 2026-10-05 05:00, every ref tip since is parsed from object storage on each fetch and
 *   push, and a km write's fetch+push grew about 190 ms in a week. An upkeep that reports success without a graph, or
 *   that loses a ref value or an object, would hide that again or do worse.
 * @level l1
 * @consumer the km daemon's publisher (kept copy) and the state-authority-pack unit (state authority), hh 28530
 * @testonly none
 * @reach fs-walk <fixture-only: each temp bare store's refs/ and objects/info/commit-graphs/>
 */
import { spawn } from "node:child_process"
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { maintainStore } from "../src/index.js"
import { appendEmptyHistory, createBareRepo, git } from "./helpers/git.js"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** A bare store with history and many loose refs, the shape the kept copy has had since 2026-10-05. */
async function storeWithLooseRefs(refCount: number) {
  const store = await createBareRepo()
  cleanups.push(store.cleanup)
  await appendEmptyHistory(store.repo, store.initial, 40)
  const commits = (await git(store.repo, "rev-list", "refs/heads/main")).split("\n").filter(Boolean)
  for (let index = 0; index < refCount; index++) {
    await git(store.repo, "update-ref", `refs/km/items/i${index}`, commits[index % commits.length] as string)
  }
  return store
}

function chainDirectory(repo: string): string {
  return join(repo, "objects", "info", "commit-graphs")
}

function looseRefFiles(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

async function objectCount(repo: string): Promise<number> {
  return (await git(repo, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)")).split("\n").filter(Boolean)
    .length
}

describe("maintainStore", () => {
  test("loose refs and no graph: a real graph is written, every ref is packed, no value and no object is lost", async () => {
    const { repo } = await storeWithLooseRefs(50)
    const valuesBefore = await git(repo, "for-each-ref")
    const objectsBefore = await objectCount(repo)
    expect(existsSync(join(chainDirectory(repo), "commit-graph-chain"))).toBe(false)
    expect(looseRefFiles(join(repo, "refs")).length).toBe(51)

    const result = await maintainStore(repo, { timeoutMs: 20_000 })

    expect(result).toMatchObject({ outcome: "maintained", repo, refs: 51 })
    if (result.outcome !== "maintained") throw new Error("unreachable")
    expect(result.layers).toBeGreaterThanOrEqual(1)
    expect(result.commitGraphMs).toBeGreaterThanOrEqual(0)
    expect(result.packRefsMs).toBeGreaterThanOrEqual(0)
    const chain = readFileSync(join(chainDirectory(repo), "commit-graph-chain"), "utf8")
      .split("\n")
      .filter(Boolean)
    expect(chain).toHaveLength(result.layers)
    // Isolated (nothing writes concurrently): every unchanged eligible ref is packed.
    expect(looseRefFiles(join(repo, "refs"))).toEqual([])
    expect(await git(repo, "for-each-ref")).toBe(valuesBefore)
    expect(await objectCount(repo)).toBe(objectsBefore)
  })

  test("a later run over a packed store and a new loose ref changes no earlier ref value", async () => {
    const { repo } = await storeWithLooseRefs(10)
    expect((await maintainStore(repo)).outcome).toBe("maintained")
    const before = (await git(repo, "for-each-ref")).split("\n").filter(Boolean)
    await git(repo, "update-ref", "refs/km/items/after", (await git(repo, "rev-parse", "refs/heads/main~3")).trim())
    const second = await maintainStore(repo)
    expect(second).toMatchObject({ outcome: "maintained", refs: 12 })
    const after = (await git(repo, "for-each-ref")).split("\n").filter(Boolean)
    for (const line of before) expect(after).toContain(line)
  })

  test("a store with no commits is named empty, never maintained", async () => {
    // Beside a helper store, so the helper's own cleanup removes it.
    const host = await createBareRepo()
    cleanups.push(host.cleanup)
    const directory = dirname(host.repo)
    const repo = join(directory, "empty.git")
    await git(directory, "init", "--bare", "--quiet", repo)
    expect(await maintainStore(repo)).toEqual({ outcome: "empty", repo, refs: 0 })
  })

  test("core.commitGraph=false is named graph-disabled: git would exit 0 there without writing a graph", async () => {
    const { repo } = await storeWithLooseRefs(3)
    await git(repo, "config", "core.commitGraph", "false")
    const result = await maintainStore(repo)
    expect(result).toMatchObject({ outcome: "graph-disabled", repo })
    expect(existsSync(join(chainDirectory(repo), "commit-graph-chain"))).toBe(false)
  })

  test("a path that is not a store fails at its named step, never thrown and never reported as maintained", async () => {
    const host = await createBareRepo()
    cleanups.push(host.cleanup)
    const result = await maintainStore(join(dirname(host.repo), "absent.git"))
    expect(result).toMatchObject({ outcome: "failed", step: "probe" })
    if (result.outcome !== "failed") throw new Error("unreachable")
    expect(result.code).not.toBe(0)
    expect(result.detail).toMatch(/exited/u)
  })

  test("graph layers: an unreferenced layer older than the grace is expired, a fresh one is kept", async () => {
    const { repo } = await storeWithLooseRefs(5)
    expect((await maintainStore(repo)).outcome).toBe("maintained")
    const directory = chainDirectory(repo)
    const stale = join(directory, `graph-${"a".repeat(40)}.graph`)
    const fresh = join(directory, `graph-${"b".repeat(40)}.graph`)
    writeFileSync(stale, "stale layer no chain lists")
    writeFileSync(fresh, "fresh layer no chain lists")
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(stale, twoHoursAgo, twoHoursAgo)
    await appendEmptyHistory(repo, (await git(repo, "rev-parse", "refs/heads/main")).trim(), 5)

    expect((await maintainStore(repo)).outcome).toBe("maintained")

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  test("graph-backed reads stay green while maintenance runs", async () => {
    const { repo } = await storeWithLooseRefs(30)
    expect((await maintainStore(repo)).outcome).toBe("maintained")
    let reading = true
    const failures: string[] = []
    let reads = 0
    const reader = (async () => {
      while (reading) {
        const code = await new Promise<number | null>((resolve) => {
          const child = spawn("git", [
            "--git-dir",
            repo,
            "rev-list",
            "--objects",
            "--stdin",
            "--not",
            "--all",
            "--quiet",
          ])
          child.stdin.end()
          let stderr = ""
          child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
          child.on("close", (exit) => {
            if (exit !== 0) failures.push(stderr)
            resolve(exit)
          })
        })
        reads += code === null ? 0 : 1
      }
    })()
    for (let round = 0; round < 5; round++) {
      await appendEmptyHistory(repo, (await git(repo, "rev-parse", "refs/heads/main")).trim(), 3)
      await git(
        repo,
        "update-ref",
        `refs/km/items/round${round}`,
        (await git(repo, "rev-parse", "refs/heads/main")).trim(),
      )
      expect((await maintainStore(repo)).outcome).toBe("maintained")
    }
    reading = false
    await reader
    expect(failures).toEqual([])
    expect(reads).toBeGreaterThan(0)
  })
})
