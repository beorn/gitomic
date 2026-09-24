#!/usr/bin/env bun
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { type Address, parseAddress } from "./address.js"
import { assertTrailers, identProblem, validateOid } from "./git-object.js"
import {
  apply,
  CANDIDATE_CONFIG,
  CandidateRefused,
  EditDoesNotApply,
  matchGlob,
  open,
  openReader,
  openRemoteRepository,
  projectCheckout,
  projectRemoteFirstFastForward,
  readRepositoryDeclaration,
  repositoryCandidate,
  trustDeclaration,
  runGit,
  synchronizeCheckoutToCommit,
  worktreeDirtyPaths,
  type CheckoutSyncOutcome,
  type Committed,
  type CommitMeta,
  type Edit,
  type GitomicBackend,
  type Ident,
  type Oid,
  type OpenOptions,
  type RemoteFirstProjectionOutcome,
  type Snapshot,
  type Trailer,
} from "./index.js"
import { decodeUtf8 } from "./utf8.js"

/**
 * `gitomic` — the file-level door: read and write a Git ref by address, with
 * no checkout, from anywhere. See README.md for the library this fronts.
 *
 * Grammar: `gitomic <verb> <repo>#<ref> [args] [flags]`. The address is
 * `parseAddress`'s `<repo>#<ref>` (ref defaults to `main` with no `#`). QUOTE
 * the address in the shell — `gitomic read 'repo#main' path`, never
 * unquoted: `#` is a glob operator under zsh's `extended_glob`, and `?` (a
 * legal ref character) is a glob operator in every POSIX shell.
 *
 * Read verbs (openReader, an immutable snapshot pinned at `--at` or the tip):
 * - `read <addr> <path> [--at <oid>]` — print the path's exact content to stdout.
 * - `ls <addr> [<prefix-or-glob>] [--at <oid>]` — print matching paths, one per line.
 * - `grep <addr> [--at <oid>] <pattern> [<glob>]` — print `path:line` for every
 *   line in every matching path whose content matches the (JS) regex `pattern`.
 *   A path that is not valid UTF-8 is skipped with a note on stderr rather than
 *   failing the whole scan.
 * - `log <addr> [<glob>] [--at <oid>] [-n <count>] [--json]` — newest-first
 *   first-parent history, default 50 commits, maximum 1024. A glob counts
 *   matching commits, not inspected commits; it may read 1024 metadata objects
 *   even when an early commit matches. An insufficient bounded scan fails.
 * - `diff <addr> --base <oid> [--at <oid>] [<glob>] [--json]` — sorted blob
 *   identity changes, not text, rename or mode-only changes. `--at` defaults
 *   to one pinned tip. Both history commands buffer output until success.
 *
 * Write verbs (open + apply, one commit per invocation). Every `--expect`
 * or clause anchor is the git BLOB oid `ls`/a prior write's own commit
 * reports, never a raw hash of the file's bytes:
 * - `write <addr> -m <message> [--writer <label>] [--json] [--expect <path>=<oid>]...
 *   [--create <path>]... <path>=<file>...` — one `put` edit per
 *   `<path>=<file>` pair, `<file>` read from the local filesystem (`-` reads
 *   stdin). Each path's precondition: `--expect <path>=<oid>` uses that oid;
 *   `--create <path>` is a STRICT create (refuses if the path already
 *   exists); otherwise the CLI auto-reads the path's own current oid the
 *   moment the command starts and uses THAT as the precondition — present
 *   means "replace exactly this", absent means a create, the same rule
 *   `rm`/`mv` use below. `--expect` and `--create` on the same path is a
 *   usage error (contradictory preconditions), never a silent pick.
 * - `rm <addr> -m <message> [--writer <label>] [--json] [--expect <path>=<oid>]... <path>...`
 *   — one `rm` edit per path. A path with no matching `--expect` reads its OWN
 *   current oid the moment the command starts and uses that as the
 *   precondition — still race-safe, because `apply`'s CAS replay re-checks
 *   that same precondition against whatever tree the commit actually attempts.
 * - `mv <addr> -m <message> [--writer <label>] [--json] <from> <to>` — one `mv` edit;
 *   the source's current oid is read the same way `rm`'s default is, and the
 *   destination must be absent (the library's own `mv` precondition — no flag
 *   for it).
 * - `apply <addr> -m <message> [--writer <label>] [--base <oid>] [--json] <clause>...`
 *   — the general multi-edit verb: one `Edit` per clause, built in the order
 *   given and landed as ONE all-or-nothing commit (the first clause whose
 *   precondition is refused aborts every clause, per R44 — never a partial
 *   apply). Each clause is introduced by its own kind keyword:
 *     - `put <path> <file> [--expect <oid> | --create]`
 *     - `append <path> <file>`
 *     - `rm <path> [--expect <oid>]`
 *     - `mv <from> <to> [--expect <oid>]`
 *   `<file>` is read from the local filesystem, or stdin for `-`. `put`,
 *   `rm` and `mv` without `--expect` (and `put` without `--create`)
 *   auto-read their path's current oid at `--base` (default: the current
 *   head) — the same rule `write` uses above; `put --create` is a strict
 *   create; `append` carries no anchor at all, per the library's own `Edit`
 *   shape. Clause ORDER is apply order against the SAME attempted tree, so a
 *   later clause can depend on an earlier one: `rm to.md` then
 *   `mv from.md to.md` frees `to.md` for the move inside one commit, while
 *   the reverse order refuses on `destination-absent`. A PATH spelled like a
 *   clause keyword (`put`/`append`/`rm`/`mv`) is named by prefixing it `./` —
 *   git's own "this is a path" form, which a gitomic tree path never begins
 *   with, so the `./` is an unambiguous escape and is stripped. A FILE argument
 *   spelled like a keyword is written `./rm` too, a normal relative path read
 *   straight from disk.
 *
 * Every write verb prints the landed commit oid to stdout on success — or,
 * with `--json`, a one-line `{"oid":<oid>,"retries":<n>}` receipt of the oid
 * and how many CAS retries the landing took (the output contract for an agent
 * scripting the door). `log`/`diff` support `--json` arrays; `read`/`ls`/`grep`
 * do not, and a write refusal is unchanged by it. Product output goes to
 * stdout; narration and errors go to stderr.
 *
 * Write verbs run the repository's own gate: the `.gitomic.conf` its base
 * declares (see `repositoryCandidate`), only once that exact declaration is
 * trusted; an untrusted one refuses with exit 4 and runs nothing. `--author "Name <email>"` records who
 * acted, defaulting to the ident `git commit` would record (ADR-0020); gitomic
 * stays the committer. `--trailer Key=Value` (repeatable) adds caller trailers;
 * `Gitomic-*` keys are gitomic's own and refused.
 *
 * With `--checkout <path>`, write verbs project `<path>`'s working tree and
 * index forward after a successful write. A projection failure reports to
 * stderr and never fails the landed write.
 *
 * Trust verb:
 * - `trust <addr>` — print the `.gitomic.conf` the address's tip declares,
 *   then record its blob as the one declaration write verbs may run:
 *   `gitomic.trust` in a path repository's own git config, or
 *   `gitomic.<url>.trust` in the caller's global git config for a URL (its
 *   clone keeps no config). Exit 1 when the tip declares none. Read verbs
 *   never need trust.
 *
 * Project verbs:
 * - `project <path> [--remote <name>] [--ref <ref>] [--timeout <ms>]` — fetch
 *   the remote branch (default origin/refs/heads/main) and fast-forward the
 *   checkout's index and working tree to the fetched tip under the checkout
 *   lock, preserving unrelated dirt. One-line stdout names outcome kind and
 *   both oids.
 *
 * Exit codes — the only five, nothing else is a success:
 * - `0` ok: landed, or already current / fast-forwarded.
 * - `1` a runtime/data error: a read or backend failure (not-found, invalid
 *   UTF-8, exhausted retries — the subject names itself in the message) or a
 *   transport/environment projection failure (fetch-failed,
 *   ancestry-unverifiable, ref-advance-refused, wrong-branch).
 * - `2` a usage error (unknown verb, a missing or malformed argument or
 *   flag, a bad address).
 * - `3` an {@link EditDoesNotApply} CAS precondition refusal, reported as
 *   facts only on stderr — never an owner, role, or remediation. Tree and
 *   ref unchanged.
 * - `4` a {@link CandidateRefused}: the repository's gate refused the write.
 *   Its reasons, then one machine line `code=candidate-refused base=<oid>
 *   reasons=<JSON array>`. Tree and ref unchanged. Or, for `project`, an
 *   unsynchronized or stranded checkout (stranded-local-commits,
 *   landed-but-unsynchronized, worktree-update-refused, dirt-changed,
 *   dirt-unverifiable).
 *
 * Deliberately not built here (need new grammar or library plumbing this CLI
 * does not add): `read --log`, `commit <checkout>`.
 */
