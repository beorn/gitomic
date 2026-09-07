import childProcess from "node:child_process"
import fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** One owned object repository shared by existing Store and Reader handles. */
export interface OpenedRemoteRepository extends Disposable {
  /** Temporary runtime storage, never a durable repository identity. */
  readonly repo: string
  readonly remote: "origin"
}

/**
 * Open a native Git source in an isolated temporary bare repository. Even a
 * filesystem source is cloned: calling this function explicitly requests a
 * remote. Keep the owner alive until every Store/Reader using it is finished.
 * Local caller-owned repositories continue to use open/openReader directly.
 */
export function openRemoteRepository(source: string): OpenedRemoteRepository {
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
    childProcess.execFileSync("git", ["clone", "--bare", "--no-local", "--", source, repo], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    const exit =
      error instanceof Error && "status" in error && typeof error.status === "number" ? ` (exit ${error.status})` : ""
    const failure = new Error(`${JSON.stringify(source)}: git clone failed${exit}: ${String(error)}`, { cause: error })
    try {
      fs.rmSync(parent, { recursive: true, force: true })
    } catch (cleanupError) {
      throw new AggregateError(
        [failure, cleanupError],
        `${JSON.stringify(source)}: clone and cleanup of ${parent} failed`,
      )
    }
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
