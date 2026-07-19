import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, open as openFile, rename, rm, unlink } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import {
  formatCommitMessage,
  GITOMIC_EMAIL,
  GITOMIC_NAME,
  TRANSACTION_SEARCH_LIMIT,
  transactionLookupExceeded,
  transactionMatches,
  validateOid,
} from "./git-object.js"
import { assertRegularBlob } from "./path.js"
import type { CommitInput, GitomicBackend, Oid } from "./types.js"
import { decodeUtf8 } from "./utf8.js"

type GitResult = {
  stdout: Buffer
  stderr: Buffer
  code: number
}

type GitOptions = {
  env?: NodeJS.ProcessEnv
  input?: string | Buffer
}

type PinnedCommit = {
  oid: Oid
  ref: string
  released: boolean
}

const DURABLE_GIT_CONFIG = ["-c", "core.fsync=loose-object,reference", "-c", "core.fsyncMethod=fsync"] as const

export function createShellBackend(): GitomicBackend {
  return createShellRuntime().backend
}

export function createShellRuntime(): {
  backend: GitomicBackend
  resolveGitDir(repo: string): Promise<string>
  refStorage(repo: string): Promise<"files" | "native">
  objectFormat(repo: string): Promise<"sha1" | "sha256">
  pinCommit(repo: string, writer: string, oid: Oid): Promise<void>
} {
  const resolveGitDir = createGitDirResolver()
  const pins = new Map<string, PinnedCommit>()
  const inflightDirectories = new Map<string, Promise<void>>()
  const refStorages = new Map<string, Promise<"files" | "native">>()
  const objectFormats = new Map<string, Promise<"sha1" | "sha256">>()
  const refStorage = async (repo: string): Promise<"files" | "native"> =>
    await resolveRefStorage(await resolveGitDir(repo), refStorages)
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
  const pinCommit = async (repo: string, writer: string, oid: Oid): Promise<void> => {
    const gitdir = await resolveGitDir(repo)
    const ref = inflightRef(writer)
    const key = pinKey(gitdir, oid)
    if (pins.has(key)) throw new Error(`commit ${oid} is already pinned by this backend`)
    const storage = await refStorage(repo)
    if (storage === "files") await ensureInflightDirectory(gitdir, inflightDirectories)
    const pin = await writeInflightRef(gitdir, ref, oid, storage)
    pins.set(key, pin)
  }
  const withPinnedCommit = async <T>(
    repo: string,
    oid: Oid,
    operation: (gitdir: string, pin: PinnedCommit | undefined) => Promise<T>,
  ): Promise<T> => {
    const gitdir = await resolveGitDir(repo)
    const key = pinKey(gitdir, oid)
    const pin = pins.get(key)
    try {
      return await operation(gitdir, pin)
    } finally {
      if (pin !== undefined) {
        try {
          await releasePinnedCommit(gitdir, pin)
        } finally {
          pins.delete(key)
        }
      }
    }
  }
  const backend: GitomicBackend = {
    acquireWriter: async (repo, writer) => await acquireWriterLease(await resolveGitDir(repo), writer),
    head: async (repo, ref) => await head(await resolveGitDir(repo), ref),
    readFiles: async (repo, commit) => await readFiles(await resolveGitDir(repo), commit),
    writeCommit: async (repo, input) => {
      const oid = await writeCommit(await resolveGitDir(repo), input)
      await pinCommit(repo, input.writer, oid)
      return oid
    },
    compareAndSwap: async (repo, ref, next, expected) =>
      await withPinnedCommit(repo, next, async (gitdir, pin) =>
        pin === undefined
          ? await compareAndSwap(gitdir, ref, next, expected)
          : await compareAndSwapPinned(gitdir, ref, next, expected, pin),
      ),
    findTransaction: async (repo, tip, writer, seq) =>
      await findTransaction(await resolveGitDir(repo), tip, writer, seq),
    fetchRemote: async (repo, ref, remote) => await fetchRemote(await resolveGitDir(repo), ref, remote),
    compareAndSwapRemote: async (repo, ref, next, expected, remote) =>
      await withPinnedCommit(
        repo,
        next,
        async (gitdir, pin) => await compareAndSwapRemote(gitdir, ref, next, expected, remote, pin),
      ),
  }
  return { backend, resolveGitDir, refStorage, objectFormat, pinCommit }
}

type WriterLease = {
  writer: string
  instance: string
  pid: number
  host: string
  openedAt: string
}