export async function main(argv: string[], io: CliIo = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout
  const stderr = io.stderr ?? process.stderr
  const stdin = io.stdin ?? process.stdin
  const backend = io.backend
  const args = [...argv]
  try {
    const verb = args.shift()
    if (verb === undefined) throw new UsageError(`missing verb; expected one of ${VERBS.join(", ")}`)
    if (verb === "--help" || verb === "-h") {
      stdout.write(`Usage: gitomic <verb> <repo>#<ref> [args] [flags]\n\nVerbs: ${VERBS.join(", ")}\n`)
      return OK
    }
    switch (verb) {
      case "read":
        return await runRead(args, stdout, backend)
      case "ls":
        return await runLs(args, stdout, backend)
      case "grep":
        return await runGrep(args, stdout, stderr, backend)
      case "log":
        return await runLog(args, stdout, stderr, backend)
      case "diff":
        return await runDiff(args, stdout, backend)
      case "write":
        return await runWrite(args, stdin, stdout, stderr, backend)
      case "rm":
        return await runRm(args, stdout, stderr, backend)
      case "mv":
        return await runMv(args, stdout, stderr, backend)
      case "apply":
        return await runApply(args, stdin, stdout, stderr, backend)
      case "project":
        return await runProject(args, stdout, stderr)
      case "trust":
        return await runTrust(args, stdout, backend)
      default:
        throw new UsageError(`unknown verb: ${JSON.stringify(verb)}; expected one of ${VERBS.join(", ")}`)
    }
  } catch (error) {
    return reportError(error, stderr)
  }
}

export type CliWriter = { write(chunk: string): unknown }
export type CliStdin = AsyncIterable<string | Uint8Array>

export type CliIo = {
  stdin?: CliStdin
  stdout?: CliWriter
  stderr?: CliWriter
  backend?: GitomicBackend
}

export const VERBS = ["read", "ls", "grep", "log", "diff", "write", "rm", "mv", "apply", "project", "trust"] as const

const OK = 0
const RUNTIME_ERROR = 1
const USAGE_ERROR = 2
const PRECONDITION_REFUSED = 3
const CANDIDATE_REFUSED = 4
const HISTORY_SCAN_LIMIT = 1_024

// --- read verbs --------------------------------------------------------

async function runRead(args: string[], stdout: CliWriter, backend: GitomicBackend | undefined): Promise<number> {
  const { positionals, flags } = extractFlags(args, { "--at": "value" })
  const address = requirePositional(positionals, 0, "<address>")
  const path = requirePositional(positionals, 1, "<path>")
  const at: Oid | undefined = optionalStringFlag(flags, "--at")
  using repository = await openAddressFor(address, backend)
  const reader = await openReader(repository)
  const value = await reader.at(at).get(path)
  if (value === undefined) throw new Error(`path not found: ${JSON.stringify(path)} at ${describeAddress(address, at)}`)
  stdout.write(value)
  return OK
}

async function runLs(args: string[], stdout: CliWriter, backend: GitomicBackend | undefined): Promise<number> {
  const { positionals, flags } = extractFlags(args, { "--at": "value" })
  const address = requirePositional(positionals, 0, "<address>")
  const glob = positionals.at(1)
  const at: Oid | undefined = optionalStringFlag(flags, "--at")
  using repository = await openAddressFor(address, backend)
  const reader = await openReader(repository)
  for (const key of await matchingKeys(reader.at(at), glob)) stdout.write(`${key}\n`)
  return OK
}

