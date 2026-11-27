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
 * It also packs the loose objects a store's own writes leave behind (hh 33875). A rail writes one loose object per
 * change, `gc.auto=0` stops git ever packing them, and the live km store reached 1,528,296 loose objects - which is
 * why its doctor cannot witness integrity (a bounded `git fsck --full` cannot finish) and why every object read pays a
 * loose-object lookup. Git's own `loose-objects` maintenance task does it `@cto`-bounded: one batch, fifty thousand
 * objects by default (`maintenance.loose-objects.batchSize`), so one pass fits the shared bound below and a backlog
 * drains across passes, unattended. It is threshold-gated too, so a store that keeps up pays nothing.
 *
 * It then folds the small packs that task and the fetches leave behind (`git multi-pack-index repack --batch-size=`
 * then `expire`, hh 33875). The batch is a byte budget, not a pack count: one pass copies the whole packs that fit it
 * into one pack, so it stays inside the same shared bound and a long tail of small packs shrinks across passes, and it
 * is sized above the pack a loose-objects pass mints so those fold too. The
 * repack alone never removes what it folded - git leaves that to `expire`, which deletes only the packs the rewritten
 * index no longer references, so the count actually comes down and no object is lost. It runs after the
 * multi-pack-index write above, so the index already covers the new pack, and it is gated on how many packs are
 * smaller than half the budget - never on the total pack count, where a kept copy's fetch packs would trigger a pass
 * that folds nothing, and not on packs up to the whole budget, where the pack the last pass folded would count and be
 * copied again every pass.
 *
 * Non-pruning means no object and no ref value is lost. It does remove files: commit-graph layers that have left the
 * chain, only once older than {@link GRAPH_LAYER_GRACE} (git refreshes a layer's mtime when it retires it), the
 * loose ref files whose values `pack-refs` has just written into packed-refs, and the loose copies of objects a pack
 * already holds (the first step of the loose-objects task). No gc, no prune, no expire: an unreferenced object stays
 * reachable-proof for its writer, loose or packed.
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
/**
 * Index every pack the store holds in one file. Written AFTER the loose-objects task, so the index covers the pack it
 * just made.
 */
export const MAINTAIN_STORE_MULTI_PACK_INDEX_ARGS = ["multi-pack-index", "write", "--no-progress"] as const
/**
 * Git's own loose-objects task, and only that task: it repacks one batch of loose objects into a new `loose-` pack
 * (50,000 by default, `maintenance.loose-objects.batchSize`) after deleting the loose copies a pack already holds.
 * `--task=` names the one job, so no other maintenance task (gc, prune, expire, incremental-repack) can run from here
 * because of a store's config.
 */
export const MAINTAIN_STORE_LOOSE_OBJECTS_ARGS = ["maintenance", "run", "--task=loose-objects", "--quiet"] as const
/**
 * Run the task only once this many objects are loose. git's own `gc.auto` default, so a store that keeps up pays
 * nothing: below it, a pass would mint a new pack for a handful of objects and charge every caller for it.
 */
export const MAINTAIN_STORE_LOOSE_OBJECTS_MIN = 6_700
/**
 * Fold the small packs the loose-objects task keeps minting into bigger ones (`git multi-pack-index repack`), which
 * otherwise leave the store with one new `loose-` pack per pass and no end to the count. The batch is a SIZE budget,
 * not a pack count: `multi-pack-index repack` copies the whole small packs that fit in it, so one pass stays bounded by
 * that many bytes rather than by how many packs the store happens to hold. The multi-pack-index it reads is the one
 * this same pass just wrote, so the selection sees the new pack.
 */
export const MAINTAIN_STORE_MIDX_REPACK_ARGS = ["multi-pack-index", "repack", "--no-progress"] as const
/**
 * The size budget one repack pass may copy, in bytes. Sized ABOVE the pack a loose-objects pass mints, not below it:
 * `multi-pack-index repack` selects only packs whose expected size is under the batch, and one 50,000-object pass on
 * the live store lands at 59.5-77.9 MiB, so a 50 MiB budget could never fold the packs the drain itself makes - it
 * reclaimed the small fetch packs and left the drain's own to accumulate forever (@cto 2026-11-25, option b).
 * Measured on that store at this size: repack 15,350 ms + expire 640 ms, 27 -> 13 packs, inside the bound below.
 */
export const MAINTAIN_STORE_MIDX_REPACK_BATCH_BYTES = 256 * 1024 * 1024
/**
 * Delete the packs the repack just replaced. `multi-pack-index repack` writes the folded pack and rewrites the index
 * but removes nothing itself (git-multi-pack-index: "a later run of git multi-pack-index expire will delete the
 * pack-files that were part of this batch"); without it the count only ever grows. `expire` deletes only packs the
 * rewritten index no longer references (`.keep` packs excepted), so every object it removes is in the folded pack.
 */
export const MAINTAIN_STORE_MIDX_EXPIRE_ARGS = ["multi-pack-index", "expire", "--no-progress"] as const
/**
 * Run the repack only once this many packs are smaller than HALF the batch size. A store with a few small packs gains
 * nothing from folding them, and a store whose packs are all larger than the batch (a kept copy's fetch packs) would run
 * a pass that selects nothing - so the count of foldable packs is the gate, never the total pack count. Half, not the
 * whole budget, because a pass leaves its output near the batch size: counted at the whole budget, last pass's pack
 * would gate the next one and be copied again every time.
 */
export const MAINTAIN_STORE_MIDX_REPACK_MIN_PACKS = 8

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
      /** Present only when this pass ran the task; a store below the loose threshold is left alone. */
      looseObjectsMs?: number
      /** Present only when this pass folded a batch of small packs; a store below the foldable-pack threshold is left alone. */
      midxRepackMs?: number
      refs: number
      layers: number
    }>
  | Readonly<{ outcome: "empty"; repo: string; refs: number }>
  | Readonly<{ outcome: "graph-disabled"; repo: string; reason: string }>
  | Readonly<{
      outcome: "failed"
      repo: string
      step:
        | "probe"
        | "loose-objects"
        | "multi-pack-index"
        | "midx-repack"
        | "midx-expire"
        | "commit-graph"
        | "pack-refs"
        | "verify"
      code: number | "timeout"
      detail: string
      looseObjectsMs?: number
      midxRepackMs?: number
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
  /**
   * The loose-object count at which a pass runs the task. Defaults to {@link MAINTAIN_STORE_LOOSE_OBJECTS_MIN}; a test
   * or an owner with a different write rate may set another, and 0 runs it every pass.
   */
  looseObjectsMin?: number
  /**
   * The size budget for the midx repack, in bytes. Defaults to {@link MAINTAIN_STORE_MIDX_REPACK_BATCH_BYTES}; a test
   * picks a smaller one so a handful of tiny packs is already "small" against it.
   */
  midxRepackBatchBytes?: number
  /**
   * How many packs at or below that budget make a pass worth running. Defaults to
   * {@link MAINTAIN_STORE_MIDX_REPACK_MIN_PACKS}; a test sets its own.
   */
  midxRepackMinPacks?: number
}>