async function acquireWriterLease(repo: string, writer: string): Promise<void> {
  const ref = writerLeaseRef(writer)
  const lease: WriterLease = {
    writer,
    instance: randomUUID(),
    pid: process.pid,
    host: hostname(),
    openedAt: new Date().toISOString(),
  }
  const next = validateOid(
    text(await gitWrite(repo, ["hash-object", "-w", "--stdin"], { input: `${JSON.stringify(lease)}\n` })),
  )
  while (true) {
    const current = await optionalRef(repo, ref)
    if (current !== undefined) {
      const owner = await readWriterLease(repo, ref, current, writer)
      if (owner.host !== lease.host) {
        throw new Error(
          `writer ${JSON.stringify(writer)} is leased on host ${JSON.stringify(owner.host)}; pass a unique writer, or delete ${ref} only after proving that host's owner is gone`,
        )
      }
      if (isProcessAlive(owner.pid)) {
        throw new Error(
          `writer ${JSON.stringify(writer)} is already open in process ${owner.pid}; pass a unique writer for each live process`,
        )
      }
    }
    const expected = current ?? "0".repeat(next.length)
    const result = await run("git", durableGitArgs(repo, ["update-ref", ref, next, expected]))
    if (result.code === 0) return
    const detail = result.stderr.toString("utf8").trim()
    if (isCompareAndSwapRejection(detail)) continue
    throw new Error(`cannot acquire writer lease ${ref}${detail ? `: ${detail}` : ""}`)
  }
}

async function optionalRef(repo: string, ref: string): Promise<Oid | undefined> {
  const result = await run("git", gitArgs(repo, ["rev-parse", "--verify", "--quiet", ref]))
  if (result.code === 1 && result.stdout.length === 0) return undefined
  if (result.code !== 0) {
    const detail = result.stderr.toString("utf8").trim()
    throw new Error(`cannot inspect writer lease ${ref}${detail ? `: ${detail}` : ""}`)
  }
  return validateOid(text(result.stdout), `writer lease ${ref} points to an invalid Git object id`)
}

async function readWriterLease(repo: string, ref: string, oid: Oid, writer: string): Promise<WriterLease> {
  let bytes: Buffer
  try {
    bytes = await git(repo, ["cat-file", "blob", oid])
  } catch (error) {
    throw new Error(
      `cannot read gitomic writer lease ${ref}; inspect or delete the ref after proving its owner is gone`,
      {
        cause: error,
      },
    )
  }
  const raw = decodeUtf8(bytes, `gitomic writer lease ${ref}`)
  try {
    const value: unknown = JSON.parse(raw)
    if (
      typeof value === "object" &&
      value !== null &&
      "writer" in value &&
      value.writer === writer &&
      "instance" in value &&
      typeof value.instance === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.instance) &&
      "pid" in value &&
      typeof value.pid === "number" &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      "host" in value &&
      typeof value.host === "string" &&
      value.host.length > 0 &&
      "openedAt" in value &&
      typeof value.openedAt === "string" &&
      !Number.isNaN(Date.parse(value.openedAt))
    ) {
      return value as WriterLease
    }
  } catch {
    // Report one stable, actionable error below.
  }
  throw new Error(`invalid gitomic writer lease ${ref}; inspect or delete the ref after proving its owner is gone`)
}

function writerLeaseRef(writer: string): string {
  const id = createHash("sha256").update(writer, "utf8").digest("hex")
  return `refs/gitomic/writers/${id}`
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !isNodeError(error) || error.code !== "ESRCH"
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

function pinKey(repo: string, oid: Oid): string {
  return `${repo}\0${oid}`
}

function inflightRef(writer: string): string {
  const id = createHash("sha256").update(writer, "utf8").digest("hex")
  return `refs/gitomic/inflight/${id}`
}

async function run(command: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.once("error", reject)
    child.once("close", (code) => {
      resolveResult({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        code: code ?? 1,
      })
    })
    child.stdin.end(options.input)
  })
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
        .then(async () => await run("git", ["-C", locator, "rev-parse", "--path-format=absolute", "--git-common-dir"]))
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

async function readFiles(repo: string, commit: Oid): Promise<ReadonlyMap<string, string>> {
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
    assertRegularBlob(path, mode, type)
    entries.push({ oid, path })
  }
  if (entries.length === 0) return new Map()

  const output = await git(repo, ["cat-file", "--batch"], {
    input: `${entries.map((entry) => entry.oid).join("\n")}\n`,
  })
  return parseBatch(entries, output)
}