async function runGrep(
  args: string[],
  stdout: CliWriter,
  stderr: CliWriter,
  backend: GitomicBackend | undefined,
): Promise<number> {
  const { positionals, flags } = extractFlags(args, { "--at": "value" })
  const address = requirePositional(positionals, 0, "<address>")
  const pattern = requirePositional(positionals, 1, "<pattern>")
  const glob = positionals.at(2)
  const at: Oid | undefined = optionalStringFlag(flags, "--at")
  const regex = compilePattern(pattern)
  using repository = await openAddressFor(address, backend)
  const reader = await openReader(repository)
  const snapshot = reader.at(at)
  for (const path of await matchingKeys(snapshot, glob)) {
    let content: string | undefined
    try {
      content = await snapshot.get(path)
    } catch (error) {
      stderr.write(
        `gitomic: grep: skipping ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      continue
    }
    if (content === undefined) continue // enumerated from this same pinned snapshot; cannot actually be absent.
    for (const line of content.split("\n")) {
      if (regex.test(line)) stdout.write(`${path}:${line}\n`)
    }
  }
  return OK
}

async function runLog(
  args: string[],
  stdout: CliWriter,
  stderr: CliWriter,
  backend: GitomicBackend | undefined,
): Promise<number> {
  const { positionals, flags } = extractFlags(args, { "--at": "value", "-n": "value", "--json": "boolean" })
  const address = requirePositional(positionals, 0, "<address>")
  assertNoExtraPositionals(positionals, 2, "<addr> [glob]", "log")
  const glob = positionals.at(1)
  let from = historyOidFlag(flags, "--at")
  const rawLimit = optionalStringFlag(flags, "-n")
  const limit = rawLimit === undefined ? 50 : Number(rawLimit)
  if (
    (rawLimit !== undefined && !/^\d+$/.test(rawLimit)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > HISTORY_SCAN_LIMIT
  ) {
    throw new UsageError("-n must be a positive integer no greater than 1024")
  }
  try {
    using repository = await openAddressFor(address, backend)
    const reader = await openReader(repository)
    from ??= await reader.head()
    const history = await reader.log({ from, limit: glob === undefined ? limit : HISTORY_SCAN_LIMIT })
    let commits: CommitMeta[] = history
    if (glob !== undefined) {
      commits = []
      for (const commit of history) {
        const paths =
          commit.parent === null
            ? await reader.at(commit.oid).keys()
            : (await reader.diff(commit.parent, commit.oid)).map(({ path }) => path)
        if (paths.some((path) => matchGlob(glob, path))) commits.push(commit)
        if (commits.length === limit) break
      }
      const scope = `${describeAddress(address, from)} filter=${JSON.stringify(glob)}; first-parent blob changes (mode-only changes excluded)`
      if (commits.length < limit && history.length === HISTORY_SCAN_LIMIT && history.at(-1)?.parent !== null) {
        throw new Error(
          `scan exhausted after 1024 commits for ${scope}; found ${commits.length} of ${limit} requested matches, root not reached`,
        )
      }
      if (commits.length < limit) {
        const result = commits.length === 0 ? "no matches" : `returned ${commits.length} of ${limit} requested matches`
        stderr.write(`gitomic: log: ${result} for ${scope}; reached root after ${history.length} commits\n`)
      }
    }
    stdout.write(
      flags.has("--json")
        ? `${JSON.stringify(commits)}\n`
        : commits.map((commit) => `${commit.oid} ${commit.message.split("\n", 1)[0]}\n`).join(""),
    )
    return OK
  } catch (error) {
    if (error instanceof UsageError) throw error
    throw new Error(
      `log ${describeAddress(address, from)}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

async function runDiff(args: string[], stdout: CliWriter, backend: GitomicBackend | undefined): Promise<number> {
  const { positionals, flags } = extractFlags(args, { "--base": "value", "--at": "value", "--json": "boolean" })
  const address = requirePositional(positionals, 0, "<address>")
  assertNoExtraPositionals(positionals, 2, "<addr> [glob]", "diff")
  const glob = positionals.at(1)
  const base = historyOidFlag(flags, "--base")
  if (base === undefined) throw new UsageError("missing --base <oid>")
  let to = historyOidFlag(flags, "--at")
  try {
    using repository = await openAddressFor(address, backend)
    const reader = await openReader(repository)
    to ??= await reader.head()
    const changes = (await reader.diff(base, to)).filter(({ path }) => glob === undefined || matchGlob(glob, path))
    stdout.write(
      flags.has("--json")
        ? `${JSON.stringify(changes)}\n`
        : changes
            .map(({ path, from, to: after }) => `${from === null ? "A" : after === null ? "D" : "M"}\t${path}\n`)
            .join(""),
    )
    return OK
  } catch (error) {
    if (error instanceof UsageError) throw error
    throw new Error(
      `diff ${describeAddress(address, to)} base=${base}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

/** Only input validation becomes usage failure; backend/data errors retain exit 1. */
function historyOidFlag(flags: FlagValues, flag: string): Oid | undefined {
  const value = optionalStringFlag(flags, flag)
  if (value === undefined) return undefined
  try {
    return validateOid(value, `invalid ${flag}`)
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

/** The keys of `snapshot`, optionally narrowed to a glob — shared by `ls` and `grep`. */
async function matchingKeys(snapshot: Snapshot, glob: string | undefined): Promise<string[]> {
  const keys = await snapshot.keys()
  return glob === undefined ? keys : keys.filter((key) => matchGlob(glob, key))
}

function compilePattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern)
  } catch (error) {
    throw new UsageError(`invalid grep pattern: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// --- write verbs ---------------------------------------------------------

async function runWrite(
  args: string[],
  stdin: CliStdin,
  stdout: CliWriter,
  stderr: CliWriter,
  backend: GitomicBackend | undefined,
): Promise<number> {
  const { positionals, flags, repeated } = extractFlags(args, {
    "-m": "value",
    "--writer": "value",
    "--expect": "repeated",
    "--create": "repeated",
    "--author": "value",
    "--trailer": "repeated",
    "--checkout": "value",
    "--json": "boolean",
  })
  const attribution = parseAttribution(optionalStringFlag(flags, "--author"), repeated.get("--trailer") ?? [])
  const address = requirePositional(positionals, 0, "<address>")
  const message = requireStringFlag(flags, "-m", "-m <message>")
  const writer = optionalStringFlag(flags, "--writer")
  const checkoutPath = optionalStringFlag(flags, "--checkout")
  const expectedDirtyPaths = checkoutPath !== undefined ? worktreeDirtyPaths(checkoutPath) : []
  const pairs = parsePathFilePairs(positionals.slice(1))
  const knownPaths = new Set(pairs.map((pair) => pair.path))
  const expect = parseExpectPairs(repeated.get("--expect") ?? [])
  const create = parseUniquePaths("--create", repeated.get("--create") ?? [])
  assertTargetsKnown("--expect", expect.keys(), knownPaths, "written")
  assertTargetsKnown("--create", create, knownPaths, "written")
  for (const path of create) assertNotContradictoryPrecondition(path, expect.has(path), true)

  using repository = await openAddressFor(address, backend)
  const store = await open({ ...repository, ...(writer === undefined ? {} : { writer }) })
  const base = await store.head()
  const snapshot = store.at(base)
  const edits: Edit[] = []
  for (const { path, file } of pairs) {
    const content = file === "-" ? await readStdin(stdin) : await readFileContent(file)
    const anchor = await putPrecondition(path, expect.get(path), create.has(path), snapshot)
    edits.push({ kind: "put", path, content, expect: anchor })
  }

  const committed = await apply(store, base, edits, message, await writeOptions(attribution, repository, stderr))
  let projectionOutcome: ProjectOutcomeReceipt | undefined
  if (checkoutPath !== undefined) {
    projectionOutcome = await projectAfterWrite(
      checkoutPath,
      committed.oid,
      repository,
      base,
      expectedDirtyPaths,
      stderr,
    )
  }
  writeReceipt(stdout, stderr, committed, flags.get("--json") === true, projectionOutcome)
  return OK
}

async function runRm(
  args: string[],
  stdout: CliWriter,
  stderr: CliWriter,
  backend: GitomicBackend | undefined,
): Promise<number> {
  const { positionals, flags, repeated } = extractFlags(args, {
    "-m": "value",
    "--writer": "value",
    "--expect": "repeated",
    "--author": "value",
    "--trailer": "repeated",
    "--json": "boolean",
  })
  const attribution = parseAttribution(optionalStringFlag(flags, "--author"), repeated.get("--trailer") ?? [])
  const address = requirePositional(positionals, 0, "<address>")
  const message = requireStringFlag(flags, "-m", "-m <message>")
  const writer = optionalStringFlag(flags, "--writer")
  const paths = positionals.slice(1)
  if (paths.length === 0) throw new UsageError("rm requires at least one <path>")
  const seen = new Set<string>()
  for (const path of paths) {
    if (seen.has(path)) throw new UsageError(`duplicate path in one rm: ${path}`)
    seen.add(path)
  }
  const expect = parseExpectPairs(repeated.get("--expect") ?? [])
  assertTargetsKnown("--expect", expect.keys(), seen, "removed")

  using repository = await openAddressFor(address, backend)
  const store = await open({ ...repository, ...(writer === undefined ? {} : { writer }) })
  const base = await store.head()
  const snapshot = store.at(base)
  const edits: Edit[] = []
  for (const path of paths) {
    const anchor = await removalPrecondition(path, expect.get(path), snapshot)
    if (anchor === undefined) throw new Error(`path not found, cannot remove: ${JSON.stringify(path)} at ${address}`)
    edits.push({ kind: "rm", path, expect: anchor })
  }
  const committed = await apply(store, base, edits, message, await writeOptions(attribution, repository, stderr))
  writeReceipt(stdout, stderr, committed, flags.get("--json") === true)
  return OK
}

async function runMv(
  args: string[],
  stdout: CliWriter,
  stderr: CliWriter,
  backend: GitomicBackend | undefined,
): Promise<number> {
  const { positionals, flags, repeated } = extractFlags(args, {
    "-m": "value",
    "--writer": "value",
    "--author": "value",
    "--trailer": "repeated",
    "--json": "boolean",
  })
  const attribution = parseAttribution(optionalStringFlag(flags, "--author"), repeated.get("--trailer") ?? [])
  const address = requirePositional(positionals, 0, "<address>")
  const from = requirePositional(positionals, 1, "<from>")
  const to = requirePositional(positionals, 2, "<to>")
  const message = requireStringFlag(flags, "-m", "-m <message>")
  const writer = optionalStringFlag(flags, "--writer")

  using repository = await openAddressFor(address, backend)
  const store = await open({ ...repository, ...(writer === undefined ? {} : { writer }) })
  const base = await store.head()
  const expect = await store.at(base).oid(from)
  if (expect === undefined) throw new Error(`source path not found: ${JSON.stringify(from)} at ${address}`)
  const committed = await apply(
    store,
    base,
    [{ kind: "mv", from, to, expect }],
    message,
    await writeOptions(attribution, repository, stderr),
  )
  writeReceipt(stdout, stderr, committed, flags.get("--json") === true)
  return OK
}

// --- apply verb ------------------------------------------------------------

const CLAUSE_KEYWORDS = new Set(["put", "append", "rm", "mv"])

async function runApply(
  args: string[],
  stdin: CliStdin,
  stdout: CliWriter,
  stderr: CliWriter,
  backend: GitomicBackend | undefined,
): Promise<number> {
  const queue = [...args]
  const address = queue.shift()
  if (address === undefined) throw new UsageError("missing <address>")

  let message: string | undefined
  let writer: string | undefined
  let base: Oid | undefined
  let author: string | undefined
  let checkoutPath: string | undefined
  const trailers: string[] = []
  let asJson = false
  while (true) {
    const token = queue.at(0)
    if (token === undefined || CLAUSE_KEYWORDS.has(token)) break
    queue.shift()
    switch (token) {
      case "-m":
        message = requireQueuedValue(queue, token)
        break
      case "--writer":
        writer = requireQueuedValue(queue, token)
        break
      case "--base":
        base = requireQueuedValue(queue, token)
        break
      case "--author":
        author = requireQueuedValue(queue, token)
        break
      case "--trailer":
        trailers.push(requireQueuedValue(queue, token))
        break
      case "--checkout":
        checkoutPath = requireQueuedValue(queue, token)
        break
      case "--json":
        asJson = true
        break
      default:
        throw new UsageError(`unrecognized flag: ${token}`)
    }
  }
  if (message === undefined) throw new UsageError("missing -m <message>")
  const attribution = parseAttribution(author, trailers)
  const expectedDirtyPaths = checkoutPath !== undefined ? worktreeDirtyPaths(checkoutPath) : []

  using repository = await openAddressFor(address, backend)
  const store = await open({ ...repository, ...(writer === undefined ? {} : { writer }) })
  const startBase = base ?? (await store.head())
  const snapshot = store.at(startBase)
  const edits: Edit[] = []
  for (const clause of splitClauses(queue)) {
    edits.push(await parseClause(clause, snapshot, stdin, address))
  }
  const committed = await apply(store, startBase, edits, message, await writeOptions(attribution, repository, stderr))
  let projectionOutcome: ProjectOutcomeReceipt | undefined
  if (checkoutPath !== undefined) {
    projectionOutcome = await projectAfterWrite(
      checkoutPath,
      committed.oid,
      repository,
      startBase,
      expectedDirtyPaths,
      stderr,
    )
  }
  writeReceipt(stdout, stderr, committed, asJson, projectionOutcome)
  return OK
}

/** Shift the next token as a required flag value, failing loudly by the flag's own name. */
function requireQueuedValue(queue: string[], flag: string): string {
  const value = queue.shift()
  if (value === undefined) throw new UsageError(`${flag} requires a value`)
  return value
}

/** Split `apply`'s clause-region tokens into groups, each starting with `put`/`append`/`rm`/`mv`. */
function splitClauses(tokens: readonly string[]): string[][] {
  const clauses: string[][] = []
  for (const token of tokens) {
    if (CLAUSE_KEYWORDS.has(token)) {
      clauses.push([token])
      continue
    }
    const current = clauses.at(-1)
    if (current === undefined) {
      throw new UsageError(`apply: expected a clause keyword (put/append/rm/mv), got: ${token}`)
    }
    current.push(token)
  }
  if (clauses.length === 0) throw new UsageError("apply requires at least one clause (put/append/rm/mv)")
  return clauses
}

/**
 * Parse one clause's tokens (its kind keyword plus that clause's own args and
 * flags) into the `Edit` it names. A bare `put`/`append`/`rm`/`mv` token starts
 * a new clause (see {@link splitClauses}); a path spelled like a keyword is
 * escaped `./name` and de-escaped by {@link clausePath}.
 */
async function parseClause(
  tokens: readonly string[],
  snapshot: Snapshot,
  stdin: CliStdin,
  address: string,
): Promise<Edit> {
  const keyword = tokens.at(0)
  const rest = tokens.slice(1)
  switch (keyword) {
    case "put":
      return parsePutClause(rest, snapshot, stdin)
    case "append":
      return parseAppendClause(rest, stdin)
    case "rm":
      return parseRmClause(rest, snapshot, address)
    case "mv":
      return parseMvClause(rest, snapshot, address)
    default:
      // Unreachable: splitClauses only ever starts a group with one of these keywords.
      throw new UsageError(`apply: expected a clause keyword (put/append/rm/mv), got: ${JSON.stringify(keyword)}`)
  }
}

/**
 * De-escape a clause PATH operand. A bare `put`/`append`/`rm`/`mv` token starts
 * a new clause (see {@link splitClauses}), so a path spelled like a keyword is
 * written `./name` — git's own "this is a path" form. A gitomic tree path never
 * begins with `./` (a `.` segment is rejected), so a leading `./` is an
 * unambiguous escape and is stripped here. A FILE argument spelled like a
 * keyword is written the same way but stays a normal relative path read from
 * disk, so only path operands pass through here.
 */
function clausePath(operand: string): string {
  return operand.startsWith("./") ? operand.slice(2) : operand
}

async function parsePutClause(tokens: readonly string[], snapshot: Snapshot, stdin: CliStdin): Promise<Edit> {
  const { positionals, flags } = extractFlags(tokens, { "--expect": "value", "--create": "boolean" })
  assertNoExtraPositionals(positionals, 2, "put <path> <file>")
  const path = clausePath(requirePositional(positionals, 0, "put <path>"))
  const file = requirePositional(positionals, 1, "put <path> <file>")
  const expectFlag = optionalStringFlag(flags, "--expect")
  const createFlag = flags.get("--create") === true
  assertNotContradictoryPrecondition(path, expectFlag !== undefined, createFlag)
  const content = file === "-" ? await readStdin(stdin) : await readFileContent(file)
  const anchor = await putPrecondition(path, expectFlag, createFlag, snapshot)
  return { kind: "put", path, content, expect: anchor }
}

async function parseAppendClause(tokens: readonly string[], stdin: CliStdin): Promise<Edit> {
  const { positionals } = extractFlags(tokens, {})
  assertNoExtraPositionals(positionals, 2, "append <path> <file>")
  const path = clausePath(requirePositional(positionals, 0, "append <path>"))
  const file = requirePositional(positionals, 1, "append <path> <file>")
  const content = file === "-" ? await readStdin(stdin) : await readFileContent(file)
  return { kind: "append", path, content }
}

async function parseRmClause(tokens: readonly string[], snapshot: Snapshot, address: string): Promise<Edit> {
  const { positionals, flags } = extractFlags(tokens, { "--expect": "value" })
  assertNoExtraPositionals(positionals, 1, "rm <path>")
  const path = clausePath(requirePositional(positionals, 0, "rm <path>"))
  const anchor = await removalPrecondition(path, optionalStringFlag(flags, "--expect"), snapshot)
  if (anchor === undefined) throw new Error(`path not found, cannot remove: ${JSON.stringify(path)} at ${address}`)
  return { kind: "rm", path, expect: anchor }
}

async function parseMvClause(tokens: readonly string[], snapshot: Snapshot, address: string): Promise<Edit> {
  const { positionals, flags } = extractFlags(tokens, { "--expect": "value" })
  assertNoExtraPositionals(positionals, 2, "mv <from> <to>")
  const from = clausePath(requirePositional(positionals, 0, "mv <from>"))
  const to = clausePath(requirePositional(positionals, 1, "mv <from> <to>"))
  const anchor = await removalPrecondition(from, optionalStringFlag(flags, "--expect"), snapshot)
  if (anchor === undefined) throw new Error(`source path not found: ${JSON.stringify(from)} at ${address}`)
  return { kind: "mv", from, to, expect: anchor }
}

/** A clause must consume every positional it's given — an extra one signals a missing clause keyword or a typo, not a silent no-op. */
function assertNoExtraPositionals(
  positionals: readonly string[],
  expected: number,
  clause: string,
  verb = "apply",
): void {
  if (positionals.length > expected) {
    throw new UsageError(
      `${verb}: ${clause} takes ${expected} argument(s); got extra: ${positionals.slice(expected).join(" ")}`,
    )
  }
}

type PathFilePair = { path: string; file: string }

/** Split `<path>=<file>` tokens (write's positionals after the address); at least one is required. */
function parsePathFilePairs(tokens: readonly string[]): PathFilePair[] {
  if (tokens.length === 0) throw new UsageError("write requires at least one <path>=<file> pair")
  const pairs: PathFilePair[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    const separator = token.indexOf("=")
    if (separator <= 0) throw new UsageError(`write arguments must be <path>=<file>, got: ${token}`)
    const path = token.slice(0, separator)
    const file = token.slice(separator + 1)
    if (file.length === 0) throw new UsageError(`write arguments must be <path>=<file>, got: ${token}`)
    if (seen.has(path)) throw new UsageError(`duplicate path in one write: ${path}`)
    seen.add(path)
    pairs.push({ path, file })
  }
  return pairs
}

/** Parse repeated `--expect <path>=<oid>` values into a path -> oid map, failing loudly on a malformed or repeated path. */
function parseExpectPairs(raw: readonly string[]): ReadonlyMap<string, Oid> {
  const result = new Map<string, Oid>()
  for (const entry of raw) {
    const separator = entry.indexOf("=")
    if (separator <= 0) throw new UsageError(`--expect must be <path>=<oid>, got: ${entry}`)
    const path = entry.slice(0, separator)
    const oid = entry.slice(separator + 1)
    if (oid.length === 0) throw new UsageError(`--expect must be <path>=<oid>, got: ${entry}`)
    if (result.has(path)) throw new UsageError(`--expect given twice for the same path: ${path}`)
    result.set(path, oid)
  }
  return result
}

/** A flag naming a path this invocation is not touching is a usage mistake, not a silent no-op. */
function assertTargetsKnown(
  flag: string,
  targets: Iterable<string>,
  knownPaths: ReadonlySet<string>,
  action: string,
): void {
  for (const path of targets) {
    if (!knownPaths.has(path)) throw new UsageError(`${flag} names a path not being ${action}: ${path}`)
  }
}

/** Parse repeated single-value flags (like `--create <path>`) into a set, failing loudly on a repeated path. */
function parseUniquePaths(flag: string, raw: readonly string[]): ReadonlySet<string> {
  const result = new Set<string>()
  for (const path of raw) {
    if (result.has(path)) throw new UsageError(`${flag} given twice for the same path: ${path}`)
    result.add(path)
  }
  return result
}

/** A path cannot claim both "must already hold this oid" (`--expect`) and "must be strictly absent" (`--create`). */
function assertNotContradictoryPrecondition(path: string, hasExpect: boolean, hasCreate: boolean): void {
  if (hasExpect && hasCreate) throw new UsageError(`--create and --expect both given for the same path: ${path}`)
}

/**
 * `put`'s precondition for one path — shared by `write` and `apply`'s `put`
 * clause: an explicit oid wins, else a strict `--create` is `null` (refuses
 * if the path turns out to be present), else auto-read the path's own
 * current oid at the base the moment the command started — present means
 * "replace exactly that", absent means a create. Race-safe like `rm`/`mv`'s
 * auto-read below: `apply`'s CAS replay re-checks this same precondition
 * against whatever tree the commit actually attempts.
 */
async function putPrecondition(
  path: string,
  explicitExpect: Oid | undefined,
  strictCreate: boolean,
  snapshot: Snapshot,
): Promise<Oid | null> {
  if (explicitExpect !== undefined) return explicitExpect
  if (strictCreate) return null
  return (await snapshot.oid(path)) ?? null
}

/**
 * `rm`/`mv`'s precondition for one path — shared by both verbs and `apply`'s
 * `rm`/`mv` clauses: an explicit oid wins, else auto-read the path's own
 * current oid. `undefined` means the path is genuinely absent, which the
 * caller must reject — unlike `put`, `rm`/`mv` require the path to exist.
 */
async function removalPrecondition(
  path: string,
  explicitExpect: Oid | undefined,
  snapshot: Snapshot,
): Promise<Oid | undefined> {
  return explicitExpect ?? (await snapshot.oid(path))
}

/**
 * A write verb's success output: the committed oid on its own line, or — with
 * `--json` — a one-line `{"oid":…,"retries":…,"report":[…]}` receipt of the oid,
 * how many CAS retries the landing took, and the repository gate's report (the
 * output contract for an agent scripting the door). In plain mode each report
 * line goes to stderr as `report: <line>`, so stdout stays the bare oid. A
 * refusal is unaffected: facts only on stderr, exit 3 or 4.
 */
type ProjectOutcomeReceipt = { readonly ok: boolean; readonly kind: string; readonly error?: string }

function isSameRepository(pathA: string, pathB: string): boolean {
  if (resolve(pathA) === resolve(pathB)) return true
  const commonDir = (path: string): string => {
    const result = spawnSync("git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
    })
    const directory = result.stdout?.trim() ?? ""
    if (result.error !== undefined || result.status !== 0 || directory.length === 0) {
      const detail = result.error?.message || result.stderr?.trim() || "no common directory returned"
      throw new Error(
        `cannot inspect repository ${JSON.stringify(path)}: git rev-parse exited ${result.status ?? "without status"}: ${detail}`,
      )
    }
    return directory
  }
  return commonDir(pathA) === commonDir(pathB)
}

/**
 * A write verb's success output: the committed oid on its own line, or — with
 * `--json` — a one-line `{"oid":…,"retries":…,"report":[…]}` receipt of the oid,
 * how many CAS retries the landing took, and the repository gate's report (the
 * output contract for an agent scripting the door). In plain mode each report
 * line goes to stderr as `report: <line>`, so stdout stays the bare oid. A
 * refusal is unaffected: facts only on stderr, exit 3 or 4.
 *
 * When `--checkout` is given, the `--json` receipt also carries `projection: <kind>`
 * so a caller can inspect the projection outcome directly.
 */
function writeReceipt(
  stdout: CliWriter,
  stderr: CliWriter,
  committed: Committed,
  asJson: boolean,
  projectionOutcome?: ProjectOutcomeReceipt,
): void {
  const report = committed.report ?? []
  if (asJson) {
    const receipt: Record<string, unknown> = {
      oid: committed.oid,
      retries: committed.retries,
      report,
    }
    if (projectionOutcome !== undefined) {
      receipt.projection = projectionOutcome.kind
    }
    stdout.write(`${JSON.stringify(receipt)}\n`)
    return
  }
  stdout.write(`${committed.oid}\n`)
  for (const line of report) stderr.write(`report: ${line}\n`)
}

async function projectAfterWrite(
  checkoutPath: string,
  to: Oid,
  repository: OpenOptions,
  startBase: Oid,
  expectedDirtyPaths: readonly string[],
  stderr: CliWriter,
): Promise<ProjectOutcomeReceipt> {
  const storeRef = repository.ref.startsWith("refs/heads/") ? repository.ref : `refs/heads/${repository.ref}`
  let isLocal: boolean
  try {
    isLocal = isSameRepository(checkoutPath, repository.repo)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stderr.write(`gitomic: projection failed: ${message}\nkind=repository-inspection-failed\n`)
    return { ok: false, kind: "repository-inspection-failed", error: message }
  }

  let outcome: CheckoutSyncOutcome | RemoteFirstProjectionOutcome
  if (isLocal) {
    outcome = synchronizeCheckoutToCommit({
      repoRoot: checkoutPath,
      from: startBase,
      to,
      ref: storeRef,
      expectedDirtyPaths,
    })
  } else {
    outcome = await projectRemoteFirstFastForward({
      repoRoot: checkoutPath,
      to,
      ref: storeRef,
      remote: repository.remote ?? "origin",
      expectedDirtyPaths,
      preTransactTip: startBase,
    })
  }

  if (!outcome.ok) {
    stderr.write(`gitomic: projection failed: ${outcome.error}\nkind=${outcome.kind}\n`)
    return { ok: false, kind: outcome.kind, error: outcome.error }
  }
  return { ok: true, kind: outcome.kind }
}

async function runProject(args: string[], stdout: CliWriter, stderr: CliWriter): Promise<number> {
  const { positionals, flags } = extractFlags(args, {
    "--remote": "value",
    "--ref": "value",
    "--timeout": "value",
  })
  const checkoutPath = requirePositional(positionals, 0, "<path>")
  assertNoExtraPositionals(positionals, 1, "<path>", "project")
  const remote = optionalStringFlag(flags, "--remote") ?? "origin"
  let ref = optionalStringFlag(flags, "--ref") ?? "refs/heads/main"
  if (!ref.startsWith("refs/heads/")) ref = `refs/heads/${ref}`

  const timeoutRaw = flags.get("--timeout")
  let timeoutMs: number | undefined
  if (timeoutRaw !== undefined) {
    if (typeof timeoutRaw !== "string" || !/^\d+$/u.test(timeoutRaw) || Number(timeoutRaw) <= 0) {
      throw new UsageError(`--timeout must be a positive integer in milliseconds, got ${JSON.stringify(timeoutRaw)}`)
    }
    timeoutMs = Number(timeoutRaw)
  }

  const outcome = await projectCheckout({
    repoRoot: checkoutPath,
    remote,
    ref,
    ...(timeoutMs !== undefined ? { remoteTimeoutMs: timeoutMs } : {}),
  })

  if (outcome.ok) {
    stdout.write(`kind=${outcome.kind} local=${outcome.localTip ?? ""} to=${outcome.to ?? ""}\n`)
    return OK
  }

  const UNSYNCHRONIZED_KINDS = new Set([
    "stranded-local-commits",
    "landed-but-unsynchronized",
    "worktree-update-refused",
    "dirt-changed",
    "dirt-unverifiable",
  ])

  if (UNSYNCHRONIZED_KINDS.has(outcome.kind)) {
    const localOnlyStr =
      outcome.kind === "stranded-local-commits" ? ` localOnly=${JSON.stringify(outcome.localOnly)}` : ""
    const localTipStr = outcome.localTip ?? ""
    const toStr = "landedOid" in outcome ? outcome.landedOid : (outcome.to ?? "")
    stderr.write(`${outcome.error}\nkind=${outcome.kind} local=${localTipStr} to=${toStr}${localOnlyStr}\n`)
    return CANDIDATE_REFUSED
  }

  stderr.write(`gitomic: ${outcome.error}\nkind=${outcome.kind}\n`)
  return RUNTIME_ERROR
}

type Attribution = { author: Ident | undefined; trailers: Trailer[] }

/** Parse `--author "Name <email>"` and each `--trailer Key=Value`; either one malformed is a usage error. */
function parseAttribution(author: string | undefined, trailerFlags: readonly string[]): Attribution {
  const trailers: Trailer[] = trailerFlags.map((flag) => {
    const equals = flag.indexOf("=")
    if (equals <= 0) throw new UsageError(`--trailer must be Key=Value, got ${JSON.stringify(flag)}`)
    return [flag.slice(0, equals), flag.slice(equals + 1)]
  })
  try {
    assertTrailers(trailers)
  } catch (error) {
    throw new UsageError(`--trailer: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (author === undefined) return { author: undefined, trailers }
  const match = /^(.+?) <([^<>]+)>$/u.exec(author)
  if (match === null) throw new UsageError(`--author must be "Name <email>", got ${JSON.stringify(author)}`)
  const ident = { name: match[1] ?? "", email: match[2] ?? "" }
  const problem = identProblem(ident)
  if (problem !== undefined) throw new UsageError(`--author ${problem}`)
  return { author: ident, trailers }
}

/**
 * The options every write verb passes to `apply`: the actor (ADR-0020 — `--author`, else the ident `git commit` would
 * record, resolved by `git var GIT_AUTHOR_IDENT`), the caller's trailers, and the repository's own declared gate.
 */
async function writeOptions(
  attribution: Attribution,
  repository: OpenedAddress,
  stderr: CliWriter,
): Promise<{ author?: Ident; trailers: Trailer[]; candidate: ReturnType<typeof repositoryCandidate> }> {
  const author = attribution.author ?? (await claimedAuthor(stderr))
  return {
    ...(author === undefined ? {} : { author }),
    trailers: attribution.trailers,
    candidate: repositoryCandidate({
      repo: repository.repo,
      ref: repository.ref,
      ...(repository.url === undefined ? {} : { url: repository.url }),
    }),
  }
}

/**
 * The author `git commit` would record in the caller's environment. A missing or unusable ident never stops the write
 * (ADR-0020): the commit is authored by gitomic's committer, and stderr says why.
 */
async function claimedAuthor(stderr: CliWriter): Promise<Ident | undefined> {
  const result = await runGit(["var", "GIT_AUTHOR_IDENT"])
  const line = result.stdout.toString("utf8").trim()
  const match = /^(.+?) <([^<>]*)> \d+ [+-]\d{4}$/u.exec(line)
  if (result.code !== 0 || match === null) {
    const detail = result.stderr.toString("utf8").trim().split("\n").at(-1) ?? ""
    stderr.write(
      `gitomic: no author identity (git var GIT_AUTHOR_IDENT exit ${result.code}${detail ? `: ${detail}` : ""}); authoring as the committer\n`,
    )
    return undefined
  }
  const ident = { name: match[1] ?? "", email: match[2] ?? "" }
  const problem = identProblem(ident)
  if (problem !== undefined) {
    stderr.write(`gitomic: git var GIT_AUTHOR_IDENT ${problem}; authoring as the committer\n`)
    return undefined
  }
  return ident
}

// --- argument parsing ------------------------------------------------------

type FlagKind = "value" | "boolean" | "repeated"
type FlagValues = Map<string, string | true>
type RepeatedFlagValues = Map<string, string[]>

/**
 * Scan `args` for the `--flag value`, boolean `--flag`, and repeatable
 * `--flag value` (accumulating) options named in `spec`, returning their
 * values and the remaining positional arguments in order. A `-`-prefixed
 * token absent from `spec` fails loudly naming itself, rather than being
 * silently swallowed as a positional.
 */
function extractFlags(
  args: readonly string[],
  spec: Readonly<Record<string, FlagKind>>,
): { positionals: string[]; flags: FlagValues; repeated: RepeatedFlagValues } {
  const positionals: string[] = []
  const flags: FlagValues = new Map()
  const repeated: RepeatedFlagValues = new Map()
  const queue = [...args]
  while (queue.length > 0) {
    const token = queue.shift()
    if (token === undefined) break
    const kind = spec[token]
    if (kind === undefined) {
      if (token.startsWith("-")) throw new UsageError(`unrecognized flag: ${token}`)
      positionals.push(token)
      continue
    }
    if (kind === "boolean") {
      flags.set(token, true)
      continue
    }
    const value = queue.shift()
    if (value === undefined) throw new UsageError(`${token} requires a value`)
    if (kind === "repeated") {
      const existing = repeated.get(token)
      if (existing === undefined) repeated.set(token, [value])
      else existing.push(value)
    } else {
      flags.set(token, value)
    }
  }
  return { positionals, flags, repeated }
}

function requirePositional(positionals: readonly string[], index: number, label: string): string {
  const value = positionals.at(index)
  if (value === undefined) throw new UsageError(`missing ${label}`)
  return value
}

function optionalStringFlag(flags: ReadonlyMap<string, string | true>, flag: string): string | undefined {
  const value = flags.get(flag)
  if (value === undefined) return undefined
  if (value === true) throw new UsageError(`${flag} requires a value`)
  return value
}

function requireStringFlag(flags: ReadonlyMap<string, string | true>, flag: string, label: string): string {
  const value = optionalStringFlag(flags, flag)
  if (value === undefined) throw new UsageError(`missing ${label}`)
  return value
}

function describeAddress(address: string, at: string | undefined): string {
  return at === undefined ? address : `${address} at ${at}`
}

/**
 * Read all of stdin and decode it as UTF-8, failing loudly (naming the
 * subject, per gitomic's own {@link decodeUtf8}) rather than letting a
 * lenient decode silently replace invalid bytes with substitution
 * characters — gitomic v1 values are UTF-8 strings, never mangled ones.
 */
async function readStdin(stdin: CliStdin): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk))
  }
  return decodeUtf8(Buffer.concat(chunks), "stdin content")
}

/** Read one `write` pair's `<file>` from the local filesystem, failing loudly on either an unreadable file or invalid UTF-8. */
async function readFileContent(file: string): Promise<string> {
  return decodeUtf8(await readFile(file), `file ${JSON.stringify(file)}`)
}

// --- trust -------------------------------------------------------------------

/** Print the declaration at the address's tip, then record its blob as trusted (the order the verb promises). */
async function runTrust(args: string[], stdout: CliWriter, backend: GitomicBackend | undefined): Promise<number> {
  const { positionals } = extractFlags(args, {})
  const address = requirePositional(positionals, 0, "<address>")
  if (positionals.length > 1) throw new UsageError(`trust takes one <address>; got ${positionals.length} arguments`)
  using repository = await openAddressFor(address, backend)
  const tip = await (await openReader(repository)).head()
  const declaration = await readRepositoryDeclaration(repository.repo, tip)
  if (declaration === undefined) {
    throw new Error(`${address} declares no ${CANDIDATE_CONFIG} at ${tip}; nothing to trust`)
  }
  stdout.write(`${CANDIDATE_CONFIG} ${declaration.blob} at ${tip} declares:\n`)
  for (const line of declaration.lines) stdout.write(`  ${line}\n`)
  const scope = { repo: repository.repo, ...(repository.url === undefined ? {} : { url: repository.url }) }
  const recorded = await trustDeclaration(scope, declaration.blob)
  stdout.write(`trusted: ${recorded.key} = ${declaration.blob} (${recorded.file} git config)\n`)
  return OK
}

// --- opening the address ---------------------------------------------------

/** An opened address: the store options, plus the URL when `repo` is a throwaway clone of a remote. */
type OpenedAddress = OpenOptions & Disposable & { readonly ref: string; readonly url?: string }

/** One CLI selection point; a failed local open never selects a remote. */
async function openAddressFor(address: string, backend: GitomicBackend | undefined): Promise<OpenedAddress> {
  const { repo, ref } = parseAddressOrUsageError(address)
  const local = { repo, ref, ...(backend === undefined ? {} : { backend }), [Symbol.dispose]() {} }
  if (backend !== undefined) return local
  const drivePath = /^[A-Za-z]:[\\\\/]/.test(repo)
  const remote = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(repo) || (!drivePath && /^[^/\\\\:]+:/.test(repo))
  if (!remote) return local
  const repository = await openRemoteRepository(repo)
  return { ...repository, ref, url: repo, [Symbol.dispose]: () => repository[Symbol.dispose]() }
}

function parseAddressOrUsageError(address: string): Address {
  try {
    return parseAddress(address)
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error))
  }
}

// --- errors and exit codes --------------------------------------------------

class UsageError extends Error {
  override readonly name = "UsageError"
}

/** Facts only (R8): kind, path, the anchor, what was found, the two commits. No owner, role, or remediation. */
function formatEditDoesNotApply(error: EditDoesNotApply): string {
  const expected = error.expected ?? "absent"
  const actual = error.actual ?? "absent"
  return (
    `${error.message}\n` +
    `kind=${error.kind} editIndex=${error.editIndex} path=${error.path} ` +
    `precondition=${error.preconditionType} expected=${expected} actual=${actual} ` +
    `base=${error.base} head=${error.head}\n`
  )
}

/** Preserve the standard combined-error shapes, including contextual history wrappers. */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (error instanceof AggregateError) return [error.message, ...error.errors.map(describeFailure)].join("\n")
  // TypeScript can supply a SuppressedError polyfill on Node versions without
  // the global constructor, so use its standard Error shape rather than instanceof.
  if (error.name === "SuppressedError" && "error" in error && "suppressed" in error) {
    return [error.message, describeFailure(error.error), describeFailure(error.suppressed)].join("\n")
  }
  if (
    error.cause instanceof Error &&
    (error.cause instanceof AggregateError || error.cause.name === "SuppressedError")
  ) {
    return `${error.message}\n${describeFailure(error.cause)}`
  }
  return error.message
}

function reportError(error: unknown, stderr: CliWriter): number {
  if (error instanceof UsageError) {
    stderr.write(`gitomic: ${error.message}\n`)
    return USAGE_ERROR
  }
  if (error instanceof EditDoesNotApply) {
    stderr.write(formatEditDoesNotApply(error))
    return PRECONDITION_REFUSED
  }
  if (error instanceof CandidateRefused) {
    stderr.write(`${error.message}\ncode=${error.code} base=${error.base} reasons=${JSON.stringify(error.reasons)}\n`)
    return CANDIDATE_REFUSED
  }
  stderr.write(`gitomic: ${describeFailure(error)}\n`)
  return RUNTIME_ERROR
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
