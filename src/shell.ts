import { AsyncLocalStorage } from "node:async_hooks"
import childProcess, { type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { GitTimeout } from "./errors.js"
import {
  assertRefUpdates,
  commitIdents,
  commitMeta,
  commitParents,
  commitTimestamp,
  formatCommitMessage,
  GENESIS_MESSAGE,
  GITOMIC_IDENT,
  INITIAL_TIMESTAMP,
  isZeroOid,
  leaseConflict,
  objectOid,
  parseCommit,
  refUnderPrefix,
  TRANSACTION_SEARCH_LIMIT,
  transactionLookupExceeded,
  transactionMatches,
  validateOid,
} from "./git-object.js"
import { assertGitPrefixMatched, assertRegularBlob, normalizePrefix } from "./path.js"
import type {
  BlobValue,
  CommitInput,
  CommitMeta,
  GitomicBackend,
  Ident,
  Oid,
  PublishResult,
  RefUpdate,
  TreeEntry,
  TreeListing,
} from "./types.js"
import { decodeBlob, decodeUtf8 } from "./utf8.js"

/** The complete output of one native Git command. */
export type GitResult = {
  stdout: Buffer
  stderr: Buffer
  code: number
}

type GitOptions = {
  /** Exact environment base for a shell-backend command. Omit to inherit process.env. */
  baseEnv?: NodeJS.ProcessEnv | undefined
  env?: NodeJS.ProcessEnv
  input?: string | Buffer
  /** Stop the command, and every process it started, after this many milliseconds. */
  timeoutMs?: number
}

/** Options for {@link runGit}. */
export type RunGitOptions = Omit<GitOptions, "baseEnv">

/** One local ref whose named object is absent from the repository. */
export type DanglingRef = Readonly<{ ref: string; oid: string }>

/** A function-local command seam for {@link danglingRefs}. */
export type DanglingRefsOptions = Readonly<{
  run?: (args: readonly string[], options?: RunGitOptions) => Promise<GitResult>
}>

/** One answer to a name supplied to {@link batchCheck}. */
export type BatchCheckResult =
  | Readonly<{ input: string; oid: string; type: "blob" | "tree" | "commit" | "tag" }>
  | Readonly<{ input: string; missing: true }>

/** A function-local command seam and deadline for {@link batchCheck}. */
export type BatchCheckOptions = Readonly<{
  run?: (args: readonly string[], options?: RunGitOptions) => Promise<GitResult>
  timeoutMs?: number
}>

/** Options for {@link createShellBackend}. */
export type ShellBackendOptions = {
  /** Git executable used for every shell-backend command. A bare name resolves through `baseEnv`'s PATH. Defaults to `git`. */
  gitExecutable?: string
  /**
   * Exact base environment for every command this backend spawns. Unlike
   * `runGit(..., { env })`, omitted keys do not fall through to process.env.
   * Gitomic snapshots defined entries at construction and applies its prompt
   * and locale pins last.
   */
  baseEnv?: Readonly<NodeJS.ProcessEnv>
  /**
   * Limit, in milliseconds, for each fetch from and push to a remote. A command
   * past it rejects with `GitTimeout`. Defaults to 20 000.
   */
  remoteTimeoutMs?: number
}

/** The default limit for one fetch or push to a remote. */
export const DEFAULT_REMOTE_TIMEOUT_MS = 20_000
const DANGLING_REF_SCAN_TIMEOUT_MS = 30_000
/** How long a stopped process group gets between SIGTERM and SIGKILL. */
const GROUP_STOP_GRACE_MS = 2_000

const DURABLE_GIT_CONFIG = ["-c", "core.fsync=loose-object,reference", "-c", "core.fsyncMethod=fsync"] as const
const shellExecutable = new AsyncLocalStorage<string>()
const selectedGit = (): string => shellExecutable.getStore() ?? "git"

export function createShellBackend(options: ShellBackendOptions = {}): GitomicBackend {
  return createShellRuntime(options).backend
}

export function createShellRuntime(options: ShellBackendOptions = {}): {
  backend: GitomicBackend
  resolveGitDir(repo: string): Promise<string>
  refStorage(repo: string): Promise<"files" | "native">
  objectFormat(repo: string): Promise<"sha1" | "sha256">
} {
  const executable = options.gitExecutable ?? "git"
  if (executable.trim() === "") throw new TypeError("gitExecutable must name a Git executable")
  const remoteTimeoutMs = normalizeTimeoutMs(options.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS, "remoteTimeoutMs")
  const baseEnv = snapshotEnvironment(options.baseEnv)
  const resolveGitDir = createGitDirResolver(baseEnv)
  const refStorages = new Map<string, Promise<"files" | "native">>()
  const objectFormats = new Map<string, Promise<"sha1" | "sha256">>()
  const genesisByGitDir = new Map<string, Promise<Oid>>()
  const refStorage = async (repo: string): Promise<"files" | "native"> =>
    resolveRefStorage(await resolveGitDir(repo), refStorages, baseEnv)
  const objectFormat = async (repo: string): Promise<"sha1" | "sha256"> => {
    const gitdir = await resolveGitDir(repo)
    let format = objectFormats.get(gitdir)
    if (format === undefined) {
      format = git(gitdir, ["rev-parse", "--show-object-format=storage"], { baseEnv }).then((output) => {
        const value = text(output)
        if (value !== "sha1" && value !== "sha256") {
          throw new Error(`unsupported Git object format: ${JSON.stringify(value)}`)
        }
        return value
      })
      objectFormats.set(gitdir, format)
    }
    try {
      return await format
    } catch (error) {
      objectFormats.delete(gitdir)
      throw error
    }
  }
  const backend: GitomicBackend = {
    head: async (repo, ref) => head(await resolveGitDir(repo), ref, baseEnv),
    readCommit: async (repo, oid) => {
      validateOid(oid)
      const output = await git(await resolveGitDir(repo), ["cat-file", "--batch"], {
        baseEnv,
        input: `${oid}\n`,
      })
      const newline = output.indexOf(0x0a)
      const header = output.toString("utf8", 0, newline < 0 ? output.length : newline)
      const match = /^([0-9a-f]+) commit (\d+)$/.exec(header)
      const size = match === null ? NaN : Number(match[2])
      if (
        match?.[1] !== oid ||
        !Number.isSafeInteger(size) ||
        output.length !== newline + size + 2 ||
        output.at(-1) !== 0x0a
      ) {
        throw new Error(
          `cannot read commit ${oid} in ${JSON.stringify(repo)}: unexpected cat-file result ${JSON.stringify(header)}`,
        )
      }
      return parseCommit(oid, output.subarray(newline + 1, newline + 1 + size))
    },
    readTree: async (repo, commit, prefix) => readTree(await resolveGitDir(repo), commit, prefix, baseEnv),
    readBlobs: async (repo, oids) => readBlobs(await resolveGitDir(repo), oids, baseEnv),
    // A completed commit is unreferenced until the compare-and-swap below adopts
    // it. Gitomic writes NO ref to protect that window: Git's default gc grace
    // (`gc.pruneExpire = 2.weeks.ago`) already covers a gap that is milliseconds
    // wide, and a hidden reachability ref is a durable trace the caller did not
    // ask for.
    //
    // RESIDUAL RISK — deliberately accepted, and stated in the README so it does
    // not become an invisible assumption: a repository configured with an
    // aggressive `gc.pruneExpire`, or anyone running `git gc --prune=now` /
    // `git prune --expire=now` CONCURRENTLY with a transaction, can reclaim the
    // commit inside that window. The publish then fails loudly on the missing
    // object instead of moving the ref (see the pruned-mid-flight test in
    // tests/concurrency.test.ts). To close the hole rather than accept it, a
    // reachability ref belongs here — and the README claim must change with it.
    writeCommit: async (repo, input) => writeCommit(await resolveGitDir(repo), input, baseEnv),
    compareAndSwap: async (repo, ref, next, expected) =>
      compareAndSwap(await resolveGitDir(repo), ref, next, expected, baseEnv),
    findTransaction: async (repo, tip, base, instance, seq) =>
      findTransaction(await resolveGitDir(repo), tip, base, instance, seq, baseEnv),
    fetchRemote: async (repo, ref, remote) =>
      fetchRemote(await resolveGitDir(repo), ref, remote, remoteTimeoutMs, baseEnv),
    listRefs: async (repo, prefix, remote) =>
      listRefs(await resolveGitDir(repo), prefix, remote, remoteTimeoutMs, baseEnv),
    readHistory: async (repo, tips, historyOptions) =>
      readHistory(await resolveGitDir(repo), tips, historyOptions, baseEnv),
    writeGenesis: async (repo) => {
      const gitdir = await resolveGitDir(repo)
      let genesis = genesisByGitDir.get(gitdir)
      if (genesis === undefined) {
        genesis = writeGenesis(gitdir, await objectFormat(repo), baseEnv)
        genesisByGitDir.set(gitdir, genesis)
      }
      try {
        return await genesis
      } catch (error) {
        genesisByGitDir.delete(gitdir)
        throw error
      }
    },
    compareAndSwapRemote: async (repo, ref, next, expected, remote) =>
      compareAndSwapRemote(await resolveGitDir(repo), ref, next, expected, remote, remoteTimeoutMs, baseEnv),
    publish: async (repo, updates, remote) =>
      remote === undefined
        ? publishLocal(await resolveGitDir(repo), assertRefUpdates(updates), baseEnv)
        : publishRemote(await resolveGitDir(repo), assertRefUpdates(updates), remote, remoteTimeoutMs, baseEnv),
    fetchRefs: async (repo, refs, remote) =>
      fetchRefs(await resolveGitDir(repo), refs, remote, remoteTimeoutMs, baseEnv),
  }
  // Each backend owns its executable even when two backends run concurrently.
  // Keeping the selection in the async call chain lets the Git plumbing below
  // use one runner without adding an executable argument to every operation.
  const inRuntime = <T>(work: () => Promise<T>): Promise<T> => shellExecutable.run(executable, work)
  const selectedBackend = Object.fromEntries(
    Object.entries(backend).map(([name, operation]) => {
      const invoke = (operation as (...args: unknown[]) => Promise<unknown>).bind(backend)
      return [name, (...args: unknown[]) => inRuntime(() => invoke(...args))]
    }),
  ) as GitomicBackend
  return {
    backend: selectedBackend,
    resolveGitDir: (repo) => inRuntime(() => resolveGitDir(repo)),
    refStorage: (repo) => inRuntime(() => refStorage(repo)),
    objectFormat: (repo) => inRuntime(() => objectFormat(repo)),
  }
}

async function optionalRef(repo: string, ref: string, baseEnv?: NodeJS.ProcessEnv): Promise<Oid | undefined> {
  const result = await run(selectedGit(), gitArgs(repo, ["rev-parse", "--verify", "--quiet", ref]), { baseEnv })
  if (result.code === 1 && result.stdout.length === 0) return undefined
  if (result.code !== 0) {
    const detail = result.stderr.toString("utf8").trim()
    throw new Error(`cannot inspect ref ${ref}${detail ? `: ${detail}` : ""}`)
  }
  return validateOid(text(result.stdout), `ref ${ref} points to an invalid Git object id`)
}

/**
 * Run one native Git command and collect its output. The one bounded runner in
 * Gitomic: with `timeoutMs`, the command leads its own process group, and past
 * the limit the whole group gets SIGTERM, then SIGKILL after a grace period, and
 * the call rejects with {@link GitTimeout}. A command that exits inside the limit
 * resolves by the limit even when a helper it started still holds its output.
 * A non-zero exit resolves with its code; the caller decides what that means.
 */
export async function runGit(args: readonly string[], options: RunGitOptions = {}): Promise<GitResult> {
  return run("git", args, options)
}

/**
 * Run one command that is not Git through the same bounded runner: with `timeoutMs` it leads its own process group,
 * and past the limit the group is stopped and the call rejects with {@link GitTimeout}. For a repository's declared
 * candidate commands, which must never hang a writer.
 */
export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<GitResult> {
  return run(command, args, options)
}

/** Git's stable C-locale texts for a fetch stopped by a locally dangling ref. */
export function isMissingObjectFetchError(detail: string): boolean {
  return /\bbad object refs\/|did not send all necessary objects/u.test(detail)
}

class BatchCheckCountError extends Error {
  constructor(
    readonly answered: number,
    readonly requested: number,
    repository: string,
  ) {
    super(`git cat-file --batch-check answered ${answered} lines for ${requested} names in ${repository}`)
  }
}

/** Check object names in order with one Git process; missing or malformed answers never disappear. */
export async function batchCheck(
  repository: string,
  names: readonly string[],
  options: BatchCheckOptions = {},
): Promise<readonly BatchCheckResult[]> {
  if (names.length === 0) return []
  for (const name of names) {
    if (name.length === 0 || name.includes("\n") || name.includes("\r")) {
      throw new TypeError(
        `git cat-file --batch-check received an invalid name in ${repository}: ${JSON.stringify(name)}`,
      )
    }
  }
  const args = ["-C", resolve(repository), "cat-file", "--batch-check=%(objectname) %(objecttype)"]
  const checked = await (options.run ?? runGit)(args, {
    input: `${names.join("\n")}\n`,
    timeoutMs: options.timeoutMs ?? DANGLING_REF_SCAN_TIMEOUT_MS,
  })
  if (checked.code !== 0) throw commandFailure(repository, args, checked)
  const output = checked.stdout.toString("utf8")
  if (output !== "" && !output.endsWith("\n")) {
    throw new Error(`git cat-file --batch-check returned an unterminated answer in ${repository}`)
  }
  const answers = output === "" ? [] : output.slice(0, -1).split("\n")
  if (answers.length !== names.length) throw new BatchCheckCountError(answers.length, names.length, repository)
  return answers.map((answer, index) => {
    const input = names[index]
    if (input === undefined) throw new BatchCheckCountError(answers.length, names.length, repository)
    if (answer === `${input} missing`) return { input, missing: true }
    const present = /^([0-9a-f]{40}|[0-9a-f]{64}) (blob|tree|commit|tag)$/u.exec(answer)
    if (present?.[1] && present[2]) {
      return { input, oid: present[1], type: present[2] as "blob" | "tree" | "commit" | "tag" }
    }
    throw new Error(
      `git cat-file --batch-check returned a malformed answer in ${repository}: ${JSON.stringify(answer)}`,
    )
  })
}

/**
 * Every local ref whose named object is missing, from one explicit-format ref
 * listing and one ordered cat-file batch. A failed scan throws and never reads
 * as an empty result.
 */
export async function danglingRefs(
  repository: string,
  options: DanglingRefsOptions = {},
): Promise<readonly DanglingRef[]> {
  const invoke = options.run ?? runGit
  const at = ["-C", resolve(repository)] as const
  const listArgs = [...at, "for-each-ref", "--format=%(objectname) %(refname)"]
  const listed = await invoke(listArgs, { timeoutMs: DANGLING_REF_SCAN_TIMEOUT_MS })
  if (listed.code !== 0) throw commandFailure(repository, listArgs, listed)
  const refs = listed.stdout
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(" ")
      if (space <= 0 || space === line.length - 1) {
        throw new Error(`git for-each-ref returned a malformed row in ${repository}: ${JSON.stringify(line)}`)
      }
      return {
        oid: validateOid(line.slice(0, space), "git for-each-ref returned a malformed id"),
        ref: line.slice(space + 1),
      }
    })
  if (refs.length === 0) return []
  let answers: readonly BatchCheckResult[]
  try {
    answers = await batchCheck(
      repository,
      refs.map(({ oid }) => oid),
      { run: invoke, timeoutMs: DANGLING_REF_SCAN_TIMEOUT_MS },
    )
  } catch (error) {
    if (error instanceof BatchCheckCountError) {
      throw new Error(
        `git cat-file --batch-check answered ${error.answered} lines for ${refs.length} refs in ${repository}`,
      )
    }
    throw error
  }
  return refs.filter((_, index) => {
    const answer = answers[index]
    if (answer === undefined) throw new BatchCheckCountError(answers.length, refs.length, repository)
    return "missing" in answer
  })
}

