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
  /** What the candidate reported for the tree that landed (never a refusal); absent without a candidate. */
  report?: readonly string[]
}

/**
 * What a candidate sees: the attempt's tree, after the caller's update and before the CAS. It runs again on every CAS
 * replay, against the tree that attempt would land.
 */
export type CandidateContext = {
  /** The tip this attempt builds on. */
  readonly base: Oid
  /** The paths the caller's update changed, sorted; what the candidate derives is not in this list. */
  readonly changed: readonly string[]
  /** The candidate tree. A derive step sets and deletes here, and those edits land in the same commit. */
  readonly map: GitMap
  /** A path's content at `base`, ignoring this write: the trusted view, for a gate the write must not rewrite. */
  readBase(path: string): Promise<string | undefined>
  /** Write the current candidate as an unpublished commit on `base` and return its oid, for checks that read git. */
  materialize(): Promise<Oid>
}

/** A candidate's verdict: any `refuse` line stops the write; `report` lines ride along with the landed commit. */
export type CandidateVerdict = {
  readonly refuse?: readonly string[]
  readonly report?: readonly string[]
}

/** Derive and check one candidate tree. gitomic holds no policy: it runs what the caller or repository declares. */
export type Candidate = (context: CandidateContext) => Promise<CandidateVerdict | undefined>

/**
 * Caller-supplied original attribution recorded beside Gitomic's executor and
 * receipt metadata. It is serialization data, never a capability or grant.
 */
export type CommitProvenance = {
  readonly actor: string
  readonly session: string
  readonly generation: number
  readonly run?: string
}

/**
 * A git identity, exactly as git records it in an author or committer line.
 * It is recorded, never verified: see `identProblem` for what is refused.
 */
export type Ident = { readonly name: string; readonly email: string }

/** One trailer: key, then value. Order and duplicates are kept. */
export type Trailer = readonly [key: string, value: string]

export type CommitInput = {
  parent: Oid
  /**
   * The commit's time in unix seconds (author and committer alike), from the
   * store's clock at this attempt. Every backend writes the later of this and
   * the parent's time plus one, so times track the clock and never run
   * backwards; a non-integer is a fault (25486).
   */
  time: number
  /**
   * The complete parent list, when the commit has more than one. The first
   * entry must equal `parent`; the rest are commits this one keeps (an event
   * keeps the commit it is about). Omitted, the commit has `parent` alone.
   */
  parents?: readonly Oid[]
  /**
   * Land the commit even when `changes` leaves the tree unchanged. Opt-in and
   * used by gitomic/events only: `transact` and `apply` still treat an unchanged
   * tree as a no-op and never set it.
   */
  allowEmpty?: boolean
  /**
   * Caller trailers, written into the final trailer block ahead of gitomic's
   * own. Opaque to gitomic: it neither interprets nor reorders them.
   */
  trailers?: readonly Trailer[]
  /**
   * A changed path keeps the mode (100644 or 100755) of its own entry in
   * `parent`; a new path is 100644. Here a path names the parent entry whose
   * mode it keeps instead: a moved file's destination keeps its source's.
   * Written by `apply`'s move edit only.
   */
  modeSources?: ReadonlyMap<string, string>
  changes: ReadonlyMap<string, string | undefined>
  message: string
  /** The caller's human-readable label. Not an identity: it may repeat. */
  writer: string
  /** The one live store that produced this commit. Unique by construction. */
  instance: string
  seq: number
  /** Optional original attribution for this transaction only. */
  provenance?: CommitProvenance
  /** Git's author: who this commit acts for. Omitted, it is the committer. */
  author?: Ident
  /** Git's committer: who applied it. Omitted, it is gitomic <gitomic@localhost>. */
  committer?: Ident
}

export type CommitMeta = {
  oid: Oid
  /** The first parent; ordinary root commits have none. */
  parent: Oid | null
  /** Every parent in order; `parents[0]` is `parent`. Empty for a root commit. */
  parents: readonly Oid[]
  /** The caller trailers of the final paragraph, in order; gitomic's own are excluded. */
  trailers: readonly Trailer[]
  /** The complete stored message, including its trailers and trailing newlines. */
  message: string
  writer: string | null
  instance: string | null
  seq: number | null
  /** Original attribution, or null when absent; malformed or partial trailers are refused. */
  provenance: CommitProvenance | null
  /** Git's author, from the commit header. */
  author: Ident
  /** Git's committer, from the commit header. */
  committer: Ident
  /** Git committer time in seconds since the Unix epoch. */
  timestamp: number
}

