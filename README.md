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
  retryBudgetMs: 30_000,       // optional — how long to keep retrying a contended write (default)
})

type Update = (map: GitMap, base: string) => Promise<void>
type Committed = { oid: string; retries: number }

store.head(): Promise<string>            // newest commit id
store.at(commit?: string): Snapshot      // read-only view there — lazy
store.transact(fn: Update, message: string): Promise<Committed>
```

`transact` runs your update function and lands its writes as one commit, re-running it if another writer got there first. `message` is required — it becomes the commit message; say why, not what. The update function's second argument, `base`, is the commit oid it is running against on this attempt — a fresh tip on every re-run — so a precondition check can name the exact commit it refused on.

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

**History.** The same reader provides bounded history and blob-identity changes:

```ts
const commits = await reader.log({ from: revision, limit: 50 })
const changes = await reader.diff(olderRevision, revision)
```

`log({ from?, limit? })` returns newest-first, first-parent `CommitMeta` records. It pins one tip when `from` is omitted; `limit` defaults to 50 and must be a positive safe integer no greater than 1,024. Each record contains `oid`, `parent` (`null` at the root), the full `message`, and the committer's `timestamp` in seconds. Gitomic's own timestamps preserve order, not wall-clock time. The `writer`, `instance`, and `seq` audit trailers are each `null` when absent; malformed or duplicate trailers fail loudly. These are recorded labels, not verified authorship.

`diff(from, to)` returns sorted `{ path, from, to }` records, with blob ids on either side and `null` for an absent path. Both commit endpoints must exist, even when they are equal. It compares the backend's file projection without decoding values, so binary changes work too; it does not report mode-only changes, text hunks, or inferred renames.

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

### The `apply` door — edits with preconditions

`transact` is the general form: your function, any logic, one commit. When the writes are a plain LIST of edits with per-path preconditions — the shape a CLI, an HTTP handler, or another process hands you — `apply` lands them without a callback:

```ts
import { apply, type Edit } from "gitomic"

// Read the blob ids you are anchoring on, then land the whole list as one commit.
const base = await store.head()
const oldNote = await store.at(base).oid("notes/old.md")
if (oldNote === undefined) throw new Error("notes/old.md is gone")

const edits: Edit[] = [
  { kind: "put", path: "notes/today.md", content: "buy milk", expect: null }, // create: must be ABSENT
  { kind: "append", path: "log.md", content: "bought milk\n" }, // no precondition
  { kind: "rm", path: "notes/old.md", expect: oldNote }, // remove exactly this blob
]
const { oid } = await apply(store, base, edits, "sync notes")
```

`apply(store, base, edits, message)` lands the whole list as ONE all-or-nothing commit. `base` is the commit the edits were read against; the natural anchor for each `expect` is `store.at(base).oid(path)` — the git blob oid there, or `undefined` when the path is absent. Each edit re-checks its own precondition against the tree the commit actually attempts, so when a concurrent writer has moved the ref `apply` replays against the new tip for free (the same contract `transact` gives a callback). The FIRST edit whose precondition fails throws `EditDoesNotApply` — naming the edit index, the path, the oid it expected and the one it found, and both commits — and lands nothing. A `put` with `expect: null` demands the path be ABSENT (a create); `append` carries no precondition and always re-applies. Edits apply in order against the same attempted tree, so a later one can depend on an earlier one — `rm dest` then `mv src dest` frees the destination inside a single commit.

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

Two writers race this; exactly one wins. The loser's re-run _sees_ the winner's lock and gives up — `Conflict` reaches your caller. (`RetriesExhausted` — a transaction that made no progress within its time budget — is the only other error `transact` itself adds; the `apply` door above adds `EditDoesNotApply`.)

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

A custom backend implements `GitomicBackend`: `head`, `readFiles`, `readCommit`, `writeCommit`, `compareAndSwap`, `findTransaction`, plus the optional remote pair. `readCommit` supplies the `CommitMeta` record described above. `writeCommit` receives your `writer` label and the store's `instance` and `seq`, and must record all three so `findTransaction` can recognize `(instance, seq)` later. A backend that wraps a built-in one keeps every contract by spreading it and overriding only what it owns.

## Command line

The `gitomic` binary is the file-level door from a shell: read and write a ref by address, from anywhere, with no checkout.

```sh
$ gitomic read 'repo#main' notes/milk.md                       # print a path's content
$ gitomic ls   'repo#main' 'notes/**'                          # matching paths, one per line
$ gitomic grep 'repo#main' 'TODO' '*.md'                       # path:line for every match
$ gitomic write 'repo#main' -m edit  notes/milk.md=./milk.md   # one put, one commit
$ gitomic rm   'repo#main' -m drop   notes/old.md
$ gitomic mv   'repo#main' -m 'file it'  inbox/a.md archive/a.md
$ gitomic apply 'repo#main' -m batch  put new.md ./new.txt  rm old.md
```

**Address.** One argument, `<repo>#<ref>` — a repo path or URL, then the ref (default `main` with no `#`). QUOTE it in the shell: `#` is a glob operator under zsh's `extended_glob`, and `?` (a legal ref character) is one in every POSIX shell.

