# gitomic

Direct git commits, skip working copies — many writers, no merges, nothing lost.

## Example

```ts
import { open } from "gitomic"

const store = await open({ repo: ".", ref: "refs/heads/main", writer: "worker-3" })

await store.apply(async (map) => {
  map.set("tasks/124-dark-mode.md", "# Dark mode\nstatus: open\n")
  map.set("board.md", (await map.get("board.md")) + "- [ ] 124-dark-mode\n")
}, "create task 124")
```

This creates a task file and adds it to the board — **one commit, both files or neither**. No checkout was touched: the writes were captured in memory and built directly into git's object database. If another writer committed first, gitomic re-runs the function on their version instead of merging.

## The problem

Several programs write the same files: agents, scripts, you in an editor.

- **Plain file writes** race — the last save wins, edits vanish.
- **Lock files** cover one file at a time, and keep no history.
- **A database** handles concurrent writes, but your data no longer lives in files.

gitomic is for anyone who wants **files as the source of truth** and **many concurrent writers** without those trade-offs. Built for fleets of AI agents sharing a repo — but nothing about it is agent-specific.

## How it works

1. A write builds its files directly in git's object database — no checkout involved. Many files, one commit: all or nothing.
2. Publishing follows one rule: move the branch pointer (the **ref**) to the new commit — but only if nobody else moved it first (`git update-ref`; with a remote, `push --force-with-lease`).
3. If someone else got there first, gitomic re-runs your **update function** on top of their version. Text is never merged.
4. Every commit records who, why, and a sequence number — so a retried write can never apply twice, and history reads as a decision log.

In short: gitomic is an immutable map (the git tree), an overlay of pending writes, and a pointer that only advances if nobody else moved it first.

<details>
<summary><b>Aside: how replay-with-backoff actually works</b></summary>

1. Read the tip commit and pin its tree. Run your update function against that frozen view; collect its writes in memory.
2. Build the new commit and try the swap: *advance the ref from the pinned tip to my commit*.
3. If the ref moved meanwhile, discard the collected writes and start over from the **new** tip — a full re-run, not a patch: your function sees the winner's state and may decide differently (or throw `Conflict`, which ends the attempt cleanly).
4. Before retrying, wait a short **random, roughly-doubling delay** (capped at ~150ms). Randomness matters: with fixed delays, racing writers retry in lockstep and collide forever — jitter spreads them out.
5. Attempts are bounded — after repeated losses gitomic gives up with `RetriesExhausted` instead of spinning.

Losing costs almost nothing: the discarded attempt was memory plus unreferenced git objects (cleaned by normal `git gc`). In testing, 3 writers × 100 concurrent writes generated 431 retries — and 300 of 300 writes landed exactly once.

</details>

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
store.apply(fn, why?)          // fn(map) — runs, commits, re-runs on a race
```

The map your update function receives is almost a JS `Map`:

- `get(path)` — read (async, fetched lazily from the object database)
- `set(path, content)` — write (instant, in-memory)
- `delete(path)` — remove
- `has(path)` — check
- `ls(dir)` — list one directory
- `map.changes` — the underlying `Map`, the same shape `commit()` accepts

Reads see your own pending writes. One rule: your update function must touch nothing but the map, because it may run more than once.

### Adapters — same store, other faces

- `withFs(fn)` — write using `node:fs` verbs: `readFile`, `writeFile`, `rm`
- `asFs(store, at?)` — read any snapshot through a `node:fs`-compatible object
- `asKv(store)` — one-call reads and writes: `get(path)`, `set(path, content, why)`
- `asUnstorage(store)` — an [unstorage](https://unstorage.unjs.io) driver: `get`→`getItem`, recursive `ls`→`getKeys`

## A fuller example

```ts
// archive every finished task — all five verbs in one update function
await store.apply(async (map) => {
  for (const name of await map.ls("tasks")) {                // list
    const task = await map.get(`tasks/${name}`)              // read
    if (!task?.includes("status: done")) continue
    if (await map.has(`archive/${name}`))                    // check
      throw new Conflict(`archive/${name} already exists`)
    map.set(`archive/${name}`, task)                         // write
    map.delete(`tasks/${name}`)                              // remove
  }
}, "archive finished tasks")
```

However many files the loop touches, they land as one commit — five moves or none. In the test suite, 3 writers firing 100 concurrent writes produce a straight-line history: zero merges, zero lost updates.

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
- Side effects — your update function may re-run; keep clocks, network, and disk out of it

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
