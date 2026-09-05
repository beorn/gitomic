#!/usr/bin/env node
import { readFile } from "node:fs/promises"

import { type Address, parseAddress } from "./address.js"
import {
  apply,
  EditDoesNotApply,
  matchGlob,
  open,
  openReader,
  type Edit,
  type GitomicBackend,
  type Oid,
  type OpenOptions,
  type OpenReaderOptions,
  type Reader,
  type Snapshot,
  type Store,
} from "./index.js"
import { decodeUtf8 } from "./utf8.js"

/**
 * `gitomic` — the file-level door: read and write a Git ref by address, with
 * no checkout, from anywhere. See README.md for the library this fronts.
 *
 * Grammar: `gitomic <verb> <repo>#<ref> [args] [flags]`. The address is
 * `parseAddress`'s `<repo>#<ref>` (ref defaults to `main` with no `#`).
 *
 * Read verbs (openReader, an immutable snapshot pinned at `--at` or the tip):
 * - `read <addr> <path> [--at <oid>]` — print the path's exact content to stdout.
 * - `ls <addr> [<prefix-or-glob>] [--at <oid>]` — print matching paths, one per line.
 * - `grep <addr> [--at <oid>] <pattern> [<glob>]` — print `path:line` for every
 *   line in every matching path whose content matches the (JS) regex `pattern`.
 *   A path that is not valid UTF-8 is skipped with a note on stderr rather than
 *   failing the whole scan.
 *
 * Write verbs (open + apply, one commit per invocation):
 * - `write <addr> -m <message> [--writer <label>] [--expect <path>=<oid>]... <path>=<file>...`
 *   — one `put` edit per `<path>=<file>` pair, `<file>` read from the local
 *   filesystem (`-` reads stdin). A path with no matching `--expect` is a
 *   CREATE (refuses if the path already exists) — there is no unconditional
 *   overwrite in U1. `<oid>` is the git BLOB oid `ls`/a prior write's own
 *   commit reports, never a raw hash of the file's bytes.
 * - `rm <addr> -m <message> [--writer <label>] [--expect <path>=<oid>]... <path>...`
 *   — one `rm` edit per path. A path with no matching `--expect` reads its OWN
 *   current oid the moment the command starts and uses that as the
 *   precondition — still race-safe, because `apply`'s CAS replay re-checks
 *   that same precondition against whatever tree the commit actually attempts.
 * - `mv <addr> -m <message> [--writer <label>] <from> <to>` — one `mv` edit;
 *   the source's current oid is read the same way `rm`'s default is, and the
 *   destination must be absent (the library's own `mv` precondition — no flag
 *   for it).
 *
 * Every write verb prints the landed commit oid to stdout on success. Product
 * output (content, paths, matches, commit oid) goes to stdout; narration and
 * errors go to stderr.
 *
 * Exit codes: `0` success, `1` a read or backend failure (not-found, invalid
 * UTF-8, exhausted retries — the subject names itself in the message), `2` a
 * usage error (unknown verb, a missing or malformed argument or flag, a bad
 * address), `3` a CAS precondition refusal ({@link EditDoesNotApply}), reported
 * as facts only on stderr — never an owner, role, or remediation.
 *
 * Deliberately not built here (need new grammar or library plumbing this CLI
 * does not add): the general multi-edit-kind `apply` verb, `log`, `diff`,
 * `read --log`, `commit <checkout>`.
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
    switch (verb) {
      case "read":
        return await runRead(args, stdout, backend)
      case "ls":
        return await runLs(args, stdout, backend)
      case "grep":
        return await runGrep(args, stdout, stderr, backend)
      case "write":
        return await runWrite(args, stdin, stdout, backend)
      case "rm":
        return await runRm(args, stdout, backend)
      case "mv":
        return await runMv(args, stdout, backend)
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

const VERBS = ["read", "ls", "grep", "write", "rm", "mv"] as const

const OK = 0
const RUNTIME_ERROR = 1
const USAGE_ERROR = 2
const PRECONDITION_REFUSED = 3

// --- read verbs --------------------------------------------------------

async function runRead(args: string[], stdout: CliWriter, backend: GitomicBackend | undefined): Promise<number> {
  const { positionals, flags } = extractFlags(args, { "--at": "value" })
  const address = requirePositional(positionals, 0, "<address>")
  const path = requirePositional(positionals, 1, "<path>")
  const at: Oid | undefined = optionalStringFlag(flags, "--at")
  const reader = await openReaderFor(address, backend)
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
  const reader = await openReaderFor(address, backend)
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
  const reader = await openReaderFor(address, backend)
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
  backend: GitomicBackend | undefined,
): Promise<number> {
  const { positionals, flags, repeated } = extractFlags(args, {
    "-m": "value",
    "--writer": "value",
    "--expect": "repeated",
  })
  const address = requirePositional(positionals, 0, "<address>")
  const message = requireStringFlag(flags, "-m", "-m <message>")
  const writer = optionalStringFlag(flags, "--writer")
  const pairs = parsePathFilePairs(positionals.slice(1))
  const expect = parseExpectPairs(repeated.get("--expect") ?? [])
  assertExpectTargetsKnown(expect, new Set(pairs.map((pair) => pair.path)), "written")

  const edits: Edit[] = []
  for (const { path, file } of pairs) {
    const content = file === "-" ? await readStdin(stdin) : await readFileContent(file)
    edits.push({ kind: "put", path, content, expect: expect.get(path) ?? null })
  }

  const store = await openStoreFor(address, backend, writer)
  const base = await store.head()
  const committed = await apply(store, base, edits, message)
  stdout.write(`${committed.oid}\n`)
  return OK
}

async function runRm(args: string[], stdout: CliWriter, backend: GitomicBackend | undefined): Promise<number> {
  const { positionals, flags, repeated } = extractFlags(args, {
    "-m": "value",
    "--writer": "value",
    "--expect": "repeated",
  })
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
  assertExpectTargetsKnown(expect, seen, "removed")

  const store = await openStoreFor(address, backend, writer)
  const base = await store.head()
  const snapshot = store.at(base)
  const edits: Edit[] = []
  for (const path of paths) {
    const anchor = expect.get(path) ?? (await snapshot.oid(path))
    if (anchor === undefined) throw new Error(`path not found, cannot remove: ${JSON.stringify(path)} at ${address}`)
    edits.push({ kind: "rm", path, expect: anchor })
  }
  const committed = await apply(store, base, edits, message)
  stdout.write(`${committed.oid}\n`)
  return OK
}

async function runMv(args: string[], stdout: CliWriter, backend: GitomicBackend | undefined): Promise<number> {
  const { positionals, flags } = extractFlags(args, { "-m": "value", "--writer": "value" })
  const address = requirePositional(positionals, 0, "<address>")
  const from = requirePositional(positionals, 1, "<from>")
  const to = requirePositional(positionals, 2, "<to>")
  const message = requireStringFlag(flags, "-m", "-m <message>")
  const writer = optionalStringFlag(flags, "--writer")

  const store = await openStoreFor(address, backend, writer)
  const base = await store.head()
  const expect = await store.at(base).oid(from)
  if (expect === undefined) throw new Error(`source path not found: ${JSON.stringify(from)} at ${address}`)
  const committed = await apply(store, base, [{ kind: "mv", from, to, expect }], message)
  stdout.write(`${committed.oid}\n`)
  return OK
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

/** A `--expect` naming a path this invocation is not touching is a usage mistake, not a silent no-op. */
function assertExpectTargetsKnown(
  expect: ReadonlyMap<string, Oid>,
  knownPaths: ReadonlySet<string>,
  action: string,
): void {
  for (const path of expect.keys()) {
    if (!knownPaths.has(path)) throw new UsageError(`--expect names a path not being ${action}: ${path}`)
  }
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

// --- opening the address ---------------------------------------------------

async function openReaderFor(address: string, backend: GitomicBackend | undefined): Promise<Reader> {
  const { repo, ref } = parseAddressOrUsageError(address)
  const options: OpenReaderOptions = { repo, ref }
  if (backend !== undefined) options.backend = backend
  return openReader(options)
}

async function openStoreFor(
  address: string,
  backend: GitomicBackend | undefined,
  writer: string | undefined,
): Promise<Store> {
  const { repo, ref } = parseAddressOrUsageError(address)
  const options: OpenOptions = { repo, ref }
  if (backend !== undefined) options.backend = backend
  if (writer !== undefined) options.writer = writer
  return open(options)
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

function reportError(error: unknown, stderr: CliWriter): number {
  if (error instanceof UsageError) {
    stderr.write(`gitomic: ${error.message}\n`)
    return USAGE_ERROR
  }
  if (error instanceof EditDoesNotApply) {
    stderr.write(formatEditDoesNotApply(error))
    return PRECONDITION_REFUSED
  }
  stderr.write(`gitomic: ${error instanceof Error ? error.message : String(error)}\n`)
  return RUNTIME_ERROR
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
