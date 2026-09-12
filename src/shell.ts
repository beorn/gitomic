import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
  formatCommitMessage,
  GITOMIC_EMAIL,
  GITOMIC_NAME,
  parseCommit,
  TRANSACTION_SEARCH_LIMIT,
  transactionLookupExceeded,
  transactionMatches,
  validateOid,
} from "./git-object.js"
import { assertGitPrefixMatched, assertRegularBlob, normalizePrefix } from "./path.js"
import type { BlobValue, CommitInput, GitomicBackend, Oid } from "./types.js"
import { decodeBlob, decodeUtf8 } from "./utf8.js"

type GitResult = {
  stdout: Buffer
  stderr: Buffer
  code: number
}

type GitOptions = {
  env?: NodeJS.ProcessEnv
  input?: string | Buffer
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
} {
  const resolveGitDir = createGitDirResolver()
  const refStorages = new Map<string, Promise<"files" | "native">>()
  const objectFormats = new Map<string, Promise<"sha1" | "sha256">>()
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
    fetchRemote: async (repo, ref, remote) => fetchRemote(await resolveGitDir(repo), ref, remote),
    compareAndSwapRemote: async (repo, ref, next, expected, remote) =>
      compareAndSwapRemote(await resolveGitDir(repo), ref, next, expected, remote),
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

async function run(command: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolveResult, reject) => {
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
    if (changes.length > 0) {
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
        input: formatCommitMessage(input.writer, input.instance, input.message, input.seq),
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

async function fetchRemote(repo: string, ref: string, remote: string): Promise<Oid> {
  const scratch = `refs/gitomic/fetch/${randomUUID()}`
  let fetched: Oid | undefined
  try {
    await gitWrite(repo, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", remote, `${ref}:${scratch}`])
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
  if (local === expected) await compareAndSwap(repo, ref, next, expected)
  return true
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
