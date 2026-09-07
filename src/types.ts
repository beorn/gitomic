export type Oid = string

/**
 * What a backend reports for one tree entry: the decoded UTF-8 value, or the
 * raw bytes when the blob is not valid UTF-8.
 *
 * Values a caller can WRITE are still strings only. Bytes exist so that a tree
 * holding one binary file — an image beside ten thousand Markdown notes — does
 * not make every transaction on that tree impossible.
 */
export type BlobValue = string | Uint8Array

export type GitMap = {
  get(path: string): Promise<string | undefined>
  set(path: string, content: string): void
  delete(path: string): void
  has(path: string): Promise<boolean>
  keys(prefix?: string): Promise<string[]>
}

export type Snapshot = Pick<GitMap, "get" | "has" | "keys"> & {
  /**
   * The git blob oid of the content at `path`, or `undefined` when the path is
   * absent. This is the natural precondition anchor: it is exactly what a `put`,
   * `rm` or `mv` edit's `expect` is compared against (R46 — "the read's oid is
   * the natural base"), so a caller reads it here and feeds it straight back as
   * `expect`. Unlike `get`, it answers even for a binary blob whose value
   * gitomic cannot decode: you can anchor an `rm`/`mv` on an image you never read.
   */
  oid(path: string): Promise<Oid | undefined>
}

/**
 * The mutation a transaction runs against the tip it attempts. `base` is that
 * tip's commit oid — the tree these edits are being checked against on THIS
 * attempt. It is re-supplied on every CAS replay (a fresh tip each time), so a
 * precondition-checking update can name the exact commit it refused on. A
 * callback that ignores the second argument behaves exactly as before.
 */
export type Update = (map: GitMap, base: Oid) => Promise<void>

export type Committed = {
  oid: Oid
  retries: number
}

export type CommitInput = {
  parent: Oid
  changes: ReadonlyMap<string, string | undefined>
  message: string
  /** The caller's human-readable label. Not an identity: it may repeat. */
  writer: string
  /** The one live store that produced this commit. Unique by construction. */
  instance: string
  seq: number
}

export type CommitMeta = {
  oid: Oid
  /** The first parent; ordinary root commits have none. */
  parent: Oid | null
  /** The complete stored message, including its trailers and trailing newlines. */
  message: string
  writer: string | null
  instance: string | null
  seq: number | null
  /** Git committer time in seconds since the Unix epoch. */
  timestamp: number
}

/** A changed projected blob identity; mode-only changes are not represented. */
export type Change = { path: string; from: Oid | null; to: Oid | null }

export type GitomicBackend = {
  head(repo: string, ref: string): Promise<Oid>
  readCommit(repo: string, oid: Oid): Promise<CommitMeta>
  /**
   * Read the whole tree, or only paths matching a non-empty string prefix.
   *
   * A value may be returned as raw bytes when the blob is not valid UTF-8.
   * Such an entry is a first-class member of the tree — it counts for `keys`
   * and `has`, and a transaction that never touches it carries it into the
   * next commit untouched — but reading its VALUE still fails loudly, because
   * gitomic v1 values remain UTF-8 strings. A backend that only ever returns
   * strings satisfies this signature unchanged.
   */
  readFiles(repo: string, commit: Oid, prefix?: string): Promise<ReadonlyMap<string, BlobValue>>
  writeCommit(repo: string, input: CommitInput): Promise<Oid>
  compareAndSwap(repo: string, ref: string, next: Oid, expected: Oid): Promise<boolean>
  /**
   * Search `head`'s first-parent chain for one store instance's transaction.
   *
   * `base` is the commit that transaction was built on: nothing older can be
   * it, so reaching `base` — or the root — ends the search conclusively with
   * `undefined`. A chain that runs past the bounded horizon without reaching
   * `base` is genuinely ambiguous and must throw rather than answer.
   */
  findTransaction(repo: string, head: Oid, base: Oid, instance: string, seq: number): Promise<Oid | undefined>
  fetchRemote?(repo: string, ref: string, remote: string): Promise<Oid>
  compareAndSwapRemote?(repo: string, ref: string, next: Oid, expected: Oid, remote: string): Promise<boolean>
}

export type OpenOptions = {
  repo: string
  ref: string
  /**
   * Optional human-readable label for this store's commits. It names a role,
   * not an instance: reusing it across processes is fine and expected. Every
   * `open` mints its own unique identity underneath.
   */
  writer?: string
  remote?: string
  backend?: GitomicBackend
  /**
   * How long, in milliseconds, a transaction keeps retrying a contended CAS
   * before throwing {@link RetriesExhausted}. The budget is time, not an attempt
   * count, and it resets whenever another writer lands (the race is making
   * progress), so a healthy burst is never abandoned while a genuinely stuck
   * transaction still fails. Defaults to 30_000.
   */
  retryBudgetMs?: number
}

export type OpenReaderOptions = {
  repo: string
  ref?: string
  remote?: string
  backend?: GitomicBackend
}

export type RefTipChange = {
  from: Oid
  to: Oid
}

export type RefTipWatchOptions = {
  after: Oid
  signal: AbortSignal
  pollIntervalMs?: number
}

export type Reader = {
  head(): Promise<Oid>
  at(commit?: Oid): Snapshot
  /** Newest-first first-parent history, pinned once; default 50, maximum 1024. */
  log(options?: { from?: Oid; limit?: number }): Promise<CommitMeta[]>
  diff(from: Oid, to: Oid): Promise<Change[]>
  watch(options: RefTipWatchOptions): AsyncIterable<RefTipChange>
}

export type Store = {
  head(): Promise<Oid>
  at(commit?: Oid): Snapshot
  transact(update: Update, message: string): Promise<Committed>
}
