# gitomic

Direct git commits, skip working copies — many writers, no merges, nothing lost.

## Example

```ts
import { open, Conflict } from "gitomic"

const store = await open({ repo: ".", ref: "refs/heads/main", writer: "worker-3" })

// archive every finished task — all five verbs in one write function
await store.apply(async (d) => {
  for (const name of await d.ls("tasks")) {                  // list
    const task = await d.get(`tasks/${name}`)                // read
    if (!task?.includes("status: done")) continue
    if (await d.has(`archive/${name}`))                      // check
      throw new Conflict(`archive/${name} already exists`)
    d.set(`archive/${name}`, task)                           // write
    d.delete(`tasks/${name}`)                                // remove
  }
}, "archive finished tasks")
```

What just happened: the function read the newest commit, and its writes were captured in memory — no checkout was touched. When it returned, gitomic built the new files directly in git's object database and landed them as **one commit**: however many files the loop moved, it's five moves or none. If another writer committed first, gitomic re-ran the function on their version instead of merging. In the test suite, 3 writers firing 100 concurrent writes produce a straight-line history: zero merges, zero lost updates.

## The problem

Several programs write the same files: agents, scripts, you in an editor.

- **Plain file writes** race — the last save wins, edits vanish.
- **Lock files** cover one file at a time, and keep no history.
- **A database** handles concurrent writes, but your data no longer lives in files.

gitomic is for anyone who wants **files as the source of truth** and **many concurrent writers** without those trade-offs. Built for fleets of AI agents sharing a repo — but nothing about it is agent-specific.

## How it works

1. A write builds its files directly in git's object database — no checkout involved. Many files, one commit: all or nothing.
2. Publishing follows one rule: move the branch pointer (the **ref**) to the new commit — but only if nobody else moved it first (`git update-ref`; with a remote, `push --force-with-lease`).
3. If someone else got there first, gitomic re-runs your **write function** on top of their version. Text is never merged.
4. Every commit records who, why, and a sequence number — so a retried write can never apply twice, and history reads as a decision log.

In short: gitomic is an immutable map (the git tree), an overlay of pending writes, and a pointer that only advances if nobody else moved it first.

## API

```ts
const store = await open({
  repo: "path/inside/repo",
  ref: "refs/heads/main",
  writer: "worker-3",
  remote: "origin",            // optional: races are decided at origin
})

store.head()                   // newest commit id
store.read(at?)                // read-only view at that commit — lazy, nothing copied
store.commit(changes, opts?)   // Map<path, content | null> (null deletes) → one commit
store.apply(fn, why?)          // fn(draft) — runs, commits, re-runs on a race
```

The draft your write function receives is almost a `Map`:

- `get(path)` — read (async, fetched lazily from the object database)
- `set(path, content)` — write (instant, in-memory)
- `delete(path)` — remove
- `has(path)` — check
- `ls(dir)` — list one directory
- `draft.changes` — the underlying `Map`, the same shape `commit()` accepts

Reads see your own pending writes. One rule: your write function must touch nothing but the draft, because it may run more than once.

### Adapters — same store, other faces

- `withFs(fn)` — write using `node:fs` verbs: `readFile`, `writeFile`, `rm`
- `asFs(store, at?)` — read any snapshot through a `node:fs`-compatible object
- `asKv(store)` — one-call reads and writes: `get(path)`, `set(path, content, why)`
- `asUnstorage(store)` — an [unstorage](https://unstorage.unjs.io) driver: `get`→`getItem`, recursive `ls`→`getKeys`

## Good for / not for

**Good for:**

- Many writers, one clean history — no server, no lock files
- A full audit trail on every change: who, why, when
- Consistent snapshot reads from anywhere — no checkout needed
- Plain git underneath: log it, push it, back it up

**Not for:**

- Very high write rates — `shell` does a handful of writes per second, `iso` tens; not a telemetry store
- Code — a re-run write isn't re-tested; keep code changes in normal review and CI
- Offline or multi-master use — all writers race against one authoritative ref, by design
- Side effects — your write function may re-run; keep clocks, network, and disk out of it

## Alternatives & prior art

- **SQLite** — better for relational or high-rate data, but your files stop being files.
- **CRDTs** (Automerge, Yjs) — merge without coordination, but can't enforce rules like "only one writer may claim this."
- **The same idea elsewhere** — Gerrit NoteDb, git-bug, Irmin, Jujutsu (inside git); Kubernetes server-side apply, Replicache, Delta Lake (outside it). Datomic inspired the name and the philosophy.

## Status

Design done; v1 in development. The npm package is a name-hold placeholder — don't install it yet.

v1 ships two backends:

- `shell` — zero dependencies; the git binary you already have
- `iso` — optional import; [isomorphic-git](https://isomorphic-git.org) builds objects in-process for ~10× the write throughput; the ref compare-and-swap stays on native git, and an object-id equivalence suite holds both backends bit-identical

Planned: `mem` backend for tests · field-level claims · multi-ref transactions.

MIT © Bjørn Stabell
