import { randomUUID } from "node:crypto"

import {
  applyEdits,
  editPaths,
  GET_RAW_VALUE,
  KEEP_MODE_OF,
  PREFETCH_PATHS,
  SET_BYTES,
  type Edit,
  type PrefetchingUpdate,
} from "./edits.ts"
import { runCasLoop } from "./engine.ts"
import { shapeRefUpdates } from "./ref-updates.ts"
import {
  assertWriter,
  DEFAULT_WRITER_LABEL,
  normalizeClock,
  normalizePollInterval,
  normalizeRef,
  normalizeRetryBudget,
  rejectLegacyProvenance,
  untilAborted,
  waitForPoll,
} from "./options.ts"
import {
  AlreadyKept,
  CandidateRefused,
  Conflict,
  EditDoesNotApply,
  GitSignaled,
  GitTimeout,
  HistoryEdgesOverflow,
  HistoryEdgesTeardown,
  PublicationRejected,
  PublicationUnknown,
  RelativeOnlyEditRefused,
  RetriesExhausted,
  TreePathCollision,
} from "./errors.ts"
import { cloneIdent, GITOMIC_IDENT, validateOid } from "./git-object.ts"
import { assertTreeShape, normalizePath, normalizePrefix } from "./path.ts"
import { assertExposed, createSnapshotBase, readLazyBase, type LazyBase } from "./lazy-base.ts"
import { createShellBackend } from "./shell.ts"
import type {
  Candidate,
  BlobValue,
  Change,
  Clock,
  CommitMeta,
  RefUpdate,
  Committed,
  GitMap,
  GitomicBackend,
  Ident,
  KeptCopy,
  Oid,
  OpenOptions,
  OpenReaderOptions,
  Reader,
  RefSwap,
  RefTipChange,
  RefTipWatchOptions,
  Snapshot,
  SequenceAttempt,
  SequenceOptions,
  SequenceResult,
  SequenceStep,
  Store,
  Trailer,
} from "./types.js"
import { assertUtf8, decodeUtf8 } from "./utf8.ts"

export {
  AlreadyKept,
  CandidateRefused,
  Conflict,
  EditDoesNotApply,
  GitSignaled,
  GitTimeout,
  HistoryEdgesOverflow,
  HistoryEdgesTeardown,
  PublicationRejected,
  PublicationUnknown,
  RelativeOnlyEditRefused,
  RetriesExhausted,
  TreePathCollision,
}
export type { EditKind, PreconditionType } from "./errors.js"
export {
  ACTOR_TOKEN_MAX_BYTES,
  actorTrailersFromToken,
  parseActorTokenDeclaration,
  type ActorTokenDeclaration,
  type ActorTrailersResult,
} from "./actor-token.ts"
export { applyEdits, countOccurrences, parseEditsDeclaration, type EditsDeclaration } from "./edits.ts"
export { editsFromCheckout } from "./checkout-edits.ts"
export {
  CANDIDATE_CONFIG,
  DEFAULT_CANDIDATE_TIMEOUT_MS,
  TRUST_CONFIG,
  readPublishDeclaration,
  readStateCheckoutDeclaration,
  readRepositoryDeclaration,
  repositoryCandidate,
  trustDeclaration,
  type RepositoryCandidateOptions,
  type RepositoryDeclaration,
  type StateCheckoutDeclaration,
  type TrustScope,
} from "./candidate.ts"
export { identProblem, objectOid } from "./git-object.ts"
export type { Edit } from "./edits.js"
export { matchGlob } from "./glob.ts"
export {
  batchCheck,
  createShellBackend,
  danglingRefs,
  DEFAULT_REMOTE_TIMEOUT_MS,
  isMissingObjectFetchError,
  resolveGitAuthor,
  runCommand,
  runGit,
  readRawCommits,
  type ReadRawCommitsOptions,
  type DanglingRef,
  type DanglingRefsOptions,
  type BatchCheckOptions,
  type BatchCheckResult,
  type GitResult,
  type RunGitOptions,
  type ShellBackendOptions,
} from "./shell.ts"
export { openRemoteRepository, type OpenedRemoteRepository, type OpenRemoteRepositoryOptions } from "./repository.ts"
export { GRAPH_LAYER_GRACE, maintainStore, type MaintainStoreOptions, type StoreMaintenance } from "./maintain-store.ts"
export { normalizeRef } from "./options.ts"
export { parseOwnershipManifest } from "./ownership-manifest.ts"
export {
  checkedOutRef,
  isBareRepository,
  projectCheckout,
  projectCheckoutWithSetAside,
  projectRemoteFirstFastForward,
  synchronizeCheckoutToCommit,
  worktreeDirtyPaths,
  worktreeByteDifferences,
  type WorktreeByteDifference,
  type CheckoutSyncOutcome,
  type CheckoutSyncRequest,
  type ProjectCheckoutOutcome,
  type ProjectCheckoutRequest,
  type StateCheckoutRepairOutcome,
  type StateCheckoutRepairRequest,
  type RemoteFirstProjectionOutcome,
  type RemoteFirstProjectionRequest,
} from "./project.ts"
export type {
  BlobValue,
  Candidate,
  CandidateContext,
  CandidateVerdict,
  Change,
  CommitProvenance,
  CommitMeta,
  HistoryEdgeEvent,
  Committed,
  CommitInput,
  GitMap,
  GitomicBackend,
  Ident,
  KeptCopy,
  Oid,
  OpenOptions,
  OpenReaderOptions,
  PublishResult,
  AttemptContext,
  BesideAttempt,
  BesideRef,
  FetchRefsOptions,
  Reader,
  RefTipChange,
  RefTipWatchOptions,
  RefSwap,
  RefUpdate,
  Snapshot,
  SequenceAttempt,
  SequenceOptions,
  SequenceResult,
  SequenceStep,
  Trailer,
  Store,
  TransactOptions,
  TreeEntry,
  TreeListing,
  Update,
} from "./types.js"
export type { OwnershipManifest, OwnershipManifestPolicy } from "./ownership-manifest.js"

