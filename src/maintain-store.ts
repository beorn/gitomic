import { Buffer } from "node:buffer"
import fs from "node:fs"
import { join } from "node:path"
import { performance } from "node:perf_hooks"

import { GitTimeout } from "./errors.ts"
import { runGit } from "./shell.ts"

/**
 * One owner's non-pruning upkeep of a store whose automatic gc and maintenance are off (hh 28530, @cto 24f0006f).
 * The guards on a kept remote (`gc.auto=0`, `gc.pruneExpire=never`, `maintenance.auto=false`, repository.ts) stop git
 * from collecting a store live processes share, and they also stop the commit-graph and packed refs being kept
 * current. Without a current commit-graph every fetch and push parses one commit per ref from object storage, so
 * their cost grows with the ref count. This is the owner's explicit replacement: the store's one owner calls it on its
 * own cadence (the km daemon for a kept copy, the state-authority-pack unit for the state authority); nothing here
 * decides when.
 *
 * It also writes the store's multi-pack-index (hh 33853): every fetch into a kept copy adds one pack, and with gc off
 * nothing indexes them, so a lookup searched 931 pack indexes one by one (a one-path rev-list on the root authority's
 * kept copy: 37.7 s, 7.0 s with a current multi-pack-index, 5.0 s with the commit-graph too). The index is one new file
 * over the packs that exist; no pack is rewritten or removed.
 *
 * Non-pruning means no object and no ref value is lost. It does remove files: commit-graph layers that have left the
 * chain, only once older than {@link GRAPH_LAYER_GRACE} (git refreshes a layer's mtime when it retires it), and the
 * loose ref files whose values `pack-refs` has just written into packed-refs. No repack, no gc, no prune.
 *
 * The grace is the supported bound for an ordinary, bounded git reader: one that read the old chain and opens its
 * layer files within the hour. A reader paused longer than that between the two can miss a layer; nothing registers
 * readers.
 */
export const GRAPH_LAYER_GRACE = "1.hour.ago"

/** The commands, exactly; nothing else is run against the store. */
export const MAINTAIN_STORE_COMMIT_GRAPH_ARGS = [
  "commit-graph",
  "write",
  "--split",
  "--reachable",
  "--no-progress",
  `--expire-time=${GRAPH_LAYER_GRACE}`,
] as const
export const MAINTAIN_STORE_PACK_REFS_ARGS = ["pack-refs", "--all"] as const
/** Index every pack the store holds in one file; never `repack` or `expire`, which rewrite or delete packs. */
export const MAINTAIN_STORE_MULTI_PACK_INDEX_ARGS = ["multi-pack-index", "write", "--no-progress"] as const

/**
 * What one call did. `maintained` only when every command succeeded AND the graph and index are really there: a chain
 * file whose every listed layer exists, and a multi-pack-index file. `refs` and `layers` are observations, not promises: writes may overlap, and a concurrent
 * update legitimately leaves a newer loose ref over a packed tip, which this never fails on and never removes.
 * Everything else is named (NO SILENT ERRORS): a store with no commits is `empty`; a store whose config disables the
 * commit-graph is `graph-disabled`, because git would exit 0 there without writing one; a failed step names itself.
 */
export type StoreMaintenance =
  | Readonly<{
      outcome: "maintained"
      repo: string
      multiPackIndexMs: number
      commitGraphMs: number
      packRefsMs: number
      refs: number
      layers: number
    }>
  | Readonly<{ outcome: "empty"; repo: string; refs: number }>
  | Readonly<{ outcome: "graph-disabled"; repo: string; reason: string }>
  | Readonly<{
      outcome: "failed"
      repo: string
      step: "probe" | "multi-pack-index" | "commit-graph" | "pack-refs" | "verify"
      code: number | "timeout"
      detail: string
      multiPackIndexMs?: number
      commitGraphMs?: number
      packRefsMs?: number
    }>

/**
 * Every git command maintainStore runs is bounded by this, whoever calls it (hh 28530, @cto 22c154e1): a caller that
 * passes nothing is bounded, and an explicit bound may shorten it, never remove it.
 */
export const MAINTAIN_STORE_TIMEOUT_MS = 120_000