function commandFailure(repository: string, args: readonly string[], result: GitResult): Error {
  const detail = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim()
  const shown = args[0] === "-C" ? args.slice(2) : args
  return new Error(`git ${shown.join(" ")} failed (${result.code}) in ${repository}${detail ? `: ${detail}` : ""}`)
}

async function run(command: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  const timeoutMs = options.timeoutMs === undefined ? undefined : normalizeTimeoutMs(options.timeoutMs, "timeoutMs")
  // oxlint-disable-next-line promise/param-names -- resolveResult cannot shadow the imported path.resolve.
  return new Promise((resolveResult, reject) => {
    const bounded = timeoutMs !== undefined && process.platform !== "win32"
    const child = childProcess.spawn(command, args, {
      env: { ...(options.baseEnv ?? process.env), ...options.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
      // A bounded command leads its own process group, so the limit reaches
      // the helpers Git starts (ssh, index-pack) and not only Git itself.
      detached: bounded,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    let timedOut = false
    let exitCode: number | null | undefined
    let limit: ReturnType<typeof setTimeout> | undefined
    let escalation: ReturnType<typeof setTimeout> | undefined
    const release = bounded && child.pid !== undefined ? holdGroup(child.pid) : () => {}
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(limit)
      clearTimeout(escalation)
      release()
      finish()
    }
    const result = (code: number | null): GitResult => ({
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      code: code ?? 1,
    })
    // Stops what is left of a bounded command's group and stops reading pipes a
    // helper that left the group could otherwise hold open indefinitely.
    const abandonHelpers = (): void => {
      stopProcess(child, "SIGKILL", bounded)
      child.stdout.destroy()
      child.stderr.destroy()
    }
    if (timeoutMs !== undefined) {
      limit = setTimeout(() => {
        const exited = exitCode
        if (exited !== undefined) {
          // The command finished inside its limit; only a helper it started
          // still holds the output pipes, so the command's own result stands.
          abandonHelpers()
          settle(() => resolveResult(result(exited)))
          return
        }
        timedOut = true
        stopProcess(child, "SIGTERM", bounded)
        escalation = setTimeout(() => stopProcess(child, "SIGKILL", bounded), GROUP_STOP_GRACE_MS)
      }, timeoutMs)
    }
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.once("error", (error) => settle(() => reject(error)))
    // A stopped command settles when its own process exits, not when its pipes close.
    child.once("exit", (code) => {
      exitCode = code
      if (!timedOut) return
      abandonHelpers()
      settle(() => reject(new GitTimeout(describeGitCommand(command, args), timeoutMs ?? 0)))
    })
    child.once("close", (code) => {
      if (timedOut) return
      settle(() => resolveResult(result(code)))
    })
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // A command stopped at its limit closes stdin under a pending write; the
      // limit is then the reported outcome. A command that exits (or closes
      // stdin) without reading all of its input breaks the pipe: its exit code
      // is the result, never the EPIPE. Any other stdin failure is the result.
      if (timedOut || error.code === "EPIPE") return
      settle(() => reject(error))
    })
    child.stdin.end(options.input)
  })
}

