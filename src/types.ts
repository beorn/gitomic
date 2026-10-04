export type Oid = string

/**
 * What a backend reports for one tree entry: the decoded UTF-8 value, or the
 * raw bytes when the blob is not valid UTF-8.
 *
 * GitMap values remain text. `apply`'s put-bytes edit can write opaque bytes;
 * unrelated binary blobs survive transactions without decoding.
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
/**
 * What an attempt knows besides the tree: the tips of {@link TransactOptions.fetch}'s refs as this attempt read
 * them. A listed ref the remote lacks is ABSENT from the map (`get` is undefined), never a throw; the store's own
 * ref is not in it and stays strict (its absence fails the refresh).
 */
export type AttemptContext = { readonly tips: ReadonlyMap<string, Oid> }
export type Update = (map: GitMap, base: Oid, attempt?: AttemptContext) => Promise<void>

/** How a ref compare-and-swap ended; see {@link GitomicBackend.compareAndSwap}. */
export type RefSwap = "swapped" | "moved" | "locked"

/**
 * What a remote Store's kept ref (its local cache of origin's tip) did after a publish origin accepted: "advanced"
 * to the landed commit; "moved" by another process first (the next attempt re-reads it); or "locked", its ref lock
 * held, which the next refresh reports by failing. The publish landed in every case.
 */
export type KeptCopy = "advanced" | "moved" | "locked"

