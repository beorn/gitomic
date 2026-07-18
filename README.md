# gitomic

Atomic, merge-free writes to shared files, using git as the database.

## The problem

You have several processes writing the same small pile of files — task lists, status boards, config, notes. Agents, cron jobs, scripts, maybe a human with an editor. Today your options are bad:

- **Plain file writes** race: last save wins, someone's edit silently vanishes.
- **Lock files** serialize one file at a time, but a change spanning three files can die halfway, and you get no history and no answer to "who changed this and why."
- **A real database** fixes writes but takes the files away — no editor, no grep, no diffs, no git tooling, and the humans lose their workflow.

gitomic is for anyone who wants **files as the source of truth** and **many concurrent writers** without picking one of those poisons. It was built for fleets of AI agents sharing a repo, but nothing about it is agent-specific.

## How it works

1. A write never touches checked-out files. It builds the new file contents **directly in git's object database** and wraps them in **one commit** — so a change to five files is all-or-nothing.
2. Publishing is a **compare-and-swap** on one ref: *"make Y the new tip — but only if the tip is still X"* (`git update-ref`). One ref is the single arbiter; with a remote, `push --force-with-lease` is the same check against `origin`.
3. Lost the race? Your operation is a **function**, so gitomic re-runs it against the new tip. It finds its target in the winner's version and edits *that* — or throws a real conflict ("the task I was closing is gone"). Text is never merged.
4. Every commit records **who / sequence / why** — history reads as a decision log, and a duplicate submission (retry after a lost ack) returns the original result instead of applying twice.

The whole design in one sentence: *an immutable map (a git tree), a tiny overlay map (your pending writes), and a pointer that only advances if nobody moved it first.*

## API

```ts
import { open, Conflict } from "gitomic"

const store = await open({
  repo: "path/inside/repo",
  ref: "refs/heads/main",
  writer: "worker-3",           // durable identity; sequence numbers managed for you
  remote: "origin",             // optional — when set, the remote ref is the arbiter
})

store.head()                    // newest commit id
store.read(at?)                 // Snapshot — a lazy handle: get(path), ls(dir); nothing is copied
store.commit(changes, opts?)    // Map<path, content | null> (null = delete) → one CAS attempt
store.apply(fn, why?)           // fn: (snap, changes) => Promise<void> — atomic, re-run on race
```

Two nouns, both plain: a **Snapshot** (frozen reads from one commit, fetched lazily per file) and a **Map** (your pending writes — the actual `Map` instance that becomes the commit). Rules: read only `snap`, write only `changes`, and the function may run more than once — the same contract as Firestore's `runTransaction`.

## Example

```ts
await store.apply(async (snap, changes) => {
  const task = await snap.get("tasks/123-fix-login.md")
  if (task === undefined) throw new Conflict("task 123 no longer exists")
  changes.set("tasks/123-fix-login.md", task.replace("status: open", "status: done"))
  changes.set("board.md", (await snap.get("board.md")).replace("- [ ] 123", "- [x] 123"))
}, "close 123 — fix shipped")
```

Both files change together or not at all. If another writer lands first, the function re-runs against their snapshot; under a 3-writer × 100-op stress test this yields a strictly linear history — zero merges, zero lost updates.

Prefer filesystem ergonomics? That's composed, not core: `withFs(async fs => {...})` adapts an fs-style recipe (`readFile`/`writeFile`/`rm`) onto `(snap, changes)`, and `asFs(store, at?)` presents any snapshot as a `node:fs`-compatible object for third-party libraries. An [unstorage](https://unstorage.unjs.io) driver is planned on the same principle — `getItem`/`getKeys` from snapshots, `setItem` as an atomic commit, batch `setItems` as **one** commit, `getMeta` surfacing who/why/when — a read-write, atomic sibling to the read-only GitHub driver.

## Pros

- Multi-file atomicity, zero lost updates, and a who/why audit log — with no server to run.
- Nothing ever dirties a checkout; readers pin one commit id and see a consistent snapshot from anywhere.
- It's plain git underneath: inspect with `git log`, sync with `git push`, back up like any repo.
- Zero dependencies — shells out to the git binary you already have.

## Cons

- Not for high write rates: shelled git tops out around a handful of writes/second. Fine for coordination state; wrong for telemetry.
- Not for code or patches: replay assumes an operation can validate itself against new state. A rebased code diff can't (tests must run) — keep code on your merge queue.
- One arbiter ref by design — this is optimistic serialization, not partition-tolerant multi-master.
- Operation functions must be pure (read only their snapshot, write only their changes map) — that's what makes re-running them safe.

## Alternatives & prior art

- **SQLite** — better for relational or high-rate data; you give up files-as-truth.
- **Lock files / flock** — fine for one file, no cross-file atomicity, no history.
- **CRDTs (Automerge, Yjs)** — merge without coordination, great offline; but auto-merge can't enforce invariants ("two claims both win"), which serialized replay prevents.
- **Datomic** — the closest spiritual ancestor, and half the name (git + atomic, with the Datomic echo intended): immutable facts, a single serializing writer, derived disposable indexes, every past state queryable forever. gitomic is that philosophy with files and a git ref instead of datoms and a transactor.
- **The same pattern, embedded elsewhere**: Gerrit **NoteDb** (review state in refs, atomic ref transactions), **git-bug** (issues as op-logs), **Irmin** (`test_and_set`), **Jujutsu**; and outside git — Kubernetes **server-side apply**, **Replicache** server reconciliation, **Delta Lake/Iceberg** optimistic commits, **immer** and Redux (the pure-function-over-frozen-state shape of `apply`). gitomic is that pattern as a small standalone library.

## Status & roadmap

Design locked; v1 (shell backend) in development — the npm package is a deprecated placeholder until then. Planned: `withFs()` / `asFs()` / `asKv()` adapters · `unstorage` driver · `mem` backend for tests · isomorphic-git backend (objects in-process; the CAS stays on native git) · field-level claims · multi-ref transactions · text-merge overlay for concurrent free-text.

MIT © Bjørn Stabell
