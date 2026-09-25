import { randomUUID } from "node:crypto"

import { applyEdits, editPaths, KEEP_MODE_OF, PREFETCH_PATHS, type Edit, type PrefetchingUpdate } from "./edits.js"
import { runCasLoop } from "./engine.js"
import { shapeRefUpdates } from "./ref-updates.js"
import {
  assertWriter,
  DEFAULT_WRITER_LABEL,
  normalizeClock,
  normalizePollInterval,
  normalizeRef,
  normalizeRetryBudget,
  untilAborted,
  waitForPoll,
} from "./options.js"
import { CandidateRefused, Conflict, EditDoesNotApply, GitTimeout, RetriesExhausted } from "./errors.js"
import { cloneCommitProvenance, cloneIdent, GITOMIC_IDENT, validateOid } from "./git-object.js"
import { assertTreeShape, isGitPrefixNotFoundError, normalizePath, normalizePrefix } from "./path.js"
import { createLazyBase, readLazyBase, type LazyBase } from "./lazy-base.js"
import { createShellBackend } from "./shell.js"
import type {
  Candidate,
  Change,
  Clock,
  CommitMeta,
  CommitProvenance,
  BesideAttempt,
  BesideRef,
  FetchRefsOptions,
  RefUpdate,
  Committed,
  GitMap,
  GitomicBackend,
  Ident,
  Oid,
  OpenOptions,
  OpenReaderOptions,
  Reader,
  RefTipChange,
  RefTipWatchOptions,
  Snapshot,
  Store,
  Trailer,
  Update,
} from "./types.js"
import { assertUtf8 } from "./utf8.js"

