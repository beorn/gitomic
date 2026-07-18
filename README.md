# gitomic

Direct git commits, skip working copies — many writers, no merges, nothing lost.

> **Pre-release.** v1 is in development; the npm name is a placeholder — read now, don't install yet. Numbers below are from the working spike's test suite.

## Example

```ts
import { open } from "gitomic"

const store = await open({ repo: ".", ref: "refs/heads/main", writer: "worker-3" })

await store.apply(async (map) => {
  map.set("tasks/124-dark-mode.md", "# Dark mode\nstatus: open\n")
  map.set("board.md", ((await map.get("board.md")) ?? "") + "- [ ] 124-dark-mode\n")
}, "create task 124")
```

Creates a task and updates the board — **one commit, both files or neither**. If another writer lands first, gitomic re-runs the function on their version — no merge. **That re-run is the contract:** the function computes everything from the map it's given — no clocks, no network, no outer state — because it may run more than once.

The history is the audit log, in plain git:

```
$ git log --oneline -3
9f3c2ab (main) worker-3: create task 124
b81d0e7 worker-1: archive finished tasks
4c99a01 bjorn: reword board intro
```

**Where did the file go?** gitomic writes to the *branch*, never to files on disk — `cat tasks/124-dark-mode.md` shows nothing new until that checkout runs `git pull`. Read through the store (`store.read()`, `git show`) instead, and point gitomic at a bare repo or a ref your editor isn't sitting on when you share a live checkout.

In short: an immutable map (the git tree), an overlay of pending writes, and a pointer that only advances if nobody moved it first.

## The problem

Several programs write the same files: agents, scripts, you in an editor.

- **Plain file writes** race — the last save wins, edits vanish.
- **Lock files** guard one file at a time and keep no history.
- **A database** handles concurrency but takes your data out of files.

gitomic is for anyone who wants **files as the source of truth** and **many concurrent writers** without those trade-offs. Built for fleets of AI agents sharing a repo — but nothing about it is agent-specific.

## API

```ts
const store = await open({
  repo: ".",                   // any path inside the repo — the root is discovered
  ref: "refs/heads/main",      // short "main" is accepted and normalized
  writer: "worker-3",          // recorded on every commit; keys retry-dedup
  remote: "origin",            // optional — see below
})

store.head()                   // newest commit id
store.read(at?)                // read-only view at that commit — lazy, nothing copied
store.commit(changes, opts?)   // Map<path, content | null> (null deletes) → ONE CAS attempt;
                               // throws StaleParent if the ref moved — never a silent overwrite
store.apply(fn, why?)          // fn(map) — runs, commits, re-runs on a race; returns the commit id
```

**When to use which:** `commit()` is a single guarded write of content you already have. If your write depends on *anything you read*, use `apply()`.

**About `remote`:** when set, origin is the arbiter — every publish is a fetch + `push --force-with-lease`, so each write costs a network round-trip and origin is, honestly, your server. Omit it and everything is local.

The map your update function receives:

- `get(path)` — read (async — await it; fetched lazily)
- `set(path, content)` — write (instant, in-memory)
- `delete(path)` — remove
- `has(path)` — check (async — await it)
- `list(dir)` — one directory's entry names (not full paths)
- `map.changes` — the underlying `Map`, the same shape `commit()` accepts

Values are UTF-8 strings in v1. Reads see your own pending writes. One rule: touch nothing but the map — the function may run more than once.

## The full tour

All five verbs in one update function:

```ts
// archive every finished task
await store.apply(async (map) => {
  for (const name of await map.list("tasks")) {              // list
    const task = await map.get(`tasks/${name}`)              // read
    if (!task?.includes("status: done")) continue
    if (await map.has(`archive/${name}`)) continue           // already archived — skip
    map.set(`archive/${name}`, task)                         // write
    map.delete(`tasks/${name}`)                              // remove
  }
}, "archive finished tasks")
```

All the loop's moves land as one commit — five or none.

`Conflict` is for invariants — the rule CRDTs can't enforce:

