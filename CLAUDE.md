# gitomic contributor contract

gitomic is a standalone public library. Keep the default shell/core entrypoint free of runtime dependencies and workflow-specific policy. `isomorphic-git` is optional and may only load through `gitomic/iso`; `gitomic/mem` must never invoke Git.

The README is the public behavior contract. Work test-first, preserve object-ID equivalence across shell/iso/mem under an injected clock (commit times are the wall clock by default; `tests/clock.test.ts` keeps the equivalence tested), and prove concurrent changes by CAS/replay rather than merges or working-copy writes.

Before handing off a change, run:

```sh
bun run check
```

For concurrency or object serialization changes, also run the backend benchmark and the focused race tests. Never publish from an implementation session; release is a separate reviewed operation.