export type MaintainStoreOptions = Readonly<{
  /**
   * A shorter bound for each git command, in milliseconds. Capped at {@link MAINTAIN_STORE_TIMEOUT_MS}; a command past
   * its bound is stopped and the call answers `failed` with `timeout`.
   */
  timeoutMs?: number
}>

/** The bound each command gets: the default, or a shorter explicit one; never none. */
function commandBoundMs(requested: number | undefined): number {
  if (requested === undefined) return MAINTAIN_STORE_TIMEOUT_MS
  if (!(requested > 0)) {
    throw new RangeError(`maintainStore timeoutMs must be a positive number, got ${String(requested)}`)
  }
  return Math.min(requested, MAINTAIN_STORE_TIMEOUT_MS)
}

type Step = Extract<StoreMaintenance, { outcome: "failed" }>["step"]

class StepFailed extends Error {
  readonly step: Step
  readonly code: number | "timeout"
  readonly detail: string
  constructor(step: Step, code: number | "timeout", detail: string) {
    super(`${step}: ${detail}`)
    this.step = step
    this.code = code
    this.detail = detail
  }
}

async function git(repo: string, step: Step, args: readonly string[], timeoutMs: number): Promise<string> {
  let result
  try {
    result = await runGit(["--git-dir", repo, ...args], { timeoutMs })
  } catch (error) {
    if (error instanceof GitTimeout) throw new StepFailed(step, "timeout", error.message)
    throw error
  }
  if (result.code !== 0) {
    const detail = result.stderr.toString("utf8").trim()
    throw new StepFailed(step, result.code, `git ${args.join(" ")} exited ${result.code}${detail ? `: ${detail}` : ""}`)
  }
  return result.stdout.toString("utf8")
}