export { CandidateRefused, Conflict, EditDoesNotApply, GitTimeout, RetriesExhausted }
export type { EditKind, PreconditionType } from "./errors.js"
export { applyEdits } from "./edits.js"
export { editsFromCheckout } from "./checkout-edits.js"
export {
  CANDIDATE_CONFIG,
  DEFAULT_CANDIDATE_TIMEOUT_MS,
  TRUST_CONFIG,
  readRepositoryDeclaration,
  repositoryCandidate,
  trustDeclaration,
  type RepositoryCandidateOptions,
  type RepositoryDeclaration,
  type TrustScope,
} from "./candidate.js"
export { identProblem } from "./git-object.js"
export type { Edit } from "./edits.js"
export { matchGlob } from "./glob.js"
export {
  batchCheck,
  createShellBackend,
  danglingRefs,
  DEFAULT_REMOTE_TIMEOUT_MS,
  isMissingObjectFetchError,
  runGit,
  type DanglingRef,
  type DanglingRefsOptions,
  type BatchCheckOptions,
  type BatchCheckResult,
  type GitResult,
  type RunGitOptions,
  type ShellBackendOptions,
} from "./shell.js"
export { openRemoteRepository, type OpenedRemoteRepository, type OpenRemoteRepositoryOptions } from "./repository.js"
export { parseOwnershipManifest } from "./ownership-manifest.js"
export {
  checkedOutRef,
  isBareRepository,
  projectCheckout,
  projectRemoteFirstFastForward,
  synchronizeCheckoutToCommit,
  worktreeDirtyPaths,
  type CheckoutSyncOutcome,
  type CheckoutSyncRequest,
  type ProjectCheckoutOutcome,
  type ProjectCheckoutRequest,
  type RemoteFirstProjectionOutcome,
  type RemoteFirstProjectionRequest,
} from "./project.js"
export type {
  BlobValue,
  Candidate,
  CandidateContext,
  CandidateVerdict,
  Change,
  CommitProvenance,
  CommitMeta,
  Committed,
  CommitInput,
  GitMap,
  GitomicBackend,
  Ident,
  Oid,
  OpenOptions,
  OpenReaderOptions,
  PublishResult,
  BesideAttempt,
  BesideRef,
  FetchRefsOptions,
  Reader,
  RefTipChange,
  RefTipWatchOptions,
  RefUpdate,
  Snapshot,
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
      let provenance: CommitProvenance | undefined
      let author: Ident | undefined
      const candidate = options?.candidate
      const beside = options?.beside
      let fetch: readonly string[] | undefined
      const trailers =
        options?.trailers === undefined ? undefined : options.trailers.map(([key, value]) => [key, value] as const)
      try {
        provenance = cloneCommitProvenance(options?.provenance)
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
      return enqueue(async () =>
        transact(context, update, message, provenance, author, candidate, trailers, beside, fetch),
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
  const update: PrefetchingUpdate = (map, head) => applyEdits(map, base, head, edits)
  Object.defineProperty(update, PREFETCH_PATHS, { value: editPaths(edits) })
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
  refresh(): Promise<Oid>
  /** `refresh` plus the tips of `fetch`'s refs (null: absent), read in the same fetch on a remote store. */
  refreshWith(fetch: readonly string[]): Promise<{ readonly tip: Oid; readonly tips: ReadonlyMap<string, Oid> }>
  publish(next: Oid, expected: Oid, beside: readonly RefUpdate[]): Promise<boolean>
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
  let refresh: () => Promise<Oid>
  let refreshWith: StoreContext["refreshWith"]
  let swap: (next: Oid, expected: Oid) => Promise<boolean>
  if (remote === undefined) {
    refresh = async () => backendOid(await backend.head(repo, ref))
    refreshWith = async (fetch) => {
      const tip = await refresh()
      const listRefs = backend.listRefs
      if (listRefs === undefined) throw new TypeError("fetch on a local store needs a backend with listRefs")
      const tips = new Map<string, Oid>()
      for (const name of fetch) {
        const found = (await listRefs(repo, name)).get(name)
        if (found !== undefined) tips.set(name, found)
      }
      return { tip, tips }
    }
    swap = async (next, expected) => backend.compareAndSwap(repo, ref, next, expected)
  } else {
    const fetchRemote = backend.fetchRemote
    const compareAndSwapRemote = backend.compareAndSwapRemote
    if (fetchRemote === undefined || compareAndSwapRemote === undefined) {
      throw new TypeError("this backend cannot arbitrate remotely; omit remote or use the shell/iso backend")
    }
    const syncLocal = async (fetched: Oid): Promise<void> => {
      const local = backendOid(await backend.head(repo, ref))
      if (local !== fetched) await backend.compareAndSwap(repo, ref, fetched, local)
    }
    refresh = async () => {
      const fetched = backendOid(await fetchRemote(repo, ref, remote))
      await syncLocal(fetched)
      return fetched
    }
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
    swap = async (next, expected) => compareAndSwapRemote(repo, ref, next, expected, remote)
  }
  // With beside refs the publish is the backend's MULTI publish of the ref and every beside ref, or none. For
  // THIS door a Conflict naming any of them is a lost lease and returns false, so the loop re-reads and the
  // attempt is rebuilt against fresh tips (the events door treats a lost `also` lease as final, because `also`
  // is static). The receipt search stays on the ref: the beside refs landed with it or not at all.
  const publish = async (next: Oid, expected: Oid, beside: readonly RefUpdate[]): Promise<boolean> => {
    if (beside.length === 0) return swap(next, expected)
    const multi = backend.publish
    if (multi === undefined) throw new TypeError("beside needs a backend with publish (MULTI)")
    try {
      await multi(repo, [{ ref, expect: expected, oid: next }, ...beside], remote)
      return true
    } catch (error) {
      if (error instanceof Conflict) return false
      throw error
    }
  }
  await refresh()
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

async function transact(
  context: StoreContext,
  update: Update,
  message: string,
  provenance?: CommitProvenance,
  author?: Ident,
  candidate?: Candidate,
  trailers?: readonly Trailer[],
  beside?: (attempt: BesideAttempt) => Promise<readonly BesideRef[]> | readonly BesideRef[],
  fetch?: readonly string[],
): Promise<Committed> {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new TypeError("message must say why this transaction exists")
  }
  assertUtf8(message, "message")
  if (message.includes("\0")) throw new TypeError("message cannot contain NUL because Git commit messages forbid it")
  // Allocated once and reused across replays: every attempt is the SAME
  // transaction, so they must share one `(instance, seq)` receipt.
  let seq: number | undefined
  // The tips `fetch` named, as the current attempt's refresh read them; empty when nothing was asked for.
  let tips: ReadonlyMap<string, Oid> = new Map()
  return runCasLoop<Oid, Committed>({
    label: `${context.repo} ${context.ref}`,
    retryBudgetMs: context.retryBudgetMs,
    refresh:
      fetch === undefined
        ? context.refresh
        : async () => {
            const read = await context.refreshWith(fetch)
            tips = read.tips
            return read.tip
          },
    publish: context.publish,
    findTransaction: async (winner, base, instance, attemptSeq) =>
      context.backend.findTransaction(context.repo, winner, base, instance, attemptSeq),
    attempt: async (parent, retries) => {
      // Built inside the attempt and never captured by the receipt search: a replay reads its own parent afresh.
      const base = await readLazyBase(context.backend, context.repo, parent)
      const prefetch = (update as PrefetchingUpdate)[PREFETCH_PATHS]
      if (prefetch !== undefined) await base.prefetch(prefetch)
      const { map, changes, modeSources } = makeOverlay(base)
      await update(map, parent, { tips })
      const commitInput = (effective: ReadonlyMap<string, string | undefined>, commitMessage: string) => {
        seq ??= context.nextSeq()
        assertNextTree(base, effective)
        return {
          parent,
          time: context.clock(),
          changes: effective,
          ...(modeSources.size === 0 ? {} : { modeSources }),
          message: commitMessage,
          writer: context.writer,
          instance: context.instance,
          seq,
          ...(provenance === undefined ? {} : { provenance }),
          ...(trailers === undefined ? {} : { trailers }),
          author: author ?? context.committer,
          committer: context.committer,
        }
      }
      // The candidate runs on THIS attempt's tree, after the caller's update and before the CAS; a replay runs it again.
      let report: readonly string[] | undefined
      if (candidate !== undefined) {
        const changed = [...removeNoopChanges(base, changes).keys()].sort()
        const verdict = await candidate({
          base: parent,
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
          throw new CandidateRefused([...verdict.refuse], parent)
        }
        report = verdict?.report === undefined ? [] : [...verdict.report]
      }
      const withReport = (result: Committed): Committed => (report === undefined ? result : { ...result, report })
      const effective = removeNoopChanges(base, changes)
      if (effective.size === 0) return { kind: "noop", result: withReport({ oid: parent, retries }) }
      const next = backendOid(await context.backend.writeCommit(context.repo, commitInput(effective, message.trim())))
      // After the commit, before the CAS, once per attempt: a replay calls it again with the new commit.
      const besideRefs =
        beside === undefined
          ? []
          : shapeRefUpdates(context.ref, await beside({ next, base: parent, map, tips }), "beside")
      return {
        kind: "write",
        next,
        base: parent,
        instance: context.instance,
        seq: seq as number,
        ...(besideRefs.length === 0 ? {} : { beside: besideRefs }),
        landed: (oid, retries) => withReport({ oid: backendOid(oid), retries }),
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
  // One lazy base per prefix read: the listing is scoped through readTree(prefix), and a value is fetched by oid
  // only when `get` asks for it — `oid`, `has` and `keys` answer from the listing alone.
  const loads = new Map<string, Promise<LazyBase>>()
  const load = (prefix: string): Promise<LazyBase> => {
    for (const [loadedPrefix, base] of loads) {
      if (prefix.startsWith(loadedPrefix)) return base
    }
    const base = pinned.then(async ({ oid }) => {
      try {
        return await readLazyBase(context.backend, context.repo, oid, prefix === "" ? undefined : prefix)
      } catch (error) {
        if (prefix !== "" && isGitPrefixNotFoundError(error)) {
          return createLazyBase(context.backend, context.repo, oid, new Map())
        }
        throw error
      }
    })
    loads.set(prefix, base)
    return base
  }
  return {
    async get(path) {
      const normalized = normalizePath(path)
      return (await load(normalized)).get(normalized)
    },
    async oid(path) {
      const normalized = normalizePath(path)
      // Straight from the listing — never through a decoded value — so it answers for a binary blob `get` would
      // refuse, and it is exactly the blob `apply`'s `expect` compares.
      return (await load(normalized)).oid(normalized)
    },
    async has(path) {
      const normalized = normalizePath(path)
      return (await load(normalized)).has(normalized)
    },
    async keys(prefix = "") {
      const normalized = normalizePrefix(prefix)
      return (await load(normalized))
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

function assertNextTree(base: LazyBase, changes: ReadonlyMap<string, string | undefined>): void {
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
  changes: Map<string, string | undefined>
  modeSources: Map<string, string>
} {
  const changes = new Map<string, string | undefined>()
  const modeSources = new Map<string, string>()
  const get = (path: string): Promise<string | undefined> =>
    changes.has(path) ? Promise.resolve(changes.get(path)) : base.get(path)
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
  changes: ReadonlyMap<string, string | undefined>,
): Map<string, string | undefined> {
  return new Map([...changes].filter(([path, value]) => base.isChange(path, value)))
}
