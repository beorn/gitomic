import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { formatCommitMessage, GITOMIC_EMAIL, GITOMIC_NAME, transactionMatches } from "./git-object.js"
import type { CommitInput, GitomicBackend, Oid } from "./types.js"

type GitResult = {
  stdout: Buffer
  stderr: Buffer
  code: number
}

type GitOptions = {
  env?: NodeJS.ProcessEnv
  input?: string | Buffer
}

const ZERO_OID = "0000000000000000000000000000000000000000"
const TRANSACTION_SEARCH_LIMIT = 1_024

export function createShellBackend(): GitomicBackend {
  const resolveGitDir = createGitDirResolver()
  return {
    head: async (repo, ref) => await head(await resolveGitDir(repo), ref),
    readFiles: async (repo, commit) => await readFiles(await resolveGitDir(repo), commit),
    writeCommit: async (repo, input) => await writeCommit(await resolveGitDir(repo), input),
    compareAndSwap: async (repo, ref, next, expected) =>
      await compareAndSwap(await resolveGitDir(repo), ref, next, expected),
    findTransaction: async (repo, tip, writer, seq) =>
      await findTransaction(await resolveGitDir(repo), tip, writer, seq),
    fetchRemote: async (repo, ref, remote) => await fetchRemote(await resolveGitDir(repo), ref, remote),
    compareAndSwapRemote: async (repo, ref, next, expected, remote) =>
      await compareAndSwapRemote(await resolveGitDir(repo), ref, next, expected, remote),
  }
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

export function createGitDirResolver(): (repo: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>()
  return (repo) => {
    const locator = resolve(repo)
    let gitdir = cache.get(locator)
    if (gitdir === undefined) {
      gitdir = run("git", ["-C", locator, "rev-parse", "--absolute-git-dir"]).then((result) => {
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

async function git(repo: string, args: readonly string[], options: GitOptions = {}): Promise<Buffer> {
  const result = await run("git", gitArgs(repo, args), options)
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
  for (const record of listing.toString("utf8").split("\0")) {
    if (!record) continue
    const separator = record.indexOf("\t")
    if (separator < 0) throw new Error("git ls-tree returned a malformed record")
    const metadata = record.slice(0, separator).split(" ")
    const oid = metadata[2]
    const path = record.slice(separator + 1)
    if (metadata[1] !== "blob" || oid === undefined) continue
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
    files.set(entry.path, output.toString("utf8", start, end))
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
    await git(repo, ["read-tree", input.parent], { env: indexEnv })
    for (const [path, content] of input.changes) {
      if (content === undefined) {
        await git(repo, ["update-index", "-z", "--index-info"], {
          env: indexEnv,
          input: Buffer.concat([Buffer.from(`0 ${ZERO_OID}\t`, "utf8"), Buffer.from(path, "utf8"), Buffer.from([0])]),
        })
        continue
      }
      const blob = text(await git(repo, ["hash-object", "-w", "--stdin"], { input: content }))
      await git(repo, ["update-index", "--add", "--cacheinfo", "100644", blob, path], { env: indexEnv })
    }
    const tree = text(await git(repo, ["write-tree"], { env: indexEnv }))
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
      await git(repo, ["commit-tree", tree, "-p", input.parent], {
        env: identityEnv,
        input: formatCommitMessage(input.writer, input.message, input.seq),
      }),
    )
  } finally {
    await rm(indexDir, { recursive: true, force: true })
  }
}

async function compareAndSwap(repo: string, ref: string, next: Oid, expected: Oid): Promise<boolean> {
  const result = await run("git", gitArgs(repo, ["update-ref", ref, next, expected]))
  if (result.code === 0) return true
  const detail = result.stderr.toString("utf8").trim()
  if (isCompareAndSwapRejection(detail)) return false
  throw new Error(`git update-ref failed (${result.code})${detail ? `: ${detail}` : ""}`)
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
    throw new Error(
      `transaction lookup for writer ${JSON.stringify(writer)} sequence ${seq} exceeded ${TRANSACTION_SEARCH_LIMIT} first-parent commits; the ambiguous acknowledgement is too old to resolve safely`,
    )
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

function parseTransactionHistory(output: Buffer): Array<{ oid: Oid; message: string }> {
  const fields = output.toString("utf8").split("\0")
  const trailing = fields.pop()
  if (trailing?.trim()) throw new Error("git rev-list returned trailing transaction data")
  if (fields.length % 2 !== 0) throw new Error("git rev-list returned a malformed transaction record")

  const commits: Array<{ oid: Oid; message: string }> = []
  for (let index = 0; index < fields.length; index += 2) {
    const oid = fields[index]?.replace(/^\n/, "")
    const message = fields[index + 1]
    if (oid === undefined || message === undefined || !/^[0-9a-f]{40,64}$/.test(oid)) {
      throw new Error("git rev-list returned a malformed transaction record")
    }
    commits.push({ oid, message })
  }
  return commits
}

async function fetchRemote(repo: string, ref: string, remote: string): Promise<Oid> {
  await git(repo, ["fetch", "--quiet", "--no-tags", remote, ref])
  const fetched = await head(repo, "FETCH_HEAD")
  const local = await head(repo, ref)
  if (local !== fetched) await compareAndSwap(repo, ref, fetched, local)
  return fetched
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
    gitArgs(repo, ["push", "--porcelain", `--force-with-lease=${ref}:${expected}`, remote, `${next}:${ref}`]),
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

function isRemoteCompareAndSwapRejection(detail: string): boolean {
  return detail.split("\n").some((line) => {
    const [flag, , summary] = line.split("\t")
    return flag === "!" && summary === "[rejected] (stale info)"
  })
}
