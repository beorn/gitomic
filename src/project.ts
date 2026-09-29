/**
 * Reconcile a checkout with the branch it has checked out, after that branch
 * advanced object-side.
 *
 * Gitomic builds commits directly in the object database and moves the ref; no
 * working tree is in the loop. The checkout is then stale: `git diff
 * --name-only HEAD` reports the whole inverse delta as dirt, and every guard
 * that refuses on dirt then refuses, naming files nobody edited. One
 * unreconciled ref move bricks writing for every process sharing the checkout.
 *
 * ## Why this is NOT `git reset --keep`
 *
 * `--keep` is right when the commit was built in an isolated carrier worktree,
 * because the SHARED checkout's branch has not moved yet and `--keep` genuinely
 * moves it, keeping local modifications or aborting.
 *
 * A Gitomic transaction is the opposite case and `--keep` silently does
 * nothing. HEAD is a symbolic ref to the branch, so the instant the CAS lands
 * HEAD already reports the new commit; `reset --keep <new>` finds HEAD and
 * target identical, updates no file, and exits 0. Measured on a throwaway repo:
 * dirt `[@i/one.md, @i/two.md]` before, exit 0, and the same dirt after.
 *
 * What still holds the distinction is the INDEX, which was written when the
 * checkout last matched the old commit. `git read-tree -m -u <old> <new>` is a
 * two-way merge against that index: it updates every path whose working copy is
 * still the old committed content, preserves unrelated dirt, and refuses with
 * `Entry '<path>' not uptodate. Cannot merge.` when a path the transaction
 * touched also carries an uncommitted local edit. That refusal is the whole
 * safety property, and it is only available while the index still remembers the
 * old commit — which is why the caller must capture `from` BEFORE the swap,
 * inside the same locked section.
 */

import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

import { readStateCheckoutDeclaration } from "./candidate.js"
import { objectOid } from "./git-object.js"
import { DEFAULT_REMOTE_TIMEOUT_MS, runGit } from "./shell.js"

/**
 * Front read-only git invocations with `--no-optional-locks` so a repeated
 * reader never takes `.git/index.lock` to refresh the cached index and starve a
 * real writer. Output is byte-identical; only the stat-cache write-back is
 * skipped. Both this flag and `-C` are global (pre-subcommand) options, so a
 * plain prepend is always well-formed.
 */
const NO_OPTIONAL_LOCKS = "--no-optional-locks"

function readonlyArgs(args: readonly string[]): string[] {
  return args.includes(NO_OPTIONAL_LOCKS) ? [...args] : [NO_OPTIONAL_LOCKS, ...args]
}

export interface CheckoutSyncRequest {
  /** The checkout to bring forward. */
  readonly repoRoot: string
  /**
   * Commit the checkout's index and working tree reflect — the ref's value read
   * BEFORE the transaction, under the same lock. Reading it afterwards is
   * useless: HEAD has already followed the branch.
   */
  readonly from: string
  /** Commit the ref points at now. */
  readonly to: string
  /** Fully-qualified branch the transaction advanced, e.g. `refs/heads/main`. */
  readonly ref: string
  /**
   * Dirt observed before the ref moved. Reconciliation must leave exactly this
   * pathset behind; anything else means it touched authored work.
   */
  readonly expectedDirtyPaths: readonly string[]
  /**
   * The paths whose checkout content IS this landing: a write authored in the checkout (25350 S3) lands files the
   * caller already wrote, so they are dirty with exactly the landed content. Each must be a path the landing
   * changed and must already hold `to`'s blob (or be absent for a removal); the projection proves that for all of
   * them before staging exactly them, and never writes one. Repository-relative, as every gitomic path is.
   */
  readonly authoredPaths?: readonly string[] | undefined
}

export type CheckoutSyncOutcome =
  /** Index and working tree now hold `to`, and the dirt is the pathset we started with. */
  | {
      readonly ok: true
      readonly kind: "synchronized"
      readonly dirtyPaths: readonly string[]
      /** The ancestor whose tree the index still held; it was carried forward first (25393). */
      readonly repairedIndexFrom?: string
    }
  /** The ref did not move, so there is nothing to bring forward. */
  | {
      readonly ok: true
      readonly kind: "already-current"
      readonly dirtyPaths: readonly string[]
    }
  /** A bare repository has no working tree to reconcile. */
  | { readonly ok: true; readonly kind: "bare" }
  /** HEAD is detached or on another branch, so no two-way merge can reconcile this checkout. */
  | {
      readonly ok: false
      readonly kind: "wrong-branch"
      readonly error: string
      readonly checkedOutRef: string | null
    }
  /** The two-way merge refused rather than overwrite an uncommitted local edit. */
  | {
      readonly ok: false
      readonly kind: "worktree-update-refused"
      readonly error: string
      readonly expectedDirtyPaths: readonly string[]
      readonly gitDetail: string
    }
  /**
   * The two-way merge could not take the index lock another git process holds, so it never ran: no dirt was weighed,
   * and the index and working tree are as they were. Chosen only from the failed merge's own stderr; a caller may take
   * the checkout again once the holder lets go.
   */
  | {
      readonly ok: false
      readonly kind: "index-locked"
      readonly error: string
      readonly gitDetail: string
      /** The lock file git named. */
      readonly lockPath: string
      /** The lock's age when read, or null when it was already gone or unreadable: an old one is a dead process's. */
      readonly lockAgeMs: number | null
    }
  /** The merge ran but the resulting dirt could not be read back. */
  | { readonly ok: false; readonly kind: "dirt-unverifiable"; readonly error: string }
  /**
   * An `authoredPaths` entry is not this landing: the landing did not change it, or the checkout's content is not
   * the landed blob. Nothing was staged; the index is exactly as the carry left it.
   */
  | {
      readonly ok: false
      readonly kind: "authored-mismatch"
      readonly error: string
      readonly path: string
      /** The checkout's blob, or null when the file is absent. */
      readonly checkoutOid: string | null
      /** The landing's blob, or null when the landing removes the path. */
      readonly landedOid: string | null
    }
  /** The merge ran and changed which paths are dirty — authored work moved under someone. */
  | {
      readonly ok: false
      readonly kind: "dirt-changed"
      readonly error: string
      readonly expectedDirtyPaths: readonly string[]
      readonly observedDirtyPaths: readonly string[]
    }

export interface GitOutcome {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

/** @internal The local git runner, exported for its own test only. */
export function gitOutcomeForTest(repoRoot: string, args: readonly string[]): GitOutcome {
  return git(repoRoot, args)
}

/**
 * One local git command. A command that did not run to completion — it could not start (ENOENT), its output passed
 * `maxBuffer` (ENOBUFS, default 1 MiB), or a signal stopped it — is a failure that names that cause, with no stdout:
 * what it printed is truncated, and offering it as the failure's detail would misstate what went wrong.
 */
function git(repoRoot: string, args: readonly string[], maxBuffer?: number): GitOutcome {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    // git's own words are read here (an index.lock refusal is classified from its stderr), so they must be English,
    // as the shell backend's runner pins them.
    env: { ...process.env, LC_ALL: "C" },
    ...(maxBuffer === undefined ? {} : { maxBuffer }),
  })
  if (result.error !== undefined || result.status === null) {
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code
    const cause = result.error === undefined ? "" : (code ?? result.error.message)
    const signal = result.signal === null ? "" : `killed by ${result.signal}`
    return {
      status: result.status ?? 1,
      stdout: "",
      stderr: `git ${args.join(" ")} did not run to completion: ${[cause, signal].filter(Boolean).join(", ")}`,
    }
  }
  return {
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  }
}

/**
 * A Git command that contacts a remote, bounded by Gitomic's runner. A command
 * stopped at its limit, or one that could not start, is a failed outcome whose
 * detail names why, like any other failed Git command here.
 */
async function gitRemote(
  repoRoot: string,
  args: readonly string[],
  timeoutMs = DEFAULT_REMOTE_TIMEOUT_MS,
): Promise<GitOutcome> {
  try {
    const result = await runGit(["-C", repoRoot, ...args], { timeoutMs })
    return {
      status: result.code,
      stdout: result.stdout.toString("utf8").trim(),
      stderr: result.stderr.toString("utf8").trim(),
    }
  } catch (error) {
    return { status: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }
  }
}

function gitDetail(result: GitOutcome): string {
  return result.stderr || result.stdout || `git exited ${result.status}`
}

type ReadTreeFailure = Extract<CheckoutSyncOutcome, { readonly kind: "worktree-update-refused" | "index-locked" }>

/** git's own refusal to take a lock another process holds: `Unable to create '<path>/index.lock': File exists.` */
const INDEX_LOCK_HELD = /Unable to create '([^']*index\.lock)': File exists/u

/**
 * The one reading of a failed `read-tree -m -u`, for every site that runs one. A merge that could not take the index
 * lock never weighed any dirt, so it is `index-locked`, named from the merge's own stderr and never from a later
 * probe; any other failure is the refusal to overwrite an uncommitted edit. Each site words both.
 */
function classifyReadTreeFailure(
  merged: GitOutcome,
  expectedDirtyPaths: readonly string[],
  words: {
    readonly refused: (detail: string) => string
    readonly locked: (lock: { readonly lockPath: string; readonly lockAge: string; readonly detail: string }) => string
  },
): ReadTreeFailure {
  const detail = gitDetail(merged)
  const lockPath = INDEX_LOCK_HELD.exec(merged.stderr)?.[1]
  if (lockPath !== undefined) {
    const lockAgeMs = lockAgeOf(lockPath)
    const lockAge = lockAgeMs === null ? "age unknown: gone or unreadable when read" : `${Math.round(lockAgeMs)} ms old`
    return {
      ok: false,
      kind: "index-locked",
      gitDetail: detail,
      lockPath,
      lockAgeMs,
      error: words.locked({ lockPath, lockAge, detail }),
    }
  }
  return {
    ok: false,
    kind: "worktree-update-refused",
    expectedDirtyPaths: [...expectedDirtyPaths].sort(),
    gitDetail: detail,
    error: words.refused(detail),
  }
}

