# gitomic

Direct git commits, skip working copies — many writers, no merges, nothing lost.

> **0.x release.** The implementation and conformance suite are ready for use; the API may still change before 1.0.

## Install

```sh
npm install gitomic
```

The default `shell` backend has no runtime dependencies. Install `isomorphic-git` alongside gitomic only when using the optional `gitomic/iso` entry point.

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

**Where did the file go?** Normal git works file-side: edit working-copy files, stage, commit. gitomic inverts that — it builds the commit _object-side_, directly in git's database, and moves the branch to it; no working copy is in the loop. So it writes to the _branch_, never to files on disk. A checkout sees the new commits after `git pull`; read through the store (or `git show`) instead. Sharing a live checkout? Point gitomic at a bare repo or a ref your editor isn't on.

In short: an immutable map (the git tree), an overlay of pending writes, and a pointer that only advances if nobody moved it first.

## The problem

Several programs write the same files: agents, scripts, you in an editor.

- **Plain file writes** race — the last save wins, edits vanish.
- **Application lock files** guard one file at a time and keep no history.
- **A database** handles concurrency but takes your data out of files.

**[gitomic](https://github.com/beorn/gitomic)** is for anyone who wants **files as the source of truth** and **many concurrent writers** without those trade-offs. Built for fleets of AI agents sharing a repo — but nothing about it is agent-specific.

## API

```ts
const store = await open({
  repo: ".",                   // any path inside the repo
  ref: "main",                 // short names accepted
  writer: "worker-3",          // required — opaque caller id; keys retry-dedup
  remote: "origin",            // optional — see below
})

type Update = (map: GitMap) => Promise<void>
type Committed = { oid: string; retries: number }

store.head(): Promise<string>            // newest commit id
store.at(commit?: string): Snapshot      // read-only view there — lazy
store.transact(fn: Update, message: string): Promise<Committed>
```

`transact` runs your update function and lands its writes as one commit, re-running it if another writer got there first. `message` is required — it becomes the commit message; say why, not what.

`writer` is an opaque caller string and the retry-dedup counter's identity. Include your launcher or process instance id when one role can have multiple live instances. `open` atomically claims that exact string for the lifetime of the process: the built-in Git backends store a generation record under `refs/gitomic/writers/` and acquire it with ref compare-and-swap. The record carries a library-minted UUID, hostname, process id, and open time. A second live owner fails loudly; a dead same-host owner is reclaimed with another compare-and-swap, while a foreign-host record fails safe with an explicit inspection remedy. There is no `Store.close()` in v1, so a writer id is intentionally process/launcher-lifetime. The library does not inspect Hab, Ag, environment variables, or any agent naming convention.

**`remote`:** origin becomes the decider. Every write is one fetch/push cycle under the remote's ref lock; the lease check is compare-and-swap, never history rewriting, so a push either fast-forwards or triggers a re-run. The local ref is then a cache of origin: reads stay local and lag until the next fetch, and an unpushed local-only tip may be replaced by origin's tip. Do not use a ref that carries unrelated local work. Origin is, honestly, your server; omit it for purely local stores.

**Sharing `main` with a delivery queue:** use a strict path partition: gitomic owns its declared state paths and the queue owns code paths; neither writes the other's partition. The ref only fast-forwards. The queue never rebases or rewrites already-published gitomic commits—if its candidate is stale, it must rebuild a descendant of the current tip. Without all three invariants, use a separate ref.

The map your update function receives:

```ts
type GitMap = {
  get(path: string): Promise<string | undefined> // sees your own pending writes
  set(path: string, content: string): void // instant, in-memory
  delete(path: string): void // instant, in-memory
  has(path: string): Promise<boolean>
  keys(prefix?: string): Promise<string[]> // paths under a prefix; omit for all
}

type Snapshot = Pick<GitMap, "get" | "has" | "keys"> // what at() returns — reads only
```

Paths are git tree paths — forward slashes, no leading slash; public paths and prefixes normalize to Unicode NFC, and `keys` returns full canonical paths, sorted. Existing trees must already be NFC, valid UTF-8, free of file/directory collisions, and contain regular blobs only: invalid path bytes, symlink entries, and gitlinks fail loudly instead of being replaced, followed, or ignored. Values are strict UTF-8 strings in v1 — invalid stored bytes and unpaired JavaScript surrogates fail; there is no binary mode yet. The whole `refs/gitomic/` namespace is reserved for protocol state. `at()` accepts only a full lowercase 40- or 64-hex object id and pins it at call time (omit for the current tip); a well-formed but missing id throws on first read.

## The full tour

The whole map, in one update function:

```ts
await store.transact(async (map) => {
  for (const path of await map.keys("inbox/")) {
    const dest = path.replace("inbox/", "archive/")
    if (await map.has(dest)) continue
    const content = await map.get(path)
    if (content === undefined) throw new Conflict(`missing ${path}`)
    map.set(dest, content)
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

Two writers race this; exactly one wins. The loser's re-run _sees_ the winner's lock and aborts — `Conflict` surfaces to your caller (`RetriesExhausted` is the only other error `transact` adds).

Same store, other faces. The rule: `asX(store)` re-views the store as interface X (read-only where a write would bypass the transaction); `withX(fn)` wraps your update function so X-shaped calls stay transactional:

```ts
import { withFs, asFs, asKv, asUnstorage } from "gitomic/adapters"

await store.transact(
  withFs(async (fs) => {
    // node:fs calls, still transactional
    await fs.writeFile("notes/today.md", note)
  }),
  "add note",
)

const files = asFs(store) // read-only node:fs view of the tip; writes throw
await asKv(store).set("index.md", text, "edit") // one call = one commit
const storage = createStorage({ driver: asUnstorage(store) })
```

The zero-dependency `shell` backend is the default. Select an optional backend explicitly:

```ts
import { createIsoBackend } from "gitomic/iso"
import { createMemBackend } from "gitomic/mem"

const fast = await open({ repo: ".", ref: "main", writer: "worker-3", backend: createIsoBackend() })
const test = await open({ repo: "my-test", ref: "main", writer: "test", backend: createMemBackend() })
```

`iso` uses `isomorphic-git` for object reads, builds and durably writes canonical objects in-process, and keeps ref CAS native. `mem` creates canonical Git objects entirely in memory and requires neither a repository nor the `git` executable.

A custom backend implements the public `GitomicBackend` contract, including `acquireWriter(repo, writer)`. That call must establish one live owner for the writer before `open` returns; omitting it is a runtime error as well as a type error. Backends that wrap a built-in backend can preserve the lifecycle contract by spreading the built-in object and overriding only the operations they own.

## When to use it

**Use it for:**

- Many writers, one clean history — no merge server or application-data locks
- Audit trail on every change — who, why, and linear order, via plain `git log`
- Consistent snapshot reads from anywhere — no checkout needed
- Plain git underneath: log it, push it, back it up

**Not for:**

- High write rates — low tens of commits/sec with the default `shell` backend (spawns `git`), around a hundred with the in-process `iso` backend; not telemetry
- Code — replayed writes aren't re-tested; keep code in review and CI
- Merging two _offline_ writers — CRDT territory. (Solo offline is fine; remote ops can queue and replay on reconnect.)
- Side effects — the update function may re-run

## Alternatives & prior art

- **SQLite** — better for relational or high-rate data; files stop being files.
- **CRDTs** (Automerge, Yjs) — merge freely, but can't enforce "only one may claim this."
- **Same idea elsewhere** — Gerrit NoteDb, git-bug, Irmin, Jujutsu. Datomic inspired the name and philosophy.

## How it works

1. Writes build files straight into git's object database — many files, one commit.
2. Publish = move the ref to the new commit, only if nobody moved it first. Writers can be separate processes — the ref swap is atomic in every backend.
3. Lose the race? The update function re-runs on the winner's version — no merges. Retries back off with a random, roughly-doubling delay (≤150ms; jitter prevents lockstep) and are bounded (default 10) before `RetriesExhausted`. Same-process writers queue locally.
4. Commits carry who, why, and a per-writer counter — retries can't apply twice. If an acknowledgement is ambiguous, recovery checks one bounded near-tip batch for the original commit and fails loudly instead of walking the repo's whole history.

Commit timestamps advance deterministically from the parent so every backend produces the same object id. They preserve order, not wall-clock time; store a domain timestamp in the data when real event time matters.

Completed unpublished commits are pinned under `refs/gitomic/inflight/` before compare-and-swap, then unpinned after the publish result. With files-format refs, the hidden pin uses Git's loose-ref lockfile protocol: fsync, atomic rename, then directory fsync; other ref-storage formats delegate the pin to native Git. Publish and pin deletion share one native Git ref transaction. That keeps the full object graph reachable even during `git prune --expire=now`; a hard-killed writer leaves at most one pin for its writer id, and its next completed write replaces and releases it.

The conformance suite runs both 3 writers × 100 sustained writes and a 12-writer burst, verifying 300/300 land exactly once on one linear tip.

## Durability and trust

No repository or machine-wide Git config is required. The shell backend requires Git 2.36 or newer, supports SHA-1 and SHA-256 repositories, and supplies `core.fsync=loose-object,reference` plus `core.fsyncMethod=fsync` on its own object and ref write commands. The iso backend is SHA-1-only (use `shell` for SHA-256); it writes every loose object to a same-directory temporary file, fsyncs it, renames it into place, then fsyncs the directory before the commit can be pinned or published. Its ref and writer-generation compare-and-swap operations still use Git 2.36+. The `mem` backend also emits canonical SHA-1 objects.

Gitomic is designed for cooperating processes inside a trusted perimeter. Its writer lease, path checks, CAS, receipt scan, and audit trailers are accident guardrails and detectors; they are not a security boundary against a hostile process that can mutate the repository or impersonate a writer. Use filesystem/process isolation and remote authorization for that boundary.

## Status

The v1 source includes three backends:

- `shell` — shells out to Git 2.36+; zero package dependencies; object/ref durability config is invocation-local
- `iso` — optional; [isomorphic-git](https://isomorphic-git.org) reads objects through a Node-compatible filesystem while gitomic builds and durably writes them in-process; native CAS stays library-owned; an oid-equivalence suite holds all backends bit-identical
- `mem` — in-memory, no git binary; instant unit tests against the same API

Run `bun run bench` to measure the backends locally. On the development host, the hardened 20-commit benchmark measured 9.56 commits/s for `shell` and 71.63 commits/s for `iso` (7.49×); absolute numbers depend heavily on filesystem and process-spawn cost.

Planned: offline op queue with replay-on-reconnect · field-level claims · multi-ref transactions · remote-only stores — open a URL, no local repo; the git wire protocol already does lazy reads (partial fetch) and CAS writes (push is old→new under the server's ref lock).

MIT © Bjørn Stabell
