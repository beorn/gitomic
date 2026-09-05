# gitomic

Direct git commits, skip working copies — many writers, no merges, nothing lost.

> **0.x release.** The implementation and conformance suite are ready for use; the API may still change before 1.0.

## Nothing of ours in your files

Most "git as a database" designs keep their bookkeeping where you can see it: a dot-directory in your tree, a lock file per writer, a side ref you have to prune. You then live with it in every checkout, diff and `git status`.

gitomic keeps none. Your tree holds your data and nothing else:

```
$ git ls-tree -r --name-only main
notes/milk.md
$ git for-each-ref --format='%(refname)'
refs/heads/main
```

Check those commits out and `git status` is clean: there is no stray file of ours to ignore, and no ref of ours to prune.

- **No dot-directory.** Nothing to add to `.gitignore`.
- **No lock files, no lease refs.** Nothing to clean up after a crash, so a dead writer blocks nobody.
- **No config keys, no git notes.**
- **Bookkeeping rides in the commit message**, as trailers — where git already keeps metadata about a commit.

**Where it stops, exactly.** The commits are still gitomic's own, and they say so: author `gitomic <gitomic@localhost>`, timestamps that count up from the parent rather than the clock, and `Gitomic-*` trailers. That is the audit trail, not a leak — but it does mean you can always tell a gitomic commit from one you made by hand. Three more traces:

- A failed or replayed transaction leaves unreferenced objects until git's next `gc`.
- Moving your ref adds a reflog entry wherever reflogs are on.
- On the `remote` path only, one `refs/gitomic/fetch/<uuid>` exists for the length of a single fetch call.

**Why it is like this.** An earlier version kept a counter per writer in a `.gitomic/` file. Over the entire life of the first deployment — 64 transactions — every process wrote exactly once, and that counter read zero in 64 cases out of 64. It bought nothing, so it is gone: identity is now a UUID minted per `open`, which cannot collide with anything, alive or dead.

## Install

```sh
npm install gitomic
```

The default `shell` backend has no runtime dependencies. Install `isomorphic-git` next to gitomic only when you use the optional `gitomic/iso` entry point.

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

**Where did the file go?** Normal git works file-side: edit working-copy files, stage, commit. gitomic turns that around — it builds the commit _object-side_, straight in git's database, and moves the branch to it; no working copy is in the loop. So it writes to the _branch_, never to files on disk. A checkout sees the new commits after `git pull`; read through the store (or `git show`) instead. Sharing a live checkout? Point gitomic at a bare repo, or at a ref your editor is not on.

In short: an unchanging map (the git tree), an overlay of pending writes, and a pointer that only moves if nobody moved it first.

## The problem

Several programs write the same files: agents, scripts, you in an editor.

- **Plain file writes** race — the last save wins, edits vanish.
- **Application lock files** guard one file at a time and keep no history.
- **A database** handles concurrency but takes your data out of files.