function lockAgeOf(lockPath: string): number | null {
  try {
    return Math.max(0, Date.now() - statSync(lockPath).mtimeMs)
  } catch {
    // Released between git's refusal and this read, or unreadable: the age is unknown, and the outcome says so.
    // silent-fallback-allow: null is the outcome's named "age unknown"; the error text prints it as such
    return null
  }
}

/**
 * Fetch `ref`'s tip from `remote` through a private scratch ref, never FETCH_HEAD: that file is shared with
 * whatever else fetches in this checkout, so writing it clobbers another reader's, and reading it back can read theirs.
 * The scratch ref is released before this returns; the fetched objects stay until the branch advances onto them.
 */
async function fetchTip(
  repoRoot: string,
  remote: string,
  ref: string,
  timeoutMs: number,
): Promise<{ readonly ok: true; readonly oid: string } | { readonly ok: false; readonly detail: string }> {
  const source = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`
  const scratch = `refs/gitomic/fetch/${randomUUID()}`
  const fetched = await gitRemote(
    repoRoot,
    ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, `+${source}:${scratch}`],
    timeoutMs,
  )
  const tip = git(repoRoot, readonlyArgs(["rev-parse", "--verify", "--quiet", `${scratch}^{commit}`]))
  // Released on every path: a fetch stopped at its limit after git wrote the ref would otherwise leave it behind.
  const unreleased = tip.status === 0 ? releaseScratch(repoRoot, scratch) : undefined
  const leak = unreleased === undefined ? "" : `; the scratch ref ${scratch} could not be released (${unreleased})`
  if (fetched.status !== 0) return { ok: false, detail: `${gitDetail(fetched)}${leak}` }
  if (tip.status !== 0 || tip.stdout === "") {
    return { ok: false, detail: `the fetched tip is unreadable (${gitDetail(tip)})${leak}` }
  }
  if (unreleased !== undefined) return { ok: false, detail: `fetched ${tip.stdout}${leak}` }
  return { ok: true, oid: tip.stdout }
}

/** Delete a scratch ref; the failure's detail, or undefined once it is gone. */
function releaseScratch(repoRoot: string, scratch: string): string | undefined {
  const released = git(repoRoot, ["update-ref", "-d", scratch])
  return released.status === 0 ? undefined : gitDetail(released)
}

function nulPaths(output: string): string[] {
  return output.split("\0").filter((path) => path.length > 0)
}

/**
 * Every path a checkout would report as uncommitted work: tracked modifications
 * against HEAD plus untracked files that are not ignored.
 *
 * This is the pathset reconciliation must preserve exactly, so it must see the
 * same things the guards that refuse on dirt see.
 */
export function worktreeDirtyPaths(repoRoot: string): string[] {
  const tracked = git(repoRoot, readonlyArgs(["diff", "--name-only", "-z", "HEAD", "--"]))
  if (tracked.status !== 0) throw new Error(`read tracked worktree dirt failed: ${gitDetail(tracked)}`)
  const untracked = git(repoRoot, readonlyArgs(["ls-files", "--others", "--exclude-standard", "-z"]))
  if (untracked.status !== 0) throw new Error(`read untracked worktree dirt failed: ${gitDetail(untracked)}`)
  return [...new Set([...nulPaths(tracked.stdout), ...nulPaths(untracked.stdout)])].sort()
}

type IndexCarry =
  | { readonly ok: true; readonly expectedDirtyPaths: string[]; readonly repairedIndexFrom?: string }
  | { readonly ok: false; readonly outcome: Extract<CheckoutSyncOutcome, { readonly ok: false }> }

/**
 * Bring an index that still holds an ANCESTOR's tree forward to `tip`, before any projection judges the ref.
 *
 * A commit that advanced the ref while its own checkout update was refused (25393: a hook commit that lost the
 * index.lock race) leaves the index at its parent, and `gitomic apply` commits without the index, so any number of
 * later landings can leave it further behind. The index's tree id is matched against `tip`'s first-parent history in
 * ONE walk, with no depth cliff; the first match is carried forward by the conditional two-way merge every projection
 * uses, so unrelated dirt survives and an edit to a path the skipped commits wrote refuses. An index already at
 * `tip`, or at `alreadyAt` (a projection re-running after its probe merge), needs nothing. An index that holds no
 * ancestor's tree carries staged changes no projection may overwrite, and refuses. `expectedDirtyPaths` comes back
 * without the paths the repair resolved.
 *
 * Reading the index never takes `.git/index.lock`: another git may hold it at any moment (a hook commit), and a
 * projector that took it would both refuse while that git runs and collide with it, which is how an index is left
 * behind in the first place. The healthy path compares with `diff-index --cached`, which is lock-free; only when the
 * index matches neither `tip` nor `alreadyAt` is its tree id read, by `write-tree` over a COPY of the index.
 */
function carryIndexTo(
  repoRoot: string,
  tip: string,
  ref: string,
  expectedDirtyPaths: readonly string[],
  alreadyAt?: string,
): IndexCarry {
  const refuse = (error: string): IndexCarry => ({
    ok: false,
    outcome: { ok: false, kind: "dirt-unverifiable", error },
  })
  const expected = [...expectedDirtyPaths]
  for (const commit of alreadyAt === undefined ? [tip] : [tip, alreadyAt]) {
    const same = git(repoRoot, readonlyArgs(["diff-index", "--cached", "--quiet", commit, "--"]))
    if (same.status === 0) return { ok: true, expectedDirtyPaths: expected }
    if (same.status !== 1) {
      return refuse(
        `${ref} in the checkout ${repoRoot}: the index could not be compared with ${commit} (${gitDetail(same)}). ` +
          "Nothing was changed.",
      )
    }
  }
  const indexTree = indexTreeFromCopy(repoRoot)
  if (!indexTree.ok) {
    return refuse(
      `${ref} in the checkout ${repoRoot}: the index's tree could not be read (${indexTree.detail}). ` +
        "Nothing was changed.",
    )
  }
  let scanned = 0
  let match: string | undefined
  for (let window = 0; match === undefined; window += 1) {
    const count = walkWindow(window)
    const page = git(
      repoRoot,
      readonlyArgs([
        "rev-list",
        "--first-parent",
        "--no-commit-header",
        "--format=%H %T",
        `--max-count=${count}`,
        `--skip=${scanned}`,
        tip,
        "--",
      ]),
      count * WALK_LINE_BYTES_MAX,
    )
    if (page.status !== 0) {
      return refuse(`${ref} in the checkout ${repoRoot}: the history of ${tip} could not be read (${gitDetail(page)}).`)
    }
    const lines = page.stdout.split("\n").filter(Boolean)
    scanned += lines.length
    match = lines.find((line) => line.endsWith(` ${indexTree.tree}`))
    if (match === undefined && lines.length < count) break
  }
  if (match === undefined) {
    return refuse(
      `${ref} in the checkout ${repoRoot}: the index holds neither ${tip}'s tree nor that of any of its ` +
        `${scanned - 1} first-parent ancestors, so it carries staged changes no projection may overwrite. ` +
        "Nothing was changed; project again once the index holds one of those trees.",
    )
  }
  const ancestor = match.slice(0, match.indexOf(" "))
  if (ancestor === tip) return { ok: true, expectedDirtyPaths: expected }
  const delta = git(repoRoot, readonlyArgs(["diff", "--name-only", "-z", ancestor, tip, "--"]))
  if (delta.status !== 0) {
    return refuse(
      `${ref} in the checkout ${repoRoot}: the paths between ${ancestor} and ${tip} could not be read ` +
        `(${gitDetail(delta)}). Nothing was changed.`,
    )
  }
  // Dirt is measured against HEAD (`tip`), so a worktree file already equal to tip is absent from `expected` even
  // though the stale index still holds `ancestor`. Inspect the skipped commit's delta instead.
  const matching = matchingLandingDirt(repoRoot, ancestor, tip, nulPaths(delta.stdout))
  if (!matching.ok) return refuse(`${ref} in ${repoRoot}: ${matching.detail}. Nothing was changed.`)
  const staged = stageAuthoredPaths(repoRoot, ref, ancestor, tip, matching.paths, expected)
  if (!staged.ok) return { ok: false, outcome: staged.outcome }
  const merged = git(repoRoot, ["read-tree", "-m", "-u", ancestor, tip])
  if (merged.status !== 0) {
    const unstaged = unstageAuthoredPaths(repoRoot, ancestor, matching.paths)
    const unstageNote = unstaged === undefined ? "" : ` The matching paths could not be unstaged: ${unstaged}.`
    return {
      ok: false,
      outcome: classifyReadTreeFailure(merged, expected, {
        refused: (detail) =>
          `${ref} in the checkout ${repoRoot} is at ${tip}, but its index still holds ${ancestor}'s tree and could ` +
          `not be brought forward without overwriting an uncommitted local edit (${detail}). The index ` +
          `and working tree are unchanged.${unstageNote}`,
        locked: ({ lockPath, lockAge, detail }) =>
          `${ref} in the checkout ${repoRoot} is at ${tip}, but its index still holds ${ancestor}'s tree and could ` +
          `not be brought forward: another git process holds ${lockPath} (${lockAge}; ${detail}). No dirt was ` +
          `weighed; the index and working tree are unchanged.${unstageNote}`,
      }),
    }
  }
  const resolved = new Set(nulPaths(delta.stdout))
  return { ok: true, expectedDirtyPaths: expected.filter((path) => !resolved.has(path)), repairedIndexFrom: ancestor }
}