export type Committed = {
  oid: Oid
  retries: number
  /** What the kept ref did after this publish landed; absent when the publish touched no kept ref (a local store). */
  kept?: KeptCopy
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
 * Historical attribution parsed from older Gitomic-Actor trailers. Write
 * options no longer accept this field; new attribution uses native Git
 * author/committer identities and opaque caller trailers.
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
   * Land the commit even when `changes` leaves the tree unchanged. Opt-in:
   * gitomic/events sets it, and `transact` sets it exactly when the transaction
   * names `keeps`. Without it `transact` and `apply` treat an unchanged tree as
   * a no-op.
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
  changes: ReadonlyMap<string, BlobValue | undefined>
  message: string
  /** The caller's human-readable label. Not an identity: it may repeat. */
  writer: string
  /** The one live store that produced this commit. Unique by construction. */
  instance: string
  seq: number
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

/**
 * One commit's oid and every parent, with NO message body, author, committer or
 * timestamp. This is the byte-bounded shape a write-log ancestry walk needs: the
 * edges of the kept content DAG, nothing that grows with the message.
 */
export type HistoryEdge = {
  readonly oid: Oid
  readonly parents: readonly Oid[]
}

/** A changed projected blob identity; mode-only changes are not represented. */
export type Change = { path: string; from: Oid | null; to: Oid | null }

/**
 * The four modes a tree listing exposes: regular blob, executable blob, symlink and gitlink. A listing tells the
 * truth about the tree it read, so a mode Git reports outside this finite vocabulary is REFUSED by name at the read
 * boundary (27226, @cto 6c07a697) rather than carried as data. Whether an ADMITTED mode is acceptable where an
 * entry is EXPOSED stays the one predicate, `assertRegularBlob` in path.ts.
 */
export type TreeEntryMode = "100644" | "100755" | "120000" | "160000"

/** The modes a raw tree-object entry may carry: the four above plus the tree mode the encoder writes. */
export type GitTreeObjectEntryMode = TreeEntryMode | "40000"

const TREE_ENTRY_MODES: ReadonlySet<string> = new Set<string>(["100644", "100755", "120000", "160000"])

/**
 * Narrow a mode Git reported to the listing vocabulary, refusing an entry outside it by name — mode, path and
 * commit — before any entry is built. Git's vocabulary is finite; a mode gitomic does not understand must not flow
 * through as data until something downstream assumes.
 */
export function assertTreeEntryMode(mode: string, path: string, commit: Oid): TreeEntryMode {
  if (TREE_ENTRY_MODES.has(mode)) return mode as TreeEntryMode
  throw new Error(
    "Git tree " +
      commit +
      " has unsupported mode " +
      mode +
      " at " +
      JSON.stringify(path) +
      "; a listing carries only 100644, 100755, 120000 and 160000",
  )
}

/** One regular blob of a tree listing: its object id and its mode. */
export type TreeEntry = {
  readonly oid: Oid
  /**
   * The mode Git reported for this entry, drawn from the listing vocabulary above. Whether that mode is ACCEPTABLE
   * is a policy applied where the entry is EXPOSED — `assertRegularBlob` in path.ts, the one predicate — never by a
   * backend dropping or rewriting it (27226, @cto acb610e6 + 6c07a697).
   */
  readonly mode: TreeEntryMode
}

/** A tree's regular blobs by path, with no value decoded: what a transaction is strict about. */
export type TreeListing = ReadonlyMap<string, TreeEntry>

export type GitomicBackend = {
  /** Repository object format, independent of refs and object contents; shell caches it per Git directory. */
  objectFormat(repo: string): Promise<"sha1" | "sha256">
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
   * Resolve ONE exact path in `commit`'s tree — a scoped lookup, not a listing:
   * the backend runs `git ls-tree -z --full-tree <commit> -- <path>` (or its
   * equivalent) and answers that path's entry, or `undefined` when the tree
   * holds no entry there. A directory answers `undefined` too: a listing recurses
   * trees away, so a tree entry is not a member of the listing vocabulary, and a
   * caller asking `has`/`oid`/`get` for a directory is asking a question whose
   * answer is "no regular blob here".
   *
   * A mode outside the listing vocabulary is still REFUSED by name, exactly as
   * `readTree` refuses it — the same `assertTreeEntryMode` boundary. This is the
   * second entry point of the same question `readTree` answers, and its answer for
   * a path `readTree` lists is that path's entry, byte for byte (27226 part 2,
   * @cto 0f5c2039).
   */
  readTreeExact(repo: string, commit: Oid, path: string): Promise<TreeEntry | undefined>
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
  /**
   * Move `ref` from `expected` to `next`. "swapped" when it moved; "moved" when the ref was not at `expected` (a lost
   * lease: re-read and retry); "locked" when its ref lock was held, so nobody could move it (a live holder finishes
   * in milliseconds, a lock left by a killed Git process never does). A backend without locks never answers "locked".
   */
  compareAndSwap(repo: string, ref: string, next: Oid, expected: Oid): Promise<RefSwap>
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
   * Whether `ancestor` is reachable from `descendant` through ANY parent; a commit is its own ancestor.
   * `transact`'s `keeps` needs it to refuse a commit the base already contains. A store on a backend
   * without it refuses a non-empty `keeps` at the call.
   */
  isAncestor?(repo: string, ancestor: Oid, descendant: Oid): Promise<boolean>
  /**
   * Fetch and return the remote tip without moving the selected application ref.
   * Object downloads and private temporary fetch refs are allowed. Readers rely
   * on this contract; Store refresh separately updates its local cache ref.
   */
  fetchRemote?(repo: string, ref: string, remote: string): Promise<Oid>
  /**
   * A string selects every ref under that prefix, locally or against `remote`.
   * An array selects exact full ref names locally only, omitting absent refs.
   * Results are in ref-name order. Arrays refuse malformed/repeated names and
   * any remote before I/O; a local empty array performs no I/O.
   * `for-each-ref` locally, `ls-remote --refs` for a remote prefix. Never moves a ref.
   */
  listRefs?(repo: string, selection: string | readonly string[], remote?: string): Promise<ReadonlyMap<string, Oid>>
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
  /**
   * Every parent of every commit reachable from `tips`, streamed as
   * `{ oid, parents }` edges in ONE process, with NO commit bodies read. This
   * is the bounded lower capability a cold write-log ancestry walk uses so a
   * large kept history never materialises as one in-memory graph.
   *
   * All parents are followed (never first-parent only), so a merge carries its
   * side parent. The stream is byte-bounded by the producer: `maxBytes` and
   * `maxRecords` are hard caps that REFUSE with a typed error before yielding
   * past them, and an unparsed carry buffer above its bound kills the child. A
   * consumer that stops early cancels the child. A backend that cannot stream
   * edges omits this method; callers that require it refuse loudly by name.
   */
  readHistoryEdges?(
    repo: string,
    tips: readonly Oid[],
    options?: { readonly exclude?: readonly Oid[]; readonly maxBytes?: number; readonly maxRecords?: number },
  ): AsyncIterable<HistoryEdge>
  /**
   * A leased push of `next` to `remote`: `landed: false` is a lease origin refused. A landed push also moves the
   * local ref, a cache of origin, and `kept` says how that went: "swapped" to `next`; "moved", left alone because it
   * was not at `expected`; or "locked". The push landed whatever `kept` says.
   */
  compareAndSwapRemote?(
    repo: string,
    ref: string,
    next: Oid,
    expected: Oid,
    remote: string,
  ): Promise<{ readonly landed: false } | { readonly landed: true; readonly kept: RefSwap }>
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
   * never an application ref. A named ref missing on the remote throws, unless
   * `absent: "omit"`: then it is left out of the result (still one process; the
   * store's per-attempt `fetch` of refs that may not exist yet uses this).
   */
  fetchRefs?(
    repo: string,
    refs: string | readonly string[],
    remote: string,
    options?: FetchRefsOptions,
  ): Promise<ReadonlyMap<string, Oid>>
}

/** How `fetchRefs` treats a named ref the remote does not have. */
export type FetchRefsOptions = { readonly absent?: "throw" | "omit" }
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
  /**
   * The tips of {@link TransactOptions.fetch}'s refs as this attempt read them, in the same fetch as the store's
   * ref, so a beside ref's `expect` is one attempt old at most. A listed ref the remote lacks is absent from the
   * map (`get` is undefined): `beside` treats that as create, with a null expect.
   */
  readonly tips: ReadonlyMap<string, Oid>
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
  /**
   * Full names of refs whose tips every attempt reads afresh and hands to `update` and `beside` as `tips`. On a
   * remote store they ride the SAME `fetchRefs` call as the store's ref — one process per attempt, never one per
   * ref; on a local store they are read from the repository. Absence is tolerated for the LISTED refs only: a
   * listed ref the remote lacks is absent from `tips` (`get` is undefined), never a throw, while the store's
   * own ref stays strict as always (the refresh fails when the remote lacks it). Refuses at the call for the
   * store's own ref, a name outside `refs/`, a repeat, or a backend that cannot read them (remote: `fetchRefs`;
   * local: `listRefs`).
   */
  readonly fetch?: readonly string[]
  /** Git's author for this one transaction. Defaults to the store's committer. */
  readonly author?: Ident
  /** Derive and check the candidate tree inside the write, before the CAS, on every attempt. */
  readonly candidate?: Candidate
  /** Caller trailers for this one transaction, written ahead of gitomic's own; `Gitomic-*` keys are reserved. */
  readonly trailers?: readonly Trailer[]
  /**
   * Commits this transaction keeps: written as extra parents after the base, in order, which makes the commit a
   * merge. With `keeps` the commit lands even when `update` leaves the tree unchanged, because the parents are
   * the change. The candidate, `beside`, the lease and the retry are as without it; a retry runs `update` again
   * on the new tip. Refused at the call: a repeat, a value that is not an object id, a backend without
   * `isAncestor`. Refused on EVERY attempt, before `update` runs: a keep that is not a commit in this
   * repository, and a keep the attempt's base already contains ({@link AlreadyKept}), so a retry on a tip that
   * gained the commit can never write a second merge of it.
   */
  readonly keeps?: readonly Oid[]
}

