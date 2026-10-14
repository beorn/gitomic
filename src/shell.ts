import { AsyncLocalStorage } from "node:async_hooks"
import childProcess, { type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { fullJitter, type RandomUnit } from "@bearly/pacing"

import { syncDirectory } from "./durable.ts"
import {
  Conflict,
  GitSignaled,
  GitTimeout,
  HistoryEdgesTeardown,
  PublicationRejected,
  RemoteWriteOutcomeUnknown,
  TreePathCollision,
} from "./errors.ts"
import {
  historyEdgeParentBytes,
  historyEdgeRecordStartBytes,
  historyEdgesByteOverflow,
  historyEdgesRecordOverflow,
  normalizeHistoryEdgeByteCap,
  normalizeHistoryEdgeRecordCap,
} from "./history-edges.ts"
import { journalLeaseRejection } from "./lease-journal.ts"
import { rejectLegacyProvenance, validateRefNames } from "./options.ts"
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
  identProblem,
  isZeroOid,
  leaseConflict,
  objectOid,
  parseCommit,
  refUnderPrefix,
  TRANSACTION_SEARCH_LIMIT,
  transactionLookupExceeded,
  transactionMatches,
  validateOid,
} from "./git-object.ts"
import { assertGitPrefixMatched, assertTreePath, normalizePath, normalizePrefix } from "./path.ts"
import { assertTreeEntryMode } from "./types.ts"
import type {
  BlobValue,
  CommitInput,
  CommitMeta,
  GitomicBackend,
  HistoryEdgeEvent,
  Ident,
  Oid,
  PublishResult,
  RefSwap,
  RefUpdate,
  TreeEntry,
  TreeListing,
} from "./types.js"
import { decodeBlob, decodeUtf8 } from "./utf8.ts"

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
  /** Bound combined stdout/stderr bytes; overflow stops the command group before rejecting. */
  maxBytes?: number
  /** Called once the child process has started (its `spawn` event), before it has run; for timing only (27155). */
  onSpawn?: () => void
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
  /** Opt into standard Git commit signing through the configured signer, under this required deadline. Unsigned by default. */
  signing?: { timeoutMs: number }
  /** Default positive finite per-command limit for native Git commands without an explicit deadline. Snapshotted at construction; omitted by default. */
  localTimeoutMs?: number
  /** Positive finite performance.now() deadline in this process; caps every non-streaming command, reserving group teardown. */
  absoluteDeadlineMs?: number
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
  /** Forward host SIGTERM immediately, or let bounded commands drain to their own deadlines. */
  sigterm?: "forward" | "drain"
}

/** The default limit for one fetch or push to a remote. */
export const DEFAULT_REMOTE_TIMEOUT_MS = 20_000
const DANGLING_REF_SCAN_TIMEOUT_MS = 30_000
/** How long a stopped process group gets between SIGTERM and SIGKILL. */
const GROUP_STOP_GRACE_MS = 2_000

