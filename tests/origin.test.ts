// @failure The origin resolver could infer a repository from the current directory, climb to an ancestor repository or the global config, let an ambient repository selector (GIT_DIR, GIT_COMMON_DIR) override the explicit --repo, select an alternate remote, fall back to a replica, print more than the URL and one newline, or report a missing, empty or invalid repository/origin as success, so a STATE write is addressed to the wrong authority.
// @level l1
// @consumer /commit STATE-write recipe and the km refusal messages that must name gitomic origin --repo; @cto ruling 24168 (STATE c90b9255)
// @testonly none: real temporary repositories through the real CLI entry.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { main, VERBS } from "../src/bin.js"
import { createBareRepo, createWorktreeRepo, git, gitFrom } from "./helpers/git.js"

function capture(): { write(chunk: string): void; text(): string } {
  const chunks: string[] = []
  return { write: (chunk: string) => void chunks.push(chunk), text: () => chunks.join("") }
}

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = capture()
  const stderr = capture()
  async function* emptyStdin(): AsyncGenerator<string> {}
  const code = await main(args, { stdin: emptyStdin(), stdout, stderr })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

const URL = "file:///srv/state.git"

let work: string
const cleanups: Array<() => Promise<void>> = []

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "gitomic-origin-test-"))
})

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  await rm(work, { recursive: true, force: true })
})

async function checkout(origin?: string): Promise<string> {
  const made = await createWorktreeRepo()
  cleanups.push(made.cleanup)
  if (origin !== undefined) await gitFrom(made.repo, "remote", "add", "origin", origin)
  return made.repo
}

async function withEnv<T>(patch: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const before = new Map(Object.keys(patch).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(patch)) process.env[key] = value
  try {
    return await body()
  } finally {
    for (const [key, prior] of before) {
      if (prior === undefined) delete process.env[key]
      else process.env[key] = prior
    }
  }
}

describe("origin", () => {
  test("is a listed verb", () => {
    expect(VERBS).toContain("origin")
  })

  test("prints the exact configured origin URL and one newline, and nothing else", async () => {
    const repo = await checkout(URL)
    const result = await run(["origin", "--repo", repo])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${URL}\n`)
    expect(result.stderr).toBe("")
  })

  test("resolves each explicit repository to its own origin, never another", async () => {
    const left = await checkout("file:///srv/left.git")
    const right = await checkout("file:///srv/right.git")
    expect((await run(["origin", "--repo", left])).stdout).toBe("file:///srv/left.git\n")
    expect((await run(["origin", "--repo", right])).stdout).toBe("file:///srv/right.git\n")
  })

  test("reads a bare repository too", async () => {
    const bare = await createBareRepo()
    cleanups.push(bare.cleanup)
    await git(bare.repo, "remote", "add", "origin", URL)
    const result = await run(["origin", "--repo", bare.repo])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${URL}\n`)
  })

  test("refuses a repository with no origin", async () => {
    const repo = await checkout()
    const result = await run(["origin", "--repo", repo])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("remote.origin.url is unset")
  })

  test("refuses an empty origin rather than printing a blank line", async () => {
    const repo = await checkout(URL)
    await gitFrom(repo, "config", "remote.origin.url", "")
    const result = await run(["origin", "--repo", repo])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("remote.origin.url is empty")
  })

  test("refuses a path that is not a repository", async () => {
    const result = await run(["origin", "--repo", join(work, "absent")])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("not a Git repository")
  })

  test("refuses an existing directory that is not a repository, never an ancestor repository origin", async () => {
    const repo = await checkout(URL)
    const nested = join(repo, "nested-directory")
    await mkdir(nested)
    const result = await run(["origin", "--repo", nested])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("not a Git repository")
  })

  test("refuses a repository whose only origin is in the global config, never another authority", async () => {
    const repo = await checkout()
    const globalConfig = join(work, "gitconfig-global")
    await writeFile(globalConfig, `[remote "origin"]\n\turl = file:///srv/global-authority.git\n`)
    const before = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM }
    process.env.GIT_CONFIG_GLOBAL = globalConfig
    process.env.GIT_CONFIG_SYSTEM = join(work, "absent-system-config")
    try {
      const result = await run(["origin", "--repo", repo])
      expect(result.code).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain("remote.origin.url is unset")
    } finally {
      if (before.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = before.global
      if (before.system === undefined) delete process.env.GIT_CONFIG_SYSTEM
      else process.env.GIT_CONFIG_SYSTEM = before.system
    }
  })

  test("keeps an ambient GIT_DIR from selecting another repository than --repo", async () => {
    const named = await checkout("file:///srv/named.git")
    const other = await checkout("file:///srv/other.git")
    const result = await withEnv({ GIT_DIR: join(other, ".git") }, () => run(["origin", "--repo", named]))
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("file:///srv/named.git\n")
    expect(result.stderr).toBe("")
  })

  test("keeps an ambient GIT_COMMON_DIR from selecting another repository than --repo", async () => {
    const named = await checkout("file:///srv/named.git")
    const other = await checkout("file:///srv/other.git")
    const result = await withEnv({ GIT_COMMON_DIR: join(other, ".git") }, () => run(["origin", "--repo", named]))
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("file:///srv/named.git\n")
    expect(result.stderr).toBe("")
  })

  test("refuses a directory that is not a repository even when an ambient GIT_DIR names one", async () => {
    const other = await checkout(URL)
    const plain = join(work, "plain-directory")
    await mkdir(plain)
    const result = await withEnv({ GIT_DIR: join(other, ".git") }, () => run(["origin", "--repo", plain]))
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("not a Git repository")
  })

  test("requires --repo and never infers the current directory", async () => {
    const repo = await checkout(URL)
    const missing = await run(["origin"])
    expect(missing.code).toBe(2)
    expect(missing.stdout).toBe("")
    expect(missing.stderr).toContain("--repo")

    const extra = await run(["origin", "--repo", repo, "positional"])
    expect(extra.code).toBe(2)
    expect(extra.stdout).toBe("")
  })
})
