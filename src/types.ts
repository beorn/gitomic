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

export type Snapshot = Pick<GitMap, "get" | "has" | "keys">

export type Update = (map: GitMap) => Promise<void>

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

export type GitomicBackend = {
  head(repo: string, ref: string): Promise<Oid>
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
  watch(options: RefTipWatchOptions): AsyncIterable<RefTipChange>
}

export type Store = {
  head(): Promise<Oid>
  at(commit?: Oid): Snapshot
  transact(update: Update, message: string): Promise<Committed>
}
