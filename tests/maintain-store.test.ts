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
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { MAINTAIN_STORE_TIMEOUT_MS, maintainStore } from "../src/index.js"
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

  test("a real split merge retires a valid layer and keeps it inside the grace; a layer aged past it is expired", async () => {
    const { repo } = await storeWithLooseRefs(2)
    const directory = chainDirectory(repo)
    const chain = () => readFileSync(join(directory, "commit-graph-chain"), "utf8").split("\n").filter(Boolean)
    const layerFiles = () =>
      readdirSync(directory)
        .filter((name) => name.endsWith(".graph"))
        .map((name) => name.slice("graph-".length, -".graph".length))
    const grow = async (count: number) =>
      appendEmptyHistory(repo, (await git(repo, "rev-parse", "refs/heads/main")).trim(), count)

    expect((await maintainStore(repo)).outcome).toBe("maintained")
    const first = chain()
    await grow(60)
    // A layer this large against the base merges them: git's own --split strategy retires the old layer.
    const merged = await maintainStore(repo)
    expect(merged).toMatchObject({ outcome: "maintained", layers: chain().length })
    const retired = first.filter((hash) => !chain().includes(hash))
    expect(retired.length, `chain ${first.join(",")} -> ${chain().join(",")}`).toBeGreaterThan(0)
    // Inside the grace a freshly retired, valid layer stays on disk for a reader that opened the old chain.
    for (const hash of retired) expect(layerFiles()).toContain(hash)

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    for (const hash of retired) utimesSync(join(directory, `graph-${hash}.graph`), twoHoursAgo, twoHoursAgo)
    await grow(2)
    expect((await maintainStore(repo)).outcome).toBe("maintained")
    for (const hash of retired) expect(layerFiles()).not.toContain(hash)
    for (const hash of chain()) expect(layerFiles()).toContain(hash)
  })

  test("a positive graph-backed history walk on a shared mirror reads the right count while upkeep runs", async () => {
    const source = await storeWithLooseRefs(20)
    const store = join(dirname(source.repo), "mirror.git")
    await git(dirname(source.repo), "clone", "--quiet", "--mirror", "--shared", source.repo, store)
    expect(readFileSync(join(store, "objects", "info", "alternates"), "utf8").trim()).toBe(join(source.repo, "objects"))
    const fixed = (await git(store, "rev-parse", "refs/heads/main")).trim()
    await git(store, "update-ref", "refs/km/items/fixed", fixed)
    const expected = (await git(store, "rev-list", "--count", fixed)).trim()
    expect(Number(expected)).toBeGreaterThan(40)
    expect((await maintainStore(store)).outcome).toBe("maintained")

    let reading = true
    const wrong: string[] = []
    let reads = 0
    const reader = (async () => {
      while (reading) {
        const counted = await new Promise<string>((resolve) => {
          const child = spawn("git", ["--git-dir", store, "rev-list", "--count", "refs/km/items/fixed"])
          let out = ""
          let err = ""
          child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()))
          child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()))
          child.on("close", (code) => resolve(code === 0 ? out.trim() : `exit ${String(code)}: ${err}`))
        })
        reads++
        if (counted !== expected) wrong.push(counted)
      }
    })()
    for (let round = 0; round < 5; round++) {
      await appendEmptyHistory(store, (await git(store, "rev-parse", "refs/heads/main")).trim(), 25)
      await git(
        store,
        "update-ref",
        `refs/km/items/round${round}`,
        (await git(store, "rev-parse", "refs/heads/main")).trim(),
      )
      expect((await maintainStore(store)).outcome).toBe("maintained")
    }
    reading = false
    await reader
    expect(wrong).toEqual([])
    expect(reads).toBeGreaterThan(0)
  })
})

/**
 * The bound is maintainStore's own (@cto 22c154e1): a caller that passes nothing is bounded, and an explicit bound may
 * shorten it, never remove it. A fake `git` on PATH that never answers stands in for a hung store.
 */
describe("maintainStore's bound", () => {
  const realSetTimeout = globalThis.setTimeout
  const realSleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms))

  async function hungGit<T>(run: (repo: string) => Promise<T>): Promise<T> {
    const store = await createBareRepo()
    cleanups.push(store.cleanup)
    const bin = join(dirname(store.repo), "bin")
    mkdirSync(bin)
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexec sleep 30\n")
    chmodSync(join(bin, "git"), 0o755)
    const path = process.env.PATH
    process.env.PATH = `${bin}:${path ?? ""}`
    try {
      return await run(store.repo)
    } finally {
      process.env.PATH = path
    }
  }

  /** Start `call`, move the fake clock past `advanceMs`, and give the stopped child real time to close. */
  async function settlesWithin(call: () => Promise<unknown>, advanceMs: number): Promise<unknown> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      let outcome: unknown = "unsettled"
      void call().then((value) => (outcome = value))
      await realSleep(200)
      await vi.advanceTimersByTimeAsync(advanceMs)
      for (let waited = 0; waited < 50 && outcome === "unsettled"; waited++) {
        await vi.advanceTimersByTimeAsync(1_000)
        await realSleep(100)
      }
      return outcome
    } finally {
      vi.useRealTimers()
    }
  }

  test("a caller that passes no options is still bounded: a hung git answers failed with timeout", async () => {
    const outcome = await hungGit((repo) => settlesWithin(() => maintainStore(repo), MAINTAIN_STORE_TIMEOUT_MS + 1))
    expect(outcome).toMatchObject({ outcome: "failed", step: "probe", code: "timeout" })
  }, 60_000)

  test("an explicit bound larger than the default is capped at it, never lengthened", async () => {
    const outcome = await hungGit((repo) =>
      settlesWithin(
        () => maintainStore(repo, { timeoutMs: 10 * MAINTAIN_STORE_TIMEOUT_MS }),
        MAINTAIN_STORE_TIMEOUT_MS + 1,
      ),
    )
    expect(outcome).toMatchObject({ outcome: "failed", step: "probe", code: "timeout" })
  }, 60_000)

  test("a bound that is not a positive number is refused, never read as no bound", async () => {
    await expect(maintainStore("/unused", { timeoutMs: 0 })).rejects.toThrow(RangeError)
    await expect(maintainStore("/unused", { timeoutMs: Number.NaN })).rejects.toThrow(RangeError)
  })
})
