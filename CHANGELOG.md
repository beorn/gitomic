# Changelog

## Unreleased

### Added

- `batchCheck` checks ordered raw and peeled object names in one bounded Git
  process and reports missing objects or malformed batch answers explicitly.

### Fixed

- `gitomic project` and `gitomic apply --checkout` no longer report a checkout
  current, or merge over it, while its index holds an older tree than the tip
  (25393). Every projection first matches the index's tree id against the tip's
  first-parent history (no depth limit) and carries a match forward with the
  conditional two-way merge; a repaired projection reports `synchronized` with
  `repairedIndexFrom` on that variant only (CLI: `kind=synchronized … repaired-from=<oid>`), and an
  index matching no ancestor exits 4 (`dirt-unverifiable`), changing nothing.
  Reading the index never takes `.git/index.lock`: the common case compares
  with `diff-index --cached`, and only an index behind the tip has its tree id
  written from a copy of the index. The history walk reads in growing windows
  (256, 4,096, then 10,000 commits) and stops at the match, so a history longer
  than one process's output buffer no longer refuses.
- A local git command that does not run to completion (its output passed the
  buffer, it could not start, or a signal stopped it) is reported by its cause,
  such as `ENOBUFS`, never by its truncated output.

### Deprecated

- `RemoteFirstProjectionRequest.preTransactTip` is no longer consulted: the
  history walk above subsumes it. It will be removed.

## 0.3.0 — 2026-09-23

### Fixed

- `createShellBackend({ gitExecutable })` uses one selected executable for all
  backend Git commands, including the version probe and repository resolver, so
  callers with a configured Git tool no longer fall back to an ambient `git`.

## 0.2.0 — 2026-09-22

### Added

- `GitomicBackend.readTree` and `readBlobs`, both REQUIRED members of the
  backend contract: one listing (path, mode, oid — no value read) and one
  batched read of blobs by oid. `transact` and `apply` read their base through
  them — whole-tree strict on shape, lazy on values — so a write fetches the
  blobs it names instead of decoding every blob of the tree on every attempt
  (0.9 s and 175 MB per write on a 19,670-blob tree, measured). `apply`
  prefetches its edit paths in one read; reads issued in one microtask
  coalesce into one read. Snapshot reads the same lazy base through
  `readTree(prefix)`, so `oid`, `has` and `keys` never read a blob. All four
  known implementers are updated (shell, mem, iso, and one out-of-tree wrapper
  that projects the shell listing); any other backend must add both members.

### Removed

- `GitomicBackend.readFiles`. Its two callers (transactions and Snapshot) read
  through `readTree` and `readBlobs`; a backend that wrapped `readFiles` to
  filter or observe reads wraps `readTree` instead.
- Author and committer as data (`Ident = { name, email }`). `open` and
  `openEvents` take a `committer`; `transact`, `apply`, and the events `transact`
  and `append` take a per-call `author`, which defaults to the committer.
  `CommitInput` carries both to every backend, and `CommitMeta` and `Event` read
  them back from the header. When neither is named, commits are byte-identical
  to before. An ident that git's `commit-tree` would rewrite is refused, and
  `identProblem` exposes the same check so callers can fall back first.
- Top-level `gitomic --help` and `gitomic -h` print the CLI usage and available
  verbs without opening a repository.
- `createShellBackend({ baseEnv })` snapshots an exact environment for every
  backend Git command, while `runGit(..., { env })` keeps overlay semantics.
- `danglingRefs` and `isMissingObjectFetchError` provide one dependency-free
  owner for missing local ref-object diagnosis, including actionable fetch
  errors from the shell backend.
- `gitomic/events`: an append-only event chain on one ref, driven by the same
  compare-and-swap loop as `transact` (`openEvents`, `listRefs`, `chainsUnder`).
  `Store.transact` and `openEvents` now share one loop (`src/engine.ts`): one
  CAS, one retry budget and one receipt search, not two.
- Four backend contract additions for event chains:
  - `CommitInput.parents`: the complete parent list; the first must equal
    `parent`, and the rest are kept commits. `CommitMeta.parents` reports every
    parent, and `CommitMeta.parent` stays as the first.
  - `allowEmpty`: an opt-in for commits that leave the tree unchanged. Only
    events use it; `transact` and `apply` still land nothing on an unchanged
    tree.
  - `trailers`: `CommitInput.trailers` writes caller trailers into the final
    block, ahead of gitomic's own, and `CommitMeta.trailers` reads them back in
    order. `Gitomic-*` keys are refused.
  - `listRefs`: every ref under a prefix, via `for-each-ref` locally or
    `ls-remote --refs` remotely.
- `GitomicBackend.readHistory` and `writeGenesis`, both optional. The first is a
  batched first-parent read over many tips; the second writes the canonical
  empty root an event chain starts from.
- MULTI: `GitomicBackend.publish(repo, updates, remote?)` moves many refs
  atomically, all or none: one `update-ref --stdin` transaction locally, one
  `git push --atomic` with a lease per ref remotely, check-all-then-set on mem.
  `expect` is a lease, not an assertion: each ref is updated, unchanged
  (already at oid) or a `Conflict` naming the ref, expect and observed tip, and
  the result lists every ref's outcome from git's per-ref report. `Conflict`
  gains `refs`, the refs whose lease was lost. `append` and `transact` take
  `also: [{ ref, expect, oid }]` to publish more refs with the event; a lost
  `also` lease is a `Conflict`, never a retry.