export async function open(options: OpenOptions): Promise<Store> {
  const context = await prepareStore(options)
  const enqueue = createQueue()
  return {
    head: async () => backendOid(await context.backend.head(context.repo, context.ref)),
    at: (commit) => makeSnapshot(context, commit),
    transact: (update, message, options) => {
      // Capture the per-call scalar before enqueueing: a later transaction can
      // otherwise observe an options object the caller mutated after submit.
      let author: Ident | undefined
      const candidate = options?.candidate
      const beside = options?.beside
      let fetch: readonly string[] | undefined
      let keeps: readonly Oid[] | undefined
      const trailers =
        options?.trailers === undefined ? undefined : options.trailers.map(([key, value]) => [key, value] as const)
      try {
        rejectLegacyProvenance(options)
        keeps = shapeKeeps(context, options?.keeps)
        author = cloneIdent(options?.author, "author")
        if (candidate !== undefined && typeof candidate !== "function") {
          throw new TypeError("candidate must be a function")
        }
        if (beside !== undefined && typeof beside !== "function") {
          throw new TypeError("beside must be a function")
        }
        // Refused at the call, before any attempt, and only for a store that asks: stores that never pass
        // beside run on every backend as before.
        if (beside !== undefined && context.backend.publish === undefined) {
          throw new TypeError("beside needs a backend with publish (MULTI): the shell, iso or mem backend")
        }
        fetch = shapeFetch(context, options?.fetch)
      } catch (error) {
        return Promise.reject(error)
      }
      return enqueue(async () => {
        const completed = await transactSequenceBody<SequenceStep>(
          context,
          async (attempt) =>
            attempt.step(update, message, {
              ...(author === undefined ? {} : { author }),
              ...(candidate === undefined ? {} : { candidate }),
              ...(trailers === undefined ? {} : { trailers }),
              ...(keeps === undefined ? {} : { keeps }),
            }),
          {
            ...(fetch === undefined ? {} : { fetch }),
            ...(beside === undefined
              ? {}
              : { beside: ({ next, base, map, tips }) => beside({ next, base, map, tips }) }),
          },
        )
        return {
          oid: completed.oid,
          retries: completed.retries,
          ...(completed.value.report === undefined ? {} : { report: completed.value.report }),
          ...(completed.kept === undefined ? {} : { kept: completed.kept }),
        }
      })
    },
    transactSequence: (run, options) => {
      if (typeof run !== "function") return Promise.reject(new TypeError("sequence run must be a function"))
      const beside = options?.beside
      if (beside !== undefined && typeof beside !== "function") {
        return Promise.reject(new TypeError("beside must be a function"))
      }
      if (beside !== undefined && context.backend.publish === undefined) {
        return Promise.reject(
          new TypeError("beside needs a backend with publish (MULTI): the shell, iso or mem backend"),
        )
      }
      let fetch: readonly string[] | undefined
      try {
        fetch = shapeFetch(context, options?.fetch)
      } catch (error) {
        return Promise.reject(error)
      }
      return enqueue(() =>
        transactSequenceBody(context, run, {
          ...(fetch === undefined ? {} : { fetch }),
          ...(beside === undefined ? {} : { beside }),
        }),
      )
    },
  }
}

/**
 * Land an edit list as one commit on the store's ref (R44). `base` is the
 * commit the edits were authored against — the oid the author read, per R46.
 * Several edits are one all-or-nothing commit; on a moved base each edit
 * re-checks its own precondition (R45) and the first failure throws
 * {@link EditDoesNotApply}, landing nothing. `append`-only lists and lists
 * whose edits all leave the tree unchanged land as a no-op at the current tip.
 */