/**
 * The first-parent walk's windows, in commits. An index a few commits behind is the common case, so the first window
 * is small; later ones grow so a long history costs few processes. The walk stops at the match, so its cost is bounded
 * by how far behind the index is, never by the length of the history.
 */
function walkWindow(index: number): number {
  return index === 0 ? 256 : index === 1 ? 4_096 : 10_000
}
/** One `%H %T` line: two sha256 ids, a space and a newline, rounded up. */
const WALK_LINE_BYTES_MAX = 160

/**
 * The tree id the index holds, written from a copy of it so that `.git/index.lock` is never taken. The copy sits
 * beside the index, in the directory `git rev-parse --git-path index` names, because a split index finds its shared
 * file there; it is removed afterwards. `write-tree` only adds tree objects to the store.
 */
function indexTreeFromCopy(repoRoot: string): { ok: true; tree: string } | { ok: false; detail: string } {
  const located = git(repoRoot, readonlyArgs(["rev-parse", "--path-format=absolute", "--git-path", "index"]))
  if (located.status !== 0 || located.stdout === "") return { ok: false, detail: gitDetail(located) }
  const copy = join(dirname(located.stdout), `index.gitomic-read-${process.pid}-${randomUUID()}`)
  try {
    copyFileSync(located.stdout, copy)
  } catch (error) {
    return { ok: false, detail: `copying ${located.stdout}: ${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    const written = spawnSync("git", ["-C", repoRoot, "write-tree"], {
      encoding: "utf8",
      env: { ...process.env, GIT_INDEX_FILE: copy },
    })
    const tree = (written.stdout ?? "").trim()
    if ((written.status ?? 1) !== 0 || tree === "") {
      return {
        ok: false,
        detail: gitDetail({ status: written.status ?? 1, stdout: tree, stderr: (written.stderr ?? "").trim() }),
      }
    }
    return { ok: true, tree }
  } finally {
    rmSync(copy, { force: true })
  }
}

/** The branch HEAD points at, or null when HEAD is detached. */
export function checkedOutRef(repoRoot: string): string | null {
  const symbolic = git(repoRoot, readonlyArgs(["symbolic-ref", "--quiet", "HEAD"]))
  return symbolic.status === 0 && symbolic.stdout !== "" ? symbolic.stdout : null
}

export function isBareRepository(repoRoot: string): boolean {
  const bare = git(repoRoot, readonlyArgs(["rev-parse", "--is-bare-repository"]))
  return bare.status === 0 && bare.stdout === "true"
}

type DirtRead = { readonly ok: true; readonly paths: string[] } | { readonly ok: false; readonly detail: string }

type AuthoredStage =
  | { readonly ok: true; readonly expectedDirtyPaths: string[] }
  | { readonly ok: false; readonly outcome: Extract<CheckoutSyncOutcome, { readonly ok: false }> }

/** Prove exact matches and name every dirty landing path that Git's two-way merge must not overwrite. */
function matchingLandingDirt(
  repoRoot: string,
  from: string,
  to: string,
  dirtyPaths: readonly string[],
):
  | { readonly ok: true; readonly paths: string[]; readonly blockers: string[] }
  | { readonly ok: false; readonly detail: string } {
  const top = git(repoRoot, readonlyArgs(["rev-parse", "--show-toplevel"]))
  if (top.status !== 0 || top.stdout === "") {
    return { ok: false, detail: `reading the checkout's top level: ${gitDetail(top)}` }
  }
  const topLevel = top.stdout
  const changed = git(topLevel, readonlyArgs(["diff", "--name-only", "-z", "--no-renames", from, to, "--"]))
  if (changed.status !== 0) return { ok: false, detail: `reading the landing's changed paths: ${gitDetail(changed)}` }
  const landingPaths = new Set(nulPaths(changed.stdout))
  const candidates = dirtyPaths.filter((path) => landingPaths.has(path))
  if (candidates.length === 0) return { ok: true, paths: [], blockers: [] }
  const listed = git(topLevel, readonlyArgs(["ls-tree", "--full-tree", "-z", to, "--", ...candidates]))
  if (listed.status !== 0) return { ok: false, detail: `reading the landing's tree: ${gitDetail(listed)}` }
  const landed = new Map<string, { mode: string; oid: string }>()
  for (const entry of nulPaths(listed.stdout)) {
    const tab = entry.indexOf("\t")
    const [mode, , oid] = entry.slice(0, tab).split(" ")
    if (mode !== undefined && oid !== undefined) landed.set(entry.slice(tab + 1), { mode, oid })
  }
  const algorithm = /^[0-9a-f]{64}$/.test(to) ? "sha256" : "sha1"
  const paths: string[] = []
  for (const path of candidates) {
    let stat: ReturnType<typeof lstatSync> | undefined
    try {
      stat = lstatSync(join(topLevel, path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { ok: false, detail: `reading ${path}: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const target = landed.get(path)
    if (stat === undefined) {
      if (target === undefined) paths.push(path)
    } else if (
      stat.isFile() &&
      (target?.mode === "100644" || target?.mode === "100755") &&
      (Number(stat.mode) & 0o111 ? "100755" : "100644") === target.mode
    ) {
      try {
        if (objectOid("blob", readFileSync(join(topLevel, path)), algorithm) === target.oid) paths.push(path)
      } catch (error) {
        return { ok: false, detail: `reading ${path}: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
  }
  const matching = new Set(paths)
  return { ok: true, paths, blockers: candidates.filter((path) => !matching.has(path)) }
}

/**
 * Stage exactly the paths whose checkout content IS the landing `from` -> `to` (25350 S3, @cto 7473e4ec), and drop
 * them from the dirt the projection must preserve. Every path is proven first — changed by the landing, and the
 * checkout holding `to`'s blob or absent for a removal — so a mismatch refuses with nothing staged: the index stays
 * exactly as the carry left it and the next catch-up can still project. No authored path is ever written here.
 */
function stageAuthoredPaths(
  repoRoot: string,
  ref: string,
  from: string,
  to: string,
  authoredPaths: readonly string[],
  expectedDirtyPaths: readonly string[],
): AuthoredStage {
  if (authoredPaths.length === 0) return { ok: true, expectedDirtyPaths: [...expectedDirtyPaths] }
  const mismatch = (
    path: string,
    checkoutOid: string | null,
    landedOid: string | null,
    why: string,
  ): AuthoredStage => ({
    ok: false,
    outcome: {
      ok: false,
      kind: "authored-mismatch",
      path,
      checkoutOid,
      landedOid,
      error:
        `${ref} in the checkout ${repoRoot}: ${JSON.stringify(path)} was named as authored content of the landing ` +
        `${from} -> ${to}, but ${why} (checkout ${checkoutOid ?? "absent"}, landed ${landedOid ?? "absent"}). ` +
        "Nothing was staged and the index is unchanged; the landing is complete and safe in the ref.",
    },
  })
  const unreadable = (what: string, result: GitOutcome): AuthoredStage => ({
    ok: false,
    outcome: {
      ok: false,
      kind: "dirt-unverifiable",
      error:
        `${ref} in the checkout ${repoRoot}: ${what} could not be read (${gitDetail(result)}), so the authored ` +
        "paths cannot be proven to be the landing. Nothing was staged and the index is unchanged.",
    },
  })

  const top = git(repoRoot, readonlyArgs(["rev-parse", "--show-toplevel"]))
  if (top.status !== 0) return unreadable("the checkout's top level", top)
  const topLevel = top.stdout.trim()
  const changed = git(topLevel, readonlyArgs(["diff", "--name-only", "-z", "--no-renames", from, to, "--"]))
  if (changed.status !== 0) return unreadable(`the landing's diff ${from} -> ${to}`, changed)
  const landingPaths = new Set(nulPaths(changed.stdout))
  const listed = git(topLevel, readonlyArgs(["ls-tree", "--full-tree", "-z", to, "--", ...authoredPaths]))
  if (listed.status !== 0) return unreadable(`${to}'s tree entries for the authored paths`, listed)
  const landed = new Map<string, string>()
  for (const entry of nulPaths(listed.stdout)) {
    const tab = entry.indexOf("\t")
    landed.set(entry.slice(tab + 1), entry.slice(0, tab).split(" ")[2] ?? "")
  }
  const algorithm = /^[0-9a-f]{64}$/.test(to) ? "sha256" : "sha1"

  // Verify every path before staging any: never a half-staged index.
  for (const path of authoredPaths) {
    const landedOid = landed.get(path) ?? null
    let content: Buffer | undefined
    try {
      content = readFileSync(join(topLevel, path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return unreadable(`the checkout file ${path} (${(error as Error).message})`, {
          status: 1,
          stdout: "",
          stderr: "",
        })
      }
    }
    const checkoutOid = content === undefined ? null : objectOid("blob", content, algorithm)
    if (!landingPaths.has(path)) return mismatch(path, checkoutOid, landedOid, "the landing did not change that path")
    if (checkoutOid !== landedOid) {
      return mismatch(path, checkoutOid, landedOid, "the checkout does not hold the landed content")
    }
  }

  const staged = git(topLevel, ["update-index", "--add", "--remove", "--", ...authoredPaths])
  if (staged.status !== 0) return unreadable("staging the authored paths", staged)
  const authored = new Set(authoredPaths)
  return { ok: true, expectedDirtyPaths: expectedDirtyPaths.filter((path) => !authored.has(path)) }
}

/** Put the authored paths' index entries back to `tip`'s; the working tree is untouched. Returns the failure, if any. */
function unstageAuthoredPaths(repoRoot: string, tip: string, authoredPaths: readonly string[]): string | undefined {
  if (authoredPaths.length === 0) return undefined
  const reset = git(repoRoot, ["reset", "-q", tip, "--", ...authoredPaths.map((path) => `:(top)${path}`)])
  return reset.status === 0 ? undefined : gitDetail(reset)
}

function readDirt(repoRoot: string): DirtRead {
  try {
    return { ok: true, paths: worktreeDirtyPaths(repoRoot) }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index])
}

/**
 * Bring `repoRoot`'s index and working tree from `from` to `to`.
 *
 * Every refusal names the checkout, the branch, both commits, and the paths at
 * stake, because the ref has ALREADY advanced by the time this runs: a silent
 * failure here leaves exactly the bricked state this module exists to prevent,
 * and the write refusals it then produces name files nobody edited.
 *
 * Runs under the caller's checkout lock (`gitomic/checkout-lock`) and never
 * takes it: a second open of the lock file in a process that already holds it
 * is a second open file description, which waits on its own holder until the
 * timeout.
 */
export function synchronizeCheckoutToCommit(request: CheckoutSyncRequest): CheckoutSyncOutcome {
  const { repoRoot, from, to, ref } = request
  if (isBareRepository(repoRoot)) return { ok: true, kind: "bare" }
  if (from !== to) {
    const branch = checkedOutRef(repoRoot)
    if (branch !== ref) {
      return {
        ok: false,
        kind: "wrong-branch",
        checkedOutRef: branch,
        error:
          `${ref} in the checkout ${repoRoot} advanced ${from} -> ${to}, but that checkout has ` +
          `${branch === null ? "a detached HEAD" : `${branch} checked out`}, so no two-way merge can reconcile it. ` +
          "The commit is complete and safe in the ref; nothing here was changed.",
      }
    }
  }

  // The index must hold `from` (or already `to`) before the two-way merge can be trusted: carry a stale one forward.
  const carried = carryIndexTo(repoRoot, from, ref, request.expectedDirtyPaths, to)
  if (!carried.ok) return carried.outcome
  const repaired = carried.repairedIndexFrom === undefined ? {} : { repairedIndexFrom: carried.repairedIndexFrom }
  const matching =
    from === to
      ? { ok: true as const, paths: [], blockers: [] }
      : matchingLandingDirt(repoRoot, from, to, carried.expectedDirtyPaths)
  if (!matching.ok) {
    return {
      ok: false,
      kind: "dirt-unverifiable",
      error: `${ref} in ${repoRoot}: ${matching.detail}. Nothing was changed.`,
    }
  }
  const stagedPaths = [...new Set([...(request.authoredPaths ?? []), ...matching.paths])]
  const authored = stageAuthoredPaths(repoRoot, ref, from, to, stagedPaths, carried.expectedDirtyPaths)
  if (!authored.ok) return authored.outcome
  if (matching.blockers.length > 0) {
    const unstage = unstageAuthoredPaths(repoRoot, from, stagedPaths)
    return {
      ok: false,
      kind: "worktree-update-refused",
      expectedDirtyPaths: [...carried.expectedDirtyPaths].sort(),
      gitDetail: `preflight overlap [${matching.blockers.join(", ")}]`,
      error:
        `${ref} in ${repoRoot}: ${from} -> ${to} would overwrite locally edited or removed paths ` +
        `[${matching.blockers.join(", ")}]. The checkout was not changed.` +
        (unstage === undefined ? "" : ` Could not unstage matching paths: ${unstage}.`),
    }
  }
  const expected = [...authored.expectedDirtyPaths].sort()
  if (from === to) {
    const current = readDirt(repoRoot)
    if (!current.ok) {
      return {
        ok: false,
        kind: "dirt-unverifiable",
        error:
          `${ref} in the checkout ${repoRoot} did not move from ${from}, but that checkout's working-tree ` +
          `dirt could not be read back: ${current.detail}. Nothing was changed.`,
      }
    }
    // Already-current is a VERIFIED claim, not a report of whatever was read:
    // a dirty pathset that no longer matches the capture means the index or
    // working tree does not reflect `to` exactly, and saying current over it
    // is the false report the moved-ref witness pins.
    if (!sameSet(current.paths, expected)) {
      return {
        ok: false,
        kind: "dirt-changed",
        expectedDirtyPaths: expected,
        observedDirtyPaths: current.paths,
        error:
          `${ref} in the checkout ${repoRoot} did not move from ${from}, but the checkout's dirty pathset ` +
          `[${current.paths.join(", ")}] does not match the [${expected.join(", ")}] captured with the ` +
          `operation, so the index or working tree does not reflect ${to} exactly. Nothing was changed.`,
      }
    }
    // Current is a claim about the index too: HEAD at `to` over an index that holds some other tree is the
    // stale checkout 25393 reported as current.
    const indexed = git(repoRoot, readonlyArgs(["diff-index", "--cached", "--quiet", to, "--"]))
    if (indexed.status !== 0) {
      return {
        ok: false,
        kind: "dirt-unverifiable",
        error:
          `${ref} in the checkout ${repoRoot} is at ${to}, but its index ` +
          `${indexed.status === 1 ? `does not hold ${to}'s tree` : `could not be compared with ${to} (${gitDetail(indexed)})`}, ` +
          "so the checkout is not current. Nothing was changed.",
      }
    }
    // A repaired index DID move, so the outcome says so: current only when nothing was brought forward.
    if (carried.repairedIndexFrom !== undefined) {
      return { ok: true, kind: "synchronized", dirtyPaths: current.paths, repairedIndexFrom: carried.repairedIndexFrom }
    }
    return { ok: true, kind: "already-current", dirtyPaths: current.paths }
  }

  const merged = git(repoRoot, ["read-tree", "-m", "-u", from, to])
  if (merged.status !== 0) {
    const unstaged = unstageAuthoredPaths(repoRoot, from, stagedPaths)
    const unstageNote =
      unstaged === undefined
        ? ""
        : ` The authored paths could NOT be unstaged back to ${from} (${unstaged}); the index holds them staged.`
    return classifyReadTreeFailure(merged, expected, {
      refused: (detail) =>
        `${ref} in the checkout ${repoRoot} advanced ${from} -> ${to}, but the checkout could not be ` +
        `brought forward without overwriting an uncommitted local edit to a path the transaction wrote ` +
        `(${detail}). Dirty at the time of the transaction: [${expected.join(", ")}]. Both the dirt ` +
        `and the commit are intact, and the index and working tree still hold their pre-advance state; until ` +
        "the checkout is reconciled, every write here refuses, naming the whole inverse delta as dirt." +
        unstageNote,
      locked: ({ lockPath, lockAge, detail }) =>
        `${ref} in the checkout ${repoRoot} advanced ${from} -> ${to}, but the checkout could not be brought ` +
        `forward: another git process holds ${lockPath} (${lockAge}; ${detail}). No dirt was weighed. The commit ` +
        "is intact, and the index and working tree still hold their pre-advance state; until the checkout is " +
        "reconciled once the lock is released, every write here refuses, naming the whole inverse delta as dirt." +
        unstageNote,
    })
  }

  const remaining = readDirt(repoRoot)
  if (!remaining.ok) {
    return {
      ok: false,
      kind: "dirt-unverifiable",
      error:
        `${ref} in the checkout ${repoRoot} advanced ${from} -> ${to} and the checkout followed, but its ` +
        `remaining dirt could not be verified: ${remaining.detail}.`,
    }
  }
  if (!sameSet(remaining.paths, expected)) {
    return {
      ok: false,
      kind: "dirt-changed",
      expectedDirtyPaths: expected,
      observedDirtyPaths: remaining.paths,
      error:
        `${ref} in the checkout ${repoRoot} advanced ${from} -> ${to} and the checkout followed, but ` +
        `reconciliation changed the unrelated dirty pathset from [${expected.join(", ")}] to ` +
        `[${remaining.paths.join(", ")}].`,
    }
  }
  return { ok: true, kind: "synchronized", dirtyPaths: remaining.paths, ...repaired }
}

export interface RemoteFirstProjectionRequest {
  /** The checkout whose projection catches up. */
  readonly repoRoot: string
  /** The commit that LANDED at the remote — the transport's returned oid. */
  readonly to: string
  /** Fully-qualified branch to project, e.g. `refs/heads/main`. */
  readonly ref: string
  /** Remote the landing went through; fetched to obtain `to` locally. */
  readonly remote: string
  /** Dirt observed before projecting, under the same lock; must survive exactly. */
  readonly expectedDirtyPaths: readonly string[]
  /**
   * The paths whose checkout content IS this landing: a write authored in the checkout (25350 S3) lands files the
   * caller already wrote, so they are dirty with exactly the landed content. Each must be a path the landing
   * changed and must already hold `to`'s blob (or be absent for a removal); the projection proves that for all of
   * them before staging exactly them, and never writes one. Repository-relative, as every gitomic path is.
   */
  readonly authoredPaths?: readonly string[] | undefined
  /** Limit, in milliseconds, for fetching the landing. Defaults to Gitomic's remote limit. */
  readonly remoteTimeoutMs?: number | undefined
  /**
   * Test seam (24161 failed-CAS witness, ruling bce97727): invoked after a
   * successful merge probe, immediately before the ref CAS, so a test can
   * advance the ref exactly the way a concurrent object-side writer does.
   * Production callers never set it.
   */
  readonly beforeRefAdvance?: (() => void) | undefined
}

export type RemoteFirstProjectionOutcome =
  | CheckoutSyncOutcome
  /** The landed commit could not be fetched or is not reachable from the remote. */
  | { readonly ok: false; readonly kind: "fetch-failed"; readonly error: string }
  /** Ancestry between the local tip and the landed commit could not be decided. */
  | { readonly ok: false; readonly kind: "ancestry-unverifiable"; readonly error: string }
  /** The branch moved between the ancestry check and the fast-forward. */
  | { readonly ok: false; readonly kind: "ref-advance-refused"; readonly error: string }
  /**
   * The receipt is contained in the local tip, but local-only commits above
   * the freshly fetched remote main strand that tip. All work is preserved and
   * nothing was changed; the landing is complete and this stale receipt
   * prescribes nothing.
   */
  | {
      readonly ok: false
      readonly kind: "stranded-local-commits"
      readonly error: string
      readonly landedOid: string
      readonly localTip: string
      readonly localOnly: readonly string[]
    }
  /**
   * The landing is complete and safe at the remote, but a local-only commit on
   * the live branch blocks the fast-forward. Nothing was changed; the caller
   * must never force, rewrite, or retry the semantic operation.
   */
  | {
      readonly ok: false
      readonly kind: "landed-but-unsynchronized"
      readonly error: string
      readonly landedOid: string
      readonly localTip: string
    }

/**
 * Project a checkout after its intent landed REMOTE-FIRST through the shared
 * off-checkout transport (the 24161 seam): fetch the landing, fast-forward the
 * local branch ONLY when it is a strict ancestor, then reuse the existing
 * two-way index merge above — this arm is a composition, never a third
 * synchronizer. Runs under the caller's checkout lock (`gitomic/checkout-lock`),
 * like every projection, and never takes it: a second open of the lock file in
 * a process that already holds it is a second open file description, which
 * waits on its own holder until the timeout.
 *
 * A local-only commit (the legacy strand) blocks the fast-forward and is
 * reported as `landed-but-unsynchronized`, naming both commits and the
 * preserved state — facts only (ruling 85521b17): recovery procedure belongs
 * to the caller, and this module never prescribes a force, a rewrite, or a
 * semantic retry.
 *
 * The fetch is the one remote command, bounded through Gitomic's runner. It
 * runs after publication succeeded, so a fetch stopped at its limit is the
 * `fetch-failed` outcome naming the limit, never a throw a caller could read
 * as an unpublished write.
 */
export async function projectRemoteFirstFastForward(
  request: RemoteFirstProjectionRequest,
): Promise<RemoteFirstProjectionOutcome> {
  const { repoRoot, to, ref, remote } = request
  if (isBareRepository(repoRoot)) return { ok: true, kind: "bare" }

  const branch = checkedOutRef(repoRoot)
  if (branch !== ref) {
    return {
      ok: false,
      kind: "wrong-branch",
      checkedOutRef: branch,
      error:
        `${ref} in the checkout ${repoRoot} has ${to} landed at ${remote}, but that checkout has ` +
        `${branch === null ? "a detached HEAD" : `${branch} checked out`}, so no projection can reconcile it. ` +
        "The landing is complete and safe at the remote; nothing here was changed.",
    }
  }

  const branchName = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref
  const fetched = await fetchTip(repoRoot, remote, ref, request.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS)
  if (!fetched.ok) {
    return {
      ok: false,
      kind: "fetch-failed",
      error:
        `${ref} in the checkout ${repoRoot}: fetching ${branchName} from ${remote} failed ` +
        `(${fetched.detail}). The landing ${to} is safe at the remote; nothing here was changed.`,
    }
  }
  const landedPresent = git(repoRoot, readonlyArgs(["rev-parse", "--verify", `${to}^{commit}`]))
  if (landedPresent.status !== 0) {
    return {
      ok: false,
      kind: "fetch-failed",
      error:
        `${ref} in the checkout ${repoRoot}: the landed commit ${to} is not reachable after fetching ` +
        `${branchName} from ${remote} (${gitDetail(landedPresent)}). Nothing here was changed.`,
    }
  }

  const localTipRead = git(repoRoot, readonlyArgs(["rev-parse", "--verify", ref]))
  if (localTipRead.status !== 0) {
    return {
      ok: false,
      kind: "ancestry-unverifiable",
      error: `${ref} in the checkout ${repoRoot} could not be read (${gitDetail(localTipRead)}).`,
    }
  }
  const localTip = localTipRead.stdout
  // Carry an index left at any ancestor's tree forward to the local tip FIRST (25393): an object-side writer that
  // advanced the ref mid-flight leaves the index at an ancestor, which the search finds. From here on the index holds `localTip`, so every merge below starts there.
  const carried = carryIndexTo(repoRoot, localTip, ref, request.expectedDirtyPaths, to)
  if (!carried.ok) return carried.outcome
  const expectedDirtyPaths = carried.expectedDirtyPaths
  const authoredPaths = request.authoredPaths ?? []
  // A repair moved the index and tree, so the checkout was synchronized even when the ref itself did not move.
  const reported = (outcome: RemoteFirstProjectionOutcome): RemoteFirstProjectionOutcome => {
    if (!outcome.ok || carried.repairedIndexFrom === undefined) return outcome
    if (outcome.kind !== "synchronized" && outcome.kind !== "already-current") return outcome
    return { ...outcome, kind: "synchronized", repairedIndexFrom: carried.repairedIndexFrom }
  }
  if (localTip === to) {
    // The ref already holds the landing; already-current is verified against the expected dirt and the index.
    return reported(synchronizeCheckoutToCommit({ repoRoot, from: to, to, ref, expectedDirtyPaths, authoredPaths }))
  }

  const ancestry = git(repoRoot, readonlyArgs(["merge-base", "--is-ancestor", localTip, to]))
  if (ancestry.status === 1) {
    // Exit 1 covers two OPPOSITE states, so decide which before prescribing:
    // a tip that already CONTAINS the landing (a newer projection) must never
    // be labeled a strand nor told to rebase — only a genuine fork is one.
    const superseded = git(repoRoot, readonlyArgs(["merge-base", "--is-ancestor", to, localTip]))
    if (superseded.status === 0) {
      // Containment of the receipt is not publication of the tip (ruling
      // bce97727): already-current additionally requires the tip itself to be
      // on the remote main fetched at the start of this projection. A
      // descendant absent from the remote is a stranded local commit — its
      // own refusal, naming the local-only commits, prescribing nothing.
      const remoteRef = `refs/remotes/${remote}/${branchName}`
      const published = git(repoRoot, readonlyArgs(["merge-base", "--is-ancestor", localTip, remoteRef]))
      if (published.status === 0) {
        // The published tip supersedes this receipt, but the checkout may not
        // reflect it: a projection that lost the ref CAS mid-call left the
        // index at the earlier probed landing. Re-run the idempotent two-way
        // merge from the receipt to the tip — a checkout already at the tip
        // passes through unchanged, a stale one is repaired, and the dirt is
        // verified either way. Claiming already-current here without merging
        // is the false report the moved-ref witness pins.
        return reported(
          synchronizeCheckoutToCommit({ repoRoot, from: to, to: localTip, ref, expectedDirtyPaths, authoredPaths }),
        )
      }
      if (published.status !== 1) {
        return {
          ok: false,
          kind: "ancestry-unverifiable",
          error:
            `${ref} in the checkout ${repoRoot}: containment of local ${localTip} in ${remoteRef} could not be ` +
            `decided (${gitDetail(published)}). Nothing was changed.`,
        }
      }
      const localOnlyRead = git(repoRoot, readonlyArgs(["rev-list", `${remoteRef}..${localTip}`]))
      const localOnly = localOnlyRead.status === 0 ? localOnlyRead.stdout.split("\n").filter(Boolean) : []
      return {
        ok: false,
        kind: "stranded-local-commits",
        landedOid: to,
        localTip,
        localOnly,
        error:
          `${ref} in the checkout ${repoRoot}: the landed commit ${to} is contained in local ${localTip}, but ` +
          `${localOnly.length > 0 ? localOnly.length : "an unknown number of"} local-only commit(s) above ` +
          `${remoteRef} strand that tip${localOnly.length > 0 ? ` (${localOnly.join(", ")})` : ""}. All work is ` +
          `preserved and nothing was changed here; the landing is complete and this stale receipt prescribes nothing.`,
      }
    }
    if (superseded.status !== 1) {
      return {
        ok: false,
        kind: "ancestry-unverifiable",
        error:
          `${ref} in the checkout ${repoRoot}: ancestry between landed ${to} and local ${localTip} could not be ` +
          `decided (${gitDetail(superseded)}). Nothing was changed.`,
      }
    }
    return {
      ok: false,
      kind: "landed-but-unsynchronized",
      landedOid: to,
      localTip,
      error:
        `${ref} in the checkout ${repoRoot}: the landed commit ${to} is at ${remote}, but the local branch holds ` +
        `${localTip}, which is not an ancestor — a local-only commit strands the projection. The landing is ` +
        `complete and safe at the remote, nothing here was changed, and the intent is already committed, so ` +
        "repeating the semantic operation would duplicate it.",
    }
  }
  if (ancestry.status !== 0) {
    return {
      ok: false,
      kind: "ancestry-unverifiable",
      error:
        `${ref} in the checkout ${repoRoot}: ancestry between local ${localTip} and landed ${to} could not be ` +
        `decided (${gitDetail(ancestry)}). Nothing was changed.`,
    }
  }

  // Probe the two-way merge BEFORE the ref moves. A refusal here leaves the
  // ref on `localTip`, so a repeated projection re-enters this same path — an
  // advanced ref over a refused merge is what turned retries into a false
  // already-current over a stale index and tree. On success the merge below in
  // synchronizeCheckoutToCommit re-runs idempotently (index already at `to`),
  // and the delegate then verifies dirt against the ADVANCED head, which is
  // why the verification cannot run before the ref moves.
  // Authored paths are staged here, on the fast-forward alone: the probe then keeps them (index matches `to`) and
  // every other path moves. A refused probe unstages them again, so no refusal leaves an index no commit holds.
  const matching = matchingLandingDirt(repoRoot, localTip, to, expectedDirtyPaths)
  if (!matching.ok) {
    return {
      ok: false,
      kind: "dirt-unverifiable",
      error: `${ref} in ${repoRoot}: ${matching.detail}. The landing is safe at ${remote}; nothing was changed.`,
    }
  }
  const stagedPaths = [...new Set([...authoredPaths, ...matching.paths])]
  const authored = stageAuthoredPaths(repoRoot, ref, localTip, to, stagedPaths, expectedDirtyPaths)
  if (!authored.ok) return authored.outcome
  if (matching.blockers.length > 0) {
    const unstage = unstageAuthoredPaths(repoRoot, localTip, stagedPaths)
    return {
      ok: false,
      kind: "worktree-update-refused",
      expectedDirtyPaths: [...expectedDirtyPaths].sort(),
      gitDetail: `preflight overlap [${matching.blockers.join(", ")}]`,
      error:
        `${ref} in ${repoRoot}: origin ${to} would overwrite locally edited or removed paths ` +
        `[${matching.blockers.join(", ")}]. The branch still holds ${localTip}; the remote commit is safe and ` +
        "the working tree was not changed." +
        (unstage === undefined ? "" : ` Could not unstage matching paths: ${unstage}.`),
    }
  }
  const probed = git(repoRoot, ["read-tree", "-m", "-u", localTip, to])
  if (probed.status !== 0) {
    const unstaged = unstageAuthoredPaths(repoRoot, localTip, stagedPaths)
    const expected = [...expectedDirtyPaths].sort()
    const unstageNote =
      unstaged === undefined
        ? ""
        : ` The authored paths could NOT be unstaged back to ${localTip} (${unstaged}); the index holds them staged.`
    return classifyReadTreeFailure(probed, expected, {
      refused: (detail) =>
        `${ref} in the checkout ${repoRoot}: the landed commit ${to} is at ${remote}, but the checkout could not ` +
        `be brought forward without overwriting an uncommitted local edit to a path the landing wrote ` +
        `(${detail}). The ref still holds ${localTip} and nothing was changed. Dirty at projection ` +
        `time: [${expected.join(", ")}]. The landing ${to} is complete and safe at ${remote}.` +
        unstageNote,
      locked: ({ lockPath, lockAge, detail }) =>
        `${ref} in the checkout ${repoRoot}: the landed commit ${to} is at ${remote}, but the checkout could not ` +
        `be brought forward: another git process holds ${lockPath} (${lockAge}; ${detail}). No dirt was weighed; ` +
        `the ref still holds ${localTip} and nothing was changed. The landing ${to} is complete and safe at ` +
        `${remote}; project again once the lock is released.` +
        unstageNote,
    })
  }

  request.beforeRefAdvance?.()
  const advanced = git(repoRoot, ["update-ref", ref, to, localTip])
  if (advanced.status !== 0) {
    return {
      ok: false,
      kind: "ref-advance-refused",
      error:
        `${ref} in the checkout ${repoRoot} moved between the ancestry check and the fast-forward ` +
        `(${gitDetail(advanced)}). The index may already hold ${to}; nothing was overwritten, and projecting ` +
        `again from the current state is safe.`,
    }
  }
  return reported(
    synchronizeCheckoutToCommit({ repoRoot, from: localTip, to, ref, expectedDirtyPaths: authored.expectedDirtyPaths }),
  )
}

export interface ProjectCheckoutRequest {
  /** The checkout to project. */
  readonly repoRoot: string
  /** Remote to fetch from. Defaults to "origin". */
  readonly remote?: string | undefined
  /** Fully-qualified ref to project. Defaults to "refs/heads/main". */
  readonly ref?: string | undefined
  /** Timeout for remote fetch in ms. */
  readonly remoteTimeoutMs?: number | undefined
  /** Test seam invoked before ref advance. */
  readonly beforeRefAdvance?: (() => void) | undefined
}

export type ProjectCheckoutOutcome = RemoteFirstProjectionOutcome & {
  readonly to?: string | undefined
  readonly localTip?: string | undefined
}

/**
 * Fetch a remote branch and project a checkout to that branch's remote tip.
 *
 * This is the routine fronted by `gitomic project <path>`, which takes the
 * checkout lock around it.
 *
 * Runs under the caller's checkout lock (`gitomic/checkout-lock`) and never
 * takes it: a second open of the lock file in a process that already holds it
 * is a second open file description, which waits on its own holder until the
 * timeout.
 */
export async function projectCheckout(request: ProjectCheckoutRequest): Promise<ProjectCheckoutOutcome> {
  const { repoRoot } = request
  if (isBareRepository(repoRoot)) {
    return { ok: true, kind: "bare" }
  }

  const remote = request.remote ?? "origin"
  let ref = request.ref ?? "refs/heads/main"
  if (!ref.startsWith("refs/heads/")) {
    ref = `refs/heads/${ref}`
  }

  const branch = checkedOutRef(repoRoot)
  if (branch !== ref) {
    return {
      ok: false,
      kind: "wrong-branch",
      checkedOutRef: branch,
      error:
        `${ref} in the checkout ${repoRoot}: that checkout has ` +
        `${branch === null ? "a detached HEAD" : `${branch} checked out`}, so no projection can reconcile it. ` +
        "Nothing here was changed.",
    }
  }

  const branchName = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref
  const fetched = await fetchTip(repoRoot, remote, ref, request.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS)
  if (!fetched.ok) {
    return {
      ok: false,
      kind: "fetch-failed",
      error:
        `${ref} in the checkout ${repoRoot}: fetching ${branchName} from ${remote} failed ` +
        `(${fetched.detail}). Nothing here was changed.`,
    }
  }
  const to = fetched.oid

  const localTipRead = git(repoRoot, readonlyArgs(["rev-parse", "--verify", ref]))
  const localTip = localTipRead.status === 0 ? localTipRead.stdout : undefined

  const expectedDirtyPaths = worktreeDirtyPaths(repoRoot)
  const projectionOutcome = await projectRemoteFirstFastForward({
    repoRoot,
    to,
    ref,
    remote,
    expectedDirtyPaths,
    ...(request.remoteTimeoutMs !== undefined ? { remoteTimeoutMs: request.remoteTimeoutMs } : {}),
    ...(request.beforeRefAdvance !== undefined ? { beforeRefAdvance: request.beforeRefAdvance } : {}),
  })

  return {
    ...projectionOutcome,
    to,
    ...(localTip !== undefined ? { localTip } : {}),
  }
}

/** A verified preservation ref lets a checkout shed local commits without publishing them. */
export type StateCheckoutRepairOutcome =
  | ProjectCheckoutOutcome
  | {
      readonly ok: true
      readonly kind: "set-aside"
      readonly preserveRef: string
      readonly localTip: string
      readonly to: string
      readonly localOnly: readonly string[]
    }
  | {
      readonly ok: false
      readonly kind: "set-aside-refused"
      readonly error: string
      readonly localTip?: string
      readonly to?: string
      readonly preserveRef?: string
    }

export interface StateCheckoutRepairRequest extends ProjectCheckoutRequest {
  /** Paths a synchronous writer already authored; its own repair may never touch them. */
  readonly reservedPaths?: readonly string[] | undefined
  /** Crash seams for the three durable boundaries; production callers leave these unset. */
  readonly afterPreserveRef?: (() => void) | undefined
  readonly afterWorktreeClear?: (() => void) | undefined
  readonly afterLocalRefMove?: (() => void) | undefined
}

type CapturedPath =
  | { readonly path: string; readonly kind: "absent" }
  | {
      readonly path: string
      readonly kind: "regular" | "symlink"
      readonly mode: "100644" | "100755" | "120000"
      readonly bytes: Buffer
    }

function readCapturedPath(repoRoot: string, path: string): CapturedPath {
  if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "." || part === ".git")) {
    throw new Error(`unsafe repository path ${JSON.stringify(path)}`)
  }
  const absolute = join(repoRoot, path)
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, kind: "absent" }
    throw error
  }
  if (stat.isSymbolicLink()) {
    return { path, kind: "symlink", mode: "120000", bytes: readlinkSync(absolute, { encoding: "buffer" }) }
  }
  if (stat.isFile()) {
    return { path, kind: "regular", mode: stat.mode & 0o111 ? "100755" : "100644", bytes: readFileSync(absolute) }
  }
  throw new Error(`${path} has unsupported working-tree mode ${stat.mode.toString(8)}`)
}

function capturesEqual(a: CapturedPath, b: CapturedPath): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "absent" || b.kind === "absent") return true
  return a.mode === b.mode && a.bytes.equals(b.bytes)
}