```ts
import { Conflict } from "gitomic"

// only one writer may claim a task
await store.apply(async (map) => {
  const owner = await map.get("claims/124.md")
  if (owner && owner !== "worker-3") throw new Conflict(`124 claimed by ${owner}`)
  map.set("claims/124.md", "worker-3")
}, "claim 124")
```

Two writers race this; exactly one wins — the loser's re-run *sees* the winner's claim, and the `Conflict` it throws surfaces to the caller (catch it; `RetriesExhausted` is the only other error `apply` adds).

Same store, other faces — each adapter is a thin layer over the core:

```ts
import { withFs, asFs, asKv, asUnstorage } from "gitomic/adapters"

await store.apply(withFs(async (fs) => {           // node:fs verbs, still transactional
  await fs.writeFile("notes/today.md", note)
}), "add note")

const files = asFs(store)                          // read-only node:fs view of the tip
console.log(await files.readFile("board.md"))

await asKv(store).set("board.md", text, "edit")    // one call = one commit — don't loop it; batches belong in apply()

const storage = createStorage({ driver: asUnstorage(store) })   // unstorage driver
```

## Good for / not for

**Good for:**

- Many writers, one clean history — no server, no lock files
- A full audit trail on every change — who, why, when, readable with plain `git log`
- Consistent snapshot reads from anywhere — no checkout needed
- Plain git underneath: log it, push it, back it up

**Not for:**

- Very high write rates — a handful of commits per second with the zero-dependency `shell` backend, tens with the in-process one; not a telemetry store
- Code — a re-run write isn't re-tested; keep code changes in review and CI
- Peer-to-peer offline sync — two disconnected writers can't merge with each other; that's CRDT territory. (Solo offline is fine: local-ref mode works fully offline, and remote mode can queue ops and replay them on reconnect — conflicts just surface late.)
- Side effects — your update function may re-run; keep clocks, network, and disk out of it

## Alternatives & prior art

- **SQLite** — better for relational or high-rate data, but your files stop being files.
- **CRDTs** (Automerge, Yjs) — merge without coordination, but can't enforce rules like "only one writer may claim this."
- **The same idea elsewhere** — Gerrit NoteDb, git-bug, Irmin, Jujutsu (inside git); Kubernetes server-side apply, Replicache, Delta Lake (outside it). Datomic inspired the name and the philosophy.

## How it works

1. A write builds its files directly in git's object database — no checkout involved. Many files, one commit: all or nothing.
2. One publish rule: move the branch pointer (the **ref**) to the new commit — only if nobody else moved it first (`git update-ref`; remote: `push --force-with-lease`).
3. Lose the race? gitomic re-runs your **update function** on the winner's version. Text is never merged.
4. Every commit records who, why, and a per-writer sequence number (its high-water mark rides inside the tree) — a retried write can't apply twice, even after a crash.

### The race, in detail

1. Pin the tip's tree. Run your update function against that frozen view; collect writes in memory.
2. Build the commit and try the swap: advance the ref from the pinned tip to it.
3. If the ref moved, discard the writes and start over from the new tip — a full re-run, not a patch: the function sees the winner's state and may decide differently, or throw `Conflict` to stop cleanly.
4. Wait a short random, roughly-doubling delay (≤ ~150ms) before retrying. The randomness matters: fixed delays make racing writers collide in lockstep forever.
5. Attempts are bounded — repeated losses end in `RetriesExhausted`, not spinning. (Writers in one process are serialized on a local queue first, so only genuine cross-process races retry at all.)

Losing is cheap: memory plus unreferenced objects (normal `git gc` cleans them). In testing, 3 writers × 100 concurrent writes caused 431 retries — and 300/300 landed exactly once.

## Status

v1 ships three backends:

- `shell` — zero dependencies; the git binary you already have
- `iso` — optional import; [isomorphic-git](https://isomorphic-git.org) builds objects in-process (~10× write throughput); CAS stays on native git; an object-id equivalence suite holds all backends bit-identical
- `mem` — in-memory, no git binary, no disk; instant unit tests against the same API

Planned: offline op queue with replay-on-reconnect · field-level claims · multi-ref transactions.

MIT © Bjørn Stabell