const DURABLE_GIT_CONFIG = ["-c", "core.fsync=loose-object,reference", "-c", "core.fsyncMethod=fsync"] as const
const shellRuntime = new AsyncLocalStorage<{
  executable: string
  sigterm: "forward" | "drain"
  localTimeoutMs: number | undefined
  absoluteDeadlineMs: number | undefined
}>()
const selectedGit = (): string => shellRuntime.getStore()?.executable ?? "git"

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
  const sigterm = options.sigterm === undefined ? "forward" : options.sigterm
  if (sigterm !== "forward" && sigterm !== "drain") throw new TypeError('sigterm must be "forward" or "drain"')
  const remoteTimeoutMs = normalizeTimeoutMs(options.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS, "remoteTimeoutMs")
  const signing =
    options.signing === undefined
      ? undefined
      : { timeoutMs: normalizeTimeoutMs(options.signing.timeoutMs, "signing.timeoutMs") }
  const localTimeoutMs =
    options.localTimeoutMs === undefined ? undefined : normalizeTimeoutMs(options.localTimeoutMs, "localTimeoutMs")
  const absoluteDeadlineMs =
    options.absoluteDeadlineMs === undefined
      ? undefined
      : normalizeTimeoutMs(options.absoluteDeadlineMs, "absoluteDeadlineMs")
  const baseEnv = snapshotEnvironment(options.baseEnv)
  const resolveGitDir = createGitDirResolver(baseEnv)
  const refStorages = new Map<string, Promise<"files" | "native">>()
  const objectFormats = new Map<string, Promise<"sha1" | "sha256">>()
  const genesisByGitDir = new Map<string, Promise<Oid>>()
  const refStorage = async (repo: string): Promise<"files" | "native"> =>
    resolveRefStorage(await resolveGitDir(repo), refStorages, baseEnv)
  const syncRefs = async (repo: string, updates: readonly RefUpdate[]): Promise<void> => {
    if (process.platform !== "linux" || (await refStorage(repo)) !== "files") return
    const directories = new Map<string, boolean>()
    for (const { ref, oid, expect } of updates) {
      if (oid === expect) continue // A successful no-op CAS writes no directory entry.
      let directory = dirname(join(repo, ref))
      for (;;) {
        directories.set(directory, (directories.get(directory) ?? true) && oid === null)
        if (directory === repo) break
        directory = dirname(directory)
      }
    }
    // Leaves before their parents: names must be durable before their ancestors.
    for (const [directory, mayBeDeleted] of [...directories].sort(([a], [b]) => b.length - a.length)) {
      try {
        await syncDirectory(fs.promises, directory)
      } catch (error) {
        if (mayBeDeleted && (error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
    }
  }
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
    objectFormat,
    head: async (repo, ref) => head(await resolveGitDir(repo), ref, baseEnv),
    readCommit: async (repo, oid) => {
      validateOid(oid)
      const output = await git(await resolveGitDir(repo), ["cat-file", "--batch"], {
        baseEnv,
        input: `${oid}\n`,
      })
      const raw = parseBatch([oid], output, "commit").get(oid)
      if (raw === undefined) throw new Error(`git cat-file --batch omitted commit ${oid}`)
      return parseCommit(oid, raw)
    },
    readTree: async (repo, commit, prefix) => readTree(await resolveGitDir(repo), commit, prefix, baseEnv),
    readTreeExact: async (repo, commit, path) => readTreeExact(await resolveGitDir(repo), commit, path, baseEnv),
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
    writeCommit: async (repo, input) => {
      const gitdir = await resolveGitDir(repo)
      const oid = await writeCommit(gitdir, input, baseEnv, signing)
      await syncCommitDirectories(gitdir, oid, input.changes.size === 0 ? undefined : commitParents(input), baseEnv)
      return oid
    },
    compareAndSwap: async (repo, ref, next, expected) => {
      const gitdir = await resolveGitDir(repo)
      const result = await compareAndSwap(gitdir, ref, next, expected, baseEnv)
      if (result === "swapped") await syncRefs(gitdir, [{ ref, oid: next, expect: expected }])
      return result
    },
    findTransaction: async (repo, tip, base, instance, seq) =>
      findTransaction(await resolveGitDir(repo), tip, base, instance, seq, baseEnv),
    isAncestor: async (repo, ancestor, descendant) =>
      isAncestor(await resolveGitDir(repo), ancestor, descendant, baseEnv),
    fetchRemote: async (repo, ref, remote) =>
      fetchRemote(await resolveGitDir(repo), ref, remote, remoteTimeoutMs, syncRefs, baseEnv),
    listRefs: async (repo, selection, remote) => {
      const selected = typeof selection === "string" ? selection : validateRefNames(selection)
      if (typeof selected !== "string" && remote !== undefined) {
        throw new TypeError("listRefs exact ref names are local only; omit remote")
      }
      if (typeof selected !== "string" && selected.size === 0) return new Map()
      return listRefs(await resolveGitDir(repo), selected, remote, remoteTimeoutMs, baseEnv)
    },
    readHistory: async (repo, tips, historyOptions) =>
      readHistory(await resolveGitDir(repo), tips, historyOptions, baseEnv),
    writeGenesis: async (repo) => {
      const gitdir = await resolveGitDir(repo)
      let genesis = genesisByGitDir.get(gitdir)
      if (genesis === undefined) {
        genesis = writeGenesis(gitdir, await objectFormat(repo), baseEnv).then(async (oid) => {
          await syncCommitDirectories(gitdir, oid, undefined, baseEnv)
          return oid
        })
        genesisByGitDir.set(gitdir, genesis)
      }
      try {
        return await genesis
      } catch (error) {
        genesisByGitDir.delete(gitdir)
        throw error
      }
    },
    compareAndSwapRemote: async (repo, ref, next, expected, remote) => {
      const gitdir = await resolveGitDir(repo)
      const result = await compareAndSwapRemote(gitdir, ref, next, expected, remote, remoteTimeoutMs, baseEnv)
      if (result.landed && result.kept === "swapped") await syncRefs(gitdir, [{ ref, oid: next, expect: expected }])
      return result
    },
    publish: async (repo, updates, remote) => {
      const gitdir = await resolveGitDir(repo)
      const checked = assertRefUpdates(updates)
      if (remote !== undefined) return publishRemote(gitdir, checked, remote, remoteTimeoutMs, baseEnv)
      const result = await publishLocal(gitdir, checked, baseEnv)
      // An idempotent publish may only verify an already packed ref. Sync only
      // names this transaction changed; their directory failures remain errors.
      const changed = new Set(result.outcomes.filter(({ outcome }) => outcome !== "unchanged").map(({ ref }) => ref))
      await syncRefs(
        gitdir,
        checked.filter(({ ref }) => changed.has(ref)),
      )
      return result
    },
    fetchRefs: async (repo, refs, remote, options) =>
      fetchRefs(await resolveGitDir(repo), refs, remote, remoteTimeoutMs, baseEnv, options?.absent ?? "throw"),
  }
  // Each backend owns its executable even when two backends run concurrently.
  // Keeping the selection in the async call chain lets the Git plumbing below
  // use one runner without adding an executable argument to every operation.
  const inRuntime = <T>(work: () => Promise<T>): Promise<T> =>
    shellRuntime.run({ executable, sigterm, localTimeoutMs, absoluteDeadlineMs }, work)
  const selectedBackend = Object.fromEntries(
    Object.entries(backend).map(([name, operation]) => {
      const invoke = (operation as (...args: unknown[]) => Promise<unknown>).bind(backend)
      return [name, (...args: unknown[]) => inRuntime(() => invoke(...args))]
    }),
    // The wrapped bag is structurally heterogeneous now that one member streams:
    // every other member returns a Promise, `readHistoryEdges` returns an
    // AsyncIterable. Widen through `unknown` for the deliberate re-type; the
    // runtime shape is asserted by the backend conformance tests.
  ) as unknown as GitomicBackend
  // `readHistoryEdges` is the one STREAMING operation: it returns an AsyncIterable
  // synchronously, so the Promise wrapper above would break its contract. It is
  // attached unwrapped, carrying the selected executable explicitly and resolving
  // the git dir inside that runtime at iteration time.
  selectedBackend.readHistoryEdges = (repo, tips, edgesOptions) =>
    readHistoryEdges((target) => inRuntime(() => resolveGitDir(target)), executable, repo, tips, edgesOptions, baseEnv)
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
 * Resolve the author `git commit` would record in the caller's repository and environment.
 * Missing or unusable identities return a diagnostic; process failures reject.
 * `env` overrides the inherited environment, as with {@link runGit}.
 */
export async function resolveGitAuthor(
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ author: Ident } | { problem: string }> {
  const result = await runGit(
    [...(options.cwd === undefined ? [] : ["-C", options.cwd]), "var", "GIT_AUTHOR_IDENT"],
    options.env === undefined ? {} : { env: options.env },
  )
  const line = result.stdout.toString("utf8").trim()
  const match = /^(.+?) <([^<>]*)> \d+ [+-]\d{4}$/u.exec(line)
  if (result.code !== 0 || match === null) {
    const detail = result.stderr.toString("utf8").trim().split("\n").at(-1) ?? ""
    return {
      problem: `no author identity (git var GIT_AUTHOR_IDENT exit ${result.code}${detail ? `: ${detail}` : ""})`,
    }
  }
  const author = { name: match[1] ?? "", email: match[2] ?? "" }
  const problem = identProblem(author)
  return problem === undefined ? { author } : { problem: `git var GIT_AUTHOR_IDENT ${problem}` }
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
  readonly answered: number
  readonly requested: number
  constructor(answered: number, requested: number, repository: string) {
    super(`git cat-file --batch-check answered ${answered} lines for ${requested} names in ${repository}`)
    this.answered = answered
    this.requested = requested
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

class AbsoluteDeadlineExpired extends Error {
  constructor(deadline: number, now: number, command: string, args: readonly string[]) {
    super(
      `absolute Git deadline expired before spawn: deadline=${deadline} now=${now} command=${command} ${args.join(" ")}`,
    )
    this.name = "AbsoluteDeadlineExpired"
  }
}

/**
 * What the caller's absolute deadline still allows, with group teardown reserved, or `undefined` without one. A spawn
 * or a wait that needs `needMs` and cannot have it throws {@link AbsoluteDeadlineExpired} naming the command it was for.
 */
function remainingBeforeAbsoluteDeadline(command: string, args: readonly string[], needMs = 0): number | undefined {
  const runtime = shellRuntime.getStore()
  if (runtime?.absoluteDeadlineMs === undefined) return undefined
  const now = performance.now()
  const remaining = runtime.absoluteDeadlineMs - now - GROUP_STOP_GRACE_MS
  if (remaining <= needMs) throw new AbsoluteDeadlineExpired(runtime.absoluteDeadlineMs, now, command, args)
  return remaining
}

async function run(command: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  const runtime = shellRuntime.getStore()
  const selectedTimeoutMs = options.timeoutMs === undefined ? runtime?.localTimeoutMs : options.timeoutMs
  let timeoutMs = selectedTimeoutMs === undefined ? undefined : normalizeTimeoutMs(selectedTimeoutMs, "timeoutMs")
  const remaining = remainingBeforeAbsoluteDeadline(command, args)
  if (remaining !== undefined) timeoutMs = timeoutMs === undefined ? remaining : Math.min(timeoutMs, remaining)
  // oxlint-disable-next-line promise/param-names -- resolveResult cannot shadow the imported path.resolve.
  return new Promise((resolveResult, reject) => {
    const maxBytes = options.maxBytes === undefined ? undefined : normalizeHistoryEdgeByteCap(options.maxBytes)
    const bounded = (timeoutMs !== undefined || maxBytes !== undefined) && process.platform !== "win32"
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
    let outputOverflow: Error | undefined
    let outputBytes = 0
    let exitCode: number | null | undefined
    let exitSignal: NodeJS.Signals | null = null
    let limit: ReturnType<typeof setTimeout> | undefined
    let escalation: ReturnType<typeof setTimeout> | undefined
    const release = bounded && child.pid !== undefined ? holdGroup(child.pid, runtime?.sigterm ?? "forward") : () => {}
    const settle = (finish: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(limit)
      clearTimeout(escalation)
      release()
      finish()
    }
    // A child that failed to start (EMFILE, ENOENT) reports it with an "error" event and may have no pipes at all.
    // Listen first and touch no pipe it lacks: a later "error" with no listener takes the whole host down (@cto
    // 6c9330ac).
    child.once("error", (error) => settle(() => reject(error)))
    if ([child.stdin, child.stdout, child.stderr].some((pipe: unknown) => pipe === null || pipe === undefined)) {
      settle(() => reject(new Error(`${describeGitCommand(command, args)} could not start: it has no stdio pipes`)))
      return
    }
    if (options.onSpawn !== undefined) child.once("spawn", options.onSpawn)
    const settleOutcome = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle(() => {
        const capturedStderr = Buffer.concat(stderr)
        if (outputOverflow !== undefined) {
          reject(outputOverflow)
        } else if (signal !== null) {
          reject(new GitSignaled(describeGitCommand(command, args), signal, capturedStderr.toString("utf8")))
        } else if (code === null) {
          reject(new Error(`${describeGitCommand(command, args)} ended without an exit code or signal`))
        } else {
          resolveResult({ stdout: Buffer.concat(stdout), stderr: capturedStderr, code })
        }
      })
    }
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
          settleOutcome(exited, exitSignal)
          return
        }
        timedOut = true
        stopProcess(child, "SIGTERM", bounded)
        escalation = setTimeout(() => stopProcess(child, "SIGKILL", bounded), GROUP_STOP_GRACE_MS)
      }, timeoutMs)
    }
    const collect = (chunks: Buffer[], chunk: Buffer): void => {
      if (outputOverflow !== undefined) return
      outputBytes += chunk.length
      if (maxBytes !== undefined && outputBytes > maxBytes) {
        outputOverflow = new Error(
          `${describeGitCommand(command, args)} exceeded maxBytes ${maxBytes} after ${outputBytes} bytes`,
        )
        stopProcess(child, "SIGTERM", bounded)
        escalation = setTimeout(() => stopProcess(child, "SIGKILL", bounded), GROUP_STOP_GRACE_MS)
        return
      }
      chunks.push(chunk)
    }
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk))
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk))
    // A stopped command settles when its own process exits, not when its pipes close.
    child.once("exit", (code, signal) => {
      exitCode = code
      exitSignal = signal
      if (outputOverflow !== undefined) {
        abandonHelpers()
        settle(() => reject(outputOverflow))
        return
      }
      if (!timedOut) return
      abandonHelpers()
      settle(() => reject(new GitTimeout(describeGitCommand(command, args), timeoutMs ?? 0)))
    })
    child.once("close", (code, signal) => {
      if (timedOut) return
      settleOutcome(code, signal)
    })
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // A command stopped at its limit closes stdin under a pending write; the
      // limit is then the reported outcome. A command that exits (or closes
      // stdin) without reading all of its input breaks the pipe: its exit code
      // is the result, never the EPIPE. Any other stdin failure is the result.
      if (timedOut || outputOverflow !== undefined || error.code === "EPIPE") return
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
 * signals are forwarded unless that backend defers the first SIGTERM until
 * its bounded commands settle. When this process has no other handler, the
 * signal is raised again after forwarding or draining so the default exit
 * still happens. Deadlines and subsequent termination signals remain active.
 */