export async function apply(
  store: Pick<Store, "transact">,
  base: Oid,
  edits: readonly Edit[],
  message: string,
  options?: { readonly author?: Ident; readonly candidate?: Candidate; readonly trailers?: readonly Trailer[] },
): Promise<Committed> {
  // The edit list names every path it will read, so one attempt fetches them all in ONE read before the first edit.
  // Copy mutable byte inputs once, before a CAS replay can run against a later tip.
  const stableEdits = edits.map((edit) => {
    if (edit.kind !== "put-bytes") return edit
    if (!(edit.content instanceof Uint8Array)) throw new TypeError("put-bytes content must be Uint8Array")
    return { ...edit, content: Uint8Array.from(edit.content) }
  })
  const update: PrefetchingUpdate = (map, head) => applyEdits(map, base, head, stableEdits)
  Object.defineProperty(update, PREFETCH_PATHS, { value: editPaths(stableEdits) })
  return store.transact(
    update,
    message,
    options === undefined
      ? undefined
      : {
          ...(options.author === undefined ? {} : { author: options.author }),
          ...(options.candidate === undefined ? {} : { candidate: options.candidate }),
          ...(options.trailers === undefined ? {} : { trailers: options.trailers }),
        },
  )
}

export async function openReader(options: OpenReaderOptions): Promise<Reader> {
  const context = await prepareReader(options)
  return {
    head: context.refresh,
    at: (commit) => makeSnapshot(context, commit, context.refresh),
    async log({ from, limit = 50 } = {}) {
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_024) {
        throw new TypeError("log limit must be a positive safe integer no greater than 1024")
      }
      const start: Oid = from === undefined ? await context.refresh() : validateOid(from)
      // One batched walk when the backend has one: a single git process for the
      // whole range instead of one per commit. The start is pinned above, so a
      // writer landing mid-read cannot leak into this history either way.
      if (context.backend.readHistory !== undefined) {
        return context.backend.readHistory(context.repo, [start], { limit })
      }
      let oid: Oid | null = start
      const commits: CommitMeta[] = []
      while (oid !== null && commits.length < limit) {
        const commit = await context.backend.readCommit(context.repo, oid)
        commits.push(commit)
        oid = commit.parent
      }
      return commits
    },
    async diff(from, to) {
      validateOid(from)
      validateOid(to)
      const before = makeSnapshot(context, from)
      const after = makeSnapshot(context, to)
      const [beforePaths, afterPaths] = await Promise.all([before.keys(), after.keys()])
      const changes: Change[] = []
      for (const path of [...new Set([...beforePaths, ...afterPaths])].sort()) {
        const [beforeOid, afterOid] = await Promise.all([before.oid(path), after.oid(path)])
        if (beforeOid !== afterOid) changes.push({ path, from: beforeOid ?? null, to: afterOid ?? null })
      }
      return changes
    },
    watch: (watchOptions) => watchRef(context, watchOptions),
  }
}

type StoreContext = {
  repo: string
  ref: string
  /** Human-readable label for the audit trail. */
  writer: string
  /** This store's unique identity, minted at `open`. */
  instance: string
  /** Git's committer for every commit this store writes. */
  committer: Ident
  backend: GitomicBackend
  /** How long a transaction keeps retrying a contended CAS before giving up (ms). */
  retryBudgetMs: number
  /** The remote this store arbitrates against, when it has one. */
  remote?: string
  /** The clock every commit of this store is dated by, in unix seconds (25486). */
  clock: Clock
  refresh(reason: "initial" | "after-rejection" | "after-unknown"): Promise<Oid>
  /** `refresh` plus the tips of `fetch`'s refs (null: absent), read in the same fetch on a remote store. */
  refreshWith(fetch: readonly string[]): Promise<{ readonly tip: Oid; readonly tips: ReadonlyMap<string, Oid> }>
  /** false = a lost lease, retry; otherwise landed, with what the kept ref did when the publish moved it. */
  publish(next: Oid, expected: Oid, beside: readonly RefUpdate[]): Promise<false | { readonly kept?: KeptCopy }>
  nextSeq(): number
}
/** Validate `TransactOptions.fetch` at the call: full names, not the store's ref, no repeats, a backend that can read them. */
function shapeFetch(context: StoreContext, fetch: readonly string[] | undefined): readonly string[] | undefined {
  if (fetch === undefined) return undefined
  if (!Array.isArray(fetch)) throw new TypeError("fetch must be an array of full ref names")
  const seen = new Set<string>()
  const shaped = fetch.map((name) => {
    if (typeof name !== "string" || !name.startsWith("refs/")) {
      throw new TypeError(`fetch ref must be a full refs/ name: ${JSON.stringify(name)}`)
    }
    const ref = normalizeRef(name)
    if (ref === context.ref) throw new TypeError(`a fetch ref cannot be the store's own ref: ${ref}`)
    if (seen.has(ref)) throw new TypeError(`fetch names ${ref} more than once`)
    seen.add(ref)
    return ref
  })
  if (shaped.length === 0) return undefined
  if (context.remote !== undefined && context.backend.fetchRefs === undefined) {
    throw new TypeError("fetch on a remote store needs a backend with fetchRefs: the shell backend")
  }
  if (context.remote === undefined && context.backend.listRefs === undefined) {
    throw new TypeError("fetch on a local store needs a backend with listRefs: the shell or mem backend")
  }
  return shaped
}