function parseBatch(entries: ReadonlyArray<{ oid: Oid; path: string }>, output: Buffer): ReadonlyMap<string, string> {
  const files = new Map<string, string>()
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
    files.set(entry.path, decodeUtf8(output.subarray(start, end), `Git blob at ${JSON.stringify(entry.path)}`))
    offset = end + 1
  }
  if (offset !== output.length) throw new Error("git cat-file --batch returned trailing data")
  return files
}

async function writeCommit(repo: string, input: CommitInput): Promise<Oid> {
  const indexDir = await mkdtemp(join(tmpdir(), "gitomic-index-"))
  const index = join(indexDir, "index")
  const indexEnv = { GIT_INDEX_FILE: index }
  try {
    await gitWrite(repo, ["read-tree", input.parent], { env: indexEnv })
    for (const [path, content] of input.changes) {
      if (content === undefined) {
        await gitWrite(repo, ["update-index", "-z", "--index-info"], {
          env: indexEnv,
          input: Buffer.concat([
            Buffer.from(`0 ${"0".repeat(input.parent.length)}\t`, "utf8"),
            Buffer.from(path, "utf8"),
            Buffer.from([0]),
          ]),
        })
        continue
      }
      const blob = text(await gitWrite(repo, ["hash-object", "-w", "--stdin"], { input: content }))
      await gitWrite(repo, ["update-index", "--add", "--cacheinfo", "100644", blob, path], { env: indexEnv })
    }
    const tree = text(await gitWrite(repo, ["write-tree"], { env: indexEnv }))
    const parentTime = Number(text(await git(repo, ["show", "-s", "--format=%ct", input.parent])))
    const timestamp = Number.isFinite(parentTime) ? parentTime + 1 : 1
    const identityEnv = {
      GIT_AUTHOR_NAME: GITOMIC_NAME,
      GIT_AUTHOR_EMAIL: GITOMIC_EMAIL,
      GIT_COMMITTER_NAME: GITOMIC_NAME,
      GIT_COMMITTER_EMAIL: GITOMIC_EMAIL,
      GIT_AUTHOR_DATE: `@${timestamp} +0000`,
      GIT_COMMITTER_DATE: `@${timestamp} +0000`,
    }
    return text(
      await gitWrite(repo, ["commit-tree", tree, "-p", input.parent], {
        env: identityEnv,
        input: formatCommitMessage(input.writer, input.message, input.seq),
      }),
    )
  } finally {
    await rm(indexDir, { recursive: true, force: true })
  }
}

async function compareAndSwap(repo: string, ref: string, next: Oid, expected: Oid): Promise<boolean> {
  const result = await run("git", durableGitArgs(repo, ["update-ref", ref, next, expected]))
  if (result.code === 0) return true
  const detail = result.stderr.toString("utf8").trim()
  if (isCompareAndSwapRejection(detail) || isTransientRefLockContention(detail)) return false
  throw new Error(`git update-ref failed (${result.code})${detail ? `: ${detail}` : ""}`)
}

async function compareAndSwapPinned(
  repo: string,
  ref: string,
  next: Oid,
  expected: Oid,
  pin: PinnedCommit,
): Promise<boolean> {
  const input = [
    "start",
    `update ${ref} ${next} ${expected}`,
    `delete ${pin.ref} ${next}`,
    "prepare",
    "commit",
    "",
  ].join("\n")
  const result = await run("git", durableGitArgs(repo, ["update-ref", "--stdin"]), { input })
  if (result.code === 0) {
    pin.released = true
    return true
  }
  const detail = result.stderr.toString("utf8").trim()
  if (isCompareAndSwapRejection(detail) || isTransientRefLockContention(detail)) return false
  throw new Error(`git update-ref failed (${result.code})${detail ? `: ${detail}` : ""}`)
}