const heldGroups = new Map<number, "forward" | "drain">()
const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
let deferredTermination = false

function removeSignalForwarders(): void {
  for (const signal of forwardedSignals) process.removeListener(signal, forwardSignal)
}

function forwardSignal(signal: NodeJS.Signals): void {
  const firstTermination = signal === "SIGTERM" && !deferredTermination
  const exitsByDefault =
    process.listenerCount(signal) === 1 && !(firstTermination && [...heldGroups.values()].includes("drain"))
  let deferred = false
  for (const [pid, policy] of heldGroups) {
    if (firstTermination && policy === "drain") {
      deferred = true
      continue
    }
    try {
      process.kill(-pid, signal)
      // A default host exit loses its escalation timers. Finish stopping its
      // owned groups before exiting, as a timed-out command does for helpers.
      if (exitsByDefault) process.kill(-pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
    heldGroups.delete(pid)
  }
  if (deferred) {
    deferredTermination = true
    return
  }
  removeSignalForwarders()
  heldGroups.clear()
  deferredTermination = false
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal)
}

function holdGroup(pid: number, policy: "forward" | "drain"): () => void {
  if (heldGroups.size === 0) {
    for (const signal of forwardedSignals) process.on(signal, forwardSignal)
  }
  heldGroups.set(pid, policy)
  return () => {
    heldGroups.delete(pid)
    if (heldGroups.size === 0) {
      removeSignalForwarders()
      const terminate = deferredTermination
      deferredTermination = false
      if (terminate && process.listenerCount("SIGTERM") === 0) process.kill(process.pid, "SIGTERM")
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
    if (error instanceof AbsoluteDeadlineExpired) throw error
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

/**
 * One `ls-tree -r -z --full-tree` with NO pathspec: Git lists the WHOLE tree and the prefix is applied in JS below,
 * so a prefix-scoped read still pays for every entry — this is a whole-tree cost per call, not a scoped one.
 * Measured on the STATE rail's kept copy: 21.9-25.2 ms for 25,127 entries, no value read.
 *
 * Every entry is returned with the mode Git reported, including a symlink or gitlink; whether that mode is
 * acceptable is a policy applied where an entry is EXPOSED (`assertRegularBlob`, the one predicate), never here.
 */
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
    entries.set(path, { oid, mode: assertTreeEntryMode(mode, path, commit) })
  }
  assertGitPrefixMatched(entries.size, repo, commit, normalizedPrefix)
  return entries
}

/**
 * One `ls-tree -z --full-tree <commit> -- <path>`: Git resolves the exact path as a LITERAL pathspec and prints at
 * most one entry, so this reads one path instead of listing the whole tree. A path the tree does not hold prints
 * nothing and answers `undefined` — a missing path is a legitimate answer here, not `GitPrefixNotFoundError`.
 *
 * The `:(literal)` magic keeps a path that carries glob characters from being read as a pathspec pattern, so the
 * lookup names the byte path the listing would name. A directory prints its tree entry (type `tree`), which is not a
 * member of the listing vocabulary because `readTree` recurses trees away, so it answers `undefined` too; a
 * non-tree entry's mode is narrowed and refused by name through the same `assertTreeEntryMode` boundary readTree uses.
 */
async function readTreeExact(
  repo: string,
  commit: Oid,
  path: string,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<TreeEntry | undefined> {
  const normalized = normalizePath(path)
  const output = await git(repo, ["ls-tree", "-z", "--full-tree", commit, "--", `:(literal)${normalized}`], {
    baseEnv,
  })
  const records = decodeUtf8(output, "Git tree paths").split("\0")
  let found: TreeEntry | undefined
  for (const record of records) {
    if (!record) continue
    const separator = record.indexOf("\t")
    if (separator < 0) throw new Error("git ls-tree returned a malformed record")
    const metadata = record.slice(0, separator).split(" ")
    const mode = metadata[0]
    const type = metadata[1]
    const oid = metadata[2]
    const listedPath = record.slice(separator + 1)
    if (mode === undefined || type === undefined || oid === undefined) {
      throw new Error("git ls-tree returned malformed entry metadata")
    }
    if (listedPath !== normalized) {
      throw new Error(
        `git ls-tree resolved ${JSON.stringify(normalized)} to ${JSON.stringify(listedPath)}; the exact lookup must name one path`,
      )
    }
    if (found !== undefined) {
      throw new Error(`git ls-tree returned more than one entry for the exact path ${JSON.stringify(normalized)}`)
    }
    // A tree entry is not a listing member (`readTree` recurses trees away), so a directory answers "no blob here".
    found = type === "tree" ? undefined : { oid, mode: assertTreeEntryMode(mode, listedPath, commit) }
    if (type === "tree") return undefined
  }
  return found
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
  return new Map([...parseBatch(distinct, output, "blob")].map(([oid, raw]) => [oid, decodeBlob(raw)]))
}

function parseBatch(oids: readonly Oid[], output: Buffer, type: "commit" | "blob"): ReadonlyMap<Oid, Buffer> {
  const blobs = new Map<Oid, Buffer>()
  let offset = 0
  for (const oid of oids) {
    const newline = output.indexOf(0x0a, offset)
    if (newline < 0) throw new Error(`git cat-file --batch returned a truncated header for ${oid}`)
    const header = output.toString("utf8", offset, newline)
    if (header === `${oid} missing`) {
      throw new Error(`git cat-file --batch: object ${oid} is missing from the repository`)
    }
    const match = /^([0-9a-f]+) (blob|commit) ([0-9]+)$/.exec(header)
    if (match === null || match[1] !== oid || match[2] !== type) {
      throw new Error(`git cat-file --batch returned an unexpected object for ${oid}: ${header}`)
    }
    const size = Number(match[3])
    const start = newline + 1
    const end = start + size
    if (!Number.isSafeInteger(size) || size < 0 || end >= output.length || output[end] !== 0x0a) {
      throw new Error(`git cat-file --batch returned a malformed ${type} for ${oid}`)
    }
    blobs.set(oid, output.subarray(start, end))
    offset = end + 1
  }
  if (offset !== output.length) throw new Error(`git cat-file --batch returned trailing data after ${oids.at(-1)}`)
  return blobs
}

/** Required cumulative raw payload budget and per-command deadline for exact commit reads. */
export type ReadRawCommitsOptions = Readonly<{
  maxBytes: number
  timeoutMs: number
  run?: (args: readonly string[], options?: RunGitOptions) => Promise<GitResult>
}>

/** Read distinct commits as exact bytes, with at most 500 OIDs and 8 MiB per native batch. */
export async function readRawCommits(
  repo: string,
  oids: readonly Oid[],
  options: ReadRawCommitsOptions,
): Promise<ReadonlyMap<Oid, Buffer>> {
  const maxBytes = normalizeHistoryEdgeByteCap(options.maxBytes)
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs, "timeoutMs")
  const distinct = [...new Set(oids)]
  for (const oid of distinct) validateOid(oid, "readRawCommits needs valid Git object ids")
  const invoke = options.run ?? runGit
  const at = ["-C", resolve(repo)]
  const nativeMaxBytes = 8 * 1024 * 1024
  const result = new Map<Oid, Buffer>()
  let totalBytes = 0
  for (let offset = 0; offset < distinct.length; offset += 500) {
    const candidates = distinct.slice(offset, offset + 500)
    const args = [...at, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"]
    const checked = await invoke(args, { input: candidates.join("\n") + "\n", timeoutMs, maxBytes: nativeMaxBytes })
    if (checked.code !== 0) throw commandFailure(repo, args, checked)
    const answers = checked.stdout.toString("utf8").split("\n")
    if (answers.pop() !== "" || answers.length !== candidates.length) {
      throw new Error(`git cat-file metadata cardinality differs for ${candidates[0]} in ${repo}`)
    }
    let chunk: Oid[] = []
    let chunkBytes = 0
    const sizes = new Map<Oid, number>()
    const readChunk = async (): Promise<void> => {
      if (chunk.length === 0) return
      const readArgs = [...at, "cat-file", "--batch"]
      const read = await invoke(readArgs, { input: chunk.join("\n") + "\n", timeoutMs, maxBytes: nativeMaxBytes })
      if (read.code !== 0) throw commandFailure(repo, readArgs, read)
      for (const [oid, raw] of parseBatch(chunk, read.stdout, "commit")) {
        if (raw.length !== sizes.get(oid)) throw new Error(`git cat-file commit length differs for ${oid}`)
        result.set(oid, raw)
      }
      chunk = []
      chunkBytes = 0
    }
    for (const [index, oid] of candidates.entries()) {
      const answer = answers[index]
      const match = /^([0-9a-f]+) commit ([0-9]+)$/.exec(answer ?? "")
      const bytes = match === null ? NaN : Number(match[2])
      if (match?.[1] !== oid || !Number.isSafeInteger(bytes) || bytes < 0) {
        throw new Error(`git cat-file metadata missing or invalid commit ${oid} in ${repo}: ${answer}`)
      }
      totalBytes += bytes
      if (totalBytes > maxBytes) {
        throw new Error(`raw commits in ${repo} exceeded maxBytes ${maxBytes} after ${totalBytes} bytes at ${oid}`)
      }
      const framedBytes = bytes + Buffer.byteLength(`${oid} commit ${bytes}\n`) + 1
      if (framedBytes > nativeMaxBytes) {
        throw new Error(`git cat-file commit ${oid} exceeded maxBytes ${nativeMaxBytes} after ${framedBytes} bytes`)
      }
      if (chunkBytes + framedBytes > nativeMaxBytes) await readChunk()
      chunk.push(oid)
      sizes.set(oid, bytes)
      chunkBytes += framedBytes
    }
    await readChunk()
  }
  return result
}

async function writeCommit(
  repo: string,
  input: CommitInput,
  baseEnv?: NodeJS.ProcessEnv,
  signing?: { timeoutMs: number },
): Promise<Oid> {
  rejectLegacyProvenance(input)
  for (const path of input.changes.keys()) assertTreePath(path)
  const parents = commitParents(input)
  const idents = commitIdents(input)
  const message = formatCommitMessage(input.writer, input.instance, input.message, input.seq, input.trailers)
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
      signing,
    )
  }
  const [parentTree, parentTime] = text(
    await git(repo, ["show", "-s", "--format=%T%x00%ct", input.parent], { baseEnv }),
  ).split("\0")
  const blobDir = await mkdtemp(join(tmpdir(), "gitomic-blobs-"))
  try {
    const changes = [...input.changes]
    const blobFiles: string[] = []
    for (const [position, [, content]] of changes.entries()) {
      if (content === undefined) continue
      const blobFile = join(blobDir, `blob-${position}`)
      await writeFile(blobFile, typeof content === "string" ? Buffer.from(content, "utf8") : content)
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
    const tree = await buildTree(
      repo,
      validateOid(parentTree, "invalid parent tree id"),
      input,
      changes,
      blobs,
      baseEnv,
    )
    return await commitTree(repo, tree, parents, Number(parentTime), input.time, message, idents, baseEnv, signing)
  } finally {
    await rm(blobDir, { recursive: true, force: true })
  }
}

/** One entry of a tree being rebuilt, as `ls-tree` prints it. */
type TreeRecord = { readonly mode: string; readonly type: string; readonly oid: Oid }

/**
 * `ls-tree` children one tree build runs at once. 300 sibling directories listed all at once exhausted a 1024 file
 * descriptor limit (@cto 6c9330ac); 8 keeps a wide write well inside it at the same per-level latency for a narrow one.
 */
const LIST_TREE_CONCURRENCY = 8

/** Git's empty tree id, SHA-1 and SHA-256 (git's own EMPTY_TREE constants), chosen by the repository's id length. */
function emptyTreeOid(like: Oid): Oid {
  return like.length === 64
    ? "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"
    : "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
}

/**
 * The tree `changes` make of `parentTree`, rebuilding only the directories they touch (27155). Each touched directory
 * is listed top-down (`ls-tree -z` of its tree id, one level at a time), its entries replaced, and the new trees are
 * written bottom-up (`mktree -z --batch`, one git child per depth). Git writes and orders every object, so the id is the
 * one `read-tree`/`update-index`/`write-tree` gave a real tree, without loading the parent's whole tree into an
 * index. Measured on a 30,484-path tree, whole writeCommit, one path: 108 ms became 37 ms (2026-10-14).
 *
 * Same rules as that index route: a changed path keeps 100755 from its own (or its move source's) parent entry, else
 * 100644; a delete removes an exact entry and never a directory's name; a directory a change empties is dropped.
 * Names are carried as raw bytes (latin1 keys), so a sibling name that is not UTF-8 survives byte for byte. Where the
 * index route silently replaced a file and a directory holding the same name, this refuses with TreePathCollision.
 */
async function buildTree(
  repo: string,
  parentTree: Oid,
  input: CommitInput,
  changes: readonly (readonly [string, BlobValue | undefined])[],
  blobs: readonly Oid[],
  baseEnv?: NodeJS.ProcessEnv,
): Promise<Oid> {
  const key = (path: string) => Buffer.from(path, "utf8").toString("latin1")
  const path = (raw: string) => Buffer.from(raw, "latin1").toString("utf8")
  const rebuilt = new Set(changes.flatMap(([changed]) => treeAncestors(key(changed))))
  const read = new Set(rebuilt)
  for (const [changed, content] of changes) {
    const source = input.modeSources?.get(changed)
    if (content !== undefined && source !== undefined) for (const dir of treeAncestors(key(source))) read.add(dir)
  }
  const listings = await listDirectories(repo, parentTree, read, baseEnv)
  // The index route never records an empty subtree (write-tree drops it), so a rebuilt directory drops one too, and a
  // put over an empty subtree replaces it rather than colliding. An untouched directory keeps any it holds.
  const empty = emptyTreeOid(parentTree)
  for (const dir of rebuilt) {
    const listing = listings.get(dir) as Map<string, TreeRecord>
    for (const [name, entry] of listing) if (entry.type === "tree" && entry.oid === empty) listing.delete(name)
  }

  const executables = new Set<string>()
  for (const [changed, content] of changes) {
    if (content === undefined) continue
    const source = key(input.modeSources?.get(changed) ?? changed)
    if (listings.get(treeParent(source))?.get(treeName(source))?.mode === "100755") executables.add(path(source))
  }
  // A put over a directory that nothing below it empties: the file and the directory would share one name.
  const overDirectory: { raw: string; tree: Oid }[] = []
  let blobPosition = 0
  for (const [changed, content] of changes) {
    const raw = key(changed)
    const listing = listings.get(treeParent(raw)) as Map<string, TreeRecord>
    const existing = listing.get(treeName(raw))
    if (content === undefined) {
      if (existing !== undefined && existing.type !== "tree") listing.delete(treeName(raw))
      continue
    }
    if (existing?.type === "tree" && !rebuilt.has(raw)) overDirectory.push({ raw, tree: existing.oid })
    listing.set(treeName(raw), {
      mode: keptMode(input, changed, executables),
      type: "blob",
      oid: blobs[blobPosition++] as Oid,
    })
  }
  for (const { raw, tree } of overDirectory) {
    const first = [...(await listTree(repo, tree, baseEnv)).keys()].sort()[0] ?? ""
    throw new TreePathCollision(path(raw), path(`${raw}/${first}`))
  }

  // Bottom-up: one mktree per depth writes every non-empty rebuilt directory of that depth.
  const levels = byTreeDepth(rebuilt)
  for (let depth = levels.length - 1; depth >= 0; depth--) {
    const written = await writeTrees(
      repo,
      (levels[depth] ?? []).filter((dir) => (listings.get(dir) as Map<string, TreeRecord>).size > 0),
      listings,
      baseEnv,
    )
    for (const dir of levels[depth] ?? []) {
      const oid = written.get(dir)
      if (dir === "") {
        return (
          oid ??
          validateOid(text(await gitWrite(repo, ["mktree", "-z"], { baseEnv, input: "" })), "invalid empty tree id")
        )
      }
      const parent = listings.get(treeParent(dir)) as Map<string, TreeRecord>
      const holder = parent.get(treeName(dir))
      if (oid === undefined) {
        if (holder?.type === "tree") parent.delete(treeName(dir))
        continue
      }
      if (holder !== undefined && holder.type !== "tree") {
        const first = [...(listings.get(dir) as Map<string, TreeRecord>).keys()].sort()[0] ?? ""
        throw new TreePathCollision(path(dir), path(`${dir}/${first}`))
      }
      parent.set(treeName(dir), { mode: "040000", type: "tree", oid })
    }
  }
  throw new Error("tree build ended without writing the root tree")
}

/** The directory holding a raw tree path ("" for a root entry). */
function treeParent(raw: string): string {
  return raw.slice(0, Math.max(0, raw.lastIndexOf("/")))
}

/** The last component of a raw tree path. */
function treeName(raw: string): string {
  return raw.slice(raw.lastIndexOf("/") + 1)
}

/** Every directory above a raw tree path, the root ("") last. */
function treeAncestors(raw: string): string[] {
  const dirs: string[] = []
  for (let dir = treeParent(raw); ; dir = treeParent(dir)) {
    dirs.push(dir)
    if (dir === "") return dirs
  }
}

/** Directories grouped by depth: index 0 holds the root, index n the directories n levels below it. */
function byTreeDepth(dirs: Iterable<string>): string[][] {
  const levels: string[][] = []
  for (const dir of dirs) (levels[dir === "" ? 0 : dir.split("/").length] ??= []).push(dir)
  return levels
}

/**
 * The parent tree's listing of every named directory, top-down: a directory's tree id comes from its parent's
 * listing, and a directory absent from it (or held there by a file) is new and lists empty. One level at a time,
 * each level's `ls-tree` children in parallel.
 */
async function listDirectories(
  repo: string,
  parentTree: Oid,
  dirs: Iterable<string>,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<Map<string, Map<string, TreeRecord>>> {
  const listings = new Map<string, Map<string, TreeRecord>>()
  for (const level of byTreeDepth(dirs)) {
    if (level === undefined) continue
    // A level can hold hundreds of directories: list them a bounded batch at a time, never one child each at once.
    for (let start = 0; start < level.length; start += LIST_TREE_CONCURRENCY) {
      await Promise.all(
        level.slice(start, start + LIST_TREE_CONCURRENCY).map(async (dir) => {
          const entry = dir === "" ? undefined : listings.get(treeParent(dir))?.get(treeName(dir))
          const oid = dir === "" ? parentTree : entry?.type === "tree" ? entry.oid : undefined
          listings.set(dir, oid === undefined ? new Map<string, TreeRecord>() : await listTree(repo, oid, baseEnv))
        }),
      )
    }
  }
  return listings
}

/** One `mktree -z --batch` for the given directories' entries; their new tree ids, by directory. */
async function writeTrees(
  repo: string,
  dirs: readonly string[],
  listings: ReadonlyMap<string, ReadonlyMap<string, TreeRecord>>,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<Map<string, Oid>> {
  const written = new Map<string, Oid>()
  if (dirs.length === 0) return written
  const records = dirs.map((dir) =>
    [...(listings.get(dir) ?? [])]
      .map(([name, entry]) => `${entry.mode} ${entry.type} ${entry.oid}\t${name}\0`)
      .join(""),
  )
  const input = Buffer.from(records.join("\0"), "latin1")
  const output = text(await gitWrite(repo, ["mktree", "-z", "--batch"], { baseEnv, input })).split("\n")
  if (output.length !== dirs.length) {
    throw new Error(`git mktree --batch returned ${output.length} tree ids for ${dirs.length} trees`)
  }
  for (const [position, dir] of dirs.entries()) {
    const label = JSON.stringify(Buffer.from(dir, "latin1").toString("utf8"))
    written.set(dir, validateOid(output[position], `invalid tree id for ${label}`))
  }
  return written
}

/**
 * One `ls-tree -z` of a tree id: its entries keyed by raw name bytes. `--full-tree`, as this file's other ls-tree
 * reads: without it an inherited work tree (GIT_WORK_TREE, core.worktree) and a subdirectory cwd scope the listing to
 * that subdirectory, and a rebuilt tree would silently lose every entry outside it.
 */
async function listTree(repo: string, tree: Oid, baseEnv?: NodeJS.ProcessEnv): Promise<Map<string, TreeRecord>> {
  const entries = new Map<string, TreeRecord>()
  const listing = await git(repo, ["ls-tree", "--full-tree", "-z", tree], { baseEnv })
  for (const record of listing.toString("latin1").split("\0")) {
    if (record === "") continue
    const tab = record.indexOf("\t")
    const [mode, type, oid] = record.slice(0, Math.max(0, tab)).split(" ")
    if (tab < 0 || mode === undefined || type === undefined || oid === undefined) {
      throw new Error(`git ls-tree ${tree} returned a malformed entry: ${JSON.stringify(record)}`)
    }
    entries.set(record.slice(tab + 1), { mode, type, oid: validateOid(oid, `invalid entry id in tree ${tree}`) })
  }
  return entries
}

/** Git synced loose-object bytes; now sync the names before any ref adopts them. */
async function syncCommitDirectories(
  repo: string,
  oid: Oid,
  parents: readonly Oid[] | undefined,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<void> {
  if (process.platform !== "linux") return
  // An unchanged tree (including genesis) writes only its commit. Preserve the
  // event path's process budget; tree discovery is needed only for content writes.
  const objects =
    parents === undefined
      ? [oid]
      : text(
          await git(
            repo,
            ["rev-list", "--objects", "--no-object-names", oid, ...parents.map((parent) => `^${parent}`)],
            { baseEnv },
          ),
        ).split("\n")
  const directories = new Set<string>()
  for (const object of objects) {
    validateOid(object)
    const directory = join(repo, "objects", object.slice(0, 2))
    try {
      await fs.promises.stat(join(directory, object.slice(2)))
    } catch (error) {
      // rev-list proved it exists in Git's object database; packed and virtual
      // empty-tree objects have no loose filename for this write to sync.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    directories.add(directory)
  }
  await Promise.all([...directories].map((directory) => syncDirectory(fs.promises, directory)))
  if (directories.size > 0) await syncDirectory(fs.promises, join(repo, "objects"))
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
  signing?: { timeoutMs: number },
): Promise<Oid> {
  const timestamp = commitTimestamp(parentTime, time)
  const args = ["commit-tree", tree]
  for (const parent of parents) args.push("-p", parent)
  if (signing !== undefined) args.push("-S")
  try {
    return text(
      await gitWrite(repo, args, {
        baseEnv,
        env: identityEnv(timestamp, idents),
        input: message,
        ...(signing === undefined ? {} : { timeoutMs: signing.timeoutMs }),
      }),
    )
  } catch (error) {
    if (signing === undefined) throw error
    throw new Error(
      `Configured Git signer (-S) refused the signed commit (bound ${signing.timeoutMs} ms): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
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
  selection: string | ReadonlySet<string>,
  remote: string | undefined,
  timeoutMs: number,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<ReadonlyMap<string, Oid>> {
  if (typeof selection === "string" && !selection.startsWith("refs/")) {
    throw new TypeError(`listRefs prefix must start with refs/: ${JSON.stringify(selection)}`)
  }
  const pairs: Array<[string, Oid]> = []
  if (remote === undefined) {
    const patterns = typeof selection === "string" ? [selection] : [...selection]
    const output = await git(repo, ["for-each-ref", "--format=%(objectname) %(refname)", ...patterns], { baseEnv })
    for (const line of decodeUtf8(output, "git for-each-ref").split("\n")) {
      if (line === "") continue
      const space = line.indexOf(" ")
      pairs.push([line.slice(space + 1), validateOid(line.slice(0, space), "git for-each-ref returned a malformed id")])
    }
  } else {
    if (typeof selection !== "string") throw new TypeError("listRefs exact ref names are local only; omit remote")
    const patterns = selection.endsWith("/") ? [`${selection}*`] : [selection, `${selection}/*`]
    const output = await git(repo, ["ls-remote", "--refs", remote, ...patterns], { baseEnv, timeoutMs })
    for (const line of decodeUtf8(output, "git ls-remote").split("\n")) {
      if (line === "") continue
      const tab = line.indexOf("\t")
      pairs.push([line.slice(tab + 1), validateOid(line.slice(0, tab), "git ls-remote returned a malformed id")])
    }
  }
  const matching = pairs.filter(([ref]) =>
    typeof selection === "string" ? refUnderPrefix(ref, selection) : selection.has(ref),
  )
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
  options: { readonly exclude?: readonly Oid[]; readonly limit?: number; readonly allParents?: boolean } = {},
  baseEnv?: NodeJS.ProcessEnv,
): Promise<CommitMeta[]> {
  if (tips.length === 0) return []
  for (const tip of tips) validateOid(tip, "invalid history tip")
  const exclude = (options.exclude ?? []).map((oid) => `^${validateOid(oid, "invalid history exclusion")}`)
  const limit = options.limit === undefined ? [] : [`--max-count=${options.limit}`]
  const revisions = [...tips, ...exclude].join("\n") + "\n"
  const output = await git(
    repo,
    [
      "rev-list",
      // #27099 step 2 slice 1 (@cto 68b1ca87): the cold ancestry route asks for the WHOLE ancestor closure in
      // one process; the first-parent chain stays the default for every existing caller.
      ...(options.allParents === true ? [] : ["--first-parent"]),
      ...limit,
      "--no-commit-header",
      "--format=%H%x00%P%x00%ct%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00",
      "--stdin",
    ],
    // This call consumes complete output; buffering avoids one pipe delivery per commit.
    { baseEnv, input: revisions, env: { GIT_FLUSH: "0" } },
  )
  const fields = decodeUtf8(output, "git rev-list history")
    .split("\0")
    .map((field) => Buffer.from(field, "utf8").toString("utf8"))
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

/** Cap on the stderr tail kept for a stream-failure message: always drained, reported bounded. */
const HISTORY_EDGES_STDERR_LIMIT_BYTES = 8 * 1024
// One OID token is at most 64 hex characters; allow slack for the record's leading newline and any CR. A longer
// delimiter-free run is malformed output and is REFUSED before the carry buffer grows with it. That bound, not
// maxBytes, is what makes this reader's heap Theta(1) rather than Theta(bytes until the next delimiter):
// maxBytes bounds the WHOLE walk, and a single unterminated token could otherwise sit just under it.
const HISTORY_EDGES_MAX_TOKEN_CHARS = 128

/**
 * Stream every parent of every commit reachable from `tips`, as `commit`/`parent`/`end`
 * events from ONE `git rev-list` child. No commit body is read, so the stream does
 * not grow with message size. Parent ids are tokenised as they arrive, so no fixed
 * per-edge ceiling exists: the carry holds at most one partial id and the TOTAL
 * maxBytes/maxRecords budget is the only bound (an unbounded request is
 * deliberately unbounded). A budget overflow stops the child process group and
 * throws BEFORE the over-budget record is yielded, and a consumer that stops early
 * cancels the child in the generator finally block, which stops the group and does
 * not release custody until the child's group has settled — an exited child alone
 * is not proof, because a helper it started can still hold the pipes. stderr is
 * always drained but only a bounded tail is kept. The child leads its own process
 * group so a cancel reaches any helper Git started.
 *
 * Bytes are charged as the ONE canonical record (the OID, each ` <parent>`, a terminating
 * newline) — the SAME contract the mem backend charges, so a given cap is one wall on both
 * backends. The raw rev-list framing (the leading newline, the NUL separators) is NOT counted.
 */
async function* readHistoryEdges(
  resolveGitDir: (repo: string) => Promise<string>,
  executable: string,
  repo: string,
  tips: readonly Oid[],
  options: { readonly exclude?: readonly Oid[]; readonly maxBytes?: number; readonly maxRecords?: number } = {},
  baseEnv?: NodeJS.ProcessEnv,
): AsyncIterable<HistoryEdgeEvent> {
  const maxBytes = options.maxBytes === undefined ? undefined : normalizeHistoryEdgeByteCap(options.maxBytes)
  const maxRecords = options.maxRecords === undefined ? undefined : normalizeHistoryEdgeRecordCap(options.maxRecords)
  if (tips.length === 0) return
  for (const tip of tips) validateOid(tip, "invalid history tip")
  const gitdir = await resolveGitDir(repo)
  const exclude = (options.exclude ?? []).map((oid) => "^" + validateOid(oid, "invalid history exclusion"))
  const input = [...tips, ...exclude].join("\n") + "\n"
  const child = childProcess.spawn(
    executable,
    gitArgs(gitdir, ["rev-list", "--no-commit-header", "--format=%H%x00%P%x00", "--stdin"]),
    {
      env: { ...(baseEnv ?? process.env), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    },
  )
  const release = child.pid === undefined ? noRelease : holdGroup(child.pid, "forward")
  // Custody is released EXACTLY ONCE — and, for a walk that cannot PROVE teardown, only when the group
  // actually closes. Without this a child that exits after our bound stays in `heldGroups` forever, and the
  // next forwarded SIGTERM can target a process group id the OS has since REUSED.
  let released = false
  const releaseOnce = (): void => {
    if (released) return
    released = true
    release()
  }
  // stderr is always drained so a chatty child cannot block on a full pipe, but only a bounded tail is kept:
  // an unbounded Buffer[] would make this stream's memory grow with a runaway child's diagnostics.
  let stderrTail = Buffer.alloc(0)
  let stderrDropped = false
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrTail.length + chunk.length <= HISTORY_EDGES_STDERR_LIMIT_BYTES) {
      stderrTail = Buffer.concat([stderrTail, chunk])
      return
    }
    stderrDropped = true
    stderrTail = Buffer.from(chunk.subarray(Math.max(0, chunk.length - HISTORY_EDGES_STDERR_LIMIT_BYTES)))
  })
  child.stdin.on("error", ignoreChildStdinError)
  // A spawn failure (missing or non-executable Git) emits 'error' and may never emit 'close'; without this
  // listener Node raises it as an unhandled exception instead of a rejection the caller can act on.
  let spawnError: Error | undefined
  // `closed` (process AND its pipes) is the ONLY teardown proof. An exited child is not enough: a helper Git
  // started can inherit the pipes and keep the group alive after the child itself is gone.
  let teardownProven = false
  let escalation: ReturnType<typeof setTimeout> | undefined
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle) => {
    let settled = false
    const finish = (value: { code: number | null; signal: NodeJS.Signals | null }): void => {
      if (settled) return
      settled = true
      teardownProven = true
      // Clear the SIGKILL escalation: a timer left armed would signal -pid ~2 s later, and that pid may be gone
      // or REUSED by then, killing an unrelated process group.
      if (escalation !== undefined) {
        clearTimeout(escalation)
        escalation = undefined
      }
      settle(value)
      // Actual close is the ONLY moment custody may be dropped. In the unproven-teardown branch the walk throws
      // with the hold retained; this late-close finalizer is what releases it once the group really goes away.
      releaseOnce()
    }
    child.once("close", (code, signal) => finish({ code, signal }))
    child.once("error", (error: Error) => {
      spawnError = error
      child.stdout.destroy()
      child.stderr.destroy()
      finish({ code: null, signal: null })
    })
  })
  const kill = (): void => {
    stopProcess(child, "SIGTERM", true)
    if (escalation !== undefined) return
    escalation = setTimeout(() => {
      escalation = undefined
      stopProcess(child, "SIGKILL", true)
    }, GROUP_STOP_GRACE_MS)
    escalation.unref?.()
  }
  let bytes = 0
  let records = 0
  let carry = ""
  let pendingOid: string | undefined
  // Charge the ONE canonical record (the OID, each ` <parent>`, a newline) — the SAME unit the mem backend
  // charges — so a cap is one wall on both backends. Each accepted token is charged BEFORE its event is yielded;
  // the raw rev-list framing is not part of the contract.
  const chargeBytes = (cost: number): void => {
    bytes += cost
    if (maxBytes !== undefined && bytes > maxBytes) {
      kill()
      throw historyEdgesByteOverflow(repo, maxBytes, bytes)
    }
  }
  // Refuse a delimiter-free run before it becomes the carry buffer's size. `length` is always the whole
  // undelimited remainder, because the parser consumes each token up to its delimiter before looping.
  const refuseUndelimitedToken = (length: number): void => {
    if (length <= HISTORY_EDGES_MAX_TOKEN_CHARS) return
    kill()
    throw new Error(
      "git rev-list edges in " +
        repo +
        " returned an undelimited token of " +
        length +
        " characters (limit " +
        HISTORY_EDGES_MAX_TOKEN_CHARS +
        "); refusing rather than accumulating",
    )
  }
  let primaryFailure: unknown = undefined
  let hasPrimaryFailure = false
  try {
    child.stdin.end(input)
    try {
      for await (const chunk of child.stdout) {
        carry += decodeUtf8(chunk, "git rev-list edges")
        // Consume complete units. In the oid phase a unit ends at NUL; in the parents phase a unit ends at SPACE
        // or NUL, so a very wide merge is emitted token by token and the carry never holds a whole parent field.
        // There is deliberately no per-EDGE refusal (the ruled R3 limit is withdrawn): the TOTAL maxBytes budget,
        // charged per accepted record token, bounds the walk, and HISTORY_EDGES_MAX_TOKEN_CHARS refuses an
        // individual unterminated token.
        for (;;) {
          if (pendingOid === undefined) {
            const end = carry.indexOf("\0")
            if (end === -1) {
              refuseUndelimitedToken(carry.length)
              break
            }
            const oid = validateOid(
              stripLeadingNewlines(carry.slice(0, end)),
              "git rev-list returned a malformed history id",
            )
            carry = carry.slice(end + 1)
            pendingOid = oid
            chargeBytes(historyEdgeRecordStartBytes(oid))
            yield { kind: "commit", oid }
            continue
          }
          const space = carry.indexOf(" ")
          const nul = carry.indexOf("\0")
          const end = nul === -1 ? space : space === -1 ? nul : Math.min(space, nul)
          if (end === -1) {
            refuseUndelimitedToken(carry.length)
            break
          }
          const delimiter = carry[end]
          const token = carry.slice(0, end)
          carry = carry.slice(end + 1)
          if (token !== "") {
            const parent = validateOid(token, "git rev-list returned a malformed parent id")
            chargeBytes(historyEdgeParentBytes(parent))
            yield { kind: "parent", oid: parent }
          }
          if (delimiter === " ") continue
          records += 1
          if (maxRecords !== undefined && records > maxRecords) {
            kill()
            throw historyEdgesRecordOverflow(repo, maxRecords)
          }
          yield { kind: "end" }
          pendingOid = undefined
        }
      }
    } catch (cause) {
      // A failed spawn destroys the child's pipes; the stream error is not the story, the spawn error is.
      if (spawnError === undefined) throw cause
    }
    const { code, signal } = await closed
    if (spawnError !== undefined) {
      throw new Error("git rev-list edges could not start (" + spawnError.message + ") in " + repo, {
        cause: spawnError,
      })
    }
    if (carry.trim() !== "" || pendingOid !== undefined) {
      throw new Error("git rev-list returned trailing history-edge data in " + repo)
    }
    if (code !== 0) {
      const detail = stderrTail.toString("utf8").trim()
      const truncated = stderrDropped ? " [stderr tail; earlier output dropped]" : ""
      throw new Error(
        "git rev-list edges failed (" +
          (code ?? signal ?? "no exit") +
          ") in " +
          repo +
          (detail ? ": " + detail + truncated : truncated),
      )
    }
  } catch (cause) {
    // Remember the in-flight failure so a teardown refusal can CHAIN it instead of discarding it.
    hasPrimaryFailure = true
    primaryFailure = cause
    throw cause
  } finally {
    if (teardownProven) {
      releaseOnce()
    } else {
      // Custody must not outlive the walk: stop the group, then require `closed` — process AND pipes — as proof.
      kill()
      let settled = await settlesWithin(closed, GROUP_STOP_GRACE_MS + 1_000)
      if (!settled) {
        stopProcess(child, "SIGKILL", true)
        settled = await settlesWithin(closed, 1_000)
      }
      if (settled) {
        releaseOnce()
      } else {
        // Do NOT release: the group may still be running, and dropping the hold would orphan it silently.
        // The teardown refusal CHAINS any in-flight failure as its cause rather than discarding it.
        // oxlint-disable-next-line no-unsafe-finally -- the cause is preserved; see the line above.
        throw new HistoryEdgesTeardown(
          "git rev-list edges in " +
            repo +
            " left process group " +
            (child.pid ?? "?") +
            " unproven " +
            (GROUP_STOP_GRACE_MS + 2_000) +
            "ms after SIGKILL; custody retained (orphan escalation)",
          hasPrimaryFailure ? { cause: primaryFailure } : undefined,
        )
      }
    }
  }
}

/** Resolves true when `closed` settles within `ms`; a bound that elapses resolves false. */
async function settlesWithin(closed: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<boolean>((settle) => {
    timer = setTimeout(() => settle(false), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([
      closed.then(
        () => true,
        () => true,
      ),
      expired,
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Strip the newline(s) `git rev-list --format` writes between NUL-separated records. */
function stripLeadingNewlines(value: string): string {
  let start = 0
  while (start < value.length && value.charCodeAt(start) === 10) start += 1
  return value.slice(start)
}

function noRelease(): void {
  return undefined
}

function ignoreChildStdinError(): void {
  return undefined
}

async function compareAndSwap(
  repo: string,
  ref: string,
  next: Oid,
  expected: Oid,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<RefSwap> {
  const result = await run(selectedGit(), durableGitArgs(repo, ["update-ref", ref, next, expected]), { baseEnv })
  if (result.code === 0) return "swapped"
  const detail = result.stderr.toString("utf8").trim()
  if (isCompareAndSwapRejection(detail)) return "moved"
  if (isTransientRefLockContention(detail)) return "locked"
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

/** `merge-base --is-ancestor` answers 0 (reachable) or 1 (not); any other status is a fault, never an answer. */
async function isAncestor(repo: string, ancestor: Oid, descendant: Oid, baseEnv?: NodeJS.ProcessEnv): Promise<boolean> {
  const args = ["merge-base", "--is-ancestor", validateOid(ancestor), validateOid(descendant)]
  const result = await run(selectedGit(), gitArgs(repo, args), { baseEnv })
  if (result.code === 0) return true
  if (result.code === 1) return false
  throw commandFailure(repo, args, result)
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
 * - "moved": the ref is at `at`, not the `expected` value its lease named (a batched fetch's line names neither);
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

/**
 * Two line shapes. `cannot lock ref '<ref>': <why>` is git's lock and lease refusal everywhere. git 2.55's batched
 * fetch words a per-ref transaction failure as `fetching ref <ref> failed: <reason>` (builtin/fetch.c) with six
 * reasons; the three that mean another writer acted first map onto the same forms, without the ids the first shape
 * carries, and the other three (refname conflict, invalid new value, expected symref) match nothing (25850).
 */
const REF_LOCK_FAILURE =
  /^(.*?)(?:cannot lock ref '([^']+)': (?:is at ([0-9a-f]+) but expected ([0-9a-f]+)|(reference already exists)|reference is missing but expected ([0-9a-f]+)|(Unable to create '[^']*\.lock': File exists\.?))|fetching ref (\S+) failed: (incorrect old value provided|reference already exists|reference does not exist))\s*$/gm

const FETCH_REF_FORM = {
  "incorrect old value provided": "moved",
  "reference already exists": "exists",
  "reference does not exist": "missing",
} as const

/** Every ref lock or lease failure line in git's stderr, in order; the one reading of that text in this file. */
export function parseRefLockFailures(text: string): RefLockFailure[] {
  return [...text.matchAll(REF_LOCK_FAILURE)].map((match): RefLockFailure => {
    const [, reporter = "", lockRef, at, expected, exists, missingExpected, held, fetchRef, fetchReason] = match
    if (fetchRef !== undefined && fetchReason !== undefined) {
      return { reporter, ref: fetchRef, form: FETCH_REF_FORM[fetchReason as keyof typeof FETCH_REF_FORM] }
    }
    if (lockRef === undefined) throw new Error(`ref lock failure line matched with no ref: ${match[0]}`)
    const ref = lockRef
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
  syncRefs: (repo: string, updates: readonly RefUpdate[]) => Promise<void>,
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
      await syncRefs(repo, [{ ref: scratch, oid: null, expect: temporary }])
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
): Promise<{ readonly landed: false } | { readonly landed: true; readonly kept: RefSwap }> {
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
    if (isRemoteCompareAndSwapRejection(detail)) {
      // Journaled before the caller sees the loss (hh 25626). This site throws no Conflict to attach a journal failure
      // to, so that failure is said on stderr with its path and the lost lease is still answered.
      await journalLeaseRejection(repo, "compareAndSwapRemote", remote, [{ ref, expect: expected }])
      return { landed: false }
    }
    const rejected = rejectedPush(
      parsePushReport(result.stdout.toString("utf8")),
      [{ ref, expect: expected, oid: next }],
      detail,
    )
    if (rejected !== undefined) throw rejected
    throw new Error(`git push failed (${result.code})${detail ? `: ${detail}` : ""}`)
  }
  // Keep the local cache in step. A ref created by this push may not exist
  // locally yet: an all-zero expected then means "absent here too".
  const local = await optionalRef(repo, ref, baseEnv)
  if (local === expected || (local === undefined && isZeroOid(expected))) {
    return { landed: true, kept: await compareAndSwap(repo, ref, next, expected, baseEnv) }
  }
  return { landed: true, kept: "moved" }
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
 * A ref lock another writer holds is waited out FIRST: the whole transaction
 * re-runs, unchanged, after each pause in {@link PUBLISH_HELD_LOCK_PAUSES_MS}
 * (a prepare failure modifies nothing, so a re-run cannot double-apply), and
 * only a lock still held after the last pause is a Conflict on that ref,
 * observed "locked", so a chain race retries as contention should.
 *
 * On ANY other failure, the error text decides nothing: ONE `for-each-ref`
 * reads every ref in the transaction, and each is classified from that
 * structured output:
 * - at oid: `verify <ref> <oid>` (unchanged);
 * - at expect, or absent for a create: keep `update`;
 * - a delete keeps its `delete` line only at expect;
 * - at neither: Conflict naming the ref, expect and observed value, with no
 *   re-run.
 * With no Conflict, the whole transaction runs ONCE more with the rewritten
 * lines, and its failure is final. That is one process on success and at most
 * six on failure: four `update-ref` attempts (the first plus one per pause),
 * the `for-each-ref`, and the rewritten run.
 */
async function publishLocal(
  repo: string,
  updates: readonly RefUpdate[],
  baseEnv?: NodeJS.ProcessEnv,
): Promise<PublishResult> {
  const updateRefArgs = durableGitArgs(repo, ["update-ref", "--stdin"])
  const attempt = (unchanged: ReadonlySet<string>) =>
    run(selectedGit(), updateRefArgs, {
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

  let first = await attempt(new Set())
  if (first.code === 0) return outcomesOf(updates, new Set())
  let firstDetail = first.stderr.toString("utf8").trim()
  // A held ref lock is another live writer mid-update, often this same process adopting one fetched ref twice (hh
  // 28492: km's start fold and its publisher's first pass creating one item ref in one kept copy), or a lock a killed
  // git left behind. Wait it out and re-run the SAME transaction, as the fetch and the kept-copy refresh already do, so
  // a create that meets the ref the rival just made is classified from the re-read below: adopted at its oid, or a
  // Conflict naming that oid. Only a lock still held past the window is named "locked".
  for (const pause of PUBLISH_HELD_LOCK_PAUSES_MS) {
    if (lockHeld(firstDetail) === undefined) break
    // The caller's absolute deadline bounds this wait as it bounds every spawn: a pause that would outlive it is not
    // taken, and the publish stops here with AbsoluteDeadlineExpired, as the fetch loop does.
    remainingBeforeAbsoluteDeadline(selectedGit(), updateRefArgs, pause)
    await pauseFor(pause)
    first = await attempt(new Set())
    if (first.code === 0) return outcomesOf(updates, new Set())
    firstDetail = first.stderr.toString("utf8").trim()
  }
  const firstHeld = lockHeld(firstDetail)
  if (firstHeld !== undefined) throw firstHeld

  const current = await listRefs(
    repo,
    validateRefNames(updates.map(({ ref }) => ref)),
    undefined,
    DEFAULT_REMOTE_TIMEOUT_MS,
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
 * A porcelain report also retains rows that cannot prove refusal, so existing
 * lease and success readings keep their own semantics.
 */
type PushReport = {
  complete: boolean
  fates: Map<string, { flag: string; spec: string; summary: string }>
}

/** One reading of porcelain for single-ref and atomic pushes; incomplete rows cannot prove refusal. */
function parsePushReport(stdout: string): PushReport {
  const report: PushReport = { complete: true, fates: new Map() }
  for (const line of stdout.split("\n")) {
    if (line === "" || line === "Done" || line.startsWith("To ")) continue
    const fields = line.split("\t")
    const [flag, spec, summary] = fields
    if (flag === undefined || flag.length !== 1 || spec === undefined) {
      report.complete = false
      continue
    }
    if (fields.length !== 3 || summary === undefined || !spec.includes(":")) report.complete = false
    const ref = spec.slice(spec.indexOf(":") + 1)
    if (report.fates.has(ref)) report.complete = false
    report.fates.set(ref, { flag, spec, summary: summary ?? "" })
  }
  return report
}

/** Only an exact, complete remote refusal proves this invocation did not land; absence proves nothing. */
function rejectedPush(
  report: PushReport,
  updates: readonly RefUpdate[],
  detail: string,
): PublicationRejected | undefined {
  if (updates.length === 0 || !report.complete || report.fates.size !== updates.length) return undefined
  const reasons: string[] = []
  for (const { ref, oid } of updates) {
    const fate = report.fates.get(ref)
    if (
      fate?.flag !== "!" ||
      fate.spec !== `${oid ?? ""}:${ref}` ||
      !/^\[remote rejected\](?: \([^\r\n]*\))?$/.test(fate.summary)
    ) {
      return undefined
    }
    reasons.push(fate.summary)
  }
  return new PublicationRejected(updates, reasons, detail)
}

/**
 * MULTI, remotely: ONE atomic push with a lease per ref. Lease rejection keeps
 * its existing observation/journal contract; a complete explicit refusal is
 * PublicationRejected, while every ambiguous failure retains Git's detail.
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
  const report = parsePushReport(result.stdout.toString("utf8"))
  const { fates } = report
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
    if (stale.length === 0) {
      const rejected = rejectedPush(report, updates, detail)
      if (rejected !== undefined) throw rejected
      throw new Error(`git push failed (${result.code})${detail ? `: ${detail}` : ""}`)
    }
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
    const lost = stale.map(({ ref, expect }) => ({ ref, expect, observed: observed(ref) }))
    // Journaled before the Conflict is thrown (hh 25626); a journal failure rides on it as its cause, never instead.
    const journalFailure = await journalLeaseRejection(repo, "publishRemote", remote, lost)
    const conflict = leaseConflict(lost)
    if (journalFailure === undefined) throw conflict
    throw new Conflict(conflict.message, { refs: conflict.refs, cause: journalFailure })
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

function remoteWriteOutcomeUnknown(
  updates: readonly Pick<RefUpdate, "ref" | "expect">[],
  cause: unknown,
): RemoteWriteOutcomeUnknown {
  return new RemoteWriteOutcomeUnknown(updates, { cause })
}

async function diagnoseMissingObjectFetch(
  repo: string,
  remote: string,
  original: unknown,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<never> {
  if (original instanceof AbsoluteDeadlineExpired) throw original
  const message = original instanceof Error ? original.message : String(original)
  if (!isMissingObjectFetchError(message)) throw original
  const invoke = (args: readonly string[], options: RunGitOptions = {}) => {
    const localTimeoutMs = shellRuntime.getStore()?.localTimeoutMs
    return run(selectedGit(), args, {
      ...options,
      baseEnv,
      ...(localTimeoutMs === undefined
        ? {}
        : {
            timeoutMs: Math.min(options.timeoutMs ?? DANGLING_REF_SCAN_TIMEOUT_MS, localTimeoutMs),
          }),
    })
  }
  let dangling: readonly DanglingRef[]
  try {
    dangling = await danglingRefs(repo, { run: invoke })
  } catch (diagnosis) {
    if (diagnosis instanceof AbsoluteDeadlineExpired) throw diagnosis
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
    if (diagnosis instanceof AbsoluteDeadlineExpired) throw diagnosis
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
  // A rival that moved, created or deleted the ref first all lost us the same race (@cto edf7bf44, 25850).
  const lost = parseRefLockFailures(detail).filter(({ reporter }) => /(?:^|: )error: $/.test(reporter))
  if (lost.length === 0 || !lost.every(({ ref }) => ref.startsWith(namespace))) return undefined
  return lost.some(({ form }) => form === "held") ? "held" : "moved"
}

const HELD_LOCK_FLOOR_MS = 25
const HELD_LOCK_SPREAD_MS = 75

/** Full-jitter wait from @bearly/pacing (25676) over the held-lock window: never above HELD_LOCK_FLOOR_MS + HELD_LOCK_SPREAD_MS. */
export function waitOutHeldFetchLockMs(random: RandomUnit = Math.random): number {
  return HELD_LOCK_FLOOR_MS + Math.floor(fullJitter(HELD_LOCK_SPREAD_MS, HELD_LOCK_SPREAD_MS, 0, random))
}

/**
 * A local publish waits these out, re-running its transaction, before it names a ref lock another live writer holds
 * (hh 28492). Sized from the rival it waits for: km's publisher pass adopting every item ref a cold kept copy lacks in
 * ONE `update-ref`, which holds its first ref's lock from prepare to its last rename — measured 2026-10-12 on a cold
 * copy of the live STATE origin at 3,096 refs: p50 582 ms, max 624 ms (@cto 474f2c8c). Geometric ×3 to a cap of at
 * least twice that max; git's own `core.filesRefLockTimeout` wait (100 ms) inside every attempt adds to the reach.
 * The hold grows with N (every landed write adds a ref): when the adoption's N doubles, measure again and resize; past
 * that the window is stale. Fixed, not jittered: one process waiting on its own rival needs no spread, and a test can
 * name the pauses.
 */
const PUBLISH_HELD_LOCK_PAUSES_MS = [50, 150, 450, 1350] as const

/** The one pause both held-lock retries await; neither can outlive its caller. */
function pauseFor(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // raw-lifecycle-ok: the retry awaits this pause, so it cannot outlive its caller.
    setTimeout(resolve, ms)
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
  absent: "throw" | "omit" = "throw",
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
  // A named ref that may not exist is fetched as the pattern `ref*`, which git matches to nothing without an
  // error; the result is then filtered back to the exact names, so an over-match lands only in the namespace.
  const refspecs =
    prefix === undefined
      ? named.map((ref) => (absent === "omit" ? `+${ref}*:${local(ref)}*` : `+${ref}:${local(ref)}`))
      : [`+${prefix}*:${local(prefix)}*`]
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
      if (error instanceof AbsoluteDeadlineExpired) throw error
      // Another fetch in this repository moved or held one of our private
      // fetched refs between this fetch's read and its lock. The namespace is
      // only a cache of remote tips, so fetching again reads them afresh.
      const race = lostFetchedRefRace(error, namespace)
      if (race !== undefined && attempt < FETCH_RACE_ATTEMPTS) {
        if (race === "held") await pauseFor(waitOutHeldFetchLockMs())
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
  if (absent === "throw") {
    for (const ref of named) {
      if (!tips.has(ref)) throw new Error(`git fetch did not report ${ref} from ${remote}`)
    }
  }
  const exact = new Set(named)
  const matching = [...tips].filter(([ref]) => (prefix === undefined ? exact.has(ref) : refUnderPrefix(ref, prefix)))
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
