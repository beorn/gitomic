// @failure A remote that stalls blocks the caller's event loop, outlives its killed caller, and leaks a temporary clone.
// @failure Every open of a remote clones the whole repository again instead of reusing one kept bare repository.
// @failure A signalled Git process becomes exit 1, falsely reporting missing history; held pipes erase its native outcome.
// @level l1
// @consumer km's STATE rail in the km daemon, which must keep answering while a write waits on its remote
/**
 * @reach fs-walk <fixture-only: directory reads use temporary cache and bare repositories>
 */

import { execFile, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, describe, expect, test, vi } from "vitest"
import { tempTree } from "removely"

import { createShellBackend, open, openRemoteRepository, runCommand, runGit } from "../src/index.js"
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
  readonly exitSignal: string | undefined
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
        resolveOutcome({
          exitedOnItsOwn: !killed,
          exitSignal: error === null ? undefined : (error as { signal?: string }).signal,
          result,
          output: `${stdout}\n${stderr}`,
        })
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

      await expect(committed).rejects.toThrow(
        /Transaction publication .* is unknown; do not blindly retry.*remote write outcome is unknown for refs\/heads\/main expected [0-9a-f]{40}/s,
      )
      await expect(committed).rejects.toMatchObject({ cause: { cause: { name: "GitTimeout" } } })
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
  // @failure An outer timeout returns while a nested bounded runner's TERM-ignoring group remains alive.
  // @level l1
  // @consumer gitomic#runCommand whole-stage bounds in STATE replica restoration (#27465/#27385)
  // Direct timeout and host-policy cases do not nest two independently bounded groups.
  test("an outer timeout stops a TERM-ignoring nested process group before rejecting", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitomic-nested-bound-"))
    const pidFile = join(directory, "nested.pid")
    const child = [
      `const { runCommand } = await import(${JSON.stringify(INDEX)})`,
      `await runCommand("sh", ["-c", "trap '' TERM; echo $$ > \\\"$GITOMIC_TEST_NESTED_PID\\\"; exec sleep 5"], { timeoutMs: 60000 })`,
    ].join("\n")
    try {
      await expect(
        runCommand("bun", ["-e", child], {
          timeoutMs: 1500,
          env: { GITOMIC_TEST_NESTED_PID: pidFile },
        }),
      ).rejects.toBeInstanceOf((await import("../src/index.js")).GitTimeout)
      expect(fs.existsSync(pidFile)).toBe(true)
      const pid = Number((await readFile(pidFile, "utf8")).trim())
      expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
      expect(alive(pid)).toBe(false)
    } finally {
      // The finite child exits naturally even on RED; no manual signal can fake cleanup proof.
      await rm(directory, { recursive: true, force: true })
    }
  }, 15000)

  // #26689: signalling Git itself does not cover TERM sent to its graceful host.
  test.each([
    {
      name: "drains an admitted publication after TERM",
      policy: "drain",
      signals: ["SIGTERM"],
      release: true,
      failure: undefined,
      hostHandler: true,
    },
    {
      name: "keeps its publication deadline after TERM",
      policy: "drain",
      signals: ["SIGTERM"],
      release: false,
      failure: "GitTimeout",
      hostHandler: true,
    },
    {
      name: "forwards INT even with drain enabled",
      policy: "drain",
      signals: ["SIGINT"],
      release: false,
      failure: "GitSignaled",
      hostHandler: true,
    },
    {
      name: "forwards HUP even with drain enabled",
      policy: "drain",
      signals: ["SIGHUP"],
      release: false,
      failure: "GitSignaled",
      hostHandler: true,
    },
    {
      name: "forwards TERM with the default policy",
      policy: undefined,
      signals: ["SIGTERM"],
      release: false,
      failure: "GitSignaled",
      hostHandler: true,
    },
    {
      name: "forwards a second TERM while draining",
      policy: "drain",
      signals: ["SIGTERM", "SIGTERM"],
      release: false,
      failure: "GitSignaled",
      hostHandler: true,
    },
    {
      name: "exits by deferred TERM after publication without another handler",
      policy: "drain",
      signals: ["SIGTERM"],
      release: true,
      failure: undefined,
      hostHandler: false,
    },
    {
      name: "isolates a drained publication from a concurrent default fetch",
      policy: "drain",
      signals: ["SIGTERM"],
      release: true,
      failure: undefined,
      hostHandler: true,
    },
  ])(
    "a graceful host $name",
    async ({ name, policy, signals, release: releasePublication, failure, hostHandler }) => {
      const mixed = name === "isolates a drained publication from a concurrent default fetch"
      const fixture = await createRemoteRepos()
      const stall = mixed ? await createStallingSsh() : undefined
      const forwardRepo = mixed ? await createBareRepo() : undefined
      if (forwardRepo !== undefined) await git(forwardRepo.repo, "remote", "add", "origin", STALLING_SOURCE)
      const gate = await mkdtemp(join(tmpdir(), "gitomic-publication-gate-"))
      const entered = join(gate, "entered")
      const release = join(gate, "release")
      const parent = join(gate, "parent")
      const deferred = join(gate, "deferred")
      const hook = join(fixture.remote, "hooks", "pre-receive")
      await writeFile(
        hook,
        `#!/usr/bin/env bun\nimport { existsSync, writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(entered)}, String(process.pid))\nconst deadline = Date.now() + 10000\nwhile (!existsSync(${JSON.stringify(release)})) {\n  if (Date.now() > deadline) process.exit(1)\n  await new Promise(resolve => setTimeout(resolve, 10))\n}\n`,
      )
      await chmod(hook, 0o755)
      try {
        const child = await runInChild(
          [
            'const { existsSync, writeFileSync } = await import("node:fs")',
            "let signalCount = 0",
            ...(hostHandler
              ? ['for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => { signalCount += 1 })']
              : []),
            `const store = await gitomic.open({ repo: ${JSON.stringify(fixture.left)}, ref: "main", remote: "origin", backend: gitomic.createShellBackend(${JSON.stringify({ sigterm: policy, remoteTimeoutMs: 1000 })}) })`,
            ...(forwardRepo === undefined
              ? []
              : [
                  `const forwarded = gitomic.open({ repo: ${JSON.stringify(forwardRepo.repo)}, ref: "main", remote: "origin", backend: gitomic.createShellBackend({ remoteTimeoutMs: 5000 }) }).then(() => ({ ok: true }), error => ({ ok: false, name: error.name }))`,
                ]),
            'const publication = store.transact(map => map.set("note.md", "drained publication\\n"), "drain publication").then(result => ({ ok: true, oid: result.oid }), error => ({ ok: false, name: error.name, message: error.message, failure: error.cause?.cause?.name }))',
            "const admissionBound = Date.now() + 8000",
            `while (!existsSync(${JSON.stringify(entered)})${stall === undefined ? "" : ` || !existsSync(${JSON.stringify(join(stall.script, "..", "pids"))})`}) {`,
            '  if (Date.now() > admissionBound) throw new Error("real publication never reached its receive hook")',
            "  await new Promise(resolve => setTimeout(resolve, 10))",
            "}",
            `writeFileSync(${JSON.stringify(parent)}, String(process.pid))`,
            `for (const [index, signal] of ${JSON.stringify(signals)}.entries()) {`,
            "  process.kill(process.pid, signal)",
            ...(hostHandler
              ? ["  while (signalCount <= index) await new Promise(resolve => setTimeout(resolve, 10))"]
              : [
                  "  await new Promise(resolve => setTimeout(resolve, 50))",
                  `  writeFileSync(${JSON.stringify(deferred)}, "parent survived TERM with publication held")`,
                ]),
            "}",
            ...(forwardRepo === undefined ? [] : ["const forwardedResult = await forwarded"]),
            ...(releasePublication ? [`writeFileSync(${JSON.stringify(release)}, "release")`] : []),
            `outcome = { ...(await publication), parentPid: process.pid${forwardRepo === undefined ? "" : ", forwarded: forwardedResult"} }`,
          ].join("\n"),
          { ...process.env, ...(stall === undefined ? {} : { GIT_SSH_COMMAND: stall.script }) },
          15000,
        )
        expect(child.exitedOnItsOwn, child.output).toBe(true)
        expect(Number(await readFile(parent, "utf8"))).toBeGreaterThan(0)
        if (hostHandler) {
          expect(child.result, child.output).toMatchObject({ ok: failure === undefined, parentPid: expect.any(Number) })
          if (mixed) expect(child.result, child.output).toMatchObject({ forwarded: { ok: false, name: "GitSignaled" } })
        } else {
          expect(await readFile(deferred, "utf8")).toBe("parent survived TERM with publication held")
          expect(child.exitSignal, child.output).toBe("SIGTERM")
        }
        if (failure === undefined) {
          if (hostHandler) expect(child.result, child.output).toMatchObject({ oid: expect.any(String) })
          expect(await git(fixture.remote, "show", "main:note.md")).toBe("drained publication")
        } else {
          expect(child.result, child.output).toMatchObject({ failure })
          expect(await git(fixture.remote, "rev-parse", "main")).toBe(fixture.initial)
        }
        const hookPid = Number(await readFile(entered, "utf8"))
        expect(await survivors([hookPid, ...(stall === undefined ? [] : await stall.pids())])).toEqual([])
      } finally {
        await writeFile(release, "release")
        await stall?.cleanup()
        await forwardRepo?.cleanup()
        await fixture.cleanup()
        await rm(gate, { recursive: true, force: true })
      }
    },
    20000,
  )

  // #26595: timeout/held-pipe success cases do not exercise an externally signalled Git parent.
  // The real Git alias signals only its own Git parent; no production injection seam is needed.
  test.each([
    ["SIGTERM", false],
    ["SIGKILL", false],
    ["SIGTERM", true],
    ["SIGKILL", true],
  ] as const)(
    "preserves native %s with held pipes %s",
    async (signal, heldPipes) => {
      const helper = heldPipes ? "sleep 3600 & echo $!; " : ""
      const alias = `!${helper}echo native-signal >&2; kill -${signal.slice(3)} "$PPID"`
      const outcome = runGit(["-c", `alias.signal=${alias}`, "signal"], { timeoutMs: 500 })

      await expect(outcome).rejects.toMatchObject({
        name: "GitSignaled",
        signal,
        command: "git signal",
        stderr: expect.stringContaining("native-signal"),
      })
    },
    10_000,
  )

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

  // hh 25519: removeFailedBuild after a seeded build had a witness only for openTemporary.
  test("a seeded build that fails after its clone leaves no temporary build behind", async () => {
    const checkout = await createWorktreeRepo()
    const root = await mkdtemp(join(tmpdir(), "gitomic-kept-failed-"))
    const cacheDir = join(root, "remotes")
    const bin = join(root, "bin")
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()
    try {
      await mkdir(bin)
      // Every Git command runs as usual except the build's `remote set-url`, which fails once the clone exists.
      await writeFile(
        join(bin, "git"),
        `#!/bin/sh\ncase " $* " in *" remote set-url "*) echo "fatal: set-url refused" >&2; exit 1 ;; esac\nexec '${realGit}' "$@"\n`,
      )
      await chmod(join(bin, "git"), 0o755)
      const child = await runInChild(
        [
          `  await gitomic.openRemoteRepository(${JSON.stringify(STALLING_SOURCE)}, {`,
          `    cacheDir: ${JSON.stringify(cacheDir)},`,
          `    seed: ${JSON.stringify(checkout.repo)},`,
          "  })",
          "  outcome = { ok: true }",
        ].join("\n"),
        { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        15_000,
      )

      expect(child.result, child.output).toMatchObject({ ok: false })
      expect(String(child.result?.message)).toContain("git remote failed (exit 1): fatal: set-url refused")
      expect(await readdir(cacheDir)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
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
    await using cache = await tempTree("gitomic-kept-origin-")
    const cacheDir = cache.resolve("remotes")
    try {
      const source = pathToFileURL(fixture.repo).href
      const recorded = pathToFileURL(other.repo).href
      await mkdir(cacheDir, { recursive: true })
      await gitFrom(cacheDir, "clone", "--bare", "--quiet", "--", recorded, keptPath(cacheDir, source))

      await expect(openRemoteRepository(source, { cacheDir })).rejects.toThrow(recorded)
      expect(await git(keptPath(cacheDir, source), "config", "--get", "remote.origin.url")).toBe(recorded)
    } finally {
      await other.cleanup()
      await fixture.cleanup()
    }
  })
})
