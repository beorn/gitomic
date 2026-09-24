// @failure The CLI could land a write its repository's gate refuses, report a refusal with an exit code that also means
// something else, drop the gate's report, or record every agent's write as gitomic@localhost instead of who acted.
// @level l2
// @consumer 24168 slice A: every STATE prose/config write is `gitomic apply` from a seat (ADR-0020 author, exit 4)

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { main } from "../src/bin.js"
import { CANDIDATE_CONFIG, createShellBackend, open, type GitomicBackend } from "../src/index.js"
import { createMemBackend } from "../src/mem.js"
import { createBareRepo, git } from "./helpers/git.js"

function capture(): { write(chunk: string): void; text(): string } {
  const chunks: string[] = []
  return { write: (chunk: string) => void chunks.push(chunk), text: () => chunks.join("") }
}

async function run(backend: GitomicBackend, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = capture()
  const stderr = capture()
  async function* emptyStdin(): AsyncGenerator<string> {}
  const code = await main(args, { backend, stdin: emptyStdin(), stdout, stderr })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

let work: string
let fixture: { repo: string; cleanup(): Promise<void> }
const backend = createShellBackend()

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "gitomic-cli-candidate-"))
  fixture = await createBareRepo()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fixture.cleanup()
  await rm(work, { recursive: true, force: true })
})

async function file(name: string, content: string, mode?: number): Promise<string> {
  const path = join(work, name)
  await writeFile(path, content, "utf8")
  if (mode !== undefined) await chmod(path, mode)
  return path
}

async function declareCheck(body: string): Promise<void> {
  const check = await file("check.sh", `#!/bin/sh\n${body}\n`, 0o755)
  const store = await open({ repo: fixture.repo, ref: "main", writer: "fixture", backend })
  await store.transact(
    async (map) => map.set(CANDIDATE_CONFIG, `[candidate]\n\tcheck = ${check}\n`),
    "declare the gate",
  )
}

const address = () => `${fixture.repo}#main`

describe("gitomic CLI — the repository's gate and one exit-code table", () => {
  test("a refused write exits 4 with the reasons on stderr and one machine line, and the ref does not move", async () => {
    await declareCheck('echo "docs/a.md: heading missing"; exit 1')
    const before = await git(fixture.repo, "rev-parse", "main")

    const result = await run(backend, ["write", address(), "-m", "refused", `docs/a.md=${await file("a.md", "a\n")}`])
    expect(result.code).toBe(4)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("candidate-refused: 1 reason(s)")
    expect(result.stderr).toContain(`code=candidate-refused base=${before} reasons=["docs/a.md: heading missing"]`)
    expect(await git(fixture.repo, "rev-parse", "main")).toBe(before)
  })

  test("apply is gated the same way", async () => {
    await declareCheck('echo "refused"; exit 1')
    const result = await run(backend, [
      "apply",
      address(),
      "-m",
      "refused",
      "put",
      "docs/a.md",
      await file("a.md", "a\n"),
    ])
    expect(result.code).toBe(4)
  })

  test("a landed write carries the gate's report: stderr in plain mode, a field in --json", async () => {
    await declareCheck('echo "pm-plan.md: a whole-plan finding"; exit 0')

    const plain = await run(backend, ["write", address(), "-m", "lands", `docs/a.md=${await file("a.md", "a\n")}`])
    expect(plain.code).toBe(0)
    expect(plain.stdout).toMatch(/^[0-9a-f]{40}\n$/u)
    expect(plain.stderr).toContain("report: pm-plan.md: a whole-plan finding")

    const json = await run(backend, [
      "write",
      address(),
      "-m",
      "lands",
      "--json",
      `docs/b.md=${await file("b.md", "b\n")}`,
    ])
    expect(JSON.parse(json.stdout)).toMatchObject({ report: ["pm-plan.md: a whole-plan finding"] })
  })

  test("--author records who acted, and --trailer appends caller trailers ahead of gitomic's own", async () => {
    const result = await run(backend, [
      "write",
      address(),
      "-m",
      "authored",
      "--author",
      "Dev Four <dev4@example.org>",
      "--trailer",
      "Actor-Session=s-123",
      "--trailer",
      "Refs=@i/x",
      `docs/a.md=${await file("a.md", "a\n")}`,
    ])
    expect(result.code).toBe(0)
    const commit = await backend.readCommit(fixture.repo, result.stdout.trim())
    expect(commit.author).toEqual({ name: "Dev Four", email: "dev4@example.org" })
    expect(commit.trailers).toEqual([
      ["Actor-Session", "s-123"],
      ["Refs", "@i/x"],
    ])
  })

  test("without --author the author resolves as `git commit` resolves it (ADR-0020's claimed fallback)", async () => {
    vi.stubEnv("GIT_AUTHOR_NAME", "Claimed Seat")
    vi.stubEnv("GIT_AUTHOR_EMAIL", "claimed@example.org")
    const result = await run(backend, ["write", address(), "-m", "claimed", `docs/a.md=${await file("a.md", "a\n")}`])
    expect(result.code).toBe(0)
    const commit = await backend.readCommit(fixture.repo, result.stdout.trim())
    expect(commit.author).toEqual({ name: "Claimed Seat", email: "claimed@example.org" })
    expect(commit.committer.email).not.toBe("claimed@example.org")
  })

  test("with no identity anywhere the write still lands, authored by the committer, and stderr says why", async () => {
    vi.stubEnv("GIT_AUTHOR_NAME", undefined)
    vi.stubEnv("GIT_AUTHOR_EMAIL", undefined)
    vi.stubEnv("GIT_COMMITTER_NAME", undefined)
    vi.stubEnv("GIT_COMMITTER_EMAIL", undefined)
    vi.stubEnv("EMAIL", undefined)
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null")
    vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1")
    // Empty the worktree's local identity too; GIT_CONFIG_GLOBAL does not mask it.
    vi.stubEnv("GIT_CONFIG_COUNT", "3")
    vi.stubEnv("GIT_CONFIG_KEY_0", "user.useConfigOnly")
    vi.stubEnv("GIT_CONFIG_VALUE_0", "true")
    vi.stubEnv("GIT_CONFIG_KEY_1", "user.name")
    vi.stubEnv("GIT_CONFIG_VALUE_1", "")
    vi.stubEnv("GIT_CONFIG_KEY_2", "user.email")
    vi.stubEnv("GIT_CONFIG_VALUE_2", "")
    const result = await run(backend, ["write", address(), "-m", "anonymous", `docs/a.md=${await file("a.md", "a\n")}`])
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(
      /^gitomic: no author identity \(git var GIT_AUTHOR_IDENT exit 128: .+\); authoring as the committer\n$/u,
    )
    const commit = await backend.readCommit(fixture.repo, result.stdout.trim())
    expect(commit.author).toEqual(commit.committer)
  })

  test("a malformed --author is a usage error (exit 2), never a silent fallback", async () => {
    const result = await run(createMemBackend(), [
      "write",
      "repo#main",
      "-m",
      "x",
      "--author",
      "no email",
      `a.md=${await file("a.md", "a\n")}`,
    ])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("--author")
  })

  test("a Gitomic-* trailer is refused: those keys are gitomic's own", async () => {
    const result = await run(createMemBackend(), [
      "write",
      "repo#main",
      "-m",
      "x",
      "--trailer",
      "Gitomic-Seq=9",
      `a.md=${await file("a.md", "a\n")}`,
    ])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("Gitomic-Seq")
  })
})
