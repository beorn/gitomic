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

Creates a task and updates the board — **one commit, both files or neither**. No checkout involved: writes are captured in memory and built straight into git's object database. If another writer lands first, gitomic re-runs the function on their version — no merge.

## The problem

Several programs write the same files: agents, scripts, you in an editor.

- **Plain file writes** race — the last save wins, edits vanish.
- **Lock files** guard one file at a time and keep no history.
- **A database** handles concurrency but takes your data out of files.

gitomic is for anyone who wants **files as the source of truth** and **many concurrent writers** without those trade-offs. Built for fleets of AI agents sharing a repo — but nothing about it is agent-specific.

## How it works

1. A write builds its files directly in git's object database — no checkout involved. Many files, one commit: all or nothing.
2. One publish rule: move the branch pointer (the **ref**) to the new commit — only if nobody else moved it first (`git update-ref`; remote: `push --force-with-lease`).
3. Lose the race? gitomic re-runs your **update function** on the winner's version. Text is never merged.
4. Every commit records who, why, and a sequence number — a retried write can't apply twice, and history reads as a decision log.

In short: an immutable map (the git tree), an overlay of pending writes, and a pointer that only advances if nobody moved it first.

### The race, in detail

1. Pin the tip's tree. Run your update function against that frozen view; collect writes in memory.
2. Build the commit and try the swap: advance the ref from the pinned tip to it.
3. If the ref moved, discard the writes and start over from the new tip — a full re-run, not a patch: the function sees the winner's state and may decide differently, or throw `Conflict` to stop cleanly.
4. Wait a short random, roughly-doubling delay (≤ ~150ms) before retrying. The randomness matters: fixed delays make racing writers collide in lockstep forever.
5. Attempts are bounded — repeated losses end in `RetriesExhausted`, not spinning.

Losing is cheap: memory plus unreferenced objects (normal `git gc` cleans them). In testing, 3 writers × 100 concurrent writes caused 431 retries — and 300/300 landed exactly once.

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

- `get(path)` — read (async, fetched lazily)
- `set(path, content)` — write (instant, in-memory)
- `delete(path)` — remove
- `has(path)` — check
- `list(dir)` — list one directory
- `map.changes` — the underlying `Map`, the same shape `commit()` accepts

Reads see your own pending writes. One rule: touch nothing but the map — the function may run more than once.

## The full tour

All five verbs in one update function:

```ts
// archive every finished task
await store.apply(async (map) => {
  for (const name of await map.list("tasks")) {              // list
    const task = await map.get(`tasks/${name}`)              // read
    if (!task?.includes("status: done")) continue
    if (await map.has(`archive/${name}`))                    // check
      throw new Conflict(`archive/${name} already exists`)
    map.set(`archive/${name}`, task)                         // write
    map.delete(`tasks/${name}`)                              // remove
  }
}, "archive finished tasks")
```

All the loop's moves land as one commit — five or none.

Same store, other faces — each adapter is a thin layer over the core:

```ts
import { withFs, asFs, asKv, asUnstorage } from "gitomic/adapters"

await store.apply(withFs(async (fs) => {           // node:fs verbs, still transactional
  await fs.writeFile("notes/today.md", note)
}), "add note")

const files = asFs(store)                          // read-only node:fs view of the tip
console.log(await files.readFile("board.md"))

await asKv(store).set("board.md", text, "edit")    // one call = one commit

const storage = createStorage({ driver: asUnstorage(store) })   // unstorage driver
```

## Good for / not for

**Good for:**

- Many writers, one clean history — no server, no lock files
- A full audit trail on every change: who, why, when
- Consistent snapshot reads from anywhere — no checkout needed
- Plain git underneath: log it, push it, back it up

**Not for:**

- Very high write rates — `shell` does a handful of writes per second, `iso` tens; not a telemetry store
- Code — a re-run write isn't re-tested; keep code changes in review and CI
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
- `iso` — optional import; [isomorphic-git](https://isomorphic-git.org) builds objects in-process (~10× write throughput); CAS stays on native git; an object-id equivalence suite holds both backends bit-identical

Planned: `mem` backend for tests · field-level claims · multi-ref transactions.

MIT © Bjørn Stabell