// Pauses between retries of a kept-copy update refused by a held ref lock: about 200 ms in all (hh 25615).
const KEPT_LOCK_PAUSES_MS = [50, 150] as const

const KEPT_COPY: Record<RefSwap, KeptCopy> = { swapped: "advanced", moved: "moved", locked: "locked" }

/**
 * Refresh a kept copy: read `remote`'s tip of `ref` without moving any ref, then advance the kept `ref` in `repo` to
 * it, and answer that tip. This is the one kept-copy refresh: a remote Store's refresh runs it, and a caller keeping
 * its own copy of the same remote (a reader's base) calls it instead of repeating it (hh 25615, @cto 3d3de4f6).
 *
 * The kept ref is derived state that other processes sharing the repository may move at any moment. One that moved
 * is theirs and is left alone; one whose ref lock is held is waited out for about 200 ms, then the refresh fails
 * naming the lock file and its removal. Gitomic never removes a lock.
 */
export async function refreshKeptCopy(options: {
  readonly repo: string
  readonly ref: string
  readonly remote: string
  readonly backend?: GitomicBackend
}): Promise<Oid> {
  const backend = options.backend ?? createShellBackend()
  const ref = normalizeRef(options.ref)
  const fetchRemote = backend.fetchRemote
  if (fetchRemote === undefined) {
    throw new TypeError(
      `this backend cannot refresh the kept copy of ${JSON.stringify(options.repo)}: it has no fetchRemote`,
    )
  }
  const fetched = backendOid(await fetchRemote(options.repo, ref, options.remote))
  await syncKeptRef(backend, options.repo, ref, fetched)
  return fetched
}

// The kept ref is derived state: a cache of origin's tip that another process sharing this repository may move at any
// moment. A lost cache update is never a failure: the caller builds on `fetched`, and a stale kept ref costs the next
// attempt one refused lease and a refresh (hh 25615, @cto: a moved local ref is re-read). A "locked" answer is not
// another writer: its ref lock is held. A live holder finishes in milliseconds; a lock left by a Git process killed
// mid-update never does, and absorbing it would cost every later write a refused lease and a fetch. So it is retried
// briefly, then named, before any push (hh 25615, review2 P3, @cto bb1f7b51).
async function syncKeptRef(backend: GitomicBackend, repo: string, ref: string, fetched: Oid): Promise<void> {
  const local = backendOid(await backend.head(repo, ref))
  if (local === fetched) return
  for (const pause of [...KEPT_LOCK_PAUSES_MS, undefined]) {
    if ((await backend.compareAndSwap(repo, ref, fetched, local)) !== "locked") return
    if (pause === undefined) break
    await new Promise((resolve) => {
      // raw-lifecycle-ok: this refresh-owned pause is awaited and cannot outlive its caller.
      setTimeout(resolve, pause)
    })
  }
  // Still locked at the end of the window. A ref that moved meanwhile was another writer's: skip, as above.
  if (backendOid(await backend.head(repo, ref)) !== local) return
  throw new Error(
    `kept copy ${JSON.stringify(repo)} cannot move ${ref} from ${local} to ${fetched}, and no other writer moved it: ` +
      `${ref}.lock in its git directory is held; if no git process is running there, remove it`,
  )
}

type ReaderContext = {
  repo: string
  ref: string
  backend: GitomicBackend
  refresh(): Promise<Oid>
}