function snapshotEnvironment(source: Readonly<NodeJS.ProcessEnv> | undefined): NodeJS.ProcessEnv | undefined {
  if (source === undefined) return undefined
  return Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function normalizeTimeoutMs(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive number of milliseconds`)
  }
  return value
}

/** `git <subcommand>` and what it acts on, without global options such as `--git-dir` or `-c`. */
function describeGitCommand(command: string, args: readonly string[]): string {
  const rest = [...args]
  while (rest.length > 0) {
    const option = rest[0]
    if (option === undefined) throw new Error("git command argument unexpectedly missing")
    if (option === "--git-dir" || option === "-C" || option === "-c") {
      rest.splice(0, 2)
    } else if (option.startsWith("--git-dir=")) {
      rest.splice(0, 1)
    } else {
      break
    }
  }
  const [subcommand, ...operands] = rest
  const target = operands.filter((operand) => !operand.startsWith("-")).join(" ")
  return [command, subcommand, target].filter((part) => part !== undefined && part !== "").join(" ")
}

function stopProcess(child: ChildProcess, signal: NodeJS.Signals, group: boolean): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    if (group) process.kill(-pid, signal)
    else child.kill(signal)
  } catch (error) {
    // ESRCH: the group has already exited, which is the outcome this call wants.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

/**
 * Process groups this process leads right now. A group does not receive the
 * terminal's SIGINT or the SIGTERM sent to this process, so while any is held
 * those signals are forwarded to it; when this process has no other handler
 * for the signal, it is raised again after forwarding so the default exit
 * still happens.
 */
const heldGroups = new Set<number>()
const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const

function forwardSignal(signal: NodeJS.Signals): void {
  for (const pid of heldGroups) {
    try {
      process.kill(-pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  for (const forwarded of forwardedSignals) process.removeListener(forwarded, forwardSignal)
  heldGroups.clear()
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
}

function holdGroup(pid: number): () => void {
  if (heldGroups.size === 0) {
    for (const signal of forwardedSignals) process.on(signal, forwardSignal)
  }
  heldGroups.add(pid)
  return () => {
    heldGroups.delete(pid)
    if (heldGroups.size === 0) {
      for (const signal of forwardedSignals) process.removeListener(signal, forwardSignal)
    }
  }
}

function gitArgs(repo: string, args: readonly string[]): string[] {
  return ["--git-dir", resolve(repo), ...args]
}

function durableGitArgs(repo: string, args: readonly string[]): string[] {
  return gitArgs(repo, [...DURABLE_GIT_CONFIG, ...args])
}

export function createGitDirResolver(baseEnv?: NodeJS.ProcessEnv): (repo: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>()
  let supportedVersion: Promise<void> | undefined
  return (repo) => {
    const locator = resolve(repo)
    let gitdir = cache.get(locator)
    if (gitdir === undefined) {
      supportedVersion ??= requireSupportedGit(baseEnv)
      gitdir = supportedVersion
        .then(async () =>
          run(selectedGit(), ["-C", locator, "rev-parse", "--path-format=absolute", "--git-common-dir"], { baseEnv }),
        )
        .then((result) => {
          if (result.code !== 0) {
            const detail = result.stderr.toString("utf8").trim()
            throw new Error(`cannot resolve git repository at ${JSON.stringify(repo)}${detail ? `: ${detail}` : ""}`)
          }
          return text(result.stdout)
        })
      cache.set(locator, gitdir)
    }
    return gitdir
  }
}

async function requireSupportedGit(baseEnv?: NodeJS.ProcessEnv): Promise<void> {
  const executable = selectedGit()
  let result: GitResult
  try {
    result = await run(executable, ["--version"], { baseEnv })
  } catch (error) {
    throw new Error(`Git executable ${JSON.stringify(executable)} cannot run: ${String(error)}`, { cause: error })
  }
  const output = result.stdout.toString("utf8").trim()
  const match = /^git version (\d+)\.(\d+)(?:[.\s]|$)/.exec(output)
  const major = Number(match?.[1])
  const minor = Number(match?.[2])
  if (result.code !== 0 || match === null || major < 2 || (major === 2 && minor < 36)) {
    const found = output || result.stderr.toString("utf8").trim() || "unknown version"
    throw new Error(
      `Git 2.36 or newer is required for durable object and ref writes; ${JSON.stringify(executable)} reported ${JSON.stringify(found)}. Upgrade Git, then open the store again.`,
    )
  }
}

async function git(repo: string, args: readonly string[], options: GitOptions = {}): Promise<Buffer> {
  const result = await run(selectedGit(), gitArgs(repo, args), options)
  if (result.code !== 0) {
    const detail = result.stderr.toString("utf8").trim()
    throw new Error(`git ${args[0] ?? "command"} failed (${result.code})${detail ? `: ${detail}` : ""}`)
  }
  return result.stdout
}

async function gitWrite(repo: string, args: readonly string[], options: GitOptions = {}): Promise<Buffer> {
  const result = await run(selectedGit(), durableGitArgs(repo, args), options)
  if (result.code !== 0) {
    const detail = result.stderr.toString("utf8").trim()
    throw new Error(`git ${args[0] ?? "command"} failed (${result.code})${detail ? `: ${detail}` : ""}`)
  }
  return result.stdout
}

function text(buffer: Buffer): string {
  return buffer.toString("utf8").trim()
}

async function head(repo: string, ref: string, baseEnv?: NodeJS.ProcessEnv): Promise<Oid> {
  return text(await git(repo, ["rev-parse", "--verify", ref], { baseEnv }))
}

/** One `ls-tree -r`: every regular blob under the prefix, no value read. STATE's 19,670 entries list in ~20 ms. */
async function readTree(repo: string, commit: Oid, prefix?: string, baseEnv?: NodeJS.ProcessEnv): Promise<TreeListing> {
  const normalizedPrefix = prefix === undefined ? "" : normalizePrefix(prefix)
  const listing = await git(repo, ["ls-tree", "-r", "-z", "--full-tree", commit], { baseEnv })
  const entries = new Map<string, TreeEntry>()
  for (const record of decodeUtf8(listing, "Git tree paths").split("\0")) {
    if (!record) continue
    const separator = record.indexOf("\t")
    if (separator < 0) throw new Error("git ls-tree returned a malformed record")
    const metadata = record.slice(0, separator).split(" ")
    const mode = metadata[0]
    const type = metadata[1]
    const oid = metadata[2]
    const path = record.slice(separator + 1)
    if (mode === undefined || type === undefined || oid === undefined) {
      throw new Error("git ls-tree returned malformed entry metadata")
    }
    if (!path.startsWith(normalizedPrefix)) continue
    assertRegularBlob(path, mode, type)
    entries.set(path, { oid, mode: mode === "100755" ? "100755" : "100644" })
  }
  assertGitPrefixMatched(entries.size, repo, commit, normalizedPrefix)
  return entries
}

/** One `cat-file --batch` for the distinct oids; a missing object or a non-blob fails naming the oid. */
async function readBlobs(
  repo: string,
  oids: readonly Oid[],
  baseEnv?: NodeJS.ProcessEnv,
): Promise<ReadonlyMap<Oid, BlobValue>> {
  const distinct = [...new Set(oids)]
  if (distinct.length === 0) return new Map()
  for (const oid of distinct) validateOid(oid, "readBlobs needs valid Git object ids")
  const output = await git(repo, ["cat-file", "--batch"], { baseEnv, input: `${distinct.join("\n")}\n` })
  return parseBatch(distinct, output)
}

function parseBatch(oids: readonly Oid[], output: Buffer): ReadonlyMap<Oid, BlobValue> {
  const blobs = new Map<Oid, BlobValue>()
  let offset = 0
  for (const oid of oids) {
    const newline = output.indexOf(0x0a, offset)
    if (newline < 0) throw new Error("git cat-file --batch returned a truncated header")
    const header = output.toString("utf8", offset, newline)
    if (header === `${oid} missing`) {
      throw new Error(`git cat-file --batch: object ${oid} is missing from the repository`)
    }
    const match = /^([0-9a-f]+) blob ([0-9]+)$/.exec(header)
    if (match === null || match[1] !== oid) {
      throw new Error(`git cat-file --batch returned an unexpected object for ${oid}: ${header}`)
    }
    const size = Number(match[2])
    const start = newline + 1
    const end = start + size
    if (!Number.isSafeInteger(size) || size < 0 || end >= output.length || output[end] !== 0x0a) {
      throw new Error(`git cat-file --batch returned a malformed blob for ${oid}`)
    }
    blobs.set(oid, decodeBlob(output.subarray(start, end)))
    offset = end + 1
  }
  if (offset !== output.length) throw new Error("git cat-file --batch returned trailing data")
  return blobs
}

async function writeCommit(repo: string, input: CommitInput, baseEnv?: NodeJS.ProcessEnv): Promise<Oid> {
  const parents = commitParents(input)
  const idents = commitIdents(input)
  const message = formatCommitMessage(
    input.writer,
    input.instance,
    input.message,
    input.seq,
    input.provenance,
    input.trailers,
  )
  // An unchanged tree needs no index: reuse the first parent's tree. This is
  // the event path (two processes: read the parent, write the commit), and it
  // lands the same object the index path would have built.
  if (input.changes.size === 0) {
    const [tree, parentTime] = text(
      await git(repo, ["show", "-s", "--format=%T%x00%ct", input.parent], { baseEnv }),
    ).split("\0")
    return commitTree(
      repo,
      validateOid(tree, "invalid parent tree id"),
      parents,
      Number(parentTime),
      input.time,
      message,
      idents,
      baseEnv,
    )
  }
  const indexDir = await mkdtemp(join(tmpdir(), "gitomic-index-"))
  const index = join(indexDir, "index")
  const indexEnv = { GIT_INDEX_FILE: index }
  try {
    await gitWrite(repo, ["read-tree", input.parent], { baseEnv, env: indexEnv })
    const changes = [...input.changes]
    const executables = await parentExecutables(repo, indexEnv, changes, baseEnv)
    const blobFiles: string[] = []
    for (const [position, [, content]] of changes.entries()) {
      if (content === undefined) continue
      const blobFile = join(indexDir, `blob-${position}`)
      await writeFile(blobFile, content, "utf8")
      blobFiles.push(blobFile)
    }
    const blobOutput =
      blobFiles.length === 0
        ? ""
        : text(
            await gitWrite(repo, ["hash-object", "-w", "--stdin-paths", "--no-filters"], {
              baseEnv,
              input: `${blobFiles.join("\n")}\n`,
            }),
          )
    const blobs =
      blobOutput === ""
        ? []
        : blobOutput.split("\n").map((oid, position) => validateOid(oid, `invalid blob id at position ${position}`))
    if (blobs.length !== blobFiles.length) {
      throw new Error(`git hash-object returned ${blobs.length} blob ids for ${blobFiles.length} inputs`)
    }
    const zeroOid = "0".repeat(input.parent.length)
    let blobPosition = 0
    const indexInfo: Buffer[] = []
    for (const [path, content] of changes) {
      const oid = content === undefined ? zeroOid : blobs[blobPosition++]
      indexInfo.push(
        Buffer.from(`${content === undefined ? "0" : keptMode(input, path, executables)} ${oid}\t`, "utf8"),
        Buffer.from(path, "utf8"),
        Buffer.from([0]),
      )
    }
    await gitWrite(repo, ["update-index", "--add", "-z", "--index-info"], {
      baseEnv,
      env: indexEnv,
      input: Buffer.concat(indexInfo),
    })
    const tree = text(await gitWrite(repo, ["write-tree"], { baseEnv, env: indexEnv }))
    const parentTime = Number(text(await git(repo, ["show", "-s", "--format=%ct", input.parent], { baseEnv })))
    return await commitTree(repo, tree, parents, parentTime, input.time, message, idents, baseEnv)
  } finally {
    await rm(indexDir, { recursive: true, force: true })
  }
}

/**
 * The 100755 paths of the parent tree the temp index holds, read only when the commit writes content. One
 * `ls-files --stage` (git 2.36 has no NUL-safe per-path mode query); STATE's 19,561 entries list in under 10 ms.
 */
async function parentExecutables(
  repo: string,
  indexEnv: NodeJS.ProcessEnv,
  changes: readonly (readonly [string, string | undefined])[],
  baseEnv?: NodeJS.ProcessEnv,
): Promise<ReadonlySet<string>> {
  const executables = new Set<string>()
  if (!changes.some(([, content]) => content !== undefined)) return executables
  const listing = await git(repo, ["ls-files", "--stage", "-z"], { baseEnv, env: indexEnv })
  for (const record of listing.toString("utf8").split("\0")) {
    if (!record.startsWith("100755 ")) continue
    const tab = record.indexOf("\t")
    if (tab >= 0) executables.add(record.slice(tab + 1))
  }
  return executables
}

/** The mode a changed path keeps: its parent entry's (or its move source's) 100755, else 100644. */
function keptMode(input: CommitInput, path: string, executables: ReadonlySet<string>): "100644" | "100755" {
  return executables.has(input.modeSources?.get(path) ?? path) ? "100755" : "100644"
}

/** Write one commit as the given author and committer, at the store's time and never earlier than its first parent plus one. */
async function commitTree(
  repo: string,
  tree: Oid,
  parents: readonly Oid[],
  parentTime: number,
  time: number,
  message: string,
  idents: { readonly author: Ident; readonly committer: Ident },
  baseEnv?: NodeJS.ProcessEnv,
): Promise<Oid> {
  const timestamp = commitTimestamp(parentTime, time)
  const args = ["commit-tree", tree]
  for (const parent of parents) args.push("-p", parent)
  return text(await gitWrite(repo, args, { baseEnv, env: identityEnv(timestamp, idents), input: message }))
}

/**
 * Explicit identity for one `commit-tree`. It overrides the caller's
 * environment and git config, so gitomic never records an ident it was not
 * handed (hab's GIT_AUTHOR_* included).
 */
function identityEnv(
  timestamp: number,
  { author, committer }: { readonly author: Ident; readonly committer: Ident } = {
    author: GITOMIC_IDENT,
    committer: GITOMIC_IDENT,
  },
): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
    GIT_AUTHOR_DATE: `@${timestamp} +0000`,
    GIT_COMMITTER_DATE: `@${timestamp} +0000`,
  }
}

/**
 * Write the empty root every event chain starts from. The empty tree is one
 * git always has, so this is one `commit-tree`; the same bytes on every run
 * give the same oid, which is what makes it idempotent.
 */
async function writeGenesis(repo: string, format: "sha1" | "sha256", baseEnv?: NodeJS.ProcessEnv): Promise<Oid> {
  const emptyTree = objectOid("tree", Buffer.alloc(0), format)
  return text(
    await gitWrite(repo, ["commit-tree", emptyTree], {
      baseEnv,
      env: identityEnv(INITIAL_TIMESTAMP),
      input: GENESIS_MESSAGE,
    }),
  )
}

/**
 * Every ref under `prefix` and its tip: `for-each-ref` locally, `ls-remote
 * --refs` against a remote. Neither moves a ref. Both are filtered through the
 * same prefix rule, so a remote pattern that git matches by its tail cannot
 * widen the answer.
 */
async function listRefs(
  repo: string,
  prefix: string,
  remote: string | undefined,
  timeoutMs: number,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<ReadonlyMap<string, Oid>> {
  if (typeof prefix !== "string" || !prefix.startsWith("refs/")) {
    throw new TypeError(`listRefs prefix must start with refs/: ${JSON.stringify(prefix)}`)
  }
  const pairs: Array<[string, Oid]> = []
  if (remote === undefined) {
    const output = await git(repo, ["for-each-ref", "--format=%(objectname) %(refname)", prefix], { baseEnv })
    for (const line of decodeUtf8(output, "git for-each-ref").split("\n")) {
      if (line === "") continue
      const space = line.indexOf(" ")
      pairs.push([line.slice(space + 1), validateOid(line.slice(0, space), "git for-each-ref returned a malformed id")])
    }
  } else {
    const patterns = prefix.endsWith("/") ? [`${prefix}*`] : [prefix, `${prefix}/*`]
    const output = await git(repo, ["ls-remote", "--refs", remote, ...patterns], { baseEnv, timeoutMs })
    for (const line of decodeUtf8(output, "git ls-remote").split("\n")) {
      if (line === "") continue
      const tab = line.indexOf("\t")
      pairs.push([line.slice(tab + 1), validateOid(line.slice(0, tab), "git ls-remote returned a malformed id")])
    }
  }
  const matching = pairs.filter(([ref]) => refUnderPrefix(ref, prefix))
  const seen = new Set<string>()
  for (const [ref] of matching) {
    if (seen.has(ref)) throw new Error(`git ref listing returned duplicate ref ${ref}`)
    seen.add(ref)
  }
  return new Map(matching.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/**
 * First-parent history of every tip in ONE process. Records are NUL-separated
 * and the body is never split on lines, so a message holding blank lines or a
 * NUL-free "Key: value" line cannot shift the parse.
 */
/** One `readHistory` record: oid, parents, time, author name and email, committer name and email, body. */
const HISTORY_FIELDS = 8

async function readHistory(
  repo: string,
  tips: readonly Oid[],
  options: { readonly exclude?: readonly Oid[]; readonly limit?: number } = {},
  baseEnv?: NodeJS.ProcessEnv,
): Promise<CommitMeta[]> {
  if (tips.length === 0) return []
  for (const tip of tips) validateOid(tip, "invalid history tip")
  const exclude = (options.exclude ?? []).map((oid) => `^${validateOid(oid, "invalid history exclusion")}`)
  const limit = options.limit === undefined ? [] : [`--max-count=${options.limit}`]
  const output = await git(
    repo,
    [
      "rev-list",
      "--first-parent",
      ...limit,
      "--no-commit-header",
      "--format=%H%x00%P%x00%ct%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00",
      ...tips,
      ...exclude,
    ],
    { baseEnv },
  )
  const fields = decodeUtf8(output, "git rev-list history").split("\0")
  const trailing = fields.pop()
  if (trailing?.trim()) throw new Error("git rev-list returned trailing history data")
  if (fields.length % HISTORY_FIELDS !== 0) throw new Error("git rev-list returned a malformed history record")
  const commits: CommitMeta[] = []
  for (let index = 0; index < fields.length; index += HISTORY_FIELDS) {
    const oid = validateOid(fields[index]?.replace(/^\n/, ""), "git rev-list returned a malformed history id")
    const rawParents = fields[index + 1] ?? ""
    const parents = rawParents === "" ? [] : rawParents.split(" ").map((parent) => validateOid(parent))
    const timestamp = Number(fields[index + 2])
    if (!Number.isSafeInteger(timestamp)) throw new Error(`git rev-list returned an invalid time for ${oid}`)
    const author = { name: fields[index + 3] ?? "", email: fields[index + 4] ?? "" }
    const committer = { name: fields[index + 5] ?? "", email: fields[index + 6] ?? "" }
    commits.push(commitMeta(oid, parents, timestamp, fields[index + 7] ?? "", { author, committer }))
  }
  return commits
}

async function compareAndSwap(
  repo: string,
  ref: string,
  next: Oid,
  expected: Oid,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<boolean> {
  const result = await run(selectedGit(), durableGitArgs(repo, ["update-ref", ref, next, expected]), { baseEnv })
  if (result.code === 0) return true
  const detail = result.stderr.toString("utf8").trim()
  if (isCompareAndSwapRejection(detail) || isTransientRefLockContention(detail)) return false
  throw new Error(`git update-ref failed (${result.code})${detail ? `: ${detail}` : ""}`)
}

async function resolveRefStorage(
  repo: string,
  pending: Map<string, Promise<"files" | "native">>,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<"files" | "native"> {
  let storage = pending.get(repo)
  if (storage === undefined) {
    storage = run(selectedGit(), gitArgs(repo, ["config", "--get", "extensions.refStorage"]), { baseEnv }).then(
      (result) => {
        if (result.code === 1) return "files"
        if (result.code !== 0) {
          const detail = result.stderr.toString("utf8").trim()
          throw new Error(`cannot inspect Git ref storage${detail ? `: ${detail}` : ""}`)
        }
        return text(result.stdout) === "files" ? "files" : "native"
      },
    )
    pending.set(repo, storage)
  }
  try {
    return await storage
  } catch (error) {
    pending.delete(repo)
    throw error
  }
}

async function deleteRef(
  repo: string,
  ref: string,
  oid: Oid,
  failure: string,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<void> {
  const result = await run(selectedGit(), durableGitArgs(repo, ["update-ref", "-d", ref, oid]), { baseEnv })
  if (result.code !== 0) {
    const detail = result.stderr.toString("utf8").trim()
    throw new Error(`${failure}${detail ? `: ${detail}` : ""}`)
  }
}

async function findTransaction(
  repo: string,
  tip: Oid,
  base: Oid,
  instance: string,
  seq: number,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<Oid | undefined> {
  // `^base` is the stop condition: the sought commit is a child of `base`, so
  // one process reads only what arrived after it, however deep the history is.
  const output = await git(
    repo,
    [
      "rev-list",
      "--first-parent",
      `--max-count=${TRANSACTION_SEARCH_LIMIT + 1}`,
      "--no-commit-header",
      "--format=%H%x00%B%x00",
      tip,
      `^${base}`,
    ],
    { baseEnv },
  )
  const commits = parseTransactionHistory(output)
  for (const commit of commits.slice(0, TRANSACTION_SEARCH_LIMIT)) {
    if (transactionMatches(commit.message, instance, seq)) return commit.oid
  }
  if (commits.length > TRANSACTION_SEARCH_LIMIT) {
    throw transactionLookupExceeded(instance, seq)
  }
  return undefined
}

/**
 * One `cannot lock ref` line of git's stderr. `reporter` is the text before it on the same line
 * ("fatal: ", "fatal: prepare: ", "remote: error: ", "git fetch failed (1): error: "), which says
 * which git process refused; `form` is why:
 * - "moved": the ref is at `at`, not the `expected` value its lease named;
 * - "exists": a create found the ref already there;
 * - "missing": the ref is absent although a value was expected;
 * - "held": another writer holds the ref's `.lock` file.
 */
export type RefLockFailure = Readonly<{
  reporter: string
  ref: string
  form: "moved" | "exists" | "missing" | "held"
  at?: string
  expected?: string
}>

const REF_LOCK_FAILURE =
  /^(.*?)cannot lock ref '([^']+)': (?:is at ([0-9a-f]+) but expected ([0-9a-f]+)|(reference already exists)|reference is missing but expected ([0-9a-f]+)|(Unable to create '[^']*\.lock': File exists\.?))\s*$/gm

/** Every `cannot lock ref` line in git's stderr, in order; the one reading of that text in this file. */
export function parseRefLockFailures(text: string): RefLockFailure[] {
  return [...text.matchAll(REF_LOCK_FAILURE)].map((match): RefLockFailure => {
    const [, reporter = "", ref = "", at, expected, exists, missingExpected, held] = match
    if (at !== undefined && expected !== undefined) return { reporter, ref, form: "moved", at, expected }
    if (exists !== undefined) return { reporter, ref, form: "exists" }
    if (missingExpected !== undefined) return { reporter, ref, form: "missing", expected: missingExpected }
    if (held !== undefined) return { reporter, ref, form: "held" }
    throw new Error(`cannot lock ref line matched with no reason: ${match[0]}`)
  })
}

/** Reported by a local update-ref: "fatal: " or "fatal: <phase>: " (update-ref --stdin's prepare/commit). */
function reportedByUpdateRef(failure: RefLockFailure): boolean {
  return /^fatal: (?:\w+: )?$/.test(failure.reporter)
}

function isFullOid(oid: string | undefined): boolean {
  return oid !== undefined && (oid.length === 40 || oid.length === 64)
}

function isCompareAndSwapRejection(detail: string): boolean {
  return parseRefLockFailures(detail).some(({ form }) => form !== "held")
}

function isTransientRefLockContention(detail: string): boolean {
  return parseRefLockFailures(detail).some(({ form }) => form === "held")
}

function parseTransactionHistory(output: Buffer): Array<{ oid: Oid; message: string }> {
  const fields = decodeUtf8(output, "git rev-list transaction history").split("\0")
  const trailing = fields.pop()
  if (trailing?.trim()) throw new Error("git rev-list returned trailing transaction data")
  if (fields.length % 2 !== 0) throw new Error("git rev-list returned a malformed transaction record")

  const commits: Array<{ oid: Oid; message: string }> = []
  for (let index = 0; index < fields.length; index += 2) {
    const rawOid = fields[index]?.replace(/^\n/, "")
    const message = fields[index + 1]
    if (rawOid === undefined || message === undefined) {
      throw new Error("git rev-list returned a malformed transaction record")
    }
    const oid = validateOid(rawOid, "git rev-list returned a malformed transaction object id")
    commits.push({ oid, message })
  }
  return commits
}

async function fetchRemote(
  repo: string,
  ref: string,
  remote: string,
  timeoutMs: number,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<Oid> {
  const scratch = `refs/gitomic/fetch/${randomUUID()}`
  let fetched: Oid | undefined
  try {
    await gitWrite(repo, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, `${ref}:${scratch}`], {
      baseEnv,
      timeoutMs,
    })
    fetched = await head(repo, scratch, baseEnv)
    return fetched
  } finally {
    const temporary = fetched ?? (await optionalRef(repo, scratch, baseEnv))
    if (temporary !== undefined) {
      await deleteRef(repo, scratch, temporary, `cannot release temporary fetch ref ${scratch}`, baseEnv)
    }
  }
}

async function compareAndSwapRemote(
  repo: string,
  ref: string,
  next: Oid,
  expected: Oid,
  remote: string,
  timeoutMs: number,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<boolean> {
  let result: GitResult
  try {
    result = await run(
      selectedGit(),
      durableGitArgs(repo, ["push", "--porcelain", `--force-with-lease=${ref}:${expected}`, remote, `${next}:${ref}`]),
      { baseEnv, timeoutMs },
    )
  } catch (error) {
    throw remoteWriteOutcomeUnknown([{ ref, expect: expected }], error)
  }
  if (result.code !== 0) {
    const detail = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`.trim()
    if (isRemoteCompareAndSwapRejection(detail)) return false
    throw new Error(`git push failed (${result.code})${detail ? `: ${detail}` : ""}`)
  }
  // Keep the local cache in step. A ref created by this push may not exist
  // locally yet: an all-zero expected then means "absent here too".
  const local = await optionalRef(repo, ref, baseEnv)
  if (local === expected || (local === undefined && isZeroOid(expected))) {
    await compareAndSwap(repo, ref, next, expected, baseEnv)
  }
  return true
}

/** A lease lost between the read and the re-run, as update-ref reports it. */
function lostAt(detail: string): RefLockFailure | undefined {
  return parseRefLockFailures(detail).find(
    (failure) =>
      failure.form === "moved" && reportedByUpdateRef(failure) && isFullOid(failure.at) && isFullOid(failure.expected),
  )
}

/** Another writer holds this ref's lock, as update-ref reports it. */
function lockHeldBy(detail: string): RefLockFailure | undefined {
  return parseRefLockFailures(detail).find((failure) => failure.form === "held" && reportedByUpdateRef(failure))
}

function outcomesOf(updates: readonly RefUpdate[], unchanged: ReadonlySet<string>): PublishResult {
  return {
    outcomes: updates.map(({ ref, expect, oid }) => ({
      ref,
      outcome:
        oid === null
          ? ("deleted" as const)
          : unchanged.has(ref) || expect === oid
            ? ("unchanged" as const)
            : ("updated" as const),
    })),
  }
}

/**
 * MULTI, locally: ONE `update-ref --stdin` transaction. Git checks every lease
 * under the ref locks before committing any of them, so either every ref moves
 * or none does.
 *
 * On ANY failure, the error text decides nothing, with one exception: a lock
 * held by another writer is a Conflict on that ref, observed "locked", so a
 * chain race retries as contention should. Otherwise ONE `for-each-ref` reads
 * every ref in the transaction, and each is classified from that structured
 * output:
 * - at oid: `verify <ref> <oid>` (unchanged);
 * - at expect, or absent for a create: keep `update`;
 * - a delete keeps its `delete` line only at expect;
 * - at neither: Conflict naming the ref, expect and observed value, with no
 *   re-run.
 * With no Conflict, the whole transaction runs ONCE more with the rewritten
 * lines, and its failure is final. That is one process on success and at most
 * three on failure.
 */
async function publishLocal(
  repo: string,
  updates: readonly RefUpdate[],
  baseEnv?: NodeJS.ProcessEnv,
): Promise<PublishResult> {
  const attempt = (unchanged: ReadonlySet<string>) =>
    run(selectedGit(), durableGitArgs(repo, ["update-ref", "--stdin"]), {
      baseEnv,
      input: [
        "start",
        ...updates.map(({ ref, expect, oid }) =>
          oid === null
            ? `delete ${ref} ${expect}`
            : unchanged.has(ref)
              ? `verify ${ref} ${oid}`
              : `update ${ref} ${oid} ${expect}`,
        ),
        "prepare",
        "commit",
        "",
      ].join("\n"),
    })
  const lockHeld = (detail: string) => {
    const held = lockHeldBy(detail)
    if (held === undefined) return undefined
    const ref = held.ref
    const update = updates.find((candidate) => candidate.ref === ref)
    if (update === undefined) return undefined
    return leaseConflict([{ ref, expect: update.expect, observed: "locked" }])
  }
  const failed = (code: number | null, detail: string) =>
    new Error(`git update-ref --stdin failed (${code})${detail ? `: ${detail}` : ""}`)

  const first = await attempt(new Set())
  if (first.code === 0) return outcomesOf(updates, new Set())
  const firstDetail = first.stderr.toString("utf8").trim()
  const firstHeld = lockHeld(firstDetail)
  if (firstHeld !== undefined) throw firstHeld

  const current = await readExactRefs(
    repo,
    updates.map(({ ref }) => ref),
    baseEnv,
  )
  const lost = updates
    .map(({ ref, expect, oid }) => ({ ref, expect, oid, tip: current.get(ref) }))
    .filter(({ expect, oid, tip }) =>
      oid === null ? tip !== expect : tip !== oid && (isZeroOid(expect) ? tip !== undefined : tip !== expect),
    )
  if (lost.length > 0) {
    throw leaseConflict(lost.map(({ ref, expect, tip }) => ({ ref, expect, observed: tip ?? "absent" })))
  }
  const unchanged = new Set(updates.filter(({ ref, oid }) => current.get(ref) === oid).map(({ ref }) => ref))

  const second = await attempt(unchanged)
  if (second.code === 0) return outcomesOf(updates, unchanged)
  const secondDetail = second.stderr.toString("utf8").trim()
  const held = lockHeld(secondDetail)
  if (held !== undefined) throw held
  // A rival moved a ref between the read and the re-run: final, and a Conflict.
  const movedAgain = lostAt(secondDetail)
  const movedUpdate = movedAgain === undefined ? undefined : updates.find(({ ref }) => ref === movedAgain.ref)
  if (movedAgain?.at !== undefined && movedUpdate !== undefined) {
    throw leaseConflict([{ ref: movedUpdate.ref, expect: movedUpdate.expect, observed: movedAgain.at }])
  }
  throw failed(second.code, secondDetail)
}

/** Exactly these refs and their tips, in ONE `for-each-ref`; an absent ref is simply missing. */
async function readExactRefs(
  repo: string,
  refs: readonly string[],
  baseEnv?: NodeJS.ProcessEnv,
): Promise<ReadonlyMap<string, Oid>> {
  const output = await git(repo, ["for-each-ref", "--format=%(objectname) %(refname)", ...refs], { baseEnv })
  const wanted = new Set(refs)
  const tips = new Map<string, Oid>()
  for (const line of decodeUtf8(output, "git for-each-ref").split("\n")) {
    if (line === "") continue
    const space = line.indexOf(" ")
    const ref = line.slice(space + 1)
    // A pattern also matches refs below it; keep only the exact names asked for.
    if (wanted.has(ref)) tips.set(ref, validateOid(line.slice(0, space), "git for-each-ref returned a malformed id"))
  }
  return tips
}

function isStaleLease(summary: string): boolean {
  return summary === "[rejected] (stale info)" || summary === "[remote rejected] (incorrect old value provided)"
}

/** GitHub can put receive-pack's exact lost lease in the porcelain row, not stderr. */
function porcelainLostLease(summary: string, ref: string, expect: Oid): Oid | undefined {
  const match =
    /^\[remote rejected\] \(cannot lock ref '([^']+)': is at ([0-9a-f]{40}|[0-9a-f]{64}) but expected ([0-9a-f]{40}|[0-9a-f]{64})\)$/u.exec(
      summary,
    )
  return match?.[1] === ref && match[3] === expect ? match[2] : undefined
}

/** The refs receive-pack reports it could not lock because their value was not the lease's. */
function remoteLostLeases(stderr: string): ReadonlySet<string> {
  return new Set(
    parseRefLockFailures(stderr)
      .filter(({ reporter, form }) => reporter === "remote: error: " && form !== "held")
      .map(({ ref }) => ref),
  )
}

/**
 * MULTI, remotely: ONE `push --atomic`, a lease per ref, exactly as git does it:
 * no pre-read, and no local ref touched (in remote mode reads go through
 * {@link fetchRefs}, so no local ref is a cache of the remote). Porcelain names
 * each ref's fate: "=" unchanged; "*", " " and "+" updated; "-" deleted;
 * "[rejected] (stale info)" a lost lease, a missing ref's delete included. git
 * does not report the tip it saw, so a lost lease costs ONE `ls-remote` of the
 * lost refs to name it; that read comes after git's decision, never instead of
 * it. Anything that is not a per-ref rejection (network, auth, a missing
 * remote) is an Error with git's text.
 */
async function publishRemote(
  repo: string,
  updates: readonly RefUpdate[],
  remote: string,
  timeoutMs: number,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<PublishResult> {
  const args = [
    "push",
    "--atomic",
    "--porcelain",
    ...updates.map(({ ref, expect }) => `--force-with-lease=${ref}:${expect}`),
    remote,
    ...updates.map(({ ref, oid }) => (oid === null ? `:${ref}` : `${oid}:${ref}`)),
  ]
  let result: GitResult
  try {
    result = await run(selectedGit(), durableGitArgs(repo, args), { baseEnv, timeoutMs })
  } catch (error) {
    throw remoteWriteOutcomeUnknown(updates, error)
  }
  const detail = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`.trim()
  const fates = new Map<string, { flag: string; summary: string }>()
  for (const line of result.stdout.toString("utf8").split("\n")) {
    const [flag, spec, summary] = line.split("\t")
    if (flag === undefined || spec === undefined || flag.length !== 1) continue
    fates.set(spec.slice(spec.indexOf(":") + 1), { flag, summary: summary ?? "" })
  }
  if (result.code !== 0) {
    const lostInReceivePack = remoteLostLeases(result.stderr.toString("utf8"))
    const porcelainLost = new Map(
      updates.flatMap(({ ref, expect }) => {
        const actual = porcelainLostLease(fates.get(ref)?.summary ?? "", ref, expect)
        return actual === undefined ? [] : [[ref, actual] as const]
      }),
    )
    const rejected = [...fates.values()].filter(({ flag }) => flag === "!")
    // A rival that moved a ref after the remote advertised it loses the lease
    // inside receive-pack: git names that ref on stderr and, being atomic,
    // rejects every row as "(atomic transaction failed)". Nothing landed.
    const atomicLeaseLoss =
      rejected.length > 0 &&
      rejected.every(
        ({ summary }) =>
          summary === "[remote rejected] (atomic transaction failed)" ||
          isStaleLease(summary) ||
          updates.some(({ ref }) => porcelainLost.has(ref) && fates.get(ref)?.summary === summary),
      )
    const stale = updates.filter(({ ref }) => {
      const fate = fates.get(ref)
      return (
        fate?.flag === "!" &&
        (isStaleLease(fate.summary) || porcelainLost.has(ref) || (atomicLeaseLoss && lostInReceivePack.has(ref)))
      )
    })
    if (stale.length === 0) throw new Error(`git push failed (${result.code})${detail ? `: ${detail}` : ""}`)
    const observed = await observeRemote(
      repo,
      remote,
      stale.map(({ ref }) => ref),
      timeoutMs,
      baseEnv,
    )
    for (const { ref } of stale) {
      const reported = porcelainLost.get(ref)
      if (reported !== undefined && observed(ref) !== reported) {
        throw new Error(
          `git push reported ${ref} at ${reported}, but a fresh remote read found ${observed(ref)}; cannot prove the rejected lease: ${detail}`,
        )
      }
    }
    throw leaseConflict(stale.map(({ ref, expect }) => ({ ref, expect, observed: observed(ref) })))
  }
  return {
    outcomes: updates.map(({ ref, oid }) => {
      const flag = fates.get(ref)?.flag
      if (oid === null) {
        if (flag === "-") return { ref, outcome: "deleted" as const }
        throw new Error(`git push succeeded without reporting ${ref} as deleted: ${detail}`)
      }
      if (flag === "=") return { ref, outcome: "unchanged" as const }
      if (flag === "*" || flag === " " || flag === "+") return { ref, outcome: "updated" as const }
      throw new Error(`git push succeeded without reporting ${ref} as updated or up to date: ${detail}`)
    }),
  }
}

/**
 * What the remote holds at these refs, read by ONE `ls-remote` after git refused
 * their leases, for the Conflict message only: "absent" for a missing ref. A read
 * that fails says so in the observed value; git's refusal stands either way.
 *
 * Caveat: the observed value is what the remote held when read, after the
 * refusal, so a fast rival can make it differ from the tip that caused the
 * refusal.
 */
async function observeRemote(
  repo: string,
  remote: string,
  refs: readonly string[],
  timeoutMs: number,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<(ref: string) => string> {
  const result = await run(selectedGit(), durableGitArgs(repo, ["ls-remote", remote, ...refs]), { baseEnv, timeoutMs })
  if (result.code !== 0) {
    const reason = `unread: git ls-remote failed (${result.code}): ${result.stderr.toString("utf8").trim()}`
    return () => reason
  }
  const tips = new Map<string, string>()
  for (const line of result.stdout.toString("utf8").split("\n")) {
    const [oid, name] = line.split("\t")
    // A pattern also matches refs ending in it; keep only the exact names asked for.
    if (oid !== undefined && name !== undefined && refs.includes(name)) tips.set(name, oid)
  }
  return (ref) => tips.get(ref) ?? "absent"
}

function remoteWriteOutcomeUnknown(updates: readonly Pick<RefUpdate, "ref" | "expect">[], cause: unknown): Error {
  const leases = updates.map(({ ref, expect }) => `${ref} expected ${expect}`).join("; ")
  return new Error(
    `remote write outcome is unknown for ${leases}; inspect the remote refs at their expected object ids before retrying`,
    { cause },
  )
}

async function diagnoseMissingObjectFetch(
  repo: string,
  remote: string,
  original: unknown,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<never> {
  const message = original instanceof Error ? original.message : String(original)
  if (!isMissingObjectFetchError(message)) throw original
  const invoke = (args: readonly string[], options: RunGitOptions = {}) =>
    run(selectedGit(), args, { ...options, baseEnv })
  let dangling: readonly DanglingRef[]
  try {
    dangling = await danglingRefs(repo, { run: invoke })
  } catch (diagnosis) {
    throw new AggregateError(
      [original, diagnosis],
      `${message}; dangling-ref diagnosis failed: ${diagnosis instanceof Error ? diagnosis.message : String(diagnosis)}`,
      { cause: original },
    )
  }
  if (dangling.length === 0) throw original

  const refs = dangling.map(({ ref }) => ref)
  let advertised: GitResult
  try {
    advertised = await invoke(["-C", repo, "ls-remote", "--refs", remote, ...refs], {
      timeoutMs: DANGLING_REF_SCAN_TIMEOUT_MS,
    })
    if (advertised.code !== 0) {
      throw commandFailure(repo, ["ls-remote", "--refs", remote, ...refs], advertised)
    }
  } catch (diagnosis) {
    throw new AggregateError(
      [original, diagnosis],
      `${message}; dangling-ref remote diagnosis failed: ${diagnosis instanceof Error ? diagnosis.message : String(diagnosis)}`,
      { cause: original },
    )
  }
  const remoteTips = new Map<string, string>()
  try {
    for (const line of advertised.stdout.toString("utf8").split("\n")) {
      if (line === "") continue
      const tab = line.indexOf("\t")
      if (tab <= 0) throw new Error(`git ls-remote returned a malformed row: ${JSON.stringify(line)}`)
      const ref = line.slice(tab + 1)
      if (refs.includes(ref)) {
        remoteTips.set(ref, validateOid(line.slice(0, tab), "git ls-remote returned a malformed id"))
      }
    }
  } catch (diagnosis) {
    throw new AggregateError(
      [original, diagnosis],
      `${message}; dangling-ref remote diagnosis failed: ${diagnosis instanceof Error ? diagnosis.message : String(diagnosis)}`,
      { cause: original },
    )
  }
  const facts = dangling
    .map(({ ref, oid }) => `${ref} local=${oid} ${remote}=${remoteTips.get(ref) ?? "absent"} object missing locally`)
    .join("; ")
  const cure = dangling.map(({ ref, oid }) => `git update-ref -d ${ref} ${oid}`).join("; ")
  throw new Error(`${facts}\nCure: ${cure}, then fetch again`, { cause: original })
}

/**
 * gitomic's private tracking namespace for one remote: the remote NAME when it is
 * a plain name, else `url-` plus the URL in unpadded base64url, which is ref-safe
 * and reversible. It holds only gitomic's bookkeeping, never an application ref.
 */
export function fetchedNamespace(remote: string): string {
  const key =
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote) &&
    !remote.endsWith(".lock") &&
    !remote.endsWith(".") &&
    !remote.includes("..")
      ? remote
      : `url-${Buffer.from(remote, "utf8").toString("base64url")}`
  return `refs/gitomic/fetched/${key}/`
}

const FETCH_RACE_ATTEMPTS = 3

/**
 * How a fetch lost a race with a concurrent fetch in the same repository for refs in `namespace`:
 * "moved" when the other fetch already moved a ref (retry at once), "held" when it still holds a
 * ref's lock (wait for it first). Undefined when the failure is anything else.
 */
function lostFetchedRefRace(error: unknown, namespace: string): "moved" | "held" | undefined {
  const detail = error instanceof Error ? error.message : ""
  const lost = parseRefLockFailures(detail).filter(
    ({ reporter, form }) => /(?:^|: )error: $/.test(reporter) && form !== "exists",
  )
  if (lost.length === 0 || !lost.every(({ ref }) => ref.startsWith(namespace))) return undefined
  return lost.some(({ form }) => form === "held") ? "held" : "moved"
}

/** A short jittered wait, so a retry does not land inside the lock window of the fetch that holds it. */
function waitOutHeldFetchLock(): Promise<void> {
  return new Promise((resolve) => {
    // raw-lifecycle-ok: the fetch retry awaits this wait, so it cannot outlive its caller.
    setTimeout(resolve, 25 + Math.floor(Math.random() * 75))
  })
}

/**
 * ONE `git fetch --verbose --porcelain` of every ref under a prefix, or of exactly
 * the named refs, into {@link fetchedNamespace}. Verbose porcelain prints a line
 * for every ref it considered, unchanged ones included (`=`), so the whole tip map
 * comes from this one process. Prefix mode prunes, and the refspec confines the
 * prune to the private namespace. A named ref missing on the remote throws.
 */
async function fetchRefs(
  repo: string,
  refs: string | readonly string[],
  remote: string,
  timeoutMs: number,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<ReadonlyMap<string, Oid>> {
  const namespace = fetchedNamespace(remote)
  const local = (ref: string) => `${namespace}${ref.slice("refs/".length)}`
  const prefix = typeof refs === "string" ? refs : undefined
  const named = typeof refs === "string" ? [] : [...refs]
  if (prefix !== undefined && !prefix.startsWith("refs/")) {
    throw new TypeError(`fetchRefs prefix must start with refs/: ${JSON.stringify(prefix)}`)
  }
  if (prefix === undefined) {
    if (named.length === 0) throw new TypeError("fetchRefs needs a prefix or at least one ref")
    for (const ref of named) {
      if (typeof ref !== "string" || !ref.startsWith("refs/")) {
        throw new TypeError(`fetchRefs ref must be a full refs/ name: ${JSON.stringify(ref)}`)
      }
    }
    if (new Set(named).size !== named.length) throw new TypeError("fetchRefs names a ref more than once")
  }
  // `prefix*` rather than `prefix/*`, so a ref named exactly `prefix` is included,
  // as listRefs includes it; the result is filtered by the same prefix rule.
  const refspecs =
    prefix === undefined ? named.map((ref) => `+${ref}:${local(ref)}`) : [`+${prefix}*:${local(prefix)}*`]
  const fetchArgs = [
    "fetch",
    "--verbose",
    "--porcelain",
    "--no-tags",
    "--no-write-fetch-head",
    "--refmap=",
    ...(prefix === undefined ? [] : ["--prune"]),
    remote,
    ...refspecs,
  ]
  let output: Buffer | undefined
  for (let attempt = 1; output === undefined; attempt++) {
    try {
      output = await git(repo, fetchArgs, { baseEnv, timeoutMs })
    } catch (error) {
      // Another fetch in this repository moved or held one of our private
      // fetched refs between this fetch's read and its lock. The namespace is
      // only a cache of remote tips, so fetching again reads them afresh.
      const race = lostFetchedRefRace(error, namespace)
      if (race !== undefined && attempt < FETCH_RACE_ATTEMPTS) {
        if (race === "held") await waitOutHeldFetchLock()
        continue
      }
      if (race !== undefined) {
        throw new Error(
          `git fetch lost the race for its fetched refs to another fetch in ${repo} ${attempt} times in a row; ` +
            `the last attempt failed with: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
      await diagnoseMissingObjectFetch(repo, remote, error, baseEnv)
      throw error
    }
  }
  const tips = new Map<string, Oid>()
  for (const line of decodeUtf8(output, "git fetch --porcelain").split("\n")) {
    if (line === "") continue
    // `<flag> <old> <new> <local ref>`; the flag is one character and may be a space.
    const flag = line[0]
    const [, next, localRef] = line.slice(2).split(" ")
    if (localRef === undefined || !localRef.startsWith(namespace)) {
      throw new Error(`git fetch --porcelain returned an unexpected line: ${JSON.stringify(line)}`)
    }
    if (flag === "-") continue
    if (flag === "!") throw new Error(`git fetch rejected ${localRef}: ${line}`)
    tips.set(`refs/${localRef.slice(namespace.length)}`, validateOid(next, "git fetch returned a malformed id"))
  }
  for (const ref of named) {
    if (!tips.has(ref)) throw new Error(`git fetch did not report ${ref} from ${remote}`)
  }
  const matching = [...tips].filter(([ref]) => prefix === undefined || refUnderPrefix(ref, prefix))
  return new Map(matching.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

export function isRemoteCompareAndSwapRejection(detail: string): boolean {
  return detail.split("\n").some((line) => {
    const [flag, , summary] = line.split("\t")
    return (
      flag === "!" &&
      (summary === "[rejected] (stale info)" || summary === "[remote rejected] (incorrect old value provided)")
    )
  })
}