**[gitomic](https://github.com/beorn/gitomic)** is for anyone who wants **files as the source of truth** and **many writers at once** without those trade-offs. Built for fleets of AI agents sharing a repo — but nothing about it is agent-specific.

## API

```ts
const store = await open({
  repo: ".",                   // any path inside the repo
  ref: "main",                 // short names accepted
  writer: "worker-3",          // optional — label for the audit trail
  remote: "origin",            // optional — see below
})

type Update = (map: GitMap) => Promise<void>
type Committed = { oid: string; retries: number }

store.head(): Promise<string>            // newest commit id
store.at(commit?: string): Snapshot      // read-only view there — lazy
store.transact(fn: Update, message: string): Promise<Committed>
```

`transact` runs your update function and lands its writes as one commit, re-running it if another writer got there first. `message` is required — it becomes the commit message; say why, not what.

### Who wrote it

`writer` is a **label, not a lock**:

- It names a role for people. It leads the commit subject and repeats as a `Gitomic-Writer` trailer.
- It may repeat freely — across processes, restarts, and machines. Reuse `"indexer"` in fifty processes if that is what the audit trail should say.
- It defaults to `"gitomic"` when left out.
- gitomic never reads your environment or any agent naming convention to guess it.

Identity is minted, not declared. Every `open` mints a UUID for that one live store and stamps it on each commit, next to a counter that starts at zero:

```
worker-3: add note

Gitomic-Writer: worker-3
Gitomic-Instance: 3f9d1c02-5b7a-4e18-9c44-0a2b6d8e1f30
Gitomic-Seq: 0
```

`(instance, seq)` is the receipt that keeps a retry from applying twice, and nothing else can mint it. So there is no lock to take, nothing to reclaim after a crash, and no way for two writers to collide by picking the same name. A store replaying after an unclear answer from git still holds its own UUID in memory, which is the only place it is ever needed; a process that died holds nothing, and left nothing behind. There is no `Store.close()`, and none is needed.

### Reading

Readers get the same exact snapshots, and write nothing at all:

```ts
import { openReader } from "gitomic"

const reader = await openReader({ repo: ".", ref: "main" })
const revision = await reader.head()
const pinned = reader.at(revision)

for (const path of await pinned.keys("notes/")) {
  console.log(path, await pinned.get(path))
}

const controller = new AbortController()
for await (const change of reader.watch({
  after: revision,
  signal: controller.signal,
})) {
  console.log(`${change.from} -> ${change.to}`)
}
```

- `openReader` defaults `ref` to `main` and takes the same optional `remote` and `backend` as `open`.
- `head()` re-reads the chosen local or remote ref.
- `at(oid)` is a fixed, lazy snapshot. Leave the id out to pin the tip as of the moment you call it.
- `at(...).oid(path)` returns the git blob id of the content there, or `undefined` if absent — the natural `--expect` anchor for a later precondition write, and it answers even for a binary blob whose value cannot be decoded.
- `matchGlob(pattern, path)` filters `keys()` output by a pattern: `*` and `?` stay within one segment, `**` crosses directories, and everything else — `.`, `+`, `@` — is literal. It follows git's `:(glob)` pathspec rules, NFC-normalizing both sides.
- `watch({ after, signal })` yields ref-tip changes and stops promptly when the signal aborts. It looks once a second by default; `pollIntervalMs` is there for tests and latency-sensitive callers.

Snapshot reads are scoped by path prefix through the one backend read path, so unrelated binary blobs are never decoded. A backend prefix read that matches nothing throws `GitPrefixNotFoundError` naming the prefix, repository, and commit; Snapshot turns that into its usual `undefined` / `false` / empty-array answers. Transactions never pass a prefix — they stay whole-tree strict.

### Remote

**`remote`:** origin becomes the decider. Every write is one fetch/push cycle under the remote's ref lock; the push is a compare-and-swap (`--force-with-lease`), never a history rewrite, so it either fast-forwards or triggers a re-run. The local ref is then a cache of origin: reads stay local and lag until the next fetch, and an unpushed local-only tip may be replaced by origin's tip. Do not point it at a ref that carries unrelated local work. Origin is, honestly, your server; leave it out for purely local stores.

**Sharing `main` with a delivery queue** needs a strict path partition: gitomic owns its declared state paths and the queue owns code paths; neither writes the other's. The ref only fast-forwards. The queue never rebases or rewrites already-published gitomic commits — if its candidate is stale, it must rebuild on the current tip. Without all three, use a separate ref.

### The map

```ts
type GitMap = {
  get(path: string): Promise<string | undefined> // sees your own pending writes
  set(path: string, content: string): void // instant, in-memory
  delete(path: string): void // instant, in-memory
  has(path: string): Promise<boolean>
  keys(prefix?: string): Promise<string[]> // paths under a prefix; omit for all
}

type Snapshot = Pick<GitMap, "get" | "has" | "keys"> & {
  oid(path: string): Promise<string | undefined> // the blob id there — your --expect anchor
} // what at() returns — reads only
```

Paths are git tree paths — forward slashes, no leading slash:

- Public paths and prefixes normalize to Unicode NFC, and `keys` returns full canonical paths, sorted.
- Every path in the scope you read must be NFC, valid UTF-8, free of file/directory collisions, and a regular blob. Bad path bytes, symlink entries and gitlinks fail loudly rather than being replaced, followed, or skipped.
- Values are strict UTF-8 strings in v1 — there is no binary value mode. A tree holding a blob that is _not_ valid UTF-8 still works: the entry counts for `keys` and `has`, and a transaction that never touches it carries it into the next commit as the same blob. Only reading that one value fails, and it names the path.
- Unpaired JavaScript surrogates always fail on write.
- `at()` takes only a full lowercase 40- or 64-hex commit id and pins it when called. A well-formed but missing id throws on first read.
- `refs/gitomic/` and the `.gitomic/` tree path are reserved. gitomic writes nothing to either, and refuses to let you.

### Ownership manifests

`parseOwnershipManifest(raw, { label?, acceptPath })` parses a version-1 path/source declaration into sorted paths and an exact source-object mapping. It rejects malformed git paths, duplicates, schema drift, and any path your policy declines. gitomic owns this mechanism; it does not choose your state partition.

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

`Conflict` enforces invariants — the thing CRDTs cannot do:

```ts
import { Conflict } from "gitomic"

await store.transact(async (map) => {
  const owner = await map.get("locks/deploy")
  if (owner && owner !== "worker-3") throw new Conflict(`taken by ${owner}`)
  map.set("locks/deploy", "worker-3")
}, "take deploy lock")
```

Two writers race this; exactly one wins. The loser's re-run _sees_ the winner's lock and gives up — `Conflict` reaches your caller. (`RetriesExhausted` is the only other error `transact` adds.)

Same store, other faces. The rule: `asX(store)` re-views the store as interface X, read-only where a write would dodge the transaction; `withX(fn)` wraps your update function so X-shaped calls stay transactional:

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

The zero-dependency `shell` backend is the default. Pick another one explicitly:

```ts
import { createIsoBackend } from "gitomic/iso"
import { createMemBackend } from "gitomic/mem"

const fast = await open({ repo: ".", ref: "main", writer: "worker-3", backend: createIsoBackend() })
const test = await open({ repo: "my-test", ref: "main", writer: "test", backend: createMemBackend() })
```

`iso` reads objects through `isomorphic-git`, then builds and durably writes canonical objects in-process, keeping ref CAS native. `mem` builds canonical git objects entirely in memory and needs neither a repository nor the `git` program.

A custom backend implements `GitomicBackend`: `head`, `readFiles`, `writeCommit`, `compareAndSwap`, `findTransaction`, plus the optional remote pair. `writeCommit` receives your `writer` label and the store's `instance` and `seq`, and must record all three so `findTransaction` can recognize `(instance, seq)` later. A backend that wraps a built-in one keeps every contract by spreading it and overriding only what it owns.

## When to use it

**Use it for:**

- Many writers, one clean history — no merge server, no application-data locks
- An audit trail on every change — who, why, and linear order, via plain `git log`
- Matching snapshot reads from anywhere — no checkout needed
- Plain git underneath: log it, push it, back it up

**Not for:**

- High write rates — low tens of commits/sec on the default `shell` backend (it spawns `git`), around a hundred on the in-process `iso` backend; not telemetry
- Code — replayed writes are not re-tested; keep code in review and CI
- Merging two _offline_ writers — CRDT territory. (Solo offline is fine; remote work can queue and replay on reconnect.)
- Side effects — the update function may re-run

## Alternatives & prior art

- **SQLite** — better for relational or high-rate data; files stop being files.
- **CRDTs** (Automerge, Yjs) — merge freely, but cannot enforce "only one may claim this."
- **Same idea elsewhere** — Gerrit NoteDb, git-bug, Irmin, Jujutsu. Datomic inspired the name and the philosophy.

## How it works

1. Writes build files straight into git's object database — many files, one commit.
2. Landing = move the ref to the new commit, only if nobody moved it first. Writers can be separate processes — the ref swap is atomic in every backend.
3. Lose the race? The update function re-runs on the winner's version — no merges. Retries back off by a random, roughly doubling delay (≤150ms; the jitter stops lockstep) and are capped (default 10) before `RetriesExhausted`. Writers in one process queue locally.
4. Commits carry who, why, and a receipt no other process can mint, so a retry cannot apply twice. When git's answer is unclear, recovery looks for that receipt among the commits that arrived since the one this transaction was built on, and fails loudly rather than walking the whole history.

Commit timestamps count up from the parent so every backend produces the same commit id. They preserve order, not wall-clock time; store a real timestamp in your data when event time matters.

The test suite runs 3 writers × 100 sustained writes and a 12-writer burst, checking that 300 of 300 land exactly once on one linear tip.

## Durability and trust

No repository or machine-wide git config is required. The shell backend needs git 2.36 or newer, supports SHA-1 and SHA-256 repositories, and passes `core.fsync=loose-object,reference` plus `core.fsyncMethod=fsync` on its own object and ref writes. The iso backend is SHA-1 only (use `shell` for SHA-256); it writes each loose object to a temporary file in the same directory, fsyncs it, renames it into place, then fsyncs the directory. Its ref compare-and-swap still uses git 2.36+. The `mem` backend also emits canonical SHA-1 objects.

**The one durability assumption, stated rather than hidden.** A finished commit is unreferenced for the moment between being written and the compare-and-swap that adopts it. gitomic does not pin it — that pin was the last thing it kept in your repo. It relies instead on git's default gc grace (`gc.pruneExpire = 2.weeks.ago`), which covers a millisecond-wide gap with room to spare. **The residual risk:** a repo set to an aggressive `gc.pruneExpire`, or anyone running `git gc --prune=now` or `git prune --expire=now` **at the same time as** a transaction, can reclaim that commit mid-flight. gitomic then fails the landing loudly on the missing object — it never moves the ref to something that is not there — but the transaction does not land. Do not schedule aggressive pruning against a repo that is being written.

gitomic is built for cooperating processes inside a trusted perimeter. Its path checks, CAS, receipt scan and audit trailers catch accidents. They are **not a security boundary**: a hostile process that can rewrite the repository or forge a writer label gets past all of them. Use filesystem and process isolation, and remote authorization, for that.

## Status

Three backends ship in v1:

- `shell` — shells out to git 2.36+; zero package dependencies; durability config is per invocation
- `iso` — optional; [isomorphic-git](https://isomorphic-git.org) reads objects through a Node-compatible filesystem while gitomic builds and durably writes them in-process; native CAS stays library-owned; an equivalence suite keeps all three backends bit-identical
- `mem` — in memory, no git program; instant unit tests against the same API

Run `bun run bench` to measure locally. On the development host the hardened 20-commit benchmark measured 9.56 commits/s for `shell` and 71.63 for `iso` (7.49×); absolute numbers depend heavily on filesystem and process-spawn cost.

Planned: offline queue with replay on reconnect · field-level claims · multi-ref transactions · remote-only stores — open a URL, no local repo; the git wire protocol already does lazy reads (partial fetch) and CAS writes (push is old→new under the server's ref lock).

MIT © Bjørn Stabell