async function prepareStore(options: OpenOptions): Promise<StoreContext> {
  if (options.writer !== undefined) assertWriter(options.writer)
  const committer = cloneIdent(options.committer, "committer") ?? GITOMIC_IDENT
  const repo = options.repo
  const ref = normalizeRef(options.ref)
  const writer = options.writer ?? DEFAULT_WRITER_LABEL
  // One id per open. Nothing else in the world can mint it, so `(instance, seq)`
  // identifies a transaction without a lock, a lease, or a stored high-water
  // mark to seed it from — including against a crashed predecessor that used
  // the same writer label.
  const instance = randomUUID()
  let seq = 0
  const nextSeq = (): number => seq++
  const backend = options.backend ?? createShellBackend()
  const retryBudgetMs = normalizeRetryBudget(options.retryBudgetMs)
  const clock = normalizeClock(options.clock)
  const remote = options.remote
  if (options.refresh !== undefined && options.refresh !== "always" && options.refresh !== "on-rejection") {
    throw new TypeError(`refresh must be "always" or "on-rejection", got ${String(options.refresh)}`)
  }
  const readLocal = async (): Promise<Oid> => backendOid(await backend.head(repo, ref))
  const readKept = async (): Promise<Oid> => {
    try {
      const oid = await readLocal()
      await backend.readCommit(repo, oid)
      return oid
    } catch (cause) {
      throw new Error(`cannot read local ref ${ref} in ${JSON.stringify(repo)}`, { cause })
    }
  }
  let refresh: StoreContext["refresh"]
  let refreshWith: StoreContext["refreshWith"]
  let swap: (next: Oid, expected: Oid) => Promise<false | { readonly kept?: KeptCopy }>
  if (remote === undefined) {
    refresh = readLocal
    refreshWith = async (fetch) => {
      const tip = await refresh("initial")
      const listRefs = backend.listRefs
      if (listRefs === undefined) throw new TypeError("fetch on a local store needs a backend with listRefs")
      const observed = await listRefs(repo, fetch)
      const tips = new Map<string, Oid>()
      for (const name of fetch) {
        const found = observed.get(name)
        if (found !== undefined) tips.set(name, found)
      }
      return { tip, tips }
    }
    // A local store has no kept copy: its ref IS the store. "moved" and "locked" are both a lost lease here, and the
    // loop re-reads and retries within its budget, as before RefSwap existed; the held-lock throw is the kept copy's
    // (the remote branch's refresh), not this ref's (hh 25615, @cto P4).
    swap = async (next, expected) => (await backend.compareAndSwap(repo, ref, next, expected)) === "swapped" && {}
  } else {
    const fetchRemote = backend.fetchRemote
    const compareAndSwapRemote = backend.compareAndSwapRemote
    if (fetchRemote === undefined || compareAndSwapRemote === undefined) {
      throw new TypeError("this backend cannot arbitrate remotely; omit remote or use the shell/iso backend")
    }
    const syncLocal = (fetched: Oid): Promise<void> => syncKeptRef(backend, repo, ref, fetched)
    const refreshRemote = (): Promise<Oid> => refreshKeptCopy({ repo, ref, remote, backend })
    refresh = async (reason) =>
      options.refresh === "on-rejection" && reason === "initial" ? readKept() : refreshRemote()
    // One fetch for the store's ref and every `fetch` ref: the store's ref must be there, the others may not.
    refreshWith = async (fetch) => {
      const fetchRefs = backend.fetchRefs
      if (fetchRefs === undefined) throw new TypeError("fetch on a remote store needs a backend with fetchRefs")
      const fetched = await fetchRefs(repo, [ref, ...fetch], remote, { absent: "omit" })
      const tip = fetched.get(ref)
      if (tip === undefined) throw new Error(`${remote} does not have ${ref}`)
      await syncLocal(backendOid(tip))
      // Absence is tolerated for the listed refs only: one the remote lacks stays out of the map.
      const tips = new Map<string, Oid>()
      for (const name of fetch) {
        const found = fetched.get(name)
        if (found !== undefined) tips.set(name, found)
      }
      return { tip: backendOid(tip), tips }
    }
    // A lease the remote accepted is landed, whatever the kept copy did afterward; the result carries it (hh 25615).
    swap = async (next, expected) => {
      const pushed = await compareAndSwapRemote(repo, ref, next, expected, remote)
      return pushed.landed && { kept: KEPT_COPY[pushed.kept] }
    }
  }
  // With beside refs the publish is the backend's MULTI publish of the ref and every beside ref, or none. For
  // THIS door a Conflict naming any of them is a lost lease and returns false, so the loop re-reads and the
  // attempt is rebuilt against fresh tips (the events door treats a lost `also` lease as final, because `also`
  // is static). The receipt search stays on the ref: the beside refs landed with it or not at all.
  const publish = async (
    next: Oid,
    expected: Oid,
    beside: readonly RefUpdate[],
  ): Promise<false | { readonly kept?: KeptCopy }> => {
    if (beside.length === 0) return swap(next, expected)
    const multi = backend.publish
    if (multi === undefined) throw new TypeError("beside needs a backend with publish (MULTI)")
    try {
      await multi(repo, [{ ref, expect: expected, oid: next }, ...beside], remote)
      if (remote !== undefined && options.refresh === "on-rejection") {
        // Raw MULTI leaves local refs untouched for staged event publishers.
        // A Store's primary ref is its next attempt's kept base, so advance
        // that cache after this Store's accepted atomic publish. If another
        // process moved it first, the publish still landed: the next attempt
        // re-reads the kept ref, and the result says what happened (hh 25615).
        return { kept: KEPT_COPY[await backend.compareAndSwap(repo, ref, next, expected)] }
      }
      return {}
    } catch (error) {
      if (error instanceof Conflict) return false
      throw error
    }
  }
  await refresh("initial")
  return {
    repo,
    ref,
    writer,
    instance,
    committer,
    backend,
    retryBudgetMs,
    clock,
    ...(remote === undefined ? {} : { remote }),
    refresh,
    refreshWith,
    publish,
    nextSeq,
  }
}

