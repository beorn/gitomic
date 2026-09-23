// @failure A remote that stalls blocks the caller's event loop, outlives its killed caller, and leaks a temporary clone.
// @failure Every open of a remote clones the whole repository again instead of reusing one kept bare repository.
// @level l1
// @consumer km's STATE rail in the km daemon, which must keep answering while a write waits on its remote
/**
 * @reach fs-walk <fixture-only: every dir/cacheDir is mkdtemp(join(tmpdir(), ...)); readdir calls all target these temp directories.>
 */

import { execFile, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, describe, expect, test, vi } from "vitest"

import { createShellBackend, open, openRemoteRepository, runGit } from "../src/index.js"
import { createBareRepo, createRemoteRepos, createWorktreeRepo, git, gitFrom } from "./helpers/git.js"

const INDEX = fileURLToPath(new URL("../src/index.ts", import.meta.url))
const STALLING_SOURCE = "git@stall.invalid:state.git"

type StallingSsh = {
  readonly script: string
  pids(): Promise<number[]>
  cleanup(): Promise<void>
}

/**
 * A fake ssh that accepts the connection and never answers. It records its pid,
 * then becomes `sleep` in place, so each recorded pid is the process that stalls.
 */
async function createStallingSsh(): Promise<StallingSsh> {
  const dir = await mkdtemp(join(tmpdir(), "gitomic-stall-"))
  const script = join(dir, "ssh")
  const pidFile = join(dir, "pids")
  await writeFile(script, `#!/bin/sh\necho $$ >> '${pidFile}'\nexec sleep 3600\n`)
  await chmod(script, 0o755)
  const pids = async (): Promise<number[]> => {
    if (!fs.existsSync(pidFile)) return []
    return (await readFile(pidFile, "utf8")).split("\n").filter(Boolean).map(Number)
  }
  return {
    script,
    pids,
    async cleanup() {
      for (const pid of await pids()) {
        try {
          process.kill(pid, "SIGKILL")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        }
      }
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/**
 * Whether `pid` is a running process. A stopped helper whose new parent has not
 * reaped it yet is a zombie: it still answers `kill(pid, 0)` but runs nothing,
 * so the process state decides, not the signal probe.
 */
function alive(pid: number): boolean {
  const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
  if (state.error !== undefined) throw state.error
  const stat = state.stdout.trim()
  return stat !== "" && !stat.startsWith("Z")
}

/** Every stalled process is gone, allowing a moment for the killed group to be reaped. */
async function survivors(pids: readonly number[]): Promise<number[]> {
  const deadline = Date.now() + 2_000
  let living = pids.filter(alive)
  while (living.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    living = living.filter(alive)
  }
  return living
}

type ChildOutcome = {
  readonly exitedOnItsOwn: boolean
  readonly result: Record<string, unknown> | undefined
  readonly output: string
}

/**
 * Runs `body` in a separate Bun process, bounded from outside. A synchronous
 * clone blocks the whole event loop, so an in-process call could never be timed
 * out by the test that makes it. `body` assigns `outcome`; a 50 ms ticker counts
 * how often the child's event loop ran while the body waited.
 */
async function runInChild(body: string, env: NodeJS.ProcessEnv, boundMs: number): Promise<ChildOutcome> {
  const script = [
    `const gitomic = await import(${JSON.stringify(INDEX)})`,
    "const startedAt = Date.now()",
    "let ticks = 0",
    "const ticker = setInterval(() => { ticks += 1 }, 50)",
    "let outcome = {}",
    "try {",
    body,
    "} catch (error) {",
    "  outcome = { ok: false, name: error?.name, message: String(error?.message ?? error) }",
    "}",
    "clearInterval(ticker)",
    'process.stdout.write(JSON.stringify({ ...outcome, ms: Date.now() - startedAt, ticks }) + "\\n")',
  ].join("\n")
  return await new Promise((resolveOutcome) => {
    execFile(
      "bun",
      ["-e", script],
      { env, encoding: "utf8", timeout: boundMs, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        const lines = stdout.trim().split("\n").filter(Boolean)
        const last = lines.at(-1)
        let result: Record<string, unknown> | undefined
        if (last !== undefined) {
          try {
            result = JSON.parse(last) as Record<string, unknown>
          } catch {
            result = undefined
          }
        }
        const killed = error !== null && (error as { killed?: boolean }).killed === true
        resolveOutcome({ exitedOnItsOwn: !killed, result, output: `${stdout}\n${stderr}` })
      },
    )
  })
}

function keptPath(cacheDir: string, source: string): string {
  return join(cacheDir, `${createHash("sha256").update(source).digest("hex")}.git`)
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("a remote that stalls", () => {
  test("an open rejects at its limit naming it, keeps the event loop running, kills the whole group and leaves no directory", async () => {
    const stall = await createStallingSsh()
    const temp = await mkdtemp(join(tmpdir(), "gitomic-stall-tmp-"))
    try {
      const child = await runInChild(
        [
          `  await gitomic.openRemoteRepository(${JSON.stringify(STALLING_SOURCE)}, { timeoutMs: 500 })`,
          "  outcome = { ok: true }",
        ].join("\n"),
        { ...process.env, GIT_SSH_COMMAND: stall.script, TMPDIR: temp },
        15_000,
      )

      expect(child.exitedOnItsOwn, child.output).toBe(true)
      expect(child.result, child.output).toMatchObject({ ok: false, name: "GitTimeout" })
      expect(String(child.result?.message)).toContain("git clone")
      expect(String(child.result?.message)).toContain("500 ms")
      expect(Number(child.result?.ms)).toBeLessThan(4_500)
      expect(Number(child.result?.ticks)).toBeGreaterThan(0)
      const pids = await stall.pids()
      expect(pids.length).toBeGreaterThan(0)
      expect(await survivors(pids)).toEqual([])
      expect((await readdir(temp)).filter((entry) => entry.startsWith("gitomic-remote-"))).toEqual([])
    } finally {
      await stall.cleanup()
      await rm(temp, { recursive: true, force: true })
    }
  })

  test("a Store's fetch rejects at the remote limit naming it and kills the whole group", async () => {
    const stall = await createStallingSsh()
    const fixture = await createBareRepo()
    vi.stubEnv("GIT_SSH_COMMAND", stall.script)
    try {
      await git(fixture.repo, "remote", "add", "origin", STALLING_SOURCE)
      const startedAt = Date.now()

      const opened = open({
        repo: fixture.repo,
        ref: "main",
        remote: "origin",
        backend: createShellBackend({ remoteTimeoutMs: 500 }),
      })

      await expect(opened).rejects.toMatchObject({ name: "GitTimeout" })
      await expect(opened).rejects.toThrow(/git fetch.*500 ms/)
      expect(Date.now() - startedAt).toBeLessThan(4_500)
      expect(await survivors(await stall.pids())).toEqual([])
    } finally {
      await stall.cleanup()
      await fixture.cleanup()
    }
  }, 10_000)

  test("a Store's push rejects at the remote limit naming it, without a blind retry", async () => {
    const stall = await createStallingSsh()
    const fixture = await createRemoteRepos()
    vi.stubEnv("GIT_SSH_COMMAND", stall.script)
    try {
      await git(fixture.left, "config", "remote.origin.pushurl", STALLING_SOURCE)
      const store = await open({
        repo: fixture.left,
        ref: "main",
        remote: "origin",
        backend: createShellBackend({ remoteTimeoutMs: 500 }),
      })
      const startedAt = Date.now()

      const committed = store.transact(async (map) => map.set("note.md", "stalls on push\n"), "stall on push")

      await expect(committed).rejects.toThrow(/git push.*500 ms/)
      await expect(committed).rejects.toMatchObject({ cause: { name: "GitTimeout" } })
      expect(Date.now() - startedAt).toBeLessThan(4_500)
      expect(await git(fixture.remote, "rev-parse", "main")).toBe(fixture.initial)
      expect(await survivors(await stall.pids())).toEqual([])
    } finally {
      await stall.cleanup()
      await fixture.cleanup()
    }
  }, 10_000)
})

describe("a bounded command", () => {
  test("settles by its limit with its own result when a helper it started still holds the output pipes", async () => {
    const startedAt = Date.now()

    // The alias's shell exits at once, leaving a background sleep holding stdout and stderr.
    const result = await runGit(["-c", "alias.linger=!sleep 3600 & echo $!", "linger"], { timeoutMs: 500 })

    expect(result.code).toBe(0)
    expect(Date.now() - startedAt).toBeLessThan(4_500)
    expect(await survivors([Number(result.stdout.toString("utf8").trim())])).toEqual([])
  }, 10_000)
})

describe("a kept remote repository", () => {
  test("one bare repository per source lives under cacheDir, survives dispose, and is reused without cloning", async () => {
    const fixture = await createBareRepo()
    const cacheDir = join(await mkdtemp(join(tmpdir(), "gitomic-kept-")), "remotes")
    try {
      const source = pathToFileURL(fixture.repo).href
      const first = await openRemoteRepository(source, { cacheDir })
      first[Symbol.dispose]()

      expect(first.repo).toBe(keptPath(cacheDir, source))
      expect(first.remote).toBe("origin")
      expect(await git(first.repo, "rev-parse", "--is-bare-repository")).toBe("true")
      expect(await git(first.repo, "config", "--get", "remote.origin.url")).toBe(source)
      expect(fs.existsSync(first.repo)).toBe(true)

      // With the source gone, a second open can only succeed without cloning.
      await rename(fixture.repo, `${fixture.repo}.moved`)
      const second = await openRemoteRepository(source, { cacheDir })
      second[Symbol.dispose]()
      expect(second.repo).toBe(first.repo)
      expect(await readdir(cacheDir)).toEqual([`${createHash("sha256").update(source).digest("hex")}.git`])
    } finally {
      await rm(join(cacheDir, ".."), { recursive: true, force: true })
      await rm(`${fixture.repo}.moved`, { recursive: true, force: true })
      await fixture.cleanup()
    }
  })

  test("the first build seeds from a local checkout without contacting the source", async () => {
    const stall = await createStallingSsh()
    const checkout = await createWorktreeRepo()
    const cacheDir = join(await mkdtemp(join(tmpdir(), "gitomic-kept-seed-")), "remotes")
    try {
      const child = await runInChild(
        [
          `  const repository = await gitomic.openRemoteRepository(${JSON.stringify(STALLING_SOURCE)}, {`,
          `    cacheDir: ${JSON.stringify(cacheDir)},`,
          `    seed: ${JSON.stringify(checkout.repo)},`,
          "    timeoutMs: 5_000,",
          "  })",
          "  outcome = { ok: true, repo: repository.repo }",
        ].join("\n"),
        { ...process.env, GIT_SSH_COMMAND: stall.script },
        15_000,
      )

      expect(child.exitedOnItsOwn, child.output).toBe(true)
      expect(child.result, child.output).toMatchObject({ ok: true, repo: keptPath(cacheDir, STALLING_SOURCE) })
      expect(await stall.pids()).toEqual([])
      const kept = keptPath(cacheDir, STALLING_SOURCE)
      expect(await git(kept, "config", "--get", "remote.origin.url")).toBe(STALLING_SOURCE)
      expect(await git(kept, "rev-parse", "refs/heads/main")).toBe(checkout.initial)
    } finally {
      await stall.cleanup()
      await rm(join(cacheDir, ".."), { recursive: true, force: true })
      await checkout.cleanup()
    }
  })

  test("two opens racing build one kept repository and leave no temporary build behind", async () => {
    const fixture = await createBareRepo()
    const cacheDir = join(await mkdtemp(join(tmpdir(), "gitomic-kept-race-")), "remotes")
    try {
      const source = pathToFileURL(fixture.repo).href

      const [left, right] = await Promise.all([
        openRemoteRepository(source, { cacheDir }),
        openRemoteRepository(source, { cacheDir }),
      ])
      left[Symbol.dispose]()
      right[Symbol.dispose]()

      expect(left.repo).toBe(keptPath(cacheDir, source))
      expect(right.repo).toBe(left.repo)
      expect(await readdir(cacheDir)).toEqual([`${createHash("sha256").update(source).digest("hex")}.git`])
    } finally {
      await rm(join(cacheDir, ".."), { recursive: true, force: true })
      await fixture.cleanup()
    }
  })

  test("the next open sweeps a dead builder's temporary directory and keeps a live one's", async () => {
    const fixture = await createBareRepo()
    const cacheDir = join(await mkdtemp(join(tmpdir(), "gitomic-kept-sweep-")), "remotes")
    try {
      const source = pathToFileURL(fixture.repo).href
      const exited = await new Promise<number>((resolvePid) => {
        const child = execFile("true", [], () => resolvePid(child.pid ?? -1))
      })
      expect(alive(exited)).toBe(false)
      await mkdir(join(cacheDir, `.tmp-${exited}-dead.git`), { recursive: true })
      await mkdir(join(cacheDir, `.tmp-${process.pid}-live.git`), { recursive: true })

      const repository = await openRemoteRepository(source, { cacheDir })
      repository[Symbol.dispose]()

      expect((await readdir(cacheDir)).sort()).toEqual(
        [`${createHash("sha256").update(source).digest("hex")}.git`, `.tmp-${process.pid}-live.git`].sort(),
      )
    } finally {
      await rm(join(cacheDir, ".."), { recursive: true, force: true })
      await fixture.cleanup()
    }
  })

  test("a kept repository recorded for another origin is refused, naming the recorded origin", async () => {
    const fixture = await createBareRepo()
    const other = await createBareRepo()
    const cacheDir = join(await mkdtemp(join(tmpdir(), "gitomic-kept-origin-")), "remotes")
    try {
      const source = pathToFileURL(fixture.repo).href
      const recorded = pathToFileURL(other.repo).href
      await mkdir(cacheDir, { recursive: true })
      await gitFrom(cacheDir, "clone", "--bare", "--quiet", "--", recorded, keptPath(cacheDir, source))

      await expect(openRemoteRepository(source, { cacheDir })).rejects.toThrow(recorded)
      expect(await git(keptPath(cacheDir, source), "config", "--get", "remote.origin.url")).toBe(recorded)
    } finally {
      await rm(join(cacheDir, ".."), { recursive: true, force: true })
      await other.cleanup()
      await fixture.cleanup()
    }
  })
})