**Read verbs** open an immutable snapshot, pinned at `--at <oid>` or the tip:

| verb                                                      | prints                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| `read <addr> <path> [--at <oid>]`                         | the path's exact content                                             |
| `ls <addr> [<glob>] [--at <oid>]`                         | matching paths, sorted, one per line                                 |
| `grep <addr> <pattern> [<glob>] [--at <oid>]`             | `path:line` for every line matching the JS regex `pattern`           |
| `log <addr> [<glob>] [--at <oid>] [-n <count>] [--json]`  | full commit id and first message line; JSON: `CommitMeta[]`          |
| `diff <addr> --base <oid> [--at <oid>] [<glob>] [--json]` | `A`, `D`, or `M`, a tab, then the path; JSON: `{ path, from, to }[]` |

`read` on an absent path fails loudly (exit 1); `ls`/`grep` matching nothing print nothing and exit 0; `grep` skips a non-UTF-8 blob with a note on stderr rather than failing the whole scan.

For `log`, `--at` selects the starting commit; `-n` defaults to 50 and accepts 1–1,024. A glob counts matching commits, using first-parent blob changes and all paths at a root commit. The filtered scan loads up to 1,024 metadata records even when an early commit matches. Reaching the root with fewer than `-n` matches succeeds; reaching the cap with a parent still remaining and too few matches fails with exit 1 and empty stdout. A root-complete short result names the address, starting commit, filter, inspected count, and exclusions on stderr; it reports no matches or the returned/requested match counts. Stdout remains the complete result.

For `diff`, `--base` is required and `--at` selects the other endpoint, defaulting to one pinned tip. The optional glob narrows the blob-identity changes described under Reading. No changed paths means success with empty plain output or `[]` in JSON, but a missing endpoint is an error, including when both ids are equal.

Both commands calculate their complete result before writing stdout. Use `--json` for full commit messages and lossless paths. Malformed arguments exit 2; backend or history-data failures exit 1, with context on stderr and no partial result on stdout.

**Write verbs** open the store and land ONE commit per invocation:

| verb                                                                                        | edit(s)                                                               |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `write <addr> -m <msg> [--json] [--expect <path>=<oid>]… [--create <path>]… <path>=<file>…` | one `put` per `<path>=<file>` (`-` is stdin)                          |
| `rm <addr> -m <msg> [--json] [--expect <path>=<oid>]… <path>…`                              | one `rm` per path                                                     |
| `mv <addr> -m <msg> [--json] <from> <to>`                                                   | one `mv`                                                              |
| `apply <addr> -m <msg> [--base <oid>] [--json] <clause>…`                                   | one edit per `put`/`append`/`rm`/`mv` clause, in order, as one commit |

Every precondition is the git BLOB oid `ls`/a prior write reports — never a raw hash of the file's bytes. Unless `--expect <path>=<oid>` names it (or `--create`, a strict create), a path's precondition is auto-read the moment the command starts — present means "replace exactly this", absent means a create — and re-checked against whatever tree the commit actually attempts, so the auto-read stays race-safe. `apply` clauses apply in order against one pinned base (`--base <oid>`, default the tip), so `rm to.md` then `mv from.md to.md` frees the destination inside one commit while the reverse order refuses. A path spelled like a clause keyword is written `./put` — git's own path form, which the CLI strips (a gitomic path never begins with `./`).

`--writer <label>` labels the audit trail on any write verb. `--json` replaces the bare-oid line with a one-line receipt — the output contract for a script:

```sh
$ gitomic write 'repo#main' -m edit a.md=./a --json
{"oid":"9f3c2ab…","retries":0}
```

Product output — content, paths, matches, the oid or receipt — goes to stdout; narration and errors to stderr. The exit codes are the whole contract, and nothing fails silently:

| code | meaning                                                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | ok                                                                                                                                                                                |
| `1`  | a runtime/data error — a read miss, invalid UTF-8, a backend failure, `RetriesExhausted`; the subject names itself                                                                |
| `2`  | a usage error — unknown verb, a missing or malformed argument or flag, a bad address                                                                                              |
| `3`  | a CAS precondition refusal (`EditDoesNotApply`), reported facts-only on stderr: the kind, path, expected and actual oids, and both commits — never an owner, role, or remediation |

`read --log` and `commit <checkout>` are not in this version.

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
3. Lose the race? The update function re-runs on the winner's version — no merges. Retries back off by a random, roughly doubling delay (≤150ms; the jitter stops lockstep). Contention is bounded by TIME, not a fixed attempt count: a transaction keeps retrying for `retryBudgetMs` (default 30s), and the budget RESETS every time the ref advances — a writer landing means the race is making progress — so a healthy burst is never abandoned, while a transaction that makes no progress for the whole budget fails with `RetriesExhausted`. Writers in one process queue locally.
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