async function prepareReader(options: OpenReaderOptions): Promise<ReaderContext> {
  const repo = options.repo
  const ref = normalizeRef(options.ref ?? "main")
  const backend = options.backend ?? createShellBackend()
  const remote = options.remote
  let refresh: () => Promise<Oid>
  if (remote === undefined) {
    refresh = async () => backendOid(await backend.head(repo, ref))
  } else {
    const fetchRemote = backend.fetchRemote
    if (fetchRemote === undefined) {
      throw new TypeError("this backend cannot refresh a remote; omit remote or use the shell/iso backend")
    }
    refresh = async () => backendOid(await fetchRemote(repo, ref, remote))
  }
  await refresh()
  return { repo, ref, backend, refresh }
}

type IsAncestor = NonNullable<GitomicBackend["isAncestor"]>

/** The commits a transaction keeps, checked at the call: object ids, no repeat, and a backend that can refuse a kept one. */
function shapeKeeps(
  context: Pick<StoreContext, "backend">,
  keeps: readonly Oid[] | undefined,
): readonly Oid[] | undefined {
  if (keeps === undefined) return undefined
  if (!Array.isArray(keeps)) throw new TypeError("keeps must be an array of commit ids")
  if (keeps.length === 0) return undefined
  const shaped = keeps.map((oid) => validateOid(oid, "invalid kept commit id"))
  if (new Set(shaped).size !== shaped.length) throw new TypeError("keeps names a commit more than once")
  if (context.backend.isAncestor === undefined) {
    throw new TypeError("keeps needs a backend with isAncestor: the shell, iso or mem backend")
  }
  return shaped
}

async function transactSequenceBody<R>(
  context: StoreContext,
  run: (attempt: SequenceAttempt) => Promise<R>,
  options: SequenceOptions<R>,
): Promise<SequenceResult<R>> {
  // Position, not attempt, identifies a step across CAS replays. A step that
  // throws never changes the unpublished head; the caller may catch and continue.
  const seqs: number[] = []
  let tips: ReadonlyMap<string, Oid> = new Map()
  // What the kept ref did after the publish that landed this transaction; a receipt found after a lost
  // acknowledgement leaves it unknown.
  let kept: KeptCopy | undefined
  return runCasLoop<Oid, SequenceResult<R>>({
    label: `${context.repo} ${context.ref}`,
    retryBudgetMs: context.retryBudgetMs,
    refresh:
      options.fetch === undefined
        ? context.refresh
        : async () => {
            const read = await context.refreshWith(options.fetch as readonly string[])
            tips = read.tips
            return read.tip
          },
    publish: async (next, expected, beside) => {
      const published = await context.publish(next, expected, beside)
      kept = published === false ? undefined : published.kept
      return published !== false
    },
    findTransaction: async (winner, base, instance, seq) =>
      context.backend.findTransaction(context.repo, winner, base, instance, seq),
    attempt: async (parent, retries) => {
      let current = parent
      let position = 0
      let stepInFlight = false
      let lastMap: GitMap | undefined
      let lastCommittedSeq: number | undefined
      const value = await run({
        base: parent,
        tips,
        step: async (update, message, stepOptions) => {
          if (stepInFlight) throw new Error("sequence steps must be awaited in order")
          stepInFlight = true
          try {
            if (typeof message !== "string" || message.trim().length === 0) {
              throw new TypeError("message must say why this transaction exists")
            }
            assertUtf8(message, "message")
            if (message.includes("\0")) {
              throw new TypeError("message cannot contain NUL because Git commit messages forbid it")
            }
            const candidate = stepOptions?.candidate
            if (candidate !== undefined && typeof candidate !== "function") {
              throw new TypeError("candidate must be a function")
            }
            rejectLegacyProvenance(stepOptions)
            const author = cloneIdent(stepOptions?.author, "author")
            const trailers = stepOptions?.trailers
            const index = position++
            // The same slot keeps the same receipt even if earlier steps become
            // noops or are refused when this attempt is replayed on a new tip.
            const seq = (seqs[index] ??= context.nextSeq())
            const stepBase = current
            // Every attempt, before `update`: a keep the base already contains is refused by name, so a retry on a
            // tip that gained the commit can never write a second merge of it.
            const keeps = shapeKeeps(context, stepOptions?.keeps)
            for (const keep of keeps ?? []) {
              await context.backend.readCommit(context.repo, keep)
              if (await (context.backend.isAncestor as IsAncestor)(context.repo, keep, stepBase)) {
                throw new AlreadyKept(keep, stepBase)
              }
            }
            const base = await readLazyBase(context.backend, context.repo, stepBase)
            const prefetch = (update as PrefetchingUpdate)[PREFETCH_PATHS]
            if (prefetch !== undefined) await base.prefetch(prefetch)
            const { map, changes, modeSources } = makeOverlay(base)
            await update(map, stepBase, { tips })
            const commitInput = (effective: ReadonlyMap<string, BlobValue | undefined>, commitMessage: string) => {
              assertNextTree(base, effective)
              return {
                parent: stepBase,
                ...(keeps === undefined ? {} : { parents: [stepBase, ...keeps], allowEmpty: true }),
                time: context.clock(),
                changes: effective,
                ...(modeSources.size === 0 ? {} : { modeSources }),
                message: commitMessage,
                writer: context.writer,
                instance: context.instance,
                seq,
                ...(trailers === undefined ? {} : { trailers }),
                author: author ?? context.committer,
                committer: context.committer,
              }
            }
            let report: readonly string[] | undefined
            if (candidate !== undefined) {
              const changed = [...removeNoopChanges(base, changes).keys()].sort()
              const verdict = await candidate({
                base: stepBase,
                changed,
                map,
                readBase: (path) => base.get(path),
                materialize: async () =>
                  backendOid(
                    await context.backend.writeCommit(
                      context.repo,
                      commitInput(removeNoopChanges(base, changes), `gitomic candidate for: ${message.trim()}`),
                    ),
                  ),
              })
              if (verdict?.refuse !== undefined && verdict.refuse.length > 0) {
                throw new CandidateRefused([...verdict.refuse], stepBase)
              }
              report = verdict?.report === undefined ? [] : [...verdict.report]
            }
            const effective = removeNoopChanges(base, changes)
            // With keeps the parents are the change, so an unchanged tree still commits.
            if (effective.size === 0 && keeps === undefined) {
              lastMap = map
              return { oid: current, committed: false, ...(report === undefined ? {} : { report }) }
            }
            const next = backendOid(
              await context.backend.writeCommit(context.repo, commitInput(effective, message.trim())),
            )
            current = next
            lastMap = map
            lastCommittedSeq = seq
            return { oid: next, committed: true, ...(report === undefined ? {} : { report }) }
          } finally {
            stepInFlight = false
          }
        },
      })
      if (stepInFlight) throw new Error("sequence run returned before its last step finished")
      if (current === parent) return { kind: "noop", result: { value, oid: parent, retries } }
      if (lastMap === undefined || lastCommittedSeq === undefined) {
        throw new Error("sequence wrote a commit without a step map and receipt")
      }
      const beside =
        options.beside === undefined
          ? []
          : shapeRefUpdates(
              context.ref,
              await options.beside({ next: current, base: parent, map: lastMap, tips, value }),
              "beside",
            )
      return {
        kind: "write",
        next: current,
        base: parent,
        instance: context.instance,
        seq: lastCommittedSeq,
        ...(beside.length === 0 ? {} : { beside }),
        landed: (oid, retries) => ({ value, oid: backendOid(oid), retries, ...(kept === undefined ? {} : { kept }) }),
      }
    },
  })
}

