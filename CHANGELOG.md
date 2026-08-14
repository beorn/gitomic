# Changelog

## Unreleased

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
