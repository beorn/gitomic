# gitomic

Atomic git writes without a working copy — many writers, no merges, nothing lost.

## The problem

Several programs write the same files: agents, scripts, you in an editor. Plain writes race — the last save wins and edits vanish. Lock files cover one file at a time and keep no history. A database fixes writes but takes your files away.

gitomic is for anyone who wants **files as the source of truth** and **many concurrent writers** without picking one of those poisons. It was built for fleets of AI agents sharing a repo, but nothing about it is agent-specific.

## How it works

1. A write builds its result directly in git's object database. No checkout is touched. Changes to many files become one commit — all or nothing.
2. Publishing is one rule: *advance the ref to my commit, but only if it hasn't moved* (`git update-ref`, or `push --force-with-lease` against a remote).
3. If someone else got there first, your operation is a function — gitomic re-runs it on their version. Text is never merged.
4. Every commit records who, why, and a sequence number. Retries can't apply twice. History reads as a decision log.

In one sentence: an immutable map (the git tree), a small overlay map (your pending writes), and a pointer that only moves if nobody else moved it first.

## API

```ts
import { open, Conflict } from "gitomic"

const store = await open({
  repo: "path/inside/repo",
  ref: "refs/heads/main",
  writer: "worker-3",
  remote: "origin",            // optional: makes origin the arbiter
})

store.head()                   // newest commit id
store.read(at?)                // read-only view at that commit — lazy, nothing copied
store.commit(changes, opts?)   // Map<path, content | null> → one commit, if the ref hasn't moved
store.apply(fn, why?)          // fn(draft) — runs, commits, re-runs on a race
```

A draft is almost a `Map`: `get`, `set`, `has`, `delete`, plus `ls(dir)` to list one directory. Reads are async and lazy; writes are plain Map inserts, and `draft.changes` is the Map that `commit()` takes. Read-after-write sees your write, like immer. One rule: touch nothing but the draft — it may run twice (the `runTransaction` contract).

## Example

```ts
// archive every finished task — all five verbs in one recipe
await store.apply(async (d) => {
  for (const name of await d.ls("tasks")) {                  // list one directory
    const task = await d.get(`tasks/${name}`)                // read
    if (!task?.includes("status: done")) continue
    if (await d.has(`archive/${name}`))                      // check
      throw new Conflict(`archive/${name} already exists`)
    d.set(`archive/${name}`, task)                           // write
    d.delete(`tasks/${name}`)                                // remove
  }
}, "archive finished tasks")
```

However many files the loop touches, they land as one commit — five moves or none. Measured with 3 writers firing 100 concurrent ops: straight-line history, zero merges, zero lost updates.

Other dialects are adapters, not core: `withFs()` for fs-style recipes, `asFs()` to make a snapshot look like `node:fs`, and an [unstorage](https://unstorage.unjs.io) driver that is mostly renames (`get`→`getItem`, walked `ls`→`getKeys`).

## Good for / not for

**Good for:** many writers with one clean history — no server, no lock files. A full audit trail (who, why, when) on every change. Consistent snapshot reads from anywhere, no checkout needed. And it's plain git: log it, push it, back it up.

**Not for:** very high write rates — the `shell` backend does a handful of writes per second, the `iso` backend tens; neither is a telemetry store. Code — a replayed patch can't validate itself, so keep code on your merge queue. Offline multi-master — there is one arbiter ref, on purpose. Impure operations — recipes may re-run, so no clocks, network, or disk inside.

## Alternatives & prior art

- **SQLite** — better for relational or high-rate data, but your files stop being files.
- **CRDTs** (Automerge, Yjs) — merge without coordination, but can't enforce rules like "only one writer may claim this."
- **The same idea elsewhere**: Gerrit NoteDb, git-bug, Irmin, Jujutsu (inside git); Kubernetes server-side apply, Replicache, Delta Lake (outside it). Datomic inspired the name and the philosophy. gitomic is the small standalone version.

## Status

Design done; v1 in development. The npm name is a reserved, deprecated placeholder until then. v1 ships **two backends**: `shell` (zero dependencies — the git binary you already have) and `iso` (optional import; [isomorphic-git](https://isomorphic-git.org) builds objects in-process for ~10× the write throughput — the ref compare-and-swap stays on native git either way, and an object-id-equivalence test suite holds the two backends bit-identical). Planned: `withFs` / `asFs` / `asKv` adapters, the unstorage driver, an in-memory backend for tests, field-level claims, multi-ref transactions.

MIT © Bjørn Stabell
