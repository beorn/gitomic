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

/**
 * What one call did. `maintained` only when both commands succeeded AND the graph is really there: a chain file whose
 * every listed layer exists. `refs` and `layers` are observations, not promises: writes may overlap, and a concurrent
 * update legitimately leaves a newer loose ref over a packed tip, which this never fails on and never removes.
 * Everything else is named (NO SILENT ERRORS): a store with no commits is `empty`; a store whose config disables the
 * commit-graph is `graph-disabled`, because git would exit 0 there without writing one; a failed step names itself.
 */
export type StoreMaintenance =
  | Readonly<{
      outcome: "maintained"
      repo: string
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
      step: "probe" | "commit-graph" | "pack-refs" | "verify"
      code: number | "timeout"
      detail: string
      commitGraphMs?: number
      packRefsMs?: number
    }>

export type MaintainStoreOptions = Readonly<{
  /** Each git command's own bound; a command past it is stopped and the call answers `failed` with `timeout`. */
  timeoutMs?: number
}>

type Step = Extract<StoreMaintenance, { outcome: "failed" }>["step"]

class StepFailed extends Error {
  constructor(
    readonly step: Step,
    readonly code: number | "timeout",
    readonly detail: string,
  ) {
    super(`${step}: ${detail}`)
  }
}

async function git(repo: string, step: Step, args: readonly string[], timeoutMs: number | undefined): Promise<string> {
  let result
  try {
    result = await runGit(["--git-dir", repo, ...args], timeoutMs === undefined ? {} : { timeoutMs })
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

/** Write the store's commit-graph incrementally and pack its refs; see {@link StoreMaintenance} for what it answers. */
export async function maintainStore(repo: string, options: MaintainStoreOptions = {}): Promise<StoreMaintenance> {
  const { timeoutMs } = options
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
    const refs = (await git(repo, "verify", ["for-each-ref", "--format=%(refname)"], timeoutMs))
      .split("\n")
      .filter(Boolean)
    return { outcome: "maintained", repo, commitGraphMs, packRefsMs, refs: refs.length, layers: chain.layers }
  } catch (error) {
    if (!(error instanceof StepFailed)) throw error
    return {
      outcome: "failed",
      repo,
      step: error.step,
      code: error.code,
      detail: error.detail,
      ...(commitGraphMs === undefined ? {} : { commitGraphMs }),
      ...(packRefsMs === undefined ? {} : { packRefsMs }),
    }
  }
}
