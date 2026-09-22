import childProcess, { type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { GitTimeout } from "./errors.js"
import {
  assertRefUpdates,
  leaseConflict,
  commitMeta,
  commitParents,
  formatCommitMessage,
  GENESIS_MESSAGE,
  GITOMIC_EMAIL,
  GITOMIC_NAME,
  INITIAL_TIMESTAMP,
  isZeroOid,
  objectOid,
  parseCommit,
  refUnderPrefix,
  TRANSACTION_SEARCH_LIMIT,
  transactionLookupExceeded,
  transactionMatches,
  validateOid,
} from "./git-object.js"
import { assertGitPrefixMatched, assertRegularBlob, normalizePrefix } from "./path.js"
import type { BlobValue, CommitInput, CommitMeta, GitomicBackend, Oid, PublishResult, RefUpdate } from "./types.js"
import { decodeBlob, decodeUtf8 } from "./utf8.js"

/** The complete output of one native Git command. */
export type GitResult = {
  stdout: Buffer
  stderr: Buffer
  code: number
}

type GitOptions = {
  env?: NodeJS.ProcessEnv
  input?: string | Buffer
  /** Stop the command, and every process it started, after this many milliseconds. */
  timeoutMs?: number
}

/** Options for {@link runGit}. */
export type RunGitOptions = GitOptions

/** Options for {@link createShellBackend}. */
export type ShellBackendOptions = {
  /**
   * Limit, in milliseconds, for each fetch from and push to a remote. A command
   * past it rejects with `GitTimeout`. Defaults to 20 000.
   */
  remoteTimeoutMs?: number
}

/** The default limit for one fetch or push to a remote. */
export const DEFAULT_REMOTE_TIMEOUT_MS = 20_000
/** How long a stopped process group gets between SIGTERM and SIGKILL. */
const GROUP_STOP_GRACE_MS = 2_000

const DURABLE_GIT_CONFIG = ["-c", "core.fsync=loose-object,reference", "-c", "core.fsyncMethod=fsync"] as const

export function createShellBackend(options: ShellBackendOptions = {}): GitomicBackend {
  return createShellRuntime(options).backend
}

export function createShellRuntime(options: ShellBackendOptions = {}): {
  backend: GitomicBackend
  resolveGitDir(repo: string): Promise<string>
  refStorage(repo: string): Promise<"files" | "native">
  objectFormat(repo: string): Promise<"sha1" | "sha256">
} {
  const remoteTimeoutMs = normalizeTimeoutMs(options.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS, "remoteTimeoutMs")
  const resolveGitDir = createGitDirResolver()
  const refStorages = new Map<string, Promise<"files" | "native">>()
  const objectFormats = new Map<string, Promise<"sha1" | "sha256">>()
  const genesisByGitDir = new Map<string, Promise<Oid>>()
  const refStorage = async (repo: string): Promise<"files" | "native"> =>
    resolveRefStorage(await resolveGitDir(repo), refStorages)
  const objectFormat = async (repo: string): Promise<"sha1" | "sha256"> => {
    const gitdir = await resolveGitDir(repo)
    let format = objectFormats.get(gitdir)
    if (format === undefined) {
      format = git(gitdir, ["rev-parse", "--show-object-format=storage"]).then((output) => {
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
    head: async (repo, ref) => head(await resolveGitDir(repo), ref),
    readCommit: async (repo, oid) => {
      validateOid(oid)
      const output = await git(await resolveGitDir(repo), ["cat-file", "--batch"], { input: `${oid}\n` })
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
    readFiles: async (repo, commit, prefix) => readFiles(await resolveGitDir(repo), commit, prefix),
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
    writeCommit: async (repo, input) => writeCommit(await resolveGitDir(repo), input),
    compareAndSwap: async (repo, ref, next, expected) => compareAndSwap(await resolveGitDir(repo), ref, next, expected),
    findTransaction: async (repo, tip, base, instance, seq) =>
      findTransaction(await resolveGitDir(repo), tip, base, instance, seq),
    fetchRemote: async (repo, ref, remote) => fetchRemote(await resolveGitDir(repo), ref, remote, remoteTimeoutMs),
    listRefs: async (repo, prefix, remote) => listRefs(await resolveGitDir(repo), prefix, remote, remoteTimeoutMs),
    readHistory: async (repo, tips, historyOptions) => readHistory(await resolveGitDir(repo), tips, historyOptions),
    writeGenesis: async (repo) => {
      const gitdir = await resolveGitDir(repo)
      let genesis = genesisByGitDir.get(gitdir)
      if (genesis === undefined) {
        genesis = writeGenesis(gitdir, await objectFormat(repo))
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
      compareAndSwapRemote(await resolveGitDir(repo), ref, next, expected, remote, remoteTimeoutMs),
    publish: async (repo, updates, remote) =>
      remote === undefined
        ? publishLocal(await resolveGitDir(repo), assertRefUpdates(updates))
        : publishRemote(await resolveGitDir(repo), assertRefUpdates(updates), remote, remoteTimeoutMs),
    fetchRefs: async (repo, refs, remote) => fetchRefs(await resolveGitDir(repo), refs, remote, remoteTimeoutMs),
  }
  return { backend, resolveGitDir, refStorage, objectFormat }
}

async function optionalRef(repo: string, ref: string): Promise<Oid | undefined> {
  const result = await run("git", gitArgs(repo, ["rev-parse", "--verify", "--quiet", ref]))
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

async function run(command: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  const timeoutMs = options.timeoutMs === undefined ? undefined : normalizeTimeoutMs(options.timeoutMs, "timeoutMs")
  return new Promise((resolveResult, reject) => {
    const bounded = timeoutMs !== undefined && process.platform !== "win32"
    const child = childProcess.spawn(command, args, {
      env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
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
    child.stdin.on("error", (error) => {
      // A command stopped at its limit closes stdin under a pending write; the
      // limit is then the reported outcome. Any other stdin failure is the result.
      if (!timedOut) settle(() => reject(error))
    })
    child.stdin.end(options.input)
  })
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
    const option = rest[0]!
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

export function createGitDirResolver(): (repo: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>()
  let supportedVersion: Promise<void> | undefined
  return (repo) => {
    const locator = resolve(repo)
    let gitdir = cache.get(locator)
    if (gitdir === undefined) {
      supportedVersion ??= requireSupportedGit()
      gitdir = supportedVersion
        .then(async () => run("git", ["-C", locator, "rev-parse", "--path-format=absolute", "--git-common-dir"]))
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

async function requireSupportedGit(): Promise<void> {
  const result = await run("git", ["--version"])
  const output = result.stdout.toString("utf8").trim()
  const match = /^git version (\d+)\.(\d+)(?:[.\s]|$)/.exec(output)
  const major = Number(match?.[1])
  const minor = Number(match?.[2])
  if (result.code !== 0 || match === null || major < 2 || (major === 2 && minor < 36)) {
    const found = output || result.stderr.toString("utf8").trim() || "unknown version"
    throw new Error(
      `Git 2.36 or newer is required for durable object and ref writes; found ${JSON.stringify(found)}. Upgrade Git, then open the store again.`,
    )
  }
}

async function git(repo: string, args: readonly string[], options: GitOptions = {}): Promise<Buffer> {
  const result = await run("git", gitArgs(repo, args), options)
  if (result.code !== 0) {
    const detail = result.stderr.toString("utf8").trim()
    throw new Error(`git ${args[0] ?? "command"} failed (${result.code})${detail ? `: ${detail}` : ""}`)
  }
  return result.stdout
}

async function gitWrite(repo: string, args: readonly string[], options: GitOptions = {}): Promise<Buffer> {
  const result = await run("git", durableGitArgs(repo, args), options)
  if (result.code !== 0) {
    const detail = result.stderr.toString("utf8").trim()
    throw new Error(`git ${args[0] ?? "command"} failed (${result.code})${detail ? `: ${detail}` : ""}`)
  }
  return result.stdout
}

function text(buffer: Buffer): string {
  return buffer.toString("utf8").trim()
}

async function head(repo: string, ref: string): Promise<Oid> {
  return text(await git(repo, ["rev-parse", "--verify", ref]))
}

async function readFiles(repo: string, commit: Oid, prefix?: string): Promise<ReadonlyMap<string, BlobValue>> {
  const normalizedPrefix = prefix === undefined ? "" : normalizePrefix(prefix)
  const listing = await git(repo, ["ls-tree", "-r", "-z", "--full-tree", commit])
  const entries: Array<{ oid: Oid; path: string }> = []
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
    entries.push({ oid, path })
  }
  assertGitPrefixMatched(entries.length, repo, commit, normalizedPrefix)
  if (entries.length === 0) return new Map()

  const output = await git(repo, ["cat-file", "--batch"], {
    input: `${entries.map((entry) => entry.oid).join("\n")}\n`,
  })
  return parseBatch(entries, output)
}

function parseBatch(
  entries: ReadonlyArray<{ oid: Oid; path: string }>,
  output: Buffer,
): ReadonlyMap<string, BlobValue> {
  const files = new Map<string, BlobValue>()
  let offset = 0
  for (const entry of entries) {
    const newline = output.indexOf(0x0a, offset)
    if (newline < 0) throw new Error("git cat-file --batch returned a truncated header")
    const header = output.toString("utf8", offset, newline)
    const match = /^([0-9a-f]+) blob ([0-9]+)$/.exec(header)
    if (match === null || match[1] !== entry.oid) {
      throw new Error(`git cat-file --batch returned an unexpected object: ${header}`)
    }
    const size = Number(match[2])
    const start = newline + 1
    const end = start + size
    if (!Number.isSafeInteger(size) || size < 0 || end >= output.length || output[end] !== 0x0a) {
      throw new Error(`git cat-file --batch returned a malformed blob for ${entry.oid}`)
    }
    files.set(entry.path, decodeBlob(output.subarray(start, end)))
    offset = end + 1
  }
  if (offset !== output.length) throw new Error("git cat-file --batch returned trailing data")
  return files
}

async function writeCommit(repo: string, input: CommitInput): Promise<Oid> {
  const parents = commitParents(input)
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
    const [tree, parentTime] = text(await git(repo, ["show", "-s", "--format=%T%x00%ct", input.parent])).split("\0")
    return commitTree(repo, validateOid(tree, "invalid parent tree id"), parents, Number(parentTime), message)
  }
  const indexDir = await mkdtemp(join(tmpdir(), "gitomic-index-"))
  const index = join(indexDir, "index")
  const indexEnv = { GIT_INDEX_FILE: index }
  try {
    await gitWrite(repo, ["read-tree", input.parent], { env: indexEnv })
    const changes = [...input.changes]
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
        Buffer.from(`${content === undefined ? "0" : "100644"} ${oid}\t`, "utf8"),
        Buffer.from(path, "utf8"),
        Buffer.from([0]),
      )
    }
    await gitWrite(repo, ["update-index", "--add", "-z", "--index-info"], {
      env: indexEnv,
      input: Buffer.concat(indexInfo),
    })
    const tree = text(await gitWrite(repo, ["write-tree"], { env: indexEnv }))
    const parentTime = Number(text(await git(repo, ["show", "-s", "--format=%ct", input.parent])))
    return commitTree(repo, tree, parents, parentTime, message)
  } finally {
    await rm(indexDir, { recursive: true, force: true })
  }
}

/** Write one commit with gitomic's identity, one second after its first parent. */
async function commitTree(
  repo: string,
  tree: Oid,
  parents: readonly Oid[],
  parentTime: number,
  message: string,
): Promise<Oid> {
  const timestamp = Number.isFinite(parentTime) ? parentTime + 1 : 1
  const args = ["commit-tree", tree]
  for (const parent of parents) args.push("-p", parent)
  return text(await gitWrite(repo, args, { env: identityEnv(timestamp), input: message }))
}

function identityEnv(timestamp: number): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: GITOMIC_NAME,
    GIT_AUTHOR_EMAIL: GITOMIC_EMAIL,
    GIT_COMMITTER_NAME: GITOMIC_NAME,
    GIT_COMMITTER_EMAIL: GITOMIC_EMAIL,
    GIT_AUTHOR_DATE: `@${timestamp} +0000`,
    GIT_COMMITTER_DATE: `@${timestamp} +0000`,
  }
}

/**
 * Write the empty root every event chain starts from. The empty tree is one
 * git always has, so this is one `commit-tree`; the same bytes on every run
 * give the same oid, which is what makes it idempotent.
 */
async function writeGenesis(repo: string, format: "sha1" | "sha256"): Promise<Oid> {
  const emptyTree = objectOid("tree", Buffer.alloc(0), format)
  return text(
    await gitWrite(repo, ["commit-tree", emptyTree], { env: identityEnv(INITIAL_TIMESTAMP), input: GENESIS_MESSAGE }),
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
): Promise<ReadonlyMap<string, Oid>> {
  if (typeof prefix !== "string" || !prefix.startsWith("refs/")) {
    throw new TypeError(`listRefs prefix must start with refs/: ${JSON.stringify(prefix)}`)
  }
  const pairs: Array<[string, Oid]> = []
  if (remote === undefined) {
    const output = await git(repo, ["for-each-ref", "--format=%(objectname) %(refname)", prefix])
    for (const line of decodeUtf8(output, "git for-each-ref").split("\n")) {
      if (line === "") continue
      const space = line.indexOf(" ")
      pairs.push([line.slice(space + 1), validateOid(line.slice(0, space), "git for-each-ref returned a malformed id")])
    }
  } else {
    const patterns = prefix.endsWith("/") ? [`${prefix}*`] : [prefix, `${prefix}/*`]
    const output = await git(repo, ["ls-remote", "--refs", remote, ...patterns], { timeoutMs })
    for (const line of decodeUtf8(output, "git ls-remote").split("\n")) {
      if (line === "") continue
      const tab = line.indexOf("\t")
      pairs.push([line.slice(tab + 1), validateOid(line.slice(0, tab), "git ls-remote returned a malformed id")])
    }
  }
  const matching = pairs.filter(([ref]) => refUnderPrefix(ref, prefix))
  return new Map(matching.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/**
 * First-parent history of every tip in ONE process. Records are NUL-separated
 * and the body is never split on lines, so a message holding blank lines or a
 * NUL-free "Key: value" line cannot shift the parse.
 */
async function readHistory(
  repo: string,
  tips: readonly Oid[],
  options: { readonly exclude?: readonly Oid[]; readonly limit?: number } = {},
): Promise<CommitMeta[]> {
  if (tips.length === 0) return []
  for (const tip of tips) validateOid(tip, "invalid history tip")
  const exclude = (options.exclude ?? []).map((oid) => `^${validateOid(oid, "invalid history exclusion")}`)
  const limit = options.limit === undefined ? [] : [`--max-count=${options.limit}`]
  const output = await git(repo, [
    "rev-list",
    "--first-parent",
    ...limit,
    "--no-commit-header",
    "--format=%H%x00%P%x00%ct%x00%B%x00",
    ...tips,
    ...exclude,
  ])
  const fields = decodeUtf8(output, "git rev-list history").split("\0")
  const trailing = fields.pop()
  if (trailing?.trim()) throw new Error("git rev-list returned trailing history data")
  if (fields.length % 4 !== 0) throw new Error("git rev-list returned a malformed history record")
  const commits: CommitMeta[] = []
  for (let index = 0; index < fields.length; index += 4) {
    const oid = validateOid(fields[index]?.replace(/^\n/, ""), "git rev-list returned a malformed history id")
    const rawParents = fields[index + 1] ?? ""
    const parents = rawParents === "" ? [] : rawParents.split(" ").map((parent) => validateOid(parent))
    const timestamp = Number(fields[index + 2])
    if (!Number.isSafeInteger(timestamp)) throw new Error(`git rev-list returned an invalid time for ${oid}`)
    commits.push(commitMeta(oid, parents, timestamp, fields[index + 3] ?? ""))
  }
  return commits
}

async function compareAndSwap(repo: string, ref: string, next: Oid, expected: Oid): Promise<boolean> {
  const result = await run("git", durableGitArgs(repo, ["update-ref", ref, next, expected]))
  if (result.code === 0) return true
  const detail = result.stderr.toString("utf8").trim()
  if (isCompareAndSwapRejection(detail) || isTransientRefLockContention(detail)) return false
  throw new Error(`git update-ref failed (${result.code})${detail ? `: ${detail}` : ""}`)
}

async function resolveRefStorage(
  repo: string,
  pending: Map<string, Promise<"files" | "native">>,
): Promise<"files" | "native"> {
  let storage = pending.get(repo)
  if (storage === undefined) {
    storage = run("git", gitArgs(repo, ["config", "--get", "extensions.refStorage"])).then((result) => {
      if (result.code === 1) return "files"
      if (result.code !== 0) {
        const detail = result.stderr.toString("utf8").trim()
        throw new Error(`cannot inspect Git ref storage${detail ? `: ${detail}` : ""}`)
      }
      return text(result.stdout) === "files" ? "files" : "native"
    })
    pending.set(repo, storage)
  }
  try {
    return await storage
  } catch (error) {
    pending.delete(repo)
    throw error
  }
}

async function deleteRef(repo: string, ref: string, oid: Oid, failure: string): Promise<void> {
  const result = await run("git", durableGitArgs(repo, ["update-ref", "-d", ref, oid]))
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
): Promise<Oid | undefined> {
  // `^base` is the stop condition: the sought commit is a child of `base`, so
  // one process reads only what arrived after it, however deep the history is.
  const output = await git(repo, [
    "rev-list",
    "--first-parent",
    `--max-count=${TRANSACTION_SEARCH_LIMIT + 1}`,
    "--no-commit-header",
    "--format=%H%x00%B%x00",
    tip,
    `^${base}`,
  ])
  const commits = parseTransactionHistory(output)
  for (const commit of commits.slice(0, TRANSACTION_SEARCH_LIMIT)) {
    if (transactionMatches(commit.message, instance, seq)) return commit.oid
  }
  if (commits.length > TRANSACTION_SEARCH_LIMIT) {
    throw transactionLookupExceeded(instance, seq)
  }
  return undefined
}

function isCompareAndSwapRejection(detail: string): boolean {
  return (
    /cannot lock ref .*: is at [0-9a-f]+ but expected [0-9a-f]+/.test(detail) ||
    /cannot lock ref .*: reference already exists/.test(detail) ||
    /cannot lock ref .*: reference is missing but expected [0-9a-f]+/.test(detail)
  )
}

function isTransientRefLockContention(detail: string): boolean {
  return /cannot lock ref .*\.lock['"]?: File exists\.?/.test(detail)
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

async function fetchRemote(repo: string, ref: string, remote: string, timeoutMs: number): Promise<Oid> {
  const scratch = `refs/gitomic/fetch/${randomUUID()}`
  let fetched: Oid | undefined
  try {
    await gitWrite(repo, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, `${ref}:${scratch}`], {
      timeoutMs,
    })
    fetched = await head(repo, scratch)
    return fetched
  } finally {
    const temporary = fetched ?? (await optionalRef(repo, scratch))
    if (temporary !== undefined) {
      await deleteRef(repo, scratch, temporary, `cannot release temporary fetch ref ${scratch}`)
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
): Promise<boolean> {
  const result = await run(
    "git",
    durableGitArgs(repo, ["push", "--porcelain", `--force-with-lease=${ref}:${expected}`, remote, `${next}:${ref}`]),
    { timeoutMs },
  )
  if (result.code !== 0) {
    const detail = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`.trim()
    if (isRemoteCompareAndSwapRejection(detail)) return false
    throw new Error(`git push failed (${result.code})${detail ? `: ${detail}` : ""}`)
  }
  // Keep the local cache in step. A ref created by this push may not exist
  // locally yet: an all-zero expected then means "absent here too".
  const local = await optionalRef(repo, ref)
  if (local === expected || (local === undefined && isZeroOid(expected))) {
    await compareAndSwap(repo, ref, next, expected)
  }
  return true
}

/** git's update-ref report of the ref it could not lock, one anchored shape per case. */
const LOST_AT =
  /^fatal: (?:\w+: )?cannot lock ref '([^']+)': is at ([0-9a-f]{40}|[0-9a-f]{64}) but expected (?:[0-9a-f]{40}|[0-9a-f]{64})$/m
const LOST_EXISTS = /^fatal: (?:\w+: )?cannot lock ref '([^']+)': reference already exists$/m
const LOST_MISSING =
  /^fatal: (?:\w+: )?cannot lock ref '([^']+)': reference is missing but expected (?:[0-9a-f]{40}|[0-9a-f]{64})$/m

type LockFailure = { readonly ref: string; readonly observed: Oid | "absent" | undefined }

/** The ref update-ref named and what it found there, or undefined for any other failure. */
function lockFailure(detail: string): LockFailure | undefined {
  const at = LOST_AT.exec(detail)
  if (at !== null) return { ref: at[1] as string, observed: at[2] as Oid }
  const exists = LOST_EXISTS.exec(detail)
  // "already exists" prints no value; the caller reads it if it must decide.
  if (exists !== null) return { ref: exists[1] as string, observed: undefined }
  const missing = LOST_MISSING.exec(detail)
  if (missing !== null) return { ref: missing[1] as string, observed: "absent" }
  return undefined
}

function outcomesOf(updates: readonly RefUpdate[], unchanged: ReadonlySet<string>): PublishResult {
  return {
    outcomes: updates.map(({ ref, expect, oid }) => ({
      ref,
      outcome: unchanged.has(ref) || expect === oid ? ("unchanged" as const) : ("updated" as const),
    })),
  }
}

/**
 * MULTI, locally: ONE `update-ref --stdin` transaction. Git checks every lease
 * under the ref locks before committing any of them, so either every ref moves
 * or none does.
 *
 * A ref already at its target is unchanged, as `push --atomic` treats it. When
 * the transaction fails with one of git's lock-failure shapes, ONE
 * `for-each-ref` reads every ref this publish names. That read happens on the
 * failure path only, and it decides between verify and Conflict. A ref at
 * neither its lease nor its target is a Conflict naming the ref, the lease and
 * the tip. Otherwise the transaction runs ONCE more, with each ref already at
 * its target as `verify <ref> <oid>`, so the unchanged refs are verified inside
 * it. The re-run's failure is final and it never loops. That is one process on
 * success and at most three on failure. A failure that is not a lock failure of
 * those shapes is an Error carrying git's text.
 */
async function publishLocal(repo: string, updates: readonly RefUpdate[]): Promise<PublishResult> {
  const attempt = (unchanged: ReadonlySet<string>) =>
    run("git", durableGitArgs(repo, ["update-ref", "--stdin"]), {
      input: [
        "start",
        ...updates.map(({ ref, expect, oid }) =>
          unchanged.has(ref) ? `verify ${ref} ${oid}` : `update ${ref} ${oid} ${expect}`,
        ),
        "prepare",
        "commit",
        "",
      ].join("\n"),
    })
  const failed = (code: number | null, detail: string) =>
    new Error(`git update-ref --stdin failed (${code})${detail ? `: ${detail}` : ""}`)

  const first = await attempt(new Set())
  if (first.code === 0) return outcomesOf(updates, new Set())
  const firstDetail = first.stderr.toString("utf8").trim()
  if (lockFailure(firstDetail) === undefined) throw failed(first.code, firstDetail)

  const current = await readExactRefs(
    repo,
    updates.map(({ ref }) => ref),
  )
  const lost = updates
    .map(({ ref, expect, oid }) => ({ ref, expect, oid, tip: current.get(ref) }))
    .filter(({ expect, oid, tip }) => tip !== oid && (isZeroOid(expect) ? tip !== undefined : tip !== expect))
  if (lost.length > 0) {
    throw leaseConflict(lost.map(({ ref, expect, tip }) => ({ ref, expect, observed: tip ?? "absent" })))
  }
  const unchanged = new Set(updates.filter(({ ref, oid }) => current.get(ref) === oid).map(({ ref }) => ref))
  if (unchanged.size === 0) throw failed(first.code, firstDetail)

  const second = await attempt(unchanged)
  if (second.code === 0) return outcomesOf(updates, unchanged)
  const secondDetail = second.stderr.toString("utf8").trim()
  const lostAgain = lockFailure(secondDetail)
  if (lostAgain === undefined) throw failed(second.code, secondDetail)
  const update = updates.find(({ ref }) => ref === lostAgain.ref)
  if (update === undefined) throw failed(second.code, secondDetail)
  throw leaseConflict([{ ref: lostAgain.ref, expect: update.expect, observed: lostAgain.observed ?? "present" }])
}

/** Exactly these refs and their tips, in ONE `for-each-ref`; an absent ref is simply missing. */
async function readExactRefs(repo: string, refs: readonly string[]): Promise<ReadonlyMap<string, Oid>> {
  const output = await git(repo, ["for-each-ref", "--format=%(objectname) %(refname)", ...refs])
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

/**
 * MULTI, remotely: ONE `push --atomic`, a lease per ref, exactly as git does it:
 * no pre-read, and no local ref touched (in remote mode reads go through
 * {@link fetchRefs}, so no local ref is a cache of the remote). Porcelain names
 * each ref's fate: "=" unchanged; "*", " " and "+" updated; "[rejected] (stale
 * info)" a lost lease, whose tip git does not report. Anything that is not a
 * per-ref rejection (network, auth, a missing remote) is an Error with git's text.
 */
async function publishRemote(
  repo: string,
  updates: readonly RefUpdate[],
  remote: string,
  timeoutMs: number,
): Promise<PublishResult> {
  const args = [
    "push",
    "--atomic",
    "--porcelain",
    ...updates.map(({ ref, expect }) => `--force-with-lease=${ref}:${expect}`),
    remote,
    ...updates.map(({ ref, oid }) => `${oid}:${ref}`),
  ]
  const result = await run("git", durableGitArgs(repo, args), { timeoutMs })
  const detail = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`.trim()
  const fates = new Map<string, { flag: string; summary: string }>()
  for (const line of result.stdout.toString("utf8").split("\n")) {
    const [flag, spec, summary] = line.split("\t")
    if (flag === undefined || spec === undefined || flag.length !== 1) continue
    fates.set(spec.slice(spec.indexOf(":") + 1), { flag, summary: summary ?? "" })
  }
  if (result.code !== 0) {
    const stale = updates.filter(({ ref }) => {
      const fate = fates.get(ref)
      return (
        fate?.flag === "!" &&
        (fate.summary === "[rejected] (stale info)" ||
          fate.summary === "[remote rejected] (incorrect old value provided)")
      )
    })
    if (stale.length === 0) throw new Error(`git push failed (${result.code})${detail ? `: ${detail}` : ""}`)
    throw leaseConflict(stale.map(({ ref, expect }) => ({ ref, expect, observed: "a tip the remote did not report" })))
  }
  return {
    outcomes: updates.map(({ ref }) => {
      const flag = fates.get(ref)?.flag
      if (flag === "=") return { ref, outcome: "unchanged" as const }
      if (flag === "*" || flag === " " || flag === "+") return { ref, outcome: "updated" as const }
      throw new Error(`git push succeeded without reporting ${ref} as updated or up to date: ${detail}`)
    }),
  }
}

/**
 * gitomic's private tracking namespace for one remote: the remote NAME when it is
 * a plain name, else `url-` plus the URL in unpadded base64url, which is ref-safe
 * and reversible. It holds only gitomic's bookkeeping, never an application ref.
 */
export function fetchedNamespace(remote: string): string {
  const key =
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote) && !remote.endsWith(".lock") && !remote.includes("..")
      ? remote
      : `url-${Buffer.from(remote, "utf8").toString("base64url")}`
  return `refs/gitomic/fetched/${key}/`
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
  const output = await git(
    repo,
    [
      "fetch",
      "--verbose",
      "--porcelain",
      "--no-tags",
      "--no-write-fetch-head",
      ...(prefix === undefined ? [] : ["--prune"]),
      remote,
      ...refspecs,
    ],
    { timeoutMs },
  )
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
