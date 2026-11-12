/**
 * @failure  #33853: nothing maintained the gitomic CLI's kept copies (GITOMIC_CACHE_DIR). Every fetch added a pack and
 *           nothing indexed them, so the root authority's copy held 931 packs, no commit-graph and a stale
 *           multi-pack-index, and a one-path history read took 24-58 s where the authority answers in 1.7 s.
 * @level    l2 — real git stores and the source CLI in its own process; no daemon.
 * @consumer gitomic CLI URL reads and `gitomic apply` through a kept copy; maintainStore's other callers.
 * @reach    fs-walk <fixture-only: each temp bare store's objects/pack and objects/info/commit-graphs>
 * @testonly none
 */
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import fs from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { afterEach, describe, expect, test } from "vitest"

import { KEPT_STORE_UNINDEXED_PACK_LIMIT, keptStoreMaintenanceReason, maintainStore } from "../src/index.js"
import { createBareRepo, git, gitWithInput } from "./helpers/git.js"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function store() {
  const fixture = await createBareRepo()
  cleanups.push(fixture.cleanup)
  return fixture
}

/** One fast-import run is one new pack holding one commit on main: the shape a kept copy's fetch leaves. */
async function addPack(repo: string, index: number): Promise<void> {
  const tip = await git(repo, "rev-parse", "refs/heads/main")
  const message = `pack ${index}\n`
  await gitWithInput(
    repo,
    `commit refs/heads/main\ncommitter t <t@example.invalid> ${946_684_801 + index} +0000\ndata ${Buffer.byteLength(message)}\n${message}from ${tip}\n\ndone\n`,
    // A one-commit import is below fast-import's unpack limit and would be exploded into loose objects; keep the pack.
    "-c",
    "fastimport.unpackLimit=0",
    "fast-import",
    "--quiet",
  )
}

function packNames(repo: string): string[] {
  return fs
    .readdirSync(join(repo, "objects", "pack"))
    .filter((name) => name.endsWith(".pack"))
    .sort()
}

function indexedPackCount(repo: string): number {
  return fs.readFileSync(join(repo, "objects", "pack", "multi-pack-index")).readUInt32BE(8)
}

