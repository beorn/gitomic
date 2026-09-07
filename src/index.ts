import { randomUUID } from "node:crypto"

import { applyEdits, type Edit } from "./edits.js"
import { Conflict, EditDoesNotApply, RetriesExhausted } from "./errors.js"
import { objectOid, validateOid } from "./git-object.js"
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
  Committed,
  GitMap,
  GitomicBackend,
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

export { Conflict, EditDoesNotApply, RetriesExhausted }
export type { EditKind, PreconditionType } from "./errors.js"
export { applyEdits } from "./edits.js"
export type { Edit } from "./edits.js"
export { matchGlob } from "./glob.js"
export { createShellBackend } from "./shell.js"
export { parseOwnershipManifest } from "./ownership-manifest.js"
export type {
  BlobValue,
  Committed,
  CommitInput,
  GitMap,
  GitomicBackend,
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
export type { OwnershipManifest, OwnershipManifestPolicy } from "./ownership-manifest.js"

export async function open(options: OpenOptions): Promise<Store> {
  const context = await prepareStore(options)
  const enqueue = createQueue()
  return {
    head: async () => backendOid(await context.backend.head(context.repo, context.ref)),
    at: (commit) => makeSnapshot(context, commit),
    transact: (update, message) => enqueue(async () => transact(context, update, message)),
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
): Promise<Committed> {
  return store.transact((map, head) => applyEdits(map, base, head, edits), message)
}

export async function openReader(options: OpenReaderOptions): Promise<Reader> {
  const context = await prepareReader(options)
  return {
    head: context.refresh,
    at: (commit) => makeSnapshot(context, commit, context.refresh),
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

const DEFAULT_RETRY_BUDGET_MS = 30_000
const DEFAULT_READER_POLL_INTERVAL_MS = 1_000
const DEFAULT_WRITER_LABEL = "gitomic"

async function prepareStore(options: OpenOptions): Promise<StoreContext> {
  if (options.writer !== undefined) assertWriter(options.writer)
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
    refresh = async () => backendOid(await fetchRemote(repo, ref, remote))
    publish = async (next, expected) => compareAndSwapRemote(repo, ref, next, expected, remote)
  }
  await refresh()
  return { repo, ref, writer, instance, backend, retryBudgetMs, refresh, publish, nextSeq }
}

function normalizeRetryBudget(value: number | undefined): number {
  const budget = value ?? DEFAULT_RETRY_BUDGET_MS
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new TypeError("retryBudgetMs must be a positive number of milliseconds")
  }
  return budget
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

async function transact(context: StoreContext, update: Update, message: string): Promise<Committed> {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new TypeError("message must say why this transaction exists")
  }
  assertUtf8(message, "message")
  if (message.includes("\0")) throw new TypeError("message cannot contain NUL because Git commit messages forbid it")
  let retries = 0
  // Allocated once and reused across replays: every attempt is the SAME
  // transaction, so they must share one `(instance, seq)` receipt.
  let seq: number | undefined
  // Contention policy lives HERE, not in callers: the budget is TIME, not a
  // fixed attempt count. Under CAS one publish wins per round, so the unluckiest
  // of N writers needs about N attempts — a fixed counter abandons a healthy
  // burst by construction. The deadline resets whenever the ref advances (some
  // writer landed): a burst that keeps landing someone is never abandoned, while
  // a transaction that makes no progress for the whole budget fails loudly.
  let deadline = Date.now() + context.retryBudgetMs
  while (true) {
    const parent = await context.refresh()
    const base = checkedFiles(await context.backend.readFiles(context.repo, parent))
    const { map, changes } = makeOverlay(base)
    await update(map, parent)
    const effective = removeNoopChanges(base, changes)
    if (effective.size === 0) return { oid: parent, retries }
    seq ??= context.nextSeq()
    assertNextTree(base, effective)
    const next = backendOid(
      await context.backend.writeCommit(context.repo, {
        parent,
        changes: effective,
        message: message.trim(),
        writer: context.writer,
        instance: context.instance,
        seq,
      }),
    )
    if (await context.publish(next, parent)) return { oid: next, retries }

    retries += 1
    // A refused publish is usually plain contention, but an acknowledgement can
    // also be lost after the write landed. Look for this exact receipt before
    // replaying: replaying a landed transaction would apply it twice. The scan
    // stops at `parent`, so it reads only the commits that arrived during this
    // attempt.
    const winner = await context.refresh()
    const landed = await context.backend.findTransaction(context.repo, winner, parent, context.instance, seq)
    if (landed !== undefined) return { oid: backendOid(landed), retries }
    // The ref advanced under us: a writer landed this round, so the race is
    // making progress — extend the budget rather than abandon a healthy burst.
    if (winner !== parent) deadline = Date.now() + context.retryBudgetMs
    if (Date.now() >= deadline) throw new RetriesExhausted(retries, context.retryBudgetMs)
    await delayForRetry(retries)
  }
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

function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort)
    const onAbort = (): void => {
      cleanup()
      resolve(undefined)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    pending.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function normalizePollInterval(value: number | undefined): number {
  const interval = value ?? DEFAULT_READER_POLL_INTERVAL_MS
  if (!Number.isSafeInteger(interval) || interval <= 0) {
    throw new TypeError("pollIntervalMs must be a positive integer")
  }
  return interval
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolveWait) => {
    let settled = false
    const settle = (elapsed: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolveWait(elapsed)
    }
    const onAbort = (): void => settle(false)
    // raw-lifecycle-ok: the awaited reader poll owns and clears this timer and abort listener.
    const timer = setTimeout(() => settle(true), milliseconds)
    signal.addEventListener("abort", onAbort, { once: true })
  })
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

/** The label leads the subject and is echoed as a trailer, so it stays single-line. */
function assertWriter(writer: string): void {
  assertUtf8(writer, "writer")
  const hasControlCharacter = [...writer].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
  if (writer.trim().length === 0 || hasControlCharacter) {
    throw new TypeError("writer must be a non-empty, single-line identifier")
  }
}

function normalizeRef(ref: string): string {
  assertUtf8(ref, "ref")
  if (ref.length === 0) throw new TypeError("ref is required")
  const normalized = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`
  if (normalized === "refs/gitomic" || normalized.startsWith("refs/gitomic/")) {
    throw new TypeError("refs/gitomic/ is reserved for Gitomic's internal reachability refs")
  }
  const components = normalized.split("/")
  if (
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.endsWith(".") ||
    normalized.includes("..") ||
    normalized.includes("@{") ||
    [...normalized].some(isInvalidRefCharacter) ||
    components.some((component) => component.length === 0 || component.startsWith(".") || component.endsWith(".lock"))
  ) {
    throw new TypeError(`invalid Git ref: ${JSON.stringify(ref)}`)
  }
  return normalized
}

function isInvalidRefCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0
  return codePoint <= 0x20 || codePoint === 0x7f || "~^:?*[\\".includes(character)
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

function delayForRetry(retries: number): Promise<void> {
  const ceiling = Math.min(150, 4 * 2 ** Math.min(retries, 6))
  const milliseconds = Math.random() * ceiling
  return new Promise((resolveDelay) => {
    // raw-lifecycle-ok: this transaction-owned backoff is awaited and cannot outlive its caller.
    setTimeout(resolveDelay, milliseconds)
  })
}