function gitWithInput(repoRoot: string, args: readonly string[], input: Buffer, env?: NodeJS.ProcessEnv): GitOutcome {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", ...env },
  })
  if (result.error !== undefined || result.status === null) {
    return {
      status: result.status ?? 1,
      stdout: "",
      stderr: `git ${args[0] ?? "command"} failed: ${String(result.error ?? result.signal)}`,
    }
  }
  return { status: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() }
}

function gitWithIndex(repoRoot: string, index: string, args: readonly string[]): GitOutcome {
  return gitWithInput(repoRoot, args, Buffer.alloc(0), { GIT_INDEX_FILE: index })
}

function readGitBlob(repoRoot: string, oid: string): Buffer {
  const result = spawnSync("git", ["-C", repoRoot, "cat-file", "blob", oid], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  })
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(`cannot read baseline blob ${oid}: ${result.stderr?.toString("utf8") ?? String(result.error)}`)
  }
  return result.stdout
}

function baselinePath(repoRoot: string, tip: string, path: string): CapturedPath {
  const listed = git(repoRoot, readonlyArgs(["ls-tree", "-z", tip, "--", path]))
  if (listed.status !== 0) throw new Error(`cannot read ${path} at ${tip}: ${gitDetail(listed)}`)
  if (listed.stdout === "") return { path, kind: "absent" }
  const tab = listed.stdout.indexOf("\t")
  const header = listed.stdout.slice(0, tab).split(" ")
  const mode = header[0]
  const oid = header[2]
  if (tab < 0 || oid === undefined || listed.stdout.slice(tab + 1).replace(/\0$/u, "") !== path) {
    throw new Error(`cannot parse exact baseline entry for ${path} at ${tip}`)
  }
  if (mode === "120000") return { path, kind: "symlink", mode, bytes: readGitBlob(repoRoot, oid) }
  if (mode === "100644" || mode === "100755") return { path, kind: "regular", mode, bytes: readGitBlob(repoRoot, oid) }
  throw new Error(`${path} at ${tip} has unsupported baseline mode ${mode}`)
}