describe("maintainStore indexes every pack it holds, and deletes none (#33853)", () => {
  test("a store of several packs gets a multi-pack-index over all of them; packs and objects are unchanged", async () => {
    const { repo } = await store()
    for (let index = 1; index <= 5; index += 1) await addPack(repo, index)
    const before = packNames(repo)
    const objects = await git(repo, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)")
    const result = await maintainStore(repo, { timeoutMs: 20_000 })
    expect(result.outcome).toBe("maintained")
    if (result.outcome !== "maintained") throw new Error("unreachable")
    expect(result.multiPackIndexMs).toBeGreaterThanOrEqual(0)
    expect(packNames(repo)).toEqual(before)
    expect(indexedPackCount(repo)).toBe(before.length)
    expect(await git(repo, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)")).toBe(objects)
  })

  test("a store whose objects are all loose has nothing to index: maintained, no index, no failure", async () => {
    const { repo } = await store()
    expect(packNames(repo)).toEqual([])
    expect((await maintainStore(repo, { timeoutMs: 20_000 })).outcome).toBe("maintained")
    expect(fs.existsSync(join(repo, "objects", "pack", "multi-pack-index"))).toBe(false)
    expect(keptStoreMaintenanceReason(repo)).toBeUndefined()
  })
})

describe("keptStoreMaintenanceReason decides from files alone, at both edges (#33853, @cto fcdc1e71)", () => {
  test("no commit-graph chain, then maintained, then 32 and 33 packs outside the index", async () => {
    const { repo } = await store()
    await addPack(repo, 0)
    expect(keptStoreMaintenanceReason(repo)).toMatch(/no commit-graph chain at .*commit-graph-chain/u)
    expect((await maintainStore(repo, { timeoutMs: 20_000 })).outcome).toBe("maintained")
    expect(keptStoreMaintenanceReason(repo)).toBeUndefined()
    for (let index = 1; index <= KEPT_STORE_UNINDEXED_PACK_LIMIT; index += 1) await addPack(repo, index)
    expect(keptStoreMaintenanceReason(repo)).toBeUndefined()
    await addPack(repo, KEPT_STORE_UNINDEXED_PACK_LIMIT + 1)
    expect(keptStoreMaintenanceReason(repo)).toBe(
      `${KEPT_STORE_UNINDEXED_PACK_LIMIT + 1} packs outside the multi-pack-index (limit ${KEPT_STORE_UNINDEXED_PACK_LIMIT})`,
    )
    expect((await maintainStore(repo, { timeoutMs: 20_000 })).outcome).toBe("maintained")
    expect(keptStoreMaintenanceReason(repo)).toBeUndefined()
  }, 60_000)

  test("a missing, foreign or truncated index is a reason to maintain, never a reason to skip", async () => {
    const { repo } = await store()
    await addPack(repo, 0)
    expect((await maintainStore(repo, { timeoutMs: 20_000 })).outcome).toBe("maintained")
    const index = join(repo, "objects", "pack", "multi-pack-index")
    const good = fs.readFileSync(index)
    fs.rmSync(index)
    expect(keptStoreMaintenanceReason(repo)).toMatch(/^no readable multi-pack-index at /u)
    fs.writeFileSync(index, Buffer.concat([Buffer.from("NOPE"), good.subarray(4)]))
    expect(keptStoreMaintenanceReason(repo)).toMatch(/does not start with its MIDX signature$/u)
    fs.writeFileSync(index, good.subarray(0, 8))
    expect(keptStoreMaintenanceReason(repo)).toMatch(/shorter than its 12-byte header$/u)
  })
})

describe("the gitomic CLI maintains its kept copy before a command reads it (#33853)", () => {
  async function workspace() {
    const fresh = await store()
    for (let index = 1; index <= 3; index += 1) await addPack(fresh.repo, index)
    const dir = await mkdtemp(join(tmpdir(), "gitomic-kept-33853-"))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const url = pathToFileURL(fresh.repo).href
    const cacheDir = join(dir, "kept")
    const kept = join(cacheDir, `${createHash("sha256").update(url).digest("hex")}.git`)
    const log = () =>
      promisify(execFile)(
        "bun",
        [fileURLToPath(new URL("../src/bin.ts", import.meta.url)), "log", `${url}#main`, "-n", "1"],
        {
          env: { ...process.env, GITOMIC_CACHE_DIR: cacheDir, GIT_TERMINAL_PROMPT: "0" },
          encoding: "utf8",
        },
      ).then(
        (result) => ({ code: 0, stdout: result.stdout, stderr: result.stderr }),
        (error: { code?: number; stdout?: string; stderr?: string }) => ({
          code: error.code ?? -1,
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? "",
        }),
      )
    return { origin: fresh.repo, kept, log }
  }

  test("a new kept copy is maintained on first read; a current one is left alone; the origin is never touched", async () => {
    const { origin, kept, log } = await workspace()
    const first = await log()
    expect(first).toMatchObject({ code: 0, stderr: "" })
    expect(first.stdout).toMatch(/^[0-9a-f]{40} pack 3\n$/u)
    expect(keptStoreMaintenanceReason(kept)).toBeUndefined()
    const chain = join(kept, "objects", "info", "commit-graphs", "commit-graph-chain")
    const stamp = fs.statSync(chain).mtimeMs
    const second = await log()
    expect(second).toMatchObject({ code: 0, stderr: "", stdout: first.stdout })
    expect(fs.statSync(chain).mtimeMs).toBe(stamp)
    expect(fs.existsSync(join(origin, "objects", "info", "commit-graphs"))).toBe(false)
    expect(fs.existsSync(join(origin, "objects", "pack", "multi-pack-index"))).toBe(false)
  }, 60_000)

  test("a maintainer that loses the lock names the store and step in one stderr line and the read still answers", async () => {
    const { kept, log } = await workspace()
    expect((await log()).code).toBe(0)
    // Take the copy back to needing upkeep while another maintainer holds the commit-graph lock.
    const graphs = join(kept, "objects", "info", "commit-graphs")
    fs.rmSync(join(graphs, "commit-graph-chain"))
    fs.writeFileSync(join(graphs, "commit-graph-chain.lock"), "")
    const held = await log()
    expect(held.code).toBe(0)
    expect(held.stdout).toMatch(/^[0-9a-f]{40} pack 3\n$/u)
    const lines = held.stderr.split("\n").filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`gitomic: kept copy ${kept} not maintained (no commit-graph chain at `)
    expect(lines[0]).toMatch(/: commit-graph failed \(\d+\): .*commit-graph-chain\.lock.*; continuing$/u)
  }, 60_000)
})