function makeSnapshot(
  context: Pick<StoreContext, "repo" | "ref" | "backend">,
  commit?: Oid,
  resolveCurrent: () => Promise<Oid> = async () => backendOid(await context.backend.head(context.repo, context.ref)),
): Snapshot {
  const pinned = (commit === undefined ? resolveCurrent().then(backendOid) : Promise.resolve(validateOid(commit))).then(
    (oid) => ({ oid, algorithm: oid.length === 64 ? ("sha256" as const) : ("sha1" as const) }),
  )
  // TWO questions, two entry points, ONE map (27226 part 2, @cto 0f5c2039). `get`/`oid`/`has` resolve an EXACT
  // path through one scoped lookup, memoised in the map, so a session naming n distinct paths pays n small children
  // and a repeat pays nothing; `keys(prefix)` loads the WHOLE listing once, keeps it, and its `startsWith` contract
  // is exactly what it always was. Once the whole listing is loaded every later exact path answers from the map with
  // no child; the exact lookup never answers `keys`, and `keys` never assembles from partial lookups.
  //
  // The map is read with the "caller" exposure and each verb validates only the paths it EXPOSES (27226): a
  // whole-tree refusal here would charge every read for the whole tree (measured 15-20 ms of assertion on STATE's
  // 25,138 entries) and would refuse a tree wholesale where the refusal was always scoped to what a read exposes
  // (tests/iso.test.ts "scopes reader blob validation to the requested path prefix"). A path or prefix the map does
  // not hold stays an empty view.
  const root = pinned.then(({ oid }) => createSnapshotBase(context.backend, context.repo, oid))
  const scope = async (path: string): Promise<LazyBase> => {
    const base = await root
    await base.resolveExact(path)
    assertExposed(base.listing, [path])
    return base
  }
  return {
    async get(path) {
      const normalized = normalizePath(path)
      return (await scope(normalized)).get(normalized)
    },
    async oid(path) {
      const normalized = normalizePath(path)
      // Straight from the map — never through a decoded value — so it answers for a binary blob `get` would
      // refuse, and it is exactly the blob `apply`'s `expect` compares.
      return (await scope(normalized)).oid(normalized)
    },
    async has(path) {
      const normalized = normalizePath(path)
      return (await scope(normalized)).has(normalized)
    },
    async keys(prefix = "") {
      const normalized = normalizePrefix(prefix)
      const base = await root
      // A JS string prefix, exactly as readTree filtered before it: loading the whole listing is what keeps that
      // contract, where pushing the prefix to Git would return only the pathspec's own answer (27226 part 2).
      await base.wholeListing()
      const exposed = [...base.listing.keys()].filter((path) => path.startsWith(normalized))
      assertExposed(base.listing, exposed)
      return base
        .publicPaths()
        .filter((path) => path.startsWith(normalized))
        .sort()
    },
  }
}

