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
import { copyFileSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"

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
  /** The merge ran but the resulting dirt could not be read back. */
  | { readonly ok: false; readonly kind: "dirt-unverifiable"; readonly error: string }
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
  const merged = git(repoRoot, ["read-tree", "-m", "-u", ancestor, tip])
  if (merged.status !== 0) {
    return {
      ok: false,
      outcome: {
        ok: false,
        kind: "worktree-update-refused",
        expectedDirtyPaths: [...expected].sort(),
        gitDetail: gitDetail(merged),
        error:
          `${ref} in the checkout ${repoRoot} is at ${tip}, but its index still holds ${ancestor}'s tree and could ` +
          `not be brought forward without overwriting an uncommitted local edit (${gitDetail(merged)}). The index ` +
          "and working tree are unchanged.",
      },
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

  // The index must hold `from` (or already `to`) before the two-way merge can be trusted: carry a stale one forward.
  const carried = carryIndexTo(repoRoot, from, ref, request.expectedDirtyPaths, to)
  if (!carried.ok) return carried.outcome
  const repaired = carried.repairedIndexFrom === undefined ? {} : { repairedIndexFrom: carried.repairedIndexFrom }
  const expected = [...carried.expectedDirtyPaths].sort()
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

  const merged = git(repoRoot, ["read-tree", "-m", "-u", from, to])
  if (merged.status !== 0) {
    return {
      ok: false,
      kind: "worktree-update-refused",
      expectedDirtyPaths: expected,
      gitDetail: gitDetail(merged),
      error:
        `${ref} in the checkout ${repoRoot} advanced ${from} -> ${to}, but the checkout could not be ` +
        `brought forward without overwriting an uncommitted local edit to a path the transaction wrote ` +
        `(${gitDetail(merged)}). Dirty at the time of the transaction: [${expected.join(", ")}]. Both the dirt ` +
        `and the commit are intact, and the index and working tree still hold their pre-advance state; until ` +
        "the checkout is reconciled, every write here refuses, naming the whole inverse delta as dirt.",
    }
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
  const fetched = await gitRemote(
    repoRoot,
    ["fetch", "--quiet", remote, branchName],
    request.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS,
  )
  if (fetched.status !== 0) {
    return {
      ok: false,
      kind: "fetch-failed",
      error:
        `${ref} in the checkout ${repoRoot}: fetching ${branchName} from ${remote} failed ` +
        `(${gitDetail(fetched)}). The landing ${to} is safe at the remote; nothing here was changed.`,
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
  // A repair moved the index and tree, so the checkout was synchronized even when the ref itself did not move.
  const reported = (outcome: RemoteFirstProjectionOutcome): RemoteFirstProjectionOutcome => {
    if (!outcome.ok || carried.repairedIndexFrom === undefined) return outcome
    if (outcome.kind !== "synchronized" && outcome.kind !== "already-current") return outcome
    return { ...outcome, kind: "synchronized", repairedIndexFrom: carried.repairedIndexFrom }
  }
  if (localTip === to) {
    // The ref already holds the landing; already-current is verified against the expected dirt and the index.
    return reported(synchronizeCheckoutToCommit({ repoRoot, from: to, to, ref, expectedDirtyPaths }))
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
        return reported(synchronizeCheckoutToCommit({ repoRoot, from: to, to: localTip, ref, expectedDirtyPaths }))
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
  const probed = git(repoRoot, ["read-tree", "-m", "-u", localTip, to])
  if (probed.status !== 0) {
    const expected = [...expectedDirtyPaths].sort()
    return {
      ok: false,
      kind: "worktree-update-refused",
      expectedDirtyPaths: expected,
      gitDetail: gitDetail(probed),
      error:
        `${ref} in the checkout ${repoRoot}: the landed commit ${to} is at ${remote}, but the checkout could not ` +
        `be brought forward without overwriting an uncommitted local edit to a path the landing wrote ` +
        `(${gitDetail(probed)}). The ref still holds ${localTip} and nothing was changed. Dirty at projection ` +
        `time: [${expected.join(", ")}]. The landing ${to} is complete and safe at ${remote}.`,
    }
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
  return reported(synchronizeCheckoutToCommit({ repoRoot, from: localTip, to, ref, expectedDirtyPaths }))
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
  const fetched = await gitRemote(
    repoRoot,
    ["fetch", "--quiet", remote, branchName],
    request.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS,
  )
  if (fetched.status !== 0) {
    return {
      ok: false,
      kind: "fetch-failed",
      error:
        `${ref} in the checkout ${repoRoot}: fetching ${branchName} from ${remote} failed ` +
        `(${gitDetail(fetched)}). Nothing here was changed.`,
    }
  }

  const toRead = git(repoRoot, readonlyArgs(["rev-parse", "--verify", "FETCH_HEAD"]))
  if (toRead.status !== 0 || toRead.stdout === "") {
    return {
      ok: false,
      kind: "fetch-failed",
      error: `${ref} in the checkout ${repoRoot}: could not resolve fetched tip (${gitDetail(toRead)}).`,
    }
  }
  const to = toRead.stdout

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
