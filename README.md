# gitomic

Direct git commits, skip working copies — many writers, no merges, nothing lost.

> **Pre-release.** v1 in development; the npm name is a placeholder — read now, don't install yet. Numbers are from the spike's test suite.

## Example

```ts
import { open } from "gitomic"

const store = await open({ repo: ".", ref: "main", writer: "worker-3" })

await store.transact(async (map) => {
  map.set("notes/milk.md", "buy milk")
  map.set("index.md", ((await map.get("index.md")) ?? "") + "milk\n")
}, "add note")
```

Two files, **one commit — both or neither**. Lose a race? The function re-runs on the winner's version — no merge. **That re-run is the contract:** compute only from the map — no clocks, network, or outer state.

The history is the audit log, in plain git:

```
$ git log --oneline -3
9f3c2ab (main) worker-3: add note
b81d0e7 worker-1: archive inbox
4c99a01 bjorn: reword index
```

**Where did the file go?** gitomic writes to the *branch*, never to files on disk. A checkout sees the new commits after `git pull`; read through the store (or `git show`) instead. Sharing a live checkout? Point gitomic at a bare repo or a ref your editor isn't on.

In short: an immutable map (the git tree), an overlay of pending writes, and a pointer that only advances if nobody moved it first.

## The problem

Several programs write the same files: agents, scripts, you in an editor.

- **Plain file writes** race — the last save wins, edits vanish.
- **Lock files** guard one file at a time and keep no history.
- **A database** handles concurrency but takes your data out of files.

**[gitomic](https://github.com/beorn/gitomic)** is for anyone who wants **files as the source of truth** and **many concurrent writers** without those trade-offs. Built for fleets of AI agents sharing a repo — but nothing about it is agent-specific.

## API

```ts
const store = await open({
  repo: ".",                   // any path inside the repo
  ref: "main",                 // short names accepted
  writer: "worker-3",          // stamped on every commit; keys retry-dedup
  remote: "origin",            // optional — see below
})

type Update = (map: GitMap) => Promise<void>
type Committed = { oid: string; retries: number }

store.head(): Promise<string>            // newest commit id
store.at(commit?: string): Snapshot      // read-only view there — lazy
store.transact(fn: Update, why: string): Promise<Committed>
```

`transact` runs your update function and lands its writes as one commit, re-running it if another writer got there first. `why` is required — it becomes the commit message.

**`remote`:** origin becomes the decider — each publish is a fetch + `push --force-with-lease`. One network round-trip per write, and origin is, honestly, your server. Omit it for purely local stores.

The map your update function receives:

- `get(path)` — read
- `set(path, content)` — write
- `delete(path)` — remove
- `has(path)` — check
- `keys(prefix?)` — paths under a prefix; omit for all

Reads (`get`, `has`, `keys`) are async — await them; `set` and `delete` are instant, in-memory. Values are UTF-8 strings in v1. Reads see your own pending writes. A `Snapshot` from `at()` has the read side only: `get` / `has` / `keys`.

## The full tour

The whole map, in one update function:

```ts
await store.transact(async (map) => {
  for (const path of await map.keys("inbox/")) {
    const dest = path.replace("inbox/", "archive/")
    if (await map.has(dest)) continue
    map.set(dest, await map.get(path))
    map.delete(path)
  }
}, "archive inbox")
```

However many files move, they land as one commit — all or none.

`Conflict` enforces invariants — the thing CRDTs can't do:

```ts
import { Conflict } from "gitomic"

await store.transact(async (map) => {
  const owner = await map.get("locks/deploy")
  if (owner && owner !== "worker-3") throw new Conflict(`taken by ${owner}`)
  map.set("locks/deploy", "worker-3")
}, "take deploy lock")
```

Two writers race this; exactly one wins. The loser's re-run *sees* the winner's lock and aborts — `Conflict` surfaces to your caller (`RetriesExhausted` is the only other error `transact` adds).

Same store, other faces — each adapter is a thin layer:

```ts
import { withFs, asFs, asKv, asUnstorage } from "gitomic/adapters"

await store.transact(withFs(async (fs) => {     // node:fs calls, still transactional
  await fs.writeFile("notes/today.md", note)
}), "add note")

const files = asFs(store)                       // read-only node:fs view of the tip
await asKv(store).set("index.md", text, "edit") // one call = one commit
const storage = createStorage({ driver: asUnstorage(store) })
```

## When to use it

**Use it for:**

- Many writers, one clean history — no server, no lock files
- Audit trail on every change — who, why, when, via plain `git log`
- Consistent snapshot reads from anywhere — no checkout needed
- Plain git underneath: log it, push it, back it up

**Not for:**

- High write rates — a few commits/sec (`shell`), tens (`iso`); not telemetry
- Code — replayed writes aren't re-tested; keep code in review and CI
- Merging two *offline* writers — CRDT territory. (Solo offline is fine; remote ops can queue and replay on reconnect.)
- Side effects — the update function may re-run

## Alternatives & prior art

- **SQLite** — better for relational or high-rate data; files stop being files.
- **CRDTs** (Automerge, Yjs) — merge freely, but can't enforce "only one may claim this."
- **Same idea elsewhere** — Gerrit NoteDb, git-bug, Irmin, Jujutsu; Kubernetes server-side apply, Replicache, Delta Lake. Datomic inspired the name and philosophy.

## How it works

1. Writes build files straight into git's object database — many files, one commit.
2. Publish = move the ref to the new commit, only if nobody moved it first.
3. Lose the race? The update function re-runs on the winner's version. No merges.
4. Commits carry who, why, and a per-writer counter — retries can't apply twice.

### The race, in detail

1. Pin the tip's tree; run the update function; collect writes in memory.
2. Build the commit; swap the ref from the pinned tip to it.
3. Ref moved? Discard, re-run on the new tip — or throw `Conflict` to stop.
4. Retry after a random, roughly-doubling delay (≤150ms) — jitter prevents lockstep.
5. Attempts are bounded; then `RetriesExhausted`. Same-process writers queue locally.

Losing is cheap — memory plus objects `git gc` reclaims. Spike: 3 writers × 100 concurrent writes, 431 retries, 300/300 landed exactly once.

## Status

v1 ships three backends:

- `shell` — shells out to the `git` command you already have; zero dependencies
- `iso` — optional; [isomorphic-git](https://isomorphic-git.org) builds objects in-process (~10× faster writes); CAS stays native; an oid-equivalence suite holds all backends bit-identical
- `mem` — in-memory, no git binary; instant unit tests against the same API

Planned: offline op queue with replay-on-reconnect · field-level claims · multi-ref transactions · remote-only stores — open a URL, no local repo; the git wire protocol already does lazy reads (partial fetch) and CAS writes (push is old→new under the server's ref lock).

MIT © Bjørn Stabell