function preserveDirtyTree(
  repoRoot: string,
  localTip: string,
  captures: readonly CapturedPath[],
): { preserveRef: string; commit: string } {
  const gitDir = git(repoRoot, readonlyArgs(["rev-parse", "--absolute-git-dir"]))
  if (gitDir.status !== 0 || gitDir.stdout === "") throw new Error(`cannot locate git directory: ${gitDetail(gitDir)}`)
  const scratch = mkdtempSync(join(gitDir.stdout, "gitomic-preserve-index-"))
  const index = join(scratch, "index")
  try {
    const base = gitWithIndex(repoRoot, index, ["read-tree", localTip])
    if (base.status !== 0) throw new Error(`cannot seed separate index: ${gitDetail(base)}`)
    for (const capture of captures) {
      if (capture.kind === "absent") {
        const removed = gitWithIndex(repoRoot, index, ["update-index", "--force-remove", "--", capture.path])
        if (removed.status !== 0) throw new Error(`cannot capture removal ${capture.path}: ${gitDetail(removed)}`)
        continue
      }
      const blob = gitWithInput(repoRoot, ["hash-object", "-w", "--no-filters", "--stdin"], capture.bytes)
      if (blob.status !== 0) throw new Error(`cannot save ${capture.path} bytes: ${gitDetail(blob)}`)
      const staged = gitWithIndex(repoRoot, index, [
        "update-index",
        "--add",
        "--cacheinfo",
        `${capture.mode},${blob.stdout},${capture.path}`,
      ])
      if (staged.status !== 0) throw new Error(`cannot capture ${capture.path} mode: ${gitDetail(staged)}`)
    }
    const tree = gitWithIndex(repoRoot, index, ["write-tree"])
    if (tree.status !== 0 || tree.stdout === "") throw new Error(`cannot write preservation tree: ${gitDetail(tree)}`)
    const preserveRef = `refs/preserve/state-checkout/${localTip}-${tree.stdout}`
    const existing = git(repoRoot, readonlyArgs(["rev-parse", "--verify", "--quiet", preserveRef]))
    if (existing.status === 0) {
      const existingTree = git(repoRoot, readonlyArgs(["rev-parse", `${existing.stdout}^{tree}`]))
      const parent = git(repoRoot, readonlyArgs(["rev-parse", `${existing.stdout}^`]))
      if (
        existingTree.status !== 0 ||
        existingTree.stdout !== tree.stdout ||
        parent.status !== 0 ||
        parent.stdout !== localTip
      ) {
        throw new Error(`${preserveRef} exists but does not hold the captured tree over ${localTip}`)
      }
      return { preserveRef, commit: existing.stdout }
    }
    const message = `unattributed direct edit, found at ${new Date().toISOString()}\n\nSet aside blocking checkout paths:\n${captures.map((capture) => `${capture.kind === "absent" ? "rm" : "put"} ${capture.path}`).join("\n")}\n`
    const commit = gitWithInput(repoRoot, ["commit-tree", tree.stdout, "-p", localTip], Buffer.from(message), {
      GIT_AUTHOR_NAME: "unattributed direct edit",
      GIT_AUTHOR_EMAIL: "unattributed@invalid",
      GIT_COMMITTER_NAME: "gitomic",
      GIT_COMMITTER_EMAIL: "gitomic@invalid",
    })
    if (commit.status !== 0 || commit.stdout === "") {
      throw new Error(`cannot commit preservation tree: ${gitDetail(commit)}`)
    }
    const format = git(repoRoot, readonlyArgs(["rev-parse", "--show-object-format"]))
    if (format.status !== 0) throw new Error(`cannot read object format: ${gitDetail(format)}`)
    const absent = "0".repeat(format.stdout === "sha256" ? 64 : 40)
    const saved = git(repoRoot, ["update-ref", preserveRef, commit.stdout, absent])
    if (saved.status !== 0) throw new Error(`cannot create absent-only ${preserveRef}: ${gitDetail(saved)}`)
    return { preserveRef, commit: commit.stdout }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Rename away an exact captured entry, then restore the local tip through create-if-absent. */
function clearCapturedPaths(repoRoot: string, localTip: string, captures: readonly CapturedPath[]): void {
  const gitDir = git(repoRoot, readonlyArgs(["rev-parse", "--absolute-git-dir"]))
  if (gitDir.status !== 0 || gitDir.stdout === "") throw new Error(`cannot locate git directory: ${gitDetail(gitDir)}`)
  const backup = mkdtempSync(join(gitDir.stdout, "gitomic-preserve-working-"))
  let complete = false
  try {
    for (const [index, capture] of captures.entries()) {
      const observed = readCapturedPath(repoRoot, capture.path)
      if (!capturesEqual(capture, observed)) {
        throw new Error(`${capture.path} changed since preservation; backup ${backup} retained`)
      }
      const absolute = join(repoRoot, capture.path)
      const baseline = baselinePath(repoRoot, localTip, capture.path)
      if (capture.kind !== "absent") {
        const moved = join(backup, String(index))
        renameSync(absolute, moved)
        const movedRead = readCapturedPath(backup, String(index))
        if (!capturesEqual(capture, movedRead)) {
          throw new Error(`${capture.path} changed during move; backup ${moved} retained`)
        }
      }
      if (baseline.kind === "absent") continue
      if (baseline.kind === "symlink") {
        symlinkSync(baseline.bytes, absolute)
      } else {
        const temp = join(backup, `baseline-${index}`)
        writeFileSync(temp, baseline.bytes)
        chmodSync(temp, baseline.mode === "100755" ? 0o755 : 0o644)
        linkSync(temp, absolute)
        unlinkSync(temp)
      }
    }
    complete = true
  } catch (error) {
    throw new Error(
      `captured-path movement stopped; backup directory ${backup} is retained: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    if (complete) rmSync(backup, { recursive: true, force: true })
  }
}

function selectOldBlockingPaths(
  repoRoot: string,
  changedPaths: ReadonlySet<string>,
  quietSeconds: number,
  reservedPaths: readonly string[],
): { readonly ok: true; readonly captures: readonly CapturedPath[] } | { readonly ok: false; readonly error: string } {
  try {
    const blockers = worktreeDirtyPaths(repoRoot).filter((path) => changedPaths.has(path))
    const reserved = new Set(reservedPaths)
    const owned = blockers.filter((path) => reserved.has(path))
    if (owned.length > 0) {
      return { ok: false, error: `reserved writer paths [${owned.join(", ")}] may not be captured or cleared` }
    }
    const captures: CapturedPath[] = []
    for (const path of blockers) {
      const captured = readCapturedPath(repoRoot, path)
      const statPath = captured.kind === "absent" ? dirname(join(repoRoot, path)) : join(repoRoot, path)
      const stat = lstatSync(statPath)
      const ageMs = Math.max(0, Date.now() - Math.max(stat.mtimeMs, stat.ctimeMs))
      if (path !== ".gitomic.conf" && ageMs < quietSeconds * 1000) {
        return {
          ok: false,
          error: `${path} is only ${Math.round(ageMs)} ms old; its ${quietSeconds}-second quiet period has not elapsed`,
        }
      }
      captures.push(captured)
    }
    return { ok: true, captures }
  } catch (error) {
    return {
      ok: false,
      error: `blocking paths could not be classified (${error instanceof Error ? error.message : String(error)})`,
    }
  }
}

/**
 * Repair blocking local-only commits or old conflicting checkout dirt. All
 * calls hold the checkout lock borrowed from their Km or timer caller.
 */
export async function projectCheckoutWithSetAside(
  request: StateCheckoutRepairRequest,
): Promise<StateCheckoutRepairOutcome> {
  const projected = await projectCheckout(request)
  if (projected.to === undefined || projected.localTip === undefined) return projected
  const { repoRoot } = request
  const ref = request.ref ?? "refs/heads/main"
  const branchRef = ref.startsWith("refs/heads/") ? ref : `refs/heads/${ref}`
  const remote = request.remote ?? "origin"
  const { to, localTip } = projected
  const refused = (reason: string, preserveRef?: string): StateCheckoutRepairOutcome => ({
    ok: false,
    kind: "set-aside-refused",
    localTip,
    to,
    ...(preserveRef === undefined ? {} : { preserveRef }),
    error: `${branchRef} in ${repoRoot}: ${reason}. Local ${localTip}; origin ${to}. Nothing was published.`,
  })
  let policy: Awaited<ReturnType<typeof readStateCheckoutDeclaration>>
  try {
    policy = await readStateCheckoutDeclaration(repoRoot, to)
  } catch (error) {
    return refused(`origin checkout policy cannot be read (${error instanceof Error ? error.message : String(error)})`)
  }
  if (policy === undefined) return projected
  if (projected.ok) {
    if (!worktreeDirtyPaths(repoRoot).includes(".gitomic.conf")) return projected
    if (request.reservedPaths?.includes(".gitomic.conf")) {
      return refused("reserved writer path .gitomic.conf may not be captured or cleared")
    }
    const index = indexTreeFromCopy(repoRoot)
    const tipTree = git(repoRoot, readonlyArgs(["rev-parse", `${to}^{tree}`]))
    if (!index.ok || tipTree.status !== 0 || index.tree !== tipTree.stdout) {
      return refused("the index holds staged or unprovable work")
    }
    let capture: CapturedPath
    let saved: ReturnType<typeof preserveDirtyTree>
    try {
      capture = readCapturedPath(repoRoot, ".gitomic.conf")
      saved = preserveDirtyTree(repoRoot, to, [capture])
    } catch (error) {
      return refused(
        `local declaration preservation refused (${error instanceof Error ? error.message : String(error)})`,
      )
    }
    const readback = git(repoRoot, readonlyArgs(["rev-parse", "--verify", saved.preserveRef]))
    if (readback.status !== 0 || readback.stdout !== saved.commit) {
      return refused(`${saved.preserveRef} failed exact readback`, saved.preserveRef)
    }
    request.afterPreserveRef?.()
    try {
      clearCapturedPaths(repoRoot, to, [capture])
    } catch (error) {
      return refused(
        `clearing the preserved local declaration refused (${error instanceof Error ? error.message : String(error)})`,
        saved.preserveRef,
      )
    }
    request.afterWorktreeClear?.()
    const verified = await projectCheckout({ repoRoot, remote, ref: branchRef })
    if (!verified.ok) {
      return refused(
        `declaration was preserved but checkout verification refused (${verified.kind}: ${verified.error})`,
        saved.preserveRef,
      )
    }
    return {
      ok: true,
      kind: "set-aside",
      preserveRef: saved.preserveRef,
      localTip,
      to: verified.to ?? to,
      localOnly: [],
    }
  }
  if (projected.kind === "worktree-update-refused") {
    const index = indexTreeFromCopy(repoRoot)
    const localTree = git(repoRoot, readonlyArgs(["rev-parse", `${localTip}^{tree}`]))
    if (!index.ok || localTree.status !== 0 || index.tree !== localTree.stdout) {
      return refused("the index holds staged, unmerged or unprovable work, so no dirty path may be cleared")
    }
    const changed = git(repoRoot, readonlyArgs(["diff", "--name-only", "-z", localTip, to, "--"]))
    if (changed.status !== 0) return refused(`origin's changed paths cannot be listed (${gitDetail(changed)})`)
    const changedSet = new Set(nulPaths(changed.stdout))
    const selection = selectOldBlockingPaths(repoRoot, changedSet, policy.quietSeconds, request.reservedPaths ?? [])
    if (!selection.ok) return refused(selection.error)
    const captures = selection.captures
    if (captures.length === 0) {
      return refused(`projection refused without a named overlapping dirty path (${projected.error})`)
    }
    let saved: ReturnType<typeof preserveDirtyTree>
    try {
      saved = preserveDirtyTree(repoRoot, localTip, captures)
    } catch (error) {
      return refused(`dirty-path preservation refused (${error instanceof Error ? error.message : String(error)})`)
    }
    const readback = git(repoRoot, readonlyArgs(["rev-parse", "--verify", saved.preserveRef]))
    const savedTree = git(repoRoot, readonlyArgs(["rev-parse", `${saved.preserveRef}^{tree}`]))
    const commitTree = git(repoRoot, readonlyArgs(["rev-parse", `${saved.commit}^{tree}`]))
    if (
      readback.status !== 0 ||
      readback.stdout !== saved.commit ||
      savedTree.status !== 0 ||
      commitTree.status !== 0 ||
      savedTree.stdout !== commitTree.stdout
    ) {
      return refused(`${saved.preserveRef} did not read back as the captured commit and tree`, saved.preserveRef)
    }
    request.afterPreserveRef?.()
    try {
      clearCapturedPaths(repoRoot, localTip, captures)
    } catch (error) {
      return refused(
        `clearing exact captured paths refused (${error instanceof Error ? error.message : String(error)})`,
        saved.preserveRef,
      )
    }
    request.afterWorktreeClear?.()
    const caughtUp = await projectCheckout({ repoRoot, remote, ref: branchRef })
    if (!caughtUp.ok) {
      return refused(
        `preserved ${saved.preserveRef}, but projection refused (${caughtUp.kind}: ${caughtUp.error})`,
        saved.preserveRef,
      )
    }
    return {
      ok: true,
      kind: "set-aside",
      preserveRef: saved.preserveRef,
      localTip,
      to: caughtUp.to ?? to,
      localOnly: [],
    }
  }
  if (projected.kind !== "landed-but-unsynchronized" && projected.kind !== "stranded-local-commits") {
    return projected
  }
  const baseRead = git(repoRoot, readonlyArgs(["merge-base", localTip, to]))
  if (baseRead.status !== 0 || baseRead.stdout === "") {
    return refused(`common base cannot be read (${gitDetail(baseRead)})`)
  }
  const base = baseRead.stdout
  if (base === localTip) return projected
  const localOnlyRead = git(repoRoot, readonlyArgs(["rev-list", `${to}..${localTip}`]))
  if (localOnlyRead.status !== 0) return refused(`local-only commits cannot be listed (${gitDetail(localOnlyRead)})`)
  const localOnly = localOnlyRead.stdout.split("\n").filter(Boolean)
  if (localOnly.length === 0) {
    return refused("the local tip is not an origin ancestor, but no local-only commit is visible")
  }

  const index = indexTreeFromCopy(repoRoot)
  if (!index.ok) return refused(`index cannot be verified (${index.detail})`)
  const localTreeRead = git(repoRoot, readonlyArgs(["rev-parse", `${localTip}^{tree}`]))
  const baseTreeRead = git(repoRoot, readonlyArgs(["rev-parse", `${base}^{tree}`]))
  if (localTreeRead.status !== 0 || baseTreeRead.status !== 0) {
    return refused("the local or common-base tree cannot be read")
  }
  const indexAtBase = index.tree === baseTreeRead.stdout
  if (!indexAtBase && index.tree !== localTreeRead.stdout) return refused("the index carries staged or unprovable work")
  let preserveRef: string | undefined
  let preservedOid: string = localTip
  let combinedCaptures: readonly CapturedPath[] = []
  if (!indexAtBase) {
    const localChanges = git(repoRoot, readonlyArgs(["diff", "--name-only", "-z", base, localTip, "--"]))
    const remoteChanges = git(repoRoot, readonlyArgs(["diff", "--name-only", "-z", base, to, "--"]))
    if (localChanges.status !== 0 || remoteChanges.status !== 0) {
      return refused("local or remote changed paths cannot be listed")
    }
    const changed = new Set([...nulPaths(localChanges.stdout), ...nulPaths(remoteChanges.stdout)])
    const selection = selectOldBlockingPaths(repoRoot, changed, policy.quietSeconds, request.reservedPaths ?? [])
    if (!selection.ok) return refused(selection.error)
    if (selection.captures.length > 0) {
      combinedCaptures = selection.captures
      let saved: ReturnType<typeof preserveDirtyTree>
      try {
        saved = preserveDirtyTree(repoRoot, localTip, selection.captures)
      } catch (error) {
        return refused(
          `combined local work could not be preserved (${error instanceof Error ? error.message : String(error)})`,
        )
      }
      preserveRef = saved.preserveRef
      preservedOid = saved.commit
    }
  }
  preserveRef ??= `refs/preserve/state-checkout/${localTip}`
  const prior = git(repoRoot, readonlyArgs(["rev-parse", "--verify", "--quiet", preserveRef]))
  if (prior.status === 0 && prior.stdout !== preservedOid) {
    return refused(`preservation ref ${preserveRef} points to ${prior.stdout}`, preserveRef)
  }
  if (prior.status !== 0) {
    const format = git(repoRoot, readonlyArgs(["rev-parse", "--show-object-format"]))
    if (format.status !== 0) return refused(`object format cannot be read (${gitDetail(format)})`)
    const absent = "0".repeat(format.stdout === "sha256" ? 64 : 40)
    const saved = git(repoRoot, ["update-ref", preserveRef, preservedOid, absent])
    if (saved.status !== 0) return refused(`creating ${preserveRef} failed (${gitDetail(saved)})`, preserveRef)
  }
  const readback = git(repoRoot, readonlyArgs(["rev-parse", "--verify", preserveRef]))
  if (readback.status !== 0 || readback.stdout !== preservedOid) {
    return refused(`preservation ref ${preserveRef} failed exact readback (${gitDetail(readback)})`, preserveRef)
  }
  request.afterPreserveRef?.()

  if (combinedCaptures.length > 0 && !indexAtBase) {
    try {
      clearCapturedPaths(repoRoot, localTip, combinedCaptures)
    } catch (error) {
      return refused(
        `clearing combined captured paths refused (${error instanceof Error ? error.message : String(error)})`,
        preserveRef,
      )
    }
    request.afterWorktreeClear?.()
  }

  if (!indexAtBase) {
    const reverted = git(repoRoot, ["read-tree", "-m", "-u", localTip, base])
    if (reverted.status !== 0) {
      return refused(`two-way movement to ${base} refused (${gitDetail(reverted)})`, preserveRef)
    }
  }
  const advanced = git(repoRoot, ["update-ref", branchRef, base, localTip])
  if (advanced.status !== 0) return refused(`local ref CAS to ${base} refused (${gitDetail(advanced)})`, preserveRef)
  request.afterLocalRefMove?.()

  const caughtUp = await projectCheckout({ repoRoot, remote, ref: branchRef })
  if (!caughtUp.ok) {
    return refused(
      `preserved ${preserveRef}, but projection refused (${caughtUp.kind}: ${caughtUp.error})`,
      preserveRef,
    )
  }
  return { ok: true, kind: "set-aside", preserveRef, localTip, to: caughtUp.to ?? to, localOnly }
}
