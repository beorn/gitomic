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
  writer: string
  seq: number
}

export type GitomicBackend = {
  acquireWriter(repo: string, writer: string): Promise<void>
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
  findTransaction(repo: string, head: Oid, writer: string, seq: number): Promise<Oid | undefined>
  fetchRemote?(repo: string, ref: string, remote: string): Promise<Oid>
  compareAndSwapRemote?(repo: string, ref: string, next: Oid, expected: Oid, remote: string): Promise<boolean>
}

export type OpenOptions = {
  repo: string
  ref: string
  writer: string
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