/** The bound each command gets: the default, or a shorter explicit one; never none, never past the cap. */
function commandBoundMs(requested: number | undefined, cap: number, name: string): number {
  if (requested === undefined) return cap
  if (!(requested > 0)) {
    throw new RangeError(`maintainStore ${name} must be a positive number, got ${String(requested)}`)
  }
  return Math.min(requested, cap)
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
  const timeoutMs = commandBoundMs(options.timeoutMs, MAINTAIN_STORE_TIMEOUT_MS, "timeoutMs")
  const looseObjectsMin = options.looseObjectsMin ?? MAINTAIN_STORE_LOOSE_OBJECTS_MIN
  if (!(Number.isSafeInteger(looseObjectsMin) && looseObjectsMin >= 0)) {
    throw new RangeError(`maintainStore looseObjectsMin must be a whole number >= 0, got ${String(looseObjectsMin)}`)
  }
  const midxRepackBatchBytes = options.midxRepackBatchBytes ?? MAINTAIN_STORE_MIDX_REPACK_BATCH_BYTES
  if (!(Number.isSafeInteger(midxRepackBatchBytes) && midxRepackBatchBytes > 0)) {
    throw new RangeError(
      `maintainStore midxRepackBatchBytes must be a whole number > 0, got ${String(midxRepackBatchBytes)}`,
    )
  }
  const midxRepackMinPacks = options.midxRepackMinPacks ?? MAINTAIN_STORE_MIDX_REPACK_MIN_PACKS
  if (!(Number.isSafeInteger(midxRepackMinPacks) && midxRepackMinPacks >= 0)) {
    throw new RangeError(
      `maintainStore midxRepackMinPacks must be a whole number >= 0, got ${String(midxRepackMinPacks)}`,
    )
  }
  let looseObjectsMs: number | undefined
  let midxRepackMs: number | undefined
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
    // The loose-objects task first, so the index and the graph below cover the pack it makes.
    const loose = await countLooseObjects(repo, timeoutMs)
    if (loose >= looseObjectsMin) {
      const looseStart = performance.now()
      try {
        await git(repo, "loose-objects", MAINTAIN_STORE_LOOSE_OBJECTS_ARGS, timeoutMs)
      } finally {
        looseObjectsMs = performance.now() - looseStart
      }
    }
    // The index next: the commit-graph write then reads commits through it. A store whose objects are all loose has
    // no pack to index, and git refuses the write there ("no pack files to index"), so it is skipped, not failed.
    const packs = countPacks(repo)
    if (typeof packs === "string") throw new StepFailed("probe", 0, packs)
    const indexStart = performance.now()
    try {
      if (packs > 0) await git(repo, "multi-pack-index", MAINTAIN_STORE_MULTI_PACK_INDEX_ARGS, timeoutMs)
    } finally {
      multiPackIndexMs = performance.now() - indexStart
    }
    // Then the fold: the small packs the task and the fetches leave behind, into one pack the index above already
    // covers, and the packs it replaced deleted - the repack writes the pack but removes nothing by itself.
    const foldable = countFoldablePacks(repo, midxRepackBatchBytes)
    if (typeof foldable === "string") throw new StepFailed("probe", 0, foldable)
    if (foldable > midxRepackMinPacks) {
      const repackStart = performance.now()
      try {
        await git(
          repo,
          "midx-repack",
          [...MAINTAIN_STORE_MIDX_REPACK_ARGS, `--batch-size=${midxRepackBatchBytes}`],
          timeoutMs,
        )
        await git(repo, "midx-expire", MAINTAIN_STORE_MIDX_EXPIRE_ARGS, timeoutMs)
      } finally {
        midxRepackMs = performance.now() - repackStart
      }
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
      ...(looseObjectsMs === undefined ? {} : { looseObjectsMs }),
      ...(midxRepackMs === undefined ? {} : { midxRepackMs }),
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
      ...(looseObjectsMs === undefined ? {} : { looseObjectsMs }),
      ...(midxRepackMs === undefined ? {} : { midxRepackMs }),
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

/** How many objects the store holds loose, or a refusal naming what git printed instead of a count. */
async function countLooseObjects(repo: string, timeoutMs: number): Promise<number> {
  const printed = await git(repo, "probe", ["count-objects", "-v"], timeoutMs)
  const match = /^count: (\d+)$/mu.exec(printed)
  if (match?.[1] === undefined) {
    throw new StepFailed("probe", 0, `git count-objects -v printed no count: ${JSON.stringify(printed)}`)
  }
  return Number(match[1])
}

/**
 * How many packs the fold would consider worth it: those smaller than half the batch size, whose whole contents
 * `multi-pack-index repack` copies in one pass. Anything at or above that is either never folded by this budget (a
 * kept copy's fetch packs) or the shape the last pass just wrote; counting either would gate a pass that selects
 * nothing or re-copy what was just written. A pack directory that cannot be listed is a named refusal, never a zero.
 */
function countFoldablePacks(repo: string, batchBytes: number): number | string {
  const directory = join(repo, "objects", "pack")
  let entries: string[]
  try {
    entries = fs.readdirSync(directory)
  } catch (error) {
    return `no readable pack directory at ${directory}: ${error instanceof Error ? error.message : String(error)}`
  }
  let foldable = 0
  for (const entry of entries) {
    if (!entry.endsWith(".pack")) continue
    try {
      if (fs.statSync(join(directory, entry)).size * 2 < batchBytes) foldable++
    } catch (error) {
      // A pack that vanished between the listing and the stat is one this pass will not see; the next pass will.
      // Any other stat failure is a store this count cannot read, so it propagates.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return foldable
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
