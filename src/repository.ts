import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { GitTimeout } from "./errors.js"
import { runGit } from "./shell.js"

/** One owned object repository shared by existing Store and Reader handles. */
export interface OpenedRemoteRepository extends Disposable {
  /** Runtime storage for the source, never a durable repository identity. */
  readonly repo: string
  readonly remote: "origin"
}

/** Options for {@link openRemoteRepository}. */
export interface OpenRemoteRepositoryOptions {
  /**
   * Keep one bare repository per source under this directory, named by the
   * SHA-256 of the source, and reuse it on every later open instead of cloning
   * again. Without it, each open makes a temporary clone that disposal removes.
   */
  readonly cacheDir?: string
  /**
   * A local repository whose objects build the repository, so building does not
   * contact the source. The source becomes its `origin`; the first Store or
   * Reader refresh fetches whatever the seed lacks.
   */
  readonly seed?: string
  /** Limit for building the repository, in milliseconds. Defaults to 120 000. */
  readonly timeoutMs?: number
}

/** The default limit for building a repository by clone. */
export const DEFAULT_OPEN_TIMEOUT_MS = 120_000

/**
 * Open a native Git source in an isolated bare repository. Even a filesystem
 * source is cloned: calling this function explicitly requests a remote. Keep the
 * owner alive until every Store/Reader using it is finished. Local caller-owned
 * repositories continue to use open/openReader directly.
 *
 * The build is asynchronous and bounded: past `timeoutMs` the clone's whole
 * process group is stopped, its directory is removed, and the open rejects with
 * {@link GitTimeout}.
 */
export async function openRemoteRepository(
  source: string,
  options: OpenRemoteRepositoryOptions = {},
): Promise<OpenedRemoteRepository> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive number of milliseconds")
  }
  if (options.cacheDir === undefined) return openTemporary(source, options.seed, timeoutMs)
  return openKept(source, resolve(options.cacheDir), options.seed, timeoutMs)
}

async function openTemporary(
  source: string,
  seed: string | undefined,
  timeoutMs: number,
): Promise<OpenedRemoteRepository> {
  let parent: string
  try {
    parent = fs.mkdtempSync(join(tmpdir(), "gitomic-remote-"))
  } catch (error) {
    throw new Error(`${JSON.stringify(source)}: cannot allocate temporary Git repository: ${String(error)}`, {
      cause: error,
    })
  }
  const repo = join(parent, "repo.git")
  try {
    await build(source, repo, seed, timeoutMs)
  } catch (failure) {
    removeFailedBuild(source, parent, failure)
    throw failure
  }
  let disposed = false
  return {
    repo,
    remote: "origin",
    [Symbol.dispose]() {
      if (disposed) return
      fs.rmSync(parent, { recursive: true, force: true })
      disposed = true
    },
  }
}

/**
 * The kept repository for `source` under `cacheDir`. It is built at most once,
 * in a sibling directory named for this process, then renamed into place; an
 * open that loses that race drops its own build and uses the winner's. Builds
 * left by processes that no longer exist are removed by the next open.
 */
async function openKept(
  source: string,
  cacheDir: string,
  seed: string | undefined,
  timeoutMs: number,
): Promise<OpenedRemoteRepository> {
  const repo = join(cacheDir, `${createHash("sha256").update(source).digest("hex")}.git`)
  fs.mkdirSync(cacheDir, { recursive: true })
  sweepAbandonedBuilds(cacheDir)
  if (!fs.existsSync(repo)) {
    const building = join(cacheDir, `.tmp-${process.pid}-${randomUUID()}.git`)
    try {
      await build(source, building, seed, timeoutMs)
    } catch (failure) {
      removeFailedBuild(source, building, failure)
      throw failure
    }
    try {
      fs.renameSync(building, repo)
    } catch (error) {
      if (!fs.existsSync(repo)) {
        const failure = new Error(`${JSON.stringify(source)}: cannot place the kept repository at ${repo}`, {
          cause: error,
        })
        removeFailedBuild(source, building, failure)
        throw failure
      }
      // Another open placed it first; this build is redundant.
      fs.rmSync(building, { recursive: true, force: true })
    }
  }
  await assertKeptOrigin(source, repo, timeoutMs)
  return {
    repo,
    remote: "origin",
    [Symbol.dispose]() {
      // The kept repository outlives every owner by design.
    },
  }
}

async function build(source: string, repo: string, seed: string | undefined, timeoutMs: number): Promise<void> {
  if (seed === undefined) {
    await gitOrThrow(source, ["clone", "--bare", "--no-local", "--", source, repo], timeoutMs)
    return
  }
  await gitOrThrow(source, ["clone", "--bare", "--local", "--", seed, repo], timeoutMs)
  await gitOrThrow(source, ["--git-dir", repo, "remote", "set-url", "origin", source], timeoutMs)
}

async function gitOrThrow(source: string, args: readonly string[], timeoutMs: number): Promise<string> {
  const result = await runGit(args, { timeoutMs })
  if (result.code !== 0) {
    const subcommand = args[0] === "--git-dir" ? args[2] : args[0]
    const detail = result.stderr.toString("utf8").trim()
    throw new Error(
      `${JSON.stringify(source)}: git ${subcommand ?? "command"} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`,
    )
  }
  return result.stdout.toString("utf8").trim()
}

async function assertKeptOrigin(source: string, repo: string, timeoutMs: number): Promise<void> {
  const bare = await runGit(["--git-dir", repo, "rev-parse", "--is-bare-repository"], { timeoutMs })
  if (bare.code !== 0 || bare.stdout.toString("utf8").trim() !== "true") {
    throw new Error(
      `${JSON.stringify(source)}: ${repo} is not a bare Git repository; remove it or choose another cacheDir`,
    )
  }
  const origin = await runGit(["--git-dir", repo, "config", "--get", "remote.origin.url"], { timeoutMs })
  const recorded = origin.stdout.toString("utf8").trim()
  if (origin.code !== 0 || recorded !== source) {
    throw new Error(
      `${JSON.stringify(source)}: the kept repository ${repo} records origin ${JSON.stringify(recorded)}; ` +
        "remove it or choose another cacheDir",
    )
  }
}

/** Remove builds whose process no longer exists; a live process's build is left alone. */
function sweepAbandonedBuilds(cacheDir: string): void {
  for (const entry of fs.readdirSync(cacheDir)) {
    const match = /^\.tmp-(\d+)-.+\.git$/.exec(entry)
    if (match === null) continue
    const pid = Number(match[1])
    if (pid === process.pid || processExists(pid)) continue
    fs.rmSync(join(cacheDir, entry), { recursive: true, force: true })
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Remove a failed build's directory; a cleanup failure is reported together with the failure it followed. */
function removeFailedBuild(source: string, directory: string, failure: unknown): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true })
  } catch (cleanupError) {
    throw new AggregateError(
      [failure, cleanupError],
      `${JSON.stringify(source)}: ${failure instanceof GitTimeout ? "bounded clone" : "clone"} and cleanup of ${directory} failed`,
    )
  }
}