/** A changed projected blob identity; mode-only changes are not represented. */
export type Change = { path: string; from: Oid | null; to: Oid | null }

/** One regular blob of a tree listing: its object id and its mode. */
export type TreeEntry = { readonly oid: Oid; readonly mode: "100644" | "100755" }

/** A tree's regular blobs by path, with no value decoded: what a transaction is strict about. */
export type TreeListing = ReadonlyMap<string, TreeEntry>

export type GitomicBackend = {
  head(repo: string, ref: string): Promise<Oid>
  readCommit(repo: string, oid: Oid): Promise<CommitMeta>
  /**
   * List the whole tree, or only paths matching a non-empty string prefix:
   * every regular blob's path, mode and oid, with NO value read. This is the
   * base a transaction is strict about — a symlink, gitlink or non-NFC path
   * fails here — and the only whole-tree read a write performs. A non-empty
   * prefix that matches nothing throws `GitPrefixNotFoundError`.
   */
  readTree(repo: string, commit: Oid, prefix?: string): Promise<TreeListing>
  /**
   * Read the named blobs, by oid, in ONE read. The oids are deduplicated; an
   * oid the repository does not hold, or that is not a blob, throws naming it.
   *
   * A value is raw bytes when the blob is not valid UTF-8. Such an entry is a
   * first-class member of the tree — it counts for `keys` and `has`, and a
   * transaction that never touches it carries it into the next commit
   * untouched — but reading its VALUE fails loudly at the read, because
   * gitomic v1 values remain UTF-8 strings. A backend that only ever returns
   * strings satisfies this signature unchanged.
   */
  readBlobs(repo: string, oids: readonly Oid[]): Promise<ReadonlyMap<Oid, BlobValue>>
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
  /**
   * Fetch and return the remote tip without moving the selected application ref.
   * Object downloads and private temporary fetch refs are allowed. Readers rely
   * on this contract; Store refresh separately updates its local cache ref.
   */
  fetchRemote?(repo: string, ref: string, remote: string): Promise<Oid>
  /**
   * Every ref under `prefix` and its tip, in ref-name order: `for-each-ref`
   * locally, `ls-remote --refs` against `remote`. Never moves a ref.
   */
  listRefs?(repo: string, prefix: string, remote?: string): Promise<ReadonlyMap<string, Oid>>
  /**
   * Newest-first first-parent history of every tip in ONE read, stopping at any
   * `exclude` commit. Commits reachable from several tips are returned once.
   * This is what keeps chain reads to a single git process.
   */
  /**
   * Write, idempotently, the empty root commit every event chain starts from
   * (empty tree, message "initial", time 946684800, gitomic identity) and
   * return its oid. It is byte-identical on every backend.
   */
  writeGenesis?(repo: string): Promise<Oid>
  readHistory?(
    repo: string,
    tips: readonly Oid[],
    options?: { readonly exclude?: readonly Oid[]; readonly limit?: number },
  ): Promise<CommitMeta[]>
  compareAndSwapRemote?(repo: string, ref: string, next: Oid, expected: Oid, remote: string): Promise<boolean>
  /**
   * MULTI: move every ref in `updates`, or none. `expect` is a lease, not an
   * assertion. Per ref, three outcomes: updated (was at expect, now at oid),
   * unchanged (already at oid; not touched, not locked), Conflict (at neither;
   * the message names the ref, expect and the observed tip). An all-zero
   * `expect` means create: a ref already at oid is unchanged, at another oid a
   * Conflict. Publishing the same list twice succeeds twice.
   *
   * A null `oid` deletes the ref, leased at `expect`, which must be a real id.
   * A delete is strict: deleted (was at expect, now gone), else Conflict, with
   * the observed value "absent" when the ref is missing. It has no unchanged.
   *
   * With `remote` it is ONE `git push --atomic` and never touches a local ref;
   * remote unchanged is "as advertised at push time, not locked". Without, it is
   * one local ref transaction, where unchanged is verified inside it. Each
   * outcome comes from the tool's own per-ref report, never from a re-read. A
   * lost lease throws Conflict with `refs`; any other failure throws Error.
   */
  publish?(repo: string, updates: readonly RefUpdate[], remote?: string): Promise<PublishResult>
  /**
   * Fetch every ref under a prefix, or exactly the named refs, from `remote` in
   * ONE git process, and return each ref's tip under its original name. It
   * writes only gitomic's private namespace `refs/gitomic/fetched/<remote-key>/`,
   * never an application ref. A named ref missing on the remote throws.
   */
  fetchRefs?(repo: string, refs: string | readonly string[], remote: string): Promise<ReadonlyMap<string, Oid>>
}

