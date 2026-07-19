export type Oid = string

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
  readFiles(repo: string, commit: Oid): Promise<ReadonlyMap<string, string>>
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

export type Store = {
  head(): Promise<Oid>
  at(commit?: Oid): Snapshot
  transact(update: Update, message: string): Promise<Committed>
}