/** The layers the store's commit-graph chain lists, or the reason it does not check out. */
function readChain(repo: string): { layers: number } | { problem: string } {
  const directory = join(repo, "objects", "info", "commit-graphs")
  const chain = join(directory, "commit-graph-chain")
  let listed: string[]
  try {
    listed = fs
      .readFileSync(chain, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
  } catch (error) {
    return { problem: `no commit-graph chain at ${chain}: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (listed.length === 0) return { problem: `the commit-graph chain at ${chain} lists no layer` }
  const missing = listed.filter((hash) => !fs.existsSync(join(directory, `graph-${hash}.graph`)))
  if (missing.length > 0) {
    return { problem: `the commit-graph chain at ${chain} lists absent layers: ${missing.join(", ")}` }
  }
  return { layers: listed.length }
}

/**
 * Index the store's packs, write its commit-graph incrementally and pack its refs; see {@link StoreMaintenance} for
 * what it answers.
 */
export async function maintainStore(repo: string, options: MaintainStoreOptions = {}): Promise<StoreMaintenance> {
  const timeoutMs = commandBoundMs(options.timeoutMs)
  let multiPackIndexMs: number | undefined
  let commitGraphMs: number | undefined
  let packRefsMs: number | undefined
  try {
    const setting = (
      await git(repo, "probe", ["config", "--bool", "--default", "true", "core.commitGraph"], timeoutMs)
    ).trim()
    if (setting === "false") {
      return { outcome: "graph-disabled", repo, reason: "core.commitGraph=false: git would exit 0 without a graph" }
    }
    const commitRefs = (await git(repo, "probe", ["for-each-ref", "--format=%(*objecttype)%(objecttype)"], timeoutMs))
      .split("\n")
      .filter((type) => type.startsWith("commit")).length
    if (commitRefs === 0) {
      const refs = (await git(repo, "probe", ["for-each-ref", "--format=%(refname)"], timeoutMs))
        .split("\n")
        .filter(Boolean)
      return { outcome: "empty", repo, refs: refs.length }
    }
    // The index first: the commit-graph write then reads commits through it. A store whose objects are all loose has
    // no pack to index, and git refuses the write there ("no pack files to index"), so it is skipped, not failed.
    const packs = countPacks(repo)
    if (typeof packs === "string") throw new StepFailed("probe", 0, packs)
    const indexStart = performance.now()
    try {
      if (packs > 0) await git(repo, "multi-pack-index", MAINTAIN_STORE_MULTI_PACK_INDEX_ARGS, timeoutMs)
    } finally {
      multiPackIndexMs = performance.now() - indexStart
    }
    const graphStart = performance.now()
    try {
      await git(repo, "commit-graph", MAINTAIN_STORE_COMMIT_GRAPH_ARGS, timeoutMs)
    } finally {
      commitGraphMs = performance.now() - graphStart
    }
    const refsStart = performance.now()
    try {
      await git(repo, "pack-refs", MAINTAIN_STORE_PACK_REFS_ARGS, timeoutMs)
    } finally {
      packRefsMs = performance.now() - refsStart
    }
    const chain = readChain(repo)
    if ("problem" in chain) throw new StepFailed("verify", 0, chain.problem)
    if (packs > 0) {
      const index = readMultiPackIndex(repo)
      if ("problem" in index) throw new StepFailed("verify", 0, index.problem)
    }
    const refs = (await git(repo, "verify", ["for-each-ref", "--format=%(refname)"], timeoutMs))
      .split("\n")
      .filter(Boolean)
    return {
      outcome: "maintained",
      repo,
      multiPackIndexMs,
      commitGraphMs,
      packRefsMs,
      refs: refs.length,
      layers: chain.layers,
    }
  } catch (error) {
    if (!(error instanceof StepFailed)) throw error
    return {
      outcome: "failed",
      repo,
      step: error.step,
      code: error.code,
      detail: error.detail,
      ...(multiPackIndexMs === undefined ? {} : { multiPackIndexMs }),
      ...(commitGraphMs === undefined ? {} : { commitGraphMs }),
      ...(packRefsMs === undefined ? {} : { packRefsMs }),
    }
  }
}

/** How many packs the store holds, or why its pack directory cannot be listed. */
function countPacks(repo: string): number | string {
  const directory = join(repo, "objects", "pack")
  try {
    return fs.readdirSync(directory).filter((name) => name.endsWith(".pack")).length
  } catch (error) {
    return `no readable pack directory at ${directory}: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** How many packs the store's multi-pack-index covers, from its header, or why it cannot be read. */
function readMultiPackIndex(repo: string): { packs: number } | { problem: string } {
  const file = join(repo, "objects", "pack", "multi-pack-index")
  let header: Buffer
  try {
    const fd = fs.openSync(file, "r")
    try {
      header = Buffer.alloc(12)
      const read = fs.readSync(fd, header, 0, 12, 0)
      if (read < 12) return { problem: `the multi-pack-index at ${file} is shorter than its 12-byte header` }
    } finally {
      fs.closeSync(fd)
    }
  } catch (error) {
    return {
      problem: `no readable multi-pack-index at ${file}: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  // Header (git's gitformat-pack): "MIDX", version, object id version, chunk count, base count, then the pack count.
  if (header.toString("latin1", 0, 4) !== "MIDX") {
    return { problem: `the multi-pack-index at ${file} does not start with its MIDX signature` }
  }
  return { packs: header.readUInt32BE(8) }
}

/**
 * A kept copy is maintained once this many packs sit outside its multi-pack-index (hh 33853): each fetch adds one, so
 * a copy read often is maintained about every 32 fetches, and most commands pay nothing.
 */
export const KEPT_STORE_UNINDEXED_PACK_LIMIT = 32

/**
 * Whether a kept copy needs {@link maintainStore} before a command reads it, decided from one directory listing and two
 * small file reads, with no git process (hh 33853, @cto fcdc1e71). A missing or unreadable commit-graph chain or
 * multi-pack-index is a reason to maintain, never a reason to skip. The answer names why, so a caller can say it.
 */
export function keptStoreMaintenanceReason(repo: string): string | undefined {
  const chain = readChain(repo)
  if ("problem" in chain) return chain.problem
  const packs = countPacks(repo)
  if (typeof packs === "string") return packs
  // All objects loose: there is nothing to index (maintainStore skips the index there too).
  if (packs === 0) return undefined
  const index = readMultiPackIndex(repo)
  if ("problem" in index) return index.problem
  const unindexed = packs - index.packs
  return unindexed > KEPT_STORE_UNINDEXED_PACK_LIMIT
    ? `${unindexed} packs outside the multi-pack-index (limit ${KEPT_STORE_UNINDEXED_PACK_LIMIT})`
    : undefined
}
