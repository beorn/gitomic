# Changelog

## Unreleased

## 0.6.0 — 2026-09-25

### Changed (breaking for custom backends)

- `GitomicBackend.compareAndSwap` answers the new union `RefSwap` (`"swapped" | "moved" | "locked"`) instead of a boolean, and `GitomicBackend.compareAndSwapRemote` answers `{ landed: false } | { landed: true, kept: RefSwap }`. Callers that only want landed compare against `"swapped"`. A held ref lock is no longer indistinguishable from a lost lease. A backend or wrapper that returned `true`/`false` fails to typecheck until it answers the new shape.

### Added

- `Committed.kept` and `SequenceResult.kept`, typed `KeptCopy`: on a remote Store in either refresh mode, what its kept ref did after the publish landed — `"advanced"`, `"moved"` by another process, or `"locked"`. Absent when the publish touched no kept ref.

### Fixed

- A remote Store whose kept ref is locked (a `.lock` left by a Git process killed mid-update) retries for about 200 ms, then fails the refresh before any push, naming the lock file, instead of silently paying a refused lease and a fetch on every later write.

## 0.5.0 — 2026-09-25

### Added

- `Store.transactSequence` builds ordered content commits in one compare-and-swap attempt and publishes their final tip with optional side refs atomically. Each awaited step gets a fresh overlay, its own message, attribution and candidate gate; a rejected step leaves earlier steps intact. A lost lease replays the sequence against fresh tips, while a no-op step creates no commit.
- Event chains can `stage` commits before one atomic publication, and `transact` can decide from a bounded `from` tip without silently truncating the tail.
- Remote transactions can refresh after a rejected compare-and-swap to find an uncertain push's receipt before replay.

- `beside` on `Store.transact` (25312 E2a): a per-attempt function returning
  refs that land in the SAME atomic publish as the transaction's commit. It is
  called after the commit is written and before the compare-and-swap, with the
  commit, its base and the attempt's tree; a replay calls it again; a noop
  attempt never does. Any lost lease is a retry, unlike the events door's
  static `also`, which is final when lost. Needs a MULTI `publish` backend and
  refuses at the call otherwise. The `also`/`beside` validation is one
  function, `shapeRefUpdates`.
- `fetch` on `Store.transact`: refs whose tips every attempt reads in the SAME
  fetch as the store's ref (remote) or from the repository (local), handed to
  `update` (third argument) and `beside` as `tips`; a listed ref that does not
  exist yet is absent from the map, while the store's own ref stays strict. `fetchRefs`
  takes `{ absent: "omit" }`: a named ref the remote lacks is fetched as a
  pattern and left out instead of failing the whole fetch. `events({ at })`
  reads a chain at a tip already fetched, with no remote round trip.

- `authoredPaths` on `CheckoutSyncRequest` and `RemoteFirstProjectionRequest`
  (25350 S3): "paths whose checkout content IS this landing" — a write authored
  in the checkout lands files the caller already wrote. The projection proves
  every one first (the landing changed it, and the checkout holds the landed
  blob or is absent for a removal), then stages exactly those paths and never
  writes one, so a landing that also carries another writer's paths still ends
  clean. Any mismatch refuses as the new outcome `authored-mismatch`, naming the
  path and both blob oids, with nothing staged; a refused merge unstages them.

### Changed

- Commit times are the wall clock (25486). Every backend dated a commit one
  second after its parent, so a busy chain's dates fell hours behind the clock
  (316 STATE commits made over five hours carried five minutes of dates).
  `open` and `openEvents` take `clock?: () => number` (unix seconds, an
  integer; the wall clock by default), `CommitInput` carries `time`, and every
  backend writes the later of that time and the parent's plus one, so a chain
  never runs backwards. Pass a fixed or counting clock for deterministic
  commit ids across shell, iso and mem and across a retry; the genesis keeps
  its fixed time. A non-integer clock value or an unreadable parent time is a
  `TypeError` by name, replacing the silent `1` fallback. No CLI flag: the CLI
  is a wall-clock writer.

### Fixed

- A confirmed remote lease loss is distinguished from an uncertain push, and a chain-only rival is retried within the transaction budget.
- A fetch that loses the fetched-ref lock race to another fetch in the same
  repository waits 25-99 ms before retrying while the rival still holds the
  lock, and after its last attempt the error says how many times it lost,
  with git's error as its cause.

## 0.4.0 — 2026-09-24

### Removed

- `RemoteFirstProjectionRequest.preTransactTip` (25350 S2, 25436): deprecated and
  unread since 25393, whose first-parent walk against the index's tree id
  subsumes it; its in-repo callers are gone with it.

### Added

- The checkout lock (25350): `gitomic project` and `gitomic apply --checkout`
  hold `<git-common-dir>/km-state-write.lock` — the file hh's other checkout
  writers already take — for their whole checkout write, waiting 15 s
  (`--lock-timeout <ms>`) before exiting `5` with the lock path and the
  recorded holder. A parent holding the lock lends it to a child through
  `GITOMIC_CHECKOUT_LOCK_FD`. The Bun-only subpath `gitomic/checkout-lock`
  exports `holdCheckoutLock`, `checkoutLockPath`, `CHECKOUT_LOCK_NAME` and
  `CHECKOUT_LOCK_FD_ENV`; the root entry never imports it and still loads
  under Node.
- A runtime dependency, `@bearly/flock` (^0.1.1): the lock is flock(2) through
  `bun:ffi`, and Node has no flock API, so `project` and `apply --checkout`
  need Bun and exit `6` under Node, writing nothing; every other verb runs on
  either runtime.
- `editsFromCheckout(root, paths, base)` on the root entry (25350): the files a
  caller wrote in a checkout become edits against the snapshot it read — a
  present file a `put` under `put`'s own auto-read precondition, a missing one
  an `rm` anchored on its base oid; a path absent from both, or named twice,
  refuses. The CLI's `put` shares its file read and precondition.

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
