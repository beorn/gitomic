import { execFile } from "node:child_process"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

export async function git(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--git-dir", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "gitomic",
      GIT_AUTHOR_EMAIL: "gitomic@localhost",
      GIT_COMMITTER_NAME: "gitomic",
      GIT_COMMITTER_EMAIL: "gitomic@localhost",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      GIT_TERMINAL_PROMPT: "0",
    },
  })
  return stdout.trim()
}

export async function createBareRepo(): Promise<{
  repo: string
  initial: string
  cleanup(): Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), "gitomic-test-"))
  const repo = join(dir, "state.git")
  await execFileAsync("git", ["init", "--bare", "--quiet", repo])
  const initial = await git(repo, "commit-tree", EMPTY_TREE, "-m", "initial")
  await git(repo, "update-ref", "refs/heads/main", initial)
  await git(repo, "symbolic-ref", "HEAD", "refs/heads/main")
  return {
    repo,
    initial,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

export async function createWorktreeRepo(): Promise<{
  repo: string
  nested: string
  initial: string
  cleanup(): Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), "gitomic-worktree-test-"))
  const repo = join(dir, "checkout")
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main", repo])
  const initial = await gitFrom(repo, "commit", "--allow-empty", "--quiet", "-m", "initial").then(
    async () => await gitFrom(repo, "rev-parse", "HEAD"),
  )
  const nested = join(repo, "some", "nested", "directory")
  await mkdir(nested, { recursive: true })
  return {
    repo,
    nested,
    initial,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

export async function gitFrom(repo: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "gitomic",
      GIT_AUTHOR_EMAIL: "gitomic@localhost",
      GIT_COMMITTER_NAME: "gitomic",
      GIT_COMMITTER_EMAIL: "gitomic@localhost",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      GIT_TERMINAL_PROMPT: "0",
    },
  })
  return stdout.trim()
}

export async function createRemoteRepos(): Promise<{
  remote: string
  left: string
  right: string
  initial: string
  cleanup(): Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), "gitomic-remote-test-"))
  const remote = join(dir, "origin.git")
  const left = join(dir, "left.git")
  const right = join(dir, "right.git")
  await execFileAsync("git", ["init", "--bare", "--quiet", remote])
  const initial = await git(remote, "commit-tree", EMPTY_TREE, "-m", "initial")
  await git(remote, "update-ref", "refs/heads/main", initial)
  await git(remote, "symbolic-ref", "HEAD", "refs/heads/main")
  await execFileAsync("git", ["clone", "--bare", "--quiet", remote, left])
  await execFileAsync("git", ["clone", "--bare", "--quiet", remote, right])
  return {
    remote,
    left,
    right,
    initial,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}