/** One unpublished step in a sequence. A thrown step leaves the prior steps intact. */
export type SequenceStep = {
  readonly oid: Oid
  readonly committed: boolean
  readonly report?: readonly string[]
}

export type SequenceAttempt = {
  /** The published tip this attempt started from. */
  readonly base: Oid
  readonly tips: ReadonlyMap<string, Oid>
  /** Each call gets a fresh overlay on the preceding successful step. */
  step(update: Update, message: string, options?: Omit<TransactOptions, "fetch" | "beside">): Promise<SequenceStep>
}

export type SequenceOptions<R> = {
  readonly fetch?: readonly string[]
  /** Stage refs once, after all steps. This only runs when at least one step wrote a commit. */
  readonly beside?: (
    attempt: BesideAttempt & { readonly value: R },
  ) => Promise<readonly BesideRef[]> | readonly BesideRef[]
}

export type SequenceResult<R> = {
  readonly value: R
  readonly oid: Oid
  readonly retries: number
  /** What the kept ref did after this publish landed; absent when the publish touched no kept ref (a local store). */
  readonly kept?: KeptCopy
}

export type Store = {
  head(): Promise<Oid>
  at(commit?: Oid): Snapshot
  transact(update: Update, message: string, options?: TransactOptions): Promise<Committed>
  /** Build several ordered commits, then publish their final tip and side refs in one CAS attempt. */
  transactSequence<R>(
    run: (attempt: SequenceAttempt) => Promise<R>,
    options?: SequenceOptions<R>,
  ): Promise<SequenceResult<R>>
}