- `fetchRefs(prefixOrRefs, { repo, remote })` and `GitomicBackend.fetchRefs`:
  every ref under a prefix, or the named refs, in ONE `git fetch`, into the
  private namespace `refs/gitomic/fetched/<remote>/`. `chainsUnder` now reads a
  remote prefix: one fetch, then one walk.
- A leased delete in MULTI: `RefUpdate.oid` and `AlsoRef.oid` accept `null`,
  which deletes the ref at `expect` (a real id; a zero expect is a
  `TypeError`) in the same atomic publish, with the outcome `deleted`. A delete
  is strict: absent or elsewhere is a `Conflict` naming the observed value.
  Locally a `delete <ref> <expect>` line, remotely `:<ref>` with a lease; a
  lost remote lease costs one `ls-remote` to name the tip git did not report.
- An all-zero `expected` passed to `compareAndSwap` now means the ref must be
  absent (create-if-absent) on every backend. A remote swap that creates a ref
  missing locally no longer fails after the push has landed.

### Changed

- `Reader.log` reads the whole range in one process when the backend has
  `readHistory`. Without it, the per-commit walk is unchanged.
- The CLI's `log --json` records carry the new `parents` and `trailers` fields.
- `gitomic/events` publishes every event through `GitomicBackend.publish`, so a
  backend needs it to hold event chains. A remote chain reads through
  `fetchRefs` and no longer moves a local cache ref; `Store` is unchanged.

### Changed

- Transaction identity is now unique by construction instead of coordinated.
  Every `open` mints a UUID for that one live store and stamps it on each commit
  as a `Gitomic-Instance` trailer, beside a `Gitomic-Seq` counter that starts at
  zero and lives only in memory. `(instance, seq)` cannot collide with any other
  process, alive or dead, so retry deduplication needs nothing stored anywhere.
- `OpenOptions.writer` is now optional and purely a human-readable label for the
  audit trail (default `"gitomic"`). It may repeat across processes, restarts,
  and machines. Existing callers passing a writer keep working unchanged.
- `findTransaction` takes the transaction's base commit and its store instance:
  `findTransaction(repo, head, base, instance, seq)`. The search stops at `base`
  — nothing older can be the sought commit — so it reads only the commits that
  arrived during one publish attempt rather than a fixed near-tip batch, and
  still fails loudly when a chain runs past the horizon without reaching it.
- `CommitInput` carries `instance` beside `writer`, and is now exported.

### Removed

- The inflight commit pins under `refs/gitomic/inflight/`, with the hand-rolled
  loose-ref lockfile protocol (temp file, fsync, rename, directory fsync), the
  `.gitomic-keep` sentinel file, the ref-storage special case, and the combined
  publish-and-unpin ref transaction. A transaction now performs exactly one ref
  write: the publish. The pins guarded the window in which a completed commit is
  unreferenced; Git's default gc grace (`gc.pruneExpire = 2.weeks.ago`) covers
  that window instead. **Residual risk, now stated in the README rather than
  silently assumed:** an aggressive `gc.pruneExpire`, or `git gc --prune=now`
  running concurrently with a transaction, can reclaim the commit mid-flight —
  the publish then fails loudly on the missing object and never moves the ref.
  `createShellRuntime()` no longer returns `pinCommit`.
- The per-writer sequence ledger under `.gitomic/writers/`. Transactions no
  longer write bookkeeping into the tree they commit, and the retry path no
  longer reads the winner's whole tree to consult it. `.gitomic/` stays a
  reserved path namespace that callers cannot write.
- The writer lease refs under `refs/gitomic/writers/` and the backend's
  `acquireWriter` operation. The lease used a `kill(pid, 0)` liveness probe,
  so a stale lease plus a recycled process id could refuse every subsequent
  `open` permanently. Two live stores may now share a writer label; give
  simultaneous writers distinct labels so they do not share an inflight pin
  slot. Backends that wrap a built-in backend by spreading it are unaffected.

### Fixed

- A single blob that is not valid UTF-8 no longer makes an entire tree
  unreadable. The whole-tree read stopped eagerly decoding every blob, so
  `keys`, `has`, `set`, `delete` and `transact` all work in a tree that mixes
  text with an image, and an untouched binary blob rides into the next commit
  as the same object. Reading such a value still fails loudly and names the
  path — gitomic v1 values remain UTF-8 strings. `GitomicBackend.readFiles` may
  now return raw bytes for such an entry; a backend that only returns strings
  satisfies the signature unchanged.

## 0.1.0 — 2026-07-19

First implementation release.

### Added

- Atomic `open`, `head`, `at`, and `transact` core with a GitMap interface.
- Shell, isomorphic-git, and in-memory backends with object-ID equivalence.
- Filesystem, key-value, and unstorage adapters.
- Compare-and-swap replay, writer/sequence idempotency, and remote lease support.
- Generic versioned ownership-manifest parsing with caller-supplied path policy.
- Lease-free `openReader` snapshots and abortable local/remote ref-tip change streams.
- Prefix-scoped lazy Snapshot reads over the one backend read path, with loud
  low-level misses and whole-tree transaction strictness.

### Reliability

- Bounded transaction-receipt recovery with loud horizon failures in both Git backends.
- Durable object/ref writes, strict path and UTF-8 validation, and writer-generation ownership.
- Conformance coverage for concurrent writers, conflict semantics, README examples, packaging, and backend parity.
