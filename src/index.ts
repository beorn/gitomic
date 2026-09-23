import { randomUUID } from "node:crypto"

import { applyEdits, type Edit } from "./edits.js"
import { runCasLoop } from "./engine.js"
import {
  assertWriter,
  DEFAULT_WRITER_LABEL,
  normalizePollInterval,
  normalizeRef,
  normalizeRetryBudget,
  untilAborted,
  waitForPoll,
} from "./options.js"
import { CandidateRefused, Conflict, EditDoesNotApply, GitTimeout, RetriesExhausted } from "./errors.js"
import { cloneCommitProvenance, cloneIdent, GITOMIC_IDENT, objectOid, validateOid } from "./git-object.js"
import {
  assertGitPrefixMatched,
  assertTreeShape,
  isGitPrefixNotFoundError,
  isPublicPath,
  normalizePath,
  normalizePrefix,
} from "./path.js"
import { createShellBackend } from "./shell.js"
import type {
  BlobValue,
  Candidate,
  Trailer,
  Change,
  CommitProvenance,
  CommitMeta,
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
  Update,
} from "./types.js"
import { assertUtf8, decodeUtf8 } from "./utf8.js"

export { CandidateRefused, Conflict, EditDoesNotApply, GitTimeout, RetriesExhausted }
export type { EditKind, PreconditionType } from "./errors.js"
export { applyEdits } from "./edits.js"
export {
  CANDIDATE_CONFIG,
  DEFAULT_CANDIDATE_TIMEOUT_MS,
  repositoryCandidate,
  type RepositoryCandidateOptions,
} from "./candidate.js"
export { identProblem } from "./git-object.js"
export type { Edit } from "./edits.js"
export { matchGlob } from "./glob.js"
export {
  createShellBackend,
  DEFAULT_REMOTE_TIMEOUT_MS,
  runGit,
  type GitResult,
  type RunGitOptions,
  type ShellBackendOptions,
} from "./shell.js"
export { openRemoteRepository, type OpenedRemoteRepository, type OpenRemoteRepositoryOptions } from "./repository.js"
export { parseOwnershipManifest } from "./ownership-manifest.js"
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
  Reader,
  RefTipChange,
  RefTipWatchOptions,
  RefUpdate,
  Snapshot,
  Trailer,
  Store,
  TransactOptions,
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
      const trailers =
        options?.trailers === undefined ? undefined : options.trailers.map(([key, value]) => [key, value] as const)
      try {
        provenance = cloneCommitProvenance(options?.provenance)
        author = cloneIdent(options?.author, "author")
        if (candidate !== undefined && typeof candidate !== "function")
          throw new TypeError("candidate must be a function")
      } catch (error) {
        return Promise.reject(error)
      }
      return enqueue(async () => transact(context, update, message, provenance, author, candidate, trailers))
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
  return store.transact(
    (map, head) => applyEdits(map, base, head, edits),
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
  refresh(): Promise<Oid>
  publish(next: Oid, expected: Oid): Promise<boolean>
  nextSeq(): number
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
  const remote = options.remote
  let refresh: () => Promise<Oid>
  let publish: (next: Oid, expected: Oid) => Promise<boolean>
  if (remote === undefined) {
    refresh = async () => backendOid(await backend.head(repo, ref))
    publish = async (next, expected) => backend.compareAndSwap(repo, ref, next, expected)
  } else {
    const fetchRemote = backend.fetchRemote
    const compareAndSwapRemote = backend.compareAndSwapRemote
    if (fetchRemote === undefined || compareAndSwapRemote === undefined) {
      throw new TypeError("this backend cannot arbitrate remotely; omit remote or use the shell/iso backend")
    }
    refresh = async () => {
      const fetched = backendOid(await fetchRemote(repo, ref, remote))
      const local = backendOid(await backend.head(repo, ref))
      if (local !== fetched) await backend.compareAndSwap(repo, ref, fetched, local)
      return fetched
    }
    publish = async (next, expected) => compareAndSwapRemote(repo, ref, next, expected, remote)
  }
  await refresh()
  return { repo, ref, writer, instance, committer, backend, retryBudgetMs, refresh, publish, nextSeq }
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
): Promise<Committed> {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new TypeError("message must say why this transaction exists")
  }
  assertUtf8(message, "message")
  if (message.includes("\0")) throw new TypeError("message cannot contain NUL because Git commit messages forbid it")
  // Allocated once and reused across replays: every attempt is the SAME
  // transaction, so they must share one `(instance, seq)` receipt.
  let seq: number | undefined
  return runCasLoop<Oid, Committed>({
    label: `${context.repo} ${context.ref}`,
    retryBudgetMs: context.retryBudgetMs,
    refresh: context.refresh,
    publish: context.publish,
    findTransaction: async (winner, base, instance, attemptSeq) =>
      context.backend.findTransaction(context.repo, winner, base, instance, attemptSeq),
    attempt: async (parent, retries) => {
      const base = checkedFiles(await context.backend.readFiles(context.repo, parent))
      const { map, changes } = makeOverlay(base)
      await update(map, parent)
      const commitInput = (effective: ReadonlyMap<string, string | undefined>, commitMessage: string) => {
        seq ??= context.nextSeq()
        assertNextTree(base, effective)
        return {
          parent,
          changes: effective,
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
          readBase: async (path) => readValue(base.get(path), path),
          materialize: async () =>
            backendOid(
              await context.backend.writeCommit(
                context.repo,
                commitInput(removeNoopChanges(base, changes), `gitomic candidate for: ${message.trim()}`),
              ),
            ),
        })
        if (verdict?.refuse !== undefined && verdict.refuse.length > 0)
          throw new CandidateRefused([...verdict.refuse], parent)
        report = verdict?.report === undefined ? [] : [...verdict.report]
      }
      const withReport = (result: Committed): Committed => (report === undefined ? result : { ...result, report })
      const effective = removeNoopChanges(base, changes)
      if (effective.size === 0) return { kind: "noop", result: withReport({ oid: parent, retries }) }
      const next = backendOid(await context.backend.writeCommit(context.repo, commitInput(effective, message.trim())))
      return {
        kind: "write",
        next,
        base: parent,
        instance: context.instance,
        seq: seq as number,
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
  const loads = new Map<string, Promise<ReadonlyMap<string, BlobValue>>>()
  const load = (prefix: string): Promise<ReadonlyMap<string, BlobValue>> => {
    for (const [loadedPrefix, files] of loads) {
      if (prefix.startsWith(loadedPrefix)) return files
    }
    const files = pinned.then(async ({ oid }) => {
      try {
        const scoped = checkedFiles(
          await context.backend.readFiles(context.repo, oid, prefix === "" ? undefined : prefix),
        )
        assertGitPrefixMatched(
          [...scoped.keys()].filter((path) => path.startsWith(prefix)).length,
          context.repo,
          oid,
          prefix,
        )
        return scoped
      } catch (error) {
        if (prefix !== "" && isGitPrefixNotFoundError(error)) return new Map<string, BlobValue>()
        throw error
      }
    })
    loads.set(prefix, files)
    return files
  }
  return {
    async get(path) {
      const normalized = normalizePath(path)
      return readValue((await load(normalized)).get(normalized), normalized)
    },
    async oid(path) {
      const normalized = normalizePath(path)
      const value = (await load(normalized)).get(normalized)
      if (value === undefined) return undefined
      // The oid is computed from the stored bytes directly — never through
      // readValue — so it answers for a binary blob `get` would refuse to
      // decode. A string round-trips to its UTF-8 bytes (gitomic's write
      // guarantee), which is exactly the blob `apply`'s `expect` compares.
      return objectOid(
        "blob",
        typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value),
        (await pinned).algorithm,
      )
    },
    async has(path) {
      const normalized = normalizePath(path)
      return (await load(normalized)).has(normalized)
    },
    async keys(prefix = "") {
      const normalized = normalizePrefix(prefix)
      return [...(await load(normalized)).keys()]
        .filter((path) => isPublicPath(path) && path.startsWith(normalized))
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

/**
 * Validate the shape of a tree read, without forcing every value through UTF-8.
 *
 * Paths are still strict: `assertTreeShape` rejects reserved, colliding and
 * malformed paths for the whole tree. Values are checked only when the backend
 * already decoded them — a byte value is a blob gitomic cannot represent as a
 * v1 value, and refusing it HERE would make the entire tree unreadable and
 * every transaction on it impossible. The refusal moves to the point of use:
 * `get` on that path throws, while `keys`, `has`, `set` and `delete` work, and
 * an untouched binary blob rides into the next commit unchanged.
 */
function checkedFiles(files: ReadonlyMap<string, BlobValue>): ReadonlyMap<string, BlobValue> {
  assertTreeShape(files.keys())
  for (const [path, content] of files) {
    if (typeof content === "string") assertUtf8(content, `Git blob at ${JSON.stringify(path)}`)
  }
  return files
}

/** Decode one stored value at the point a caller actually reads it. */
function readValue(value: BlobValue | undefined, path: string): string | undefined {
  if (value === undefined || typeof value === "string") return value
  return decodeUtf8(value, `Git blob at ${JSON.stringify(path)}`)
}

function assertNextTree(base: ReadonlyMap<string, BlobValue>, changes: ReadonlyMap<string, string | undefined>): void {
  const next = new Map(base)
  for (const [path, content] of changes) {
    if (content === undefined) next.delete(path)
    else next.set(path, content)
  }
  assertTreeShape(next.keys())
}

function backendOid(value: unknown): Oid {
  return validateOid(value, "backend returned an invalid Git object id")
}

function makeOverlay(base: ReadonlyMap<string, BlobValue>): {
  map: GitMap
  changes: Map<string, string | undefined>
} {
  const changes = new Map<string, string | undefined>()
  const get = (path: string): string | undefined =>
    changes.has(path) ? changes.get(path) : readValue(base.get(path), path)
  const present = (path: string): boolean => (changes.has(path) ? changes.get(path) !== undefined : base.has(path))
  const map: GitMap = {
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
    async has(path) {
      return present(normalizePath(path))
    },
    async keys(prefix = "") {
      const normalized = normalizePrefix(prefix)
      const keys = new Set([...base.keys()].filter(isPublicPath))
      for (const [path, value] of changes) {
        if (value === undefined) keys.delete(path)
        else keys.add(path)
      }
      return [...keys].filter((path) => path.startsWith(normalized)).sort()
    },
  }
  return { map, changes }
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

function removeNoopChanges(
  base: ReadonlyMap<string, BlobValue>,
  changes: ReadonlyMap<string, string | undefined>,
): Map<string, string | undefined> {
  return new Map(
    [...changes].filter(([path, value]) => {
      const current = base.get(path)
      // A byte-valued entry is never equal to a string write: replacing a
      // binary blob with text is a real change, not a no-op.
      return typeof current === "string" || current === undefined ? current !== value : true
    }),
  )
}