async function* watchRef(context: ReaderContext, options: RefTipWatchOptions): AsyncIterable<RefTipChange> {
  let previous = validateOid(options.after, "reader watch requires a valid after object id")
  const pollIntervalMs = normalizePollInterval(options.pollIntervalMs)
  while (!options.signal.aborted) {
    const next = await untilAborted(context.refresh(), options.signal)
    if (next === undefined) return
    if (next !== previous) {
      const change = { from: previous, to: next }
      previous = next
      yield change
      continue
    }
    if (!(await waitForPoll(pollIntervalMs, options.signal))) return
  }
}

function assertNextTree(base: LazyBase, changes: ReadonlyMap<string, BlobValue | undefined>): void {
  const next = new Set(base.listing.keys())
  for (const [path, content] of changes) {
    if (content === undefined) next.delete(path)
    else next.add(path)
  }
  assertTreeShape(next)
}

function backendOid(value: unknown): Oid {
  return validateOid(value, "backend returned an invalid Git object id")
}

function makeOverlay(base: LazyBase): {
  map: GitMap
  changes: Map<string, BlobValue | undefined>
  modeSources: Map<string, string>
} {
  const changes = new Map<string, BlobValue | undefined>()
  const modeSources = new Map<string, string>()
  const raw = (path: string): Promise<BlobValue | undefined> =>
    changes.has(path) ? Promise.resolve(changes.get(path)) : base.raw(path)
  const get = async (path: string): Promise<string | undefined> => {
    if (!changes.has(path)) return base.get(path)
    const value = changes.get(path)
    if (value === undefined || typeof value === "string") return value
    return decodeUtf8(value, `Git blob at ${JSON.stringify(path)}`)
  }
  const present = (path: string): boolean => (changes.has(path) ? changes.get(path) !== undefined : base.has(path))
  const map: GitMap = {
    // oxlint-disable-next-line typescript/require-await -- Promise-typed reads reject validation errors, never throw synchronously.
    async get(path) {
      return get(normalizePath(path))
    },
    set(path, content) {
      const normalized = normalizePath(path)
      assertUtf8(content, "gitomic v1 values")
      changes.set(normalized, content)
    },
    delete(path) {
      changes.set(normalizePath(path), undefined)
    },
    // oxlint-disable-next-line typescript/require-await -- Promise-typed reads reject validation errors, never throw synchronously.
    async has(path) {
      return present(normalizePath(path))
    },
    // oxlint-disable-next-line typescript/require-await -- Promise-typed reads reject validation errors, never throw synchronously.
    async keys(prefix = "") {
      const normalized = normalizePrefix(prefix)
      const keys = new Set(base.publicPaths())
      for (const [path, value] of changes) {
        if (value === undefined) keys.delete(path)
        else keys.add(path)
      }
      return [...keys].filter((path) => path.startsWith(normalized)).sort()
    },
  }
  // A chain of moves keeps the first source's mode: a to b, then b to c, leaves c with a's.
  const keepModeOf = (to: string, from: string): void => {
    const source = normalizePath(from)
    modeSources.set(normalizePath(to), modeSources.get(source) ?? source)
  }
  Object.defineProperty(map, KEEP_MODE_OF, { value: keepModeOf })
  Object.defineProperty(map, GET_RAW_VALUE, { value: (path: string) => raw(normalizePath(path)) })
  Object.defineProperty(map, SET_BYTES, {
    value: (path: string, content: Uint8Array) => {
      if (!(content instanceof Uint8Array)) throw new TypeError("put-bytes content must be Uint8Array")
      changes.set(normalizePath(path), Uint8Array.from(content))
    },
  })
  return { map, changes, modeSources }
}

function createQueue(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

/** The changes that alter the tree, decided from the listing's oids: no base value is read for it. */
function removeNoopChanges(
  base: LazyBase,
  changes: ReadonlyMap<string, BlobValue | undefined>,
): Map<string, BlobValue | undefined> {
  return new Map([...changes].filter(([path, value]) => base.isChange(path, value)))
}