async function writeInflightRef(
  repo: string,
  ref: string,
  oid: Oid,
  storage: "files" | "native",
): Promise<PinnedCommit> {
  if (storage === "native") {
    const result = await run("git", durableGitArgs(repo, ["update-ref", ref, oid]))
    if (result.code !== 0) {
      const detail = result.stderr.toString("utf8").trim()
      throw new Error(`cannot pin unpublished commit ${oid}${detail ? `: ${detail}` : ""}`)
    }
    return { oid, ref, released: false }
  }
  const path = join(repo, ref)
  const directory = join(repo, "refs", "gitomic", "inflight")
  const lock = `${path}.lock`
  let file: Awaited<ReturnType<typeof openFile>> | undefined
  let ownsLock = false
  try {
    file = await openFile(lock, "wx", 0o644)
    ownsLock = true
    await file.writeFile(`${oid}\n`, "utf8")
    await file.sync()
    await file.close()
    file = undefined
    await rename(lock, path)
    ownsLock = false
    await syncDirectory(directory)
  } catch (error) {
    await file?.close().catch(() => undefined)
    if (ownsLock) await unlink(lock).catch(() => undefined)
    const detail = error instanceof Error ? `: ${error.message}` : ""
    throw new Error(`cannot pin unpublished commit ${oid}${detail}`, { cause: error })
  }
  return { oid, ref, released: false }
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

async function ensureInflightDirectory(repo: string, pending: Map<string, Promise<void>>): Promise<void> {
  let prepared = pending.get(repo)
  if (prepared === undefined) {
    prepared = (async () => {
      const directory = join(repo, "refs", "gitomic", "inflight")
      await mkdir(directory, { recursive: true })
      const sentinel = join(directory, ".gitomic-keep")
      try {
        const file = await openFile(sentinel, "wx", 0o644)
        try {
          await file.writeFile("gitomic inflight ref namespace\n", "utf8")
          await file.sync()
        } finally {
          await file.close()
        }
      } catch (error) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error
      }
      for (const path of [directory, dirname(directory), join(repo, "refs"), repo]) await syncDirectory(path)
    })()
    pending.set(repo, prepared)
  }
  try {
    await prepared
  } catch (error) {
    pending.delete(repo)
    throw error
  }
}

async function releasePinnedCommit(repo: string, pin: PinnedCommit): Promise<void> {
  if (pin.released) return
  await deleteRef(repo, pin.ref, pin.oid, `cannot release unpublished commit pin ${pin.oid}`)
  pin.released = true
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await openFile(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function deleteRef(repo: string, ref: string, oid: Oid, failure: string): Promise<void> {
  const result = await run("git", durableGitArgs(repo, ["update-ref", "-d", ref, oid]))
  if (result.code !== 0) {
    const detail = result.stderr.toString("utf8").trim()
    throw new Error(`${failure}${detail ? `: ${detail}` : ""}`)
  }
}

async function findTransaction(repo: string, tip: Oid, writer: string, seq: number): Promise<Oid | undefined> {
  const output = await git(repo, [
    "rev-list",
    "--first-parent",
    `--max-count=${TRANSACTION_SEARCH_LIMIT + 1}`,
    "--no-commit-header",
    "--format=%H%x00%B%x00",
    tip,
  ])
  const commits = parseTransactionHistory(output)
  for (const commit of commits.slice(0, TRANSACTION_SEARCH_LIMIT)) {
    if (transactionMatches(commit.message, writer, seq)) return commit.oid
  }
  if (commits.length > TRANSACTION_SEARCH_LIMIT) {
    throw transactionLookupExceeded(writer, seq)
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

async function fetchRemote(repo: string, ref: string, remote: string): Promise<Oid> {
  const scratch = `refs/gitomic/fetch/${randomUUID()}`
  let fetched: Oid | undefined
  try {
    await gitWrite(repo, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, `${ref}:${scratch}`])
    fetched = await head(repo, scratch)
    const local = await head(repo, ref)
    if (local !== fetched) await compareAndSwap(repo, ref, fetched, local)
    return fetched
  } finally {
    const temporary = fetched ?? (await optionalRef(repo, scratch))
    if (temporary !== undefined)
      await deleteRef(repo, scratch, temporary, `cannot release temporary fetch ref ${scratch}`)
  }
}

async function compareAndSwapRemote(
  repo: string,
  ref: string,
  next: Oid,
  expected: Oid,
  remote: string,
  pin?: PinnedCommit,
): Promise<boolean> {
  const result = await run(
    "git",
    durableGitArgs(repo, ["push", "--porcelain", `--force-with-lease=${ref}:${expected}`, remote, `${next}:${ref}`]),
  )
  if (result.code !== 0) {
    const detail = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`.trim()
    if (isRemoteCompareAndSwapRejection(detail)) return false
    throw new Error(`git push failed (${result.code})${detail ? `: ${detail}` : ""}`)
  }
  const local = await head(repo, ref)
  if (local === expected) {
    if (pin === undefined) await compareAndSwap(repo, ref, next, expected)
    else await compareAndSwapPinned(repo, ref, next, expected, pin)
  }
  return true
}

function isRemoteCompareAndSwapRejection(detail: string): boolean {
  return detail.split("\n").some((line) => {
    const [flag, , summary] = line.split("\t")
    return flag === "!" && summary === "[rejected] (stale info)"
  })
}