/**
 * One ref of a MULTI publish: move `ref` from `expect` (all-zero: absent) to
 * `oid`, or, with a null `oid`, delete it at `expect`.
 */
export type RefUpdate = {
  readonly ref: string
  readonly expect: Oid
  readonly oid: Oid | null
}

/** One ref's outcome in a MULTI publish that landed. */
export type RefOutcome = { readonly ref: string; readonly outcome: "updated" | "unchanged" | "deleted" }

/** A MULTI publish that landed: every ref's outcome, in the order given. */
export type PublishResult = { readonly outcomes: readonly RefOutcome[] }

/** A clock in unix seconds (an integer). */
export type Clock = () => number

export type OpenOptions = {
  repo: string
  ref: string
  /**
   * Optional human-readable label for this store's commits. It names a role,
   * not an instance: reusing it across processes is fine and expected. Every
   * `open` mints its own unique identity underneath.
   */
  writer?: string
  /**
   * Who applies this store's commits: git's committer. Each transaction may
   * name its own author; one that names none has this committer as author.
   * Defaults to gitomic <gitomic@localhost>.
   */
  committer?: Ident
  remote?: string
  /**
   * Remote Store refresh policy. `always` (default) fetches before opening and
   * each transaction. `on-rejection` starts each transaction from the kept
   * local ref and fetches after a rejected or uncertain publish, before
   * receipt verification or replay. Use only when a leased push can arbitrate
   * a stale local base. `head()` reads the kept local ref in both modes.
   */
  refresh?: "always" | "on-rejection"
  backend?: GitomicBackend
  /**
   * The clock this store dates its commits by, in unix seconds (an integer).
   * Defaults to the wall clock. Pass a fixed or counting clock when commit ids
   * must be identical across backends or retries (tests, replays); a
   * consumer never inherits that determinism by accident (25486).
   */
  clock?: Clock
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

/** What one attempt built, handed to `beside` before the compare-and-swap. */
export type BesideAttempt = {
  /** The commit this attempt will publish. */
  readonly next: Oid
  /** The tip it was built on. */
  readonly base: Oid
  /** The attempt's tree, for a beside ref that needs to read what was written. */
  readonly map: GitMap
}
/**
 * Another ref to land in the SAME atomic publish as a transaction's commit:
 * from `expect` (null: absent) to `oid`, or, with a null `oid`, deleted at
 * `expect` (then a real id). See {@link TransactOptions.beside}.
 */
export type BesideRef = {
  readonly ref: string
  readonly expect: Oid | null
  readonly oid: Oid | null
}
export type TransactOptions = {
  readonly provenance?: CommitProvenance
  /**
   * Refs that land in the SAME atomic publish as this transaction's commit
   * (25312 E2a). Called once per attempt, after the commit is written and
   * before the compare-and-swap, so it can name that commit (`next`) and the
   * tips it read in this attempt; a replay calls it again against the new
   * commit. A noop attempt (nothing changed) never calls it. Any lost lease,
   * the ref's or a beside ref's, is a retry: this differs from gitomic/events'
   * `also`, which is static and so final when lost — `beside` is recomputed
   * against fresh tips every attempt. Needs a backend with MULTI `publish`;
   * a non-empty option on one without it refuses at the transact call.
   */
  readonly beside?: (attempt: BesideAttempt) => Promise<readonly BesideRef[]> | readonly BesideRef[]
  /** Git's author for this one transaction. Defaults to the store's committer. */
  readonly author?: Ident
  /** Derive and check the candidate tree inside the write, before the CAS, on every attempt. */
  readonly candidate?: Candidate
  /** Caller trailers for this one transaction, written ahead of gitomic's own; `Gitomic-*` keys are reserved. */
  readonly trailers?: readonly Trailer[]
}

export type Store = {
  head(): Promise<Oid>
  at(commit?: Oid): Snapshot
  transact(update: Update, message: string, options?: TransactOptions): Promise<Committed>
}
