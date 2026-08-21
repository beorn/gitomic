# Changelog

## Unreleased

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
