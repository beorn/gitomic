/**
 * @failure A cold write-log ancestry walk would rebuild the whole kept DAG in memory; the bounded all-parent
 *          edge stream is the missing lower capability.
 * @level l1
 * @consumer km-storage's one bounded cold ancestry owner (#27349)
 * @reach fs-walk <fixture-only: the shell backend runs against temporary Git repositories>
 * @testonly none: shell + mem backends against temporary Git repositories; no production symbol exists for tests.
 */

import childProcess, { type ChildProcess } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test, vi } from "vitest"
import { tempTree } from "removely"

import { createShellBackend, GitTimeout, HistoryEdgesOverflow, HistoryEdgesTeardown, open } from "../src/index.js"
import type { GitomicBackend, HistoryEdgeEvent } from "../src/index.js"
import { createMemBackend } from "../src/mem.js"
import { createShellRuntime } from "../src/shell.js"
import { appendEmptyHistory, createBareRepo, git, gitWithInput } from "./helpers/git.js"

/** A commit folded back from the event stream - the test's own array, built only where a test needs one. */
type FoldedEdge = { oid: string; parents: string[] }

/**
 * Folds commit|parent|end into per-commit edges AND asserts the stream contract while it does: one commit open
 * at a time, parent events only inside a record, every record closed by its own end, no record left open.
 */
async function edges(iterable: AsyncIterable<HistoryEdgeEvent>): Promise<FoldedEdge[]> {
  const collected: FoldedEdge[] = []
  let open: FoldedEdge | undefined
  for await (const event of iterable) {
    if (event.kind === "commit") {
      if (open !== undefined) throw new Error("commit event arrived while a record was open")
      open = { oid: event.oid, parents: [] }
    } else if (event.kind === "parent") {
      if (open === undefined) throw new Error("parent event arrived outside a record")
      open.parents.push(event.oid)
    } else {
      if (open === undefined) throw new Error("end event arrived with no open record")
      collected.push(open)
      open = undefined
    }
  }
  if (open !== undefined) throw new Error("stream ended with an open record")
  return collected
}

async function rawEvents(iterable: AsyncIterable<HistoryEdgeEvent>): Promise<HistoryEdgeEvent[]> {
  const collected: HistoryEdgeEvent[] = []
  for await (const event of iterable) collected.push(event)
  return collected
}

/** initial <- first, initial <- side, merge(first, side): 4 commits; the merge has two parents. */
async function mergeFixture(): Promise<{
  repo: string
  initial: string
  first: string
  side: string
  merge: string
  cleanup(): Promise<void>
}> {
  const fixture = await createBareRepo()
  try {
    const tree = await git(fixture.repo, "rev-parse", fixture.initial + "^{tree}")
    const first = await git(fixture.repo, "commit-tree", tree, "-p", fixture.initial, "-m", "first")
    const side = await git(fixture.repo, "commit-tree", tree, "-p", fixture.initial, "-m", "side")
    const merge = await git(fixture.repo, "commit-tree", tree, "-p", first, "-p", side, "-m", "merge")
    return { repo: fixture.repo, initial: fixture.initial, first, side, merge, cleanup: fixture.cleanup }
  } catch (error) {
    await fixture.cleanup()
    throw error
  }
}

describe("readHistoryEdges", () => {
  test("shell yields every parent of a merge, once, with no body fields", async () => {
    const fixture = await mergeFixture()
    try {
      const backend = createShellBackend()
      expect(backend.readHistoryEdges).toBeTypeOf("function")
      const list = await edges(backend.readHistoryEdges!(fixture.repo, [fixture.merge]))
      const byOid = new Map(list.map((edge) => [edge.oid, edge]))
      expect(byOid.get(fixture.merge)?.parents).toEqual([fixture.first, fixture.side])
      expect(byOid.get(fixture.first)?.parents).toEqual([fixture.initial])
      expect(byOid.get(fixture.side)?.parents).toEqual([fixture.initial])
      expect(byOid.get(fixture.initial)?.parents).toEqual([])
      expect(list).toHaveLength(4)
      expect(new Set(list.map((edge) => edge.oid)).size).toBe(4)
      for (const edge of list) expect(Object.keys(edge).sort()).toEqual(["oid", "parents"])
    } finally {
      await fixture.cleanup()
    }
  })

  test("exclude stops the walk at the excluded commit and its ancestors", async () => {
    const fixture = await mergeFixture()
    try {
      const backend = createShellBackend()
      const list = await edges(backend.readHistoryEdges!(fixture.repo, [fixture.merge], { exclude: [fixture.first] }))
      const oids = list.map((edge) => edge.oid)
      expect(oids).toContain(fixture.merge)
      expect(oids).not.toContain(fixture.first)
      expect(oids).not.toContain(fixture.initial)
    } finally {
      await fixture.cleanup()
    }
  })

  test("the stream is commit, then its parents in Git order, then end", async () => {
    const fixture = await mergeFixture()
    try {
      const backend = createShellBackend()
      const list = await rawEvents(backend.readHistoryEdges!(fixture.repo, [fixture.merge]))
      const at = list.findIndex((event) => event.kind === "commit" && event.oid === fixture.merge)
      expect(at).toBeGreaterThanOrEqual(0)
      expect(list.slice(at, at + 4)).toEqual([
        { kind: "commit", oid: fixture.merge },
        { kind: "parent", oid: fixture.first },
        { kind: "parent", oid: fixture.side },
        { kind: "end" },
      ])
      expect(list.filter((event) => event.kind === "commit")).toHaveLength(4)
      expect(list.filter((event) => event.kind === "end")).toHaveLength(4)
      // At most one commit is open at a time, and nothing follows an end except the next commit.
      let open = false
      for (const event of list) {
        if (event.kind === "commit") {
          expect(open).toBe(false)
          open = true
        } else if (event.kind === "parent") {
          expect(open).toBe(true)
        } else {
          expect(open).toBe(true)
          open = false
        }
      }
      expect(open).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  test("an unterminated token past the OID bound is refused before it is accumulated", async () => {
    const fixture = await createBareRepo()
    const dir = mkdtempSync(join(tmpdir(), "gitomic-edges-"))
    try {
      // Delimiter-free output: no NUL and no space, so the only bound that can stop the carry buffer growing is
      // the per-token limit. maxBytes is left undefined to prove the refusal does not depend on it.
      const fakeGit = writeFakeGit(dir, ['process.stdout.write("a".repeat(4096))', "process.exit(0)"])
      const backend = createShellBackend({ gitExecutable: fakeGit })
      const failure = await rawEvents(backend.readHistoryEdges!(fixture.repo, [fixture.initial])).then(
        () => undefined,
        (error: unknown) => error as Error,
      )
      expect(failure).toBeInstanceOf(Error)
      expect(failure!.message).toMatch(/undelimited token/i)
    } finally {
      await fixture.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("maxRecords refuses with a typed error before yielding past the cap", async () => {
    const fixture = await mergeFixture()
    try {
      const backend = createShellBackend()
      await expect(edges(backend.readHistoryEdges!(fixture.repo, [fixture.merge], { maxRecords: 2 }))).rejects.toThrow(
        /maxRecords|record/i,
      )
    } finally {
      await fixture.cleanup()
    }
  })

  test("maxBytes refuses with a typed error once the byte bound is exceeded", async () => {
    const fixture = await mergeFixture()
    try {
      const backend = createShellBackend()
      await expect(edges(backend.readHistoryEdges!(fixture.repo, [fixture.merge], { maxBytes: 16 }))).rejects.toThrow(
        /byte|maxBytes/i,
      )
    } finally {
      await fixture.cleanup()
    }
  })

  test("a consumer that stops early cancels the walk without hanging", async () => {
    const fixture = await mergeFixture()
    try {
      const backend = createShellBackend()
      const iterator = backend.readHistoryEdges!(fixture.repo, [fixture.merge])[Symbol.asyncIterator]()
      const first = await iterator.next()
      expect(first.done).toBe(false)
      await iterator.return?.()
    } finally {
      await fixture.cleanup()
    }
  })

  const GROUP_STOP_GRACE_MS = 2_000

  function beAlive(pid: number): void {
    expect(() => process.kill(pid, 0)).not.toThrow()
  }

  function beDead(pid: number): void {
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u)
  }

  async function waitForDeath(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        process.kill(pid, 0)
      } catch {
        return
      }
      await new Promise((settle) => setTimeout(settle, 20))
    }
  }

  /** A native octopus merge with `parentCount` parents, built by fast-import (no second Git implementation). */
  async function appendWideMerge(repo: string, base: string, parentCount: number): Promise<string> {
    const stream: string[] = []
    for (let index = 1; index <= parentCount; index += 1) {
      const message = "wide " + index + "\n"
      const from = index === 1 ? base : ":" + (index - 1)
      stream.push(
        "commit refs/heads/wide\nmark :" +
          index +
          "\ncommitter gitomic <gitomic@localhost> " +
          (946_684_801 + index) +
          " +0000\ndata " +
          Buffer.byteLength(message) +
          "\n" +
          message +
          "from " +
          from +
          "\n\n",
      )
    }
    const mergeMessage = "wide merge\n"
    const merges: string[] = []
    for (let index = 2; index <= parentCount; index += 1) merges.push("merge :" + index)
    stream.push(
      "commit refs/heads/wide\nmark :merge\ncommitter gitomic <gitomic@localhost> " +
        (946_684_801 + parentCount + 1) +
        " +0000\ndata " +
        Buffer.byteLength(mergeMessage) +
        "\n" +
        mergeMessage +
        "from :1\n" +
        merges.join("\n") +
        "\n\n",
    )
    stream.push("done\n")
    await gitWithInput(repo, stream.join(""), "fast-import", "--quiet")
    return await git(repo, "rev-parse", "refs/heads/wide")
  }

  /**
   * A fake git executable: every Git query delegates to the real git, and a rev-list call runs `revListBody`
   * instead. Lets a test own the child's stderr and lifetime without a second Git implementation.
   */
  function writeFakeGit(dir: string, revListBody: readonly string[]): string {
    const path = join(dir, "fake-git.cjs")
    const source = [
      "#!/usr/bin/env node",
      'const { spawnSync } = require("node:child_process")',
      "const args = process.argv.slice(2)",
      'if (args.includes("--version") || args.includes("--git-common-dir")) {',
      '  const result = spawnSync("git", args, { stdio: "inherit", env: process.env })',
      "  process.exit(result.status ?? 1)",
      "}",
      ...revListBody,
      "",
    ].join("\n")
    writeFileSync(path, source)
    chmodSync(path, 0o755)
    return path
  }

  test("cancellation resolves only after the child process has exited", async () => {
    const fixture = await createBareRepo()
    const spawnSpy = vi.spyOn(childProcess, "spawn")
    try {
      // A history far larger than one pipe buffer keeps rev-list alive and blocked when the consumer stops.
      await appendEmptyHistory(fixture.repo, fixture.initial, 20_000)
      const head = await git(fixture.repo, "rev-parse", "refs/heads/main")
      const backend = createShellBackend()
      const iterator = backend.readHistoryEdges!(fixture.repo, [head])[Symbol.asyncIterator]()
      const first = await iterator.next()
      expect(first.done).toBe(false)
      const child = spawnSpy.mock.results.at(-1)?.value as ChildProcess | undefined
      expect(child).toBeTruthy()
      expect(child!.exitCode === null && child!.signalCode === null).toBe(true)
      await iterator.return?.()
      // The generator must not report cancellation complete while the child still runs.
      expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true)
    } finally {
      spawnSpy.mockRestore()
      await fixture.cleanup()
    }
  })

  test("a merge wider than a megabyte of parent ids is yielded, not refused", async () => {
    const fixture = await createBareRepo()
    try {
      const parentCount = 40_000
      const wide = await appendWideMerge(fixture.repo, fixture.initial, parentCount)
      const backend = createShellBackend()
      const list = await edges(backend.readHistoryEdges!(fixture.repo, [wide]))
      const merge = list.find((edge) => edge.oid === wide)
      expect(merge).toBeTruthy()
      expect(merge!.parents).toHaveLength(parentCount)
      const parentBytes = merge!.parents.reduce((total, oid) => total + oid.length + 1, 0)
      expect(parentBytes).toBeGreaterThan(1024 * 1024)
      // The TOTAL budget is still the bound: a walk that cannot fit it refuses.
      await expect(edges(backend.readHistoryEdges!(fixture.repo, [wide], { maxBytes: 4_096 }))).rejects.toThrow(
        /maxBytes|byte/i,
      )
    } finally {
      await fixture.cleanup()
    }
  })

  test("an exited Git that leaves a helper holding the group is not teardown proof", async () => {
    const fixture = await createBareRepo()
    const dir = mkdtempSync(join(tmpdir(), "gitomic-edges-"))
    const pidFile = join(dir, "helper.pid")
    let helperPid: number | undefined
    try {
      const fakeGit = writeFakeGit(dir, [
        'const { spawn } = require("node:child_process")',
        'const fs = require("node:fs")',
        'const helper = spawn("sleep", ["30"], { stdio: ["ignore", "inherit", "inherit"] })',
        "fs.writeFileSync(process.env.FAKE_HELPER_PID_FILE, String(helper.pid))",
        'process.stdout.write("\\n" + "a".repeat(40) + "\\0" + "b".repeat(40) + "\\0")',
        "process.exit(0)",
      ])
      const runtime = createShellRuntime({
        gitExecutable: fakeGit,
        baseEnv: { ...process.env, FAKE_HELPER_PID_FILE: pidFile },
      })
      const iterator = runtime.backend.readHistoryEdges!(fixture.repo, [fixture.initial])[Symbol.asyncIterator]()
      const first = await iterator.next()
      expect(first.done).toBe(false)
      helperPid = Number(readFileSync(pidFile, "utf8").trim())
      beAlive(helperPid)
      // Let the Git parent's own 'exit' land before cancelling: an exited parent is NOT teardown proof while
      // its helper still holds the group and the pipe.
      await new Promise((settle) => setTimeout(settle, 50))
      await iterator.return?.()
      // The Git parent exited immediately, but its helper still held the group and the pipe: teardown must
      // wait for the helper, so it is gone by the time cancellation resolves.
      await waitForDeath(helperPid)
      beDead(helperPid)
    } finally {
      if (helperPid !== undefined) {
        try {
          process.kill(helperPid, "SIGKILL")
        } catch (error) {
          // Cancellation already reaped the helper; other cleanup failures must surface.
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        }
      }
      await fixture.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a prompt cancel clears the SIGKILL escalation; no stray group kill fires", async () => {
    const fixture = await createBareRepo()
    const spawnSpy = vi.spyOn(childProcess, "spawn")
    const killSpy = vi.spyOn(process, "kill")
    try {
      await appendEmptyHistory(fixture.repo, fixture.initial, 20_000)
      const head = await git(fixture.repo, "rev-parse", "refs/heads/main")
      const backend = createShellBackend()
      const iterator = backend.readHistoryEdges!(fixture.repo, [head])[Symbol.asyncIterator]()
      await iterator.next()
      const child = spawnSpy.mock.results.at(-1)?.value as ChildProcess
      const groupPid = child.pid
      await iterator.return?.()
      killSpy.mockClear()
      await new Promise((settle) => setTimeout(settle, GROUP_STOP_GRACE_MS + 500))
      const stray = killSpy.mock.calls.filter(
        ([target, signal]) => signal === "SIGKILL" && groupPid !== undefined && target === -groupPid,
      )
      expect(stray).toEqual([])
    } finally {
      killSpy.mockRestore()
      spawnSpy.mockRestore()
      await fixture.cleanup()
    }
  })

  test("custody kept for an unproven teardown is released once the group finally closes", async () => {
    const fixture = await createBareRepo()
    const dir = mkdtempSync(join(tmpdir(), "gitomic-edges-"))
    const pidFile = join(dir, "helper.pid")
    const baseline = process.listenerCount("SIGTERM")
    let helperPid: number | undefined
    try {
      // The helper is DETACHED into its own process group, so the SIGKILL aimed at Git's group cannot reach it,
      // and it inherits Git's stdout/stderr, so `closed` cannot settle until it exits. It exits AFTER the
      // teardown bound, so cancellation refuses with custody retained — and that hold must still be released at
      // the real close, or the stale pid outlives the group for a later forwarded SIGTERM to hit a reused PGID.
      const fakeGit = writeFakeGit(dir, [
        'const { spawn } = require("node:child_process")',
        'const fs = require("node:fs")',
        'const helper = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 8000)"], { stdio: ["ignore", "inherit", "inherit"], detached: true })',
        "helper.unref()",
        "fs.writeFileSync(process.env.FAKE_HELPER_PID_FILE, String(helper.pid))",
        'process.stdout.write("\\n" + "a".repeat(40) + "\\0" + "b".repeat(40) + "\\0")',
        "process.exit(0)",
      ])
      const runtime = createShellRuntime({
        gitExecutable: fakeGit,
        baseEnv: { ...process.env, FAKE_HELPER_PID_FILE: pidFile },
      })
      const iterator = runtime.backend.readHistoryEdges!(fixture.repo, [fixture.initial])[Symbol.asyncIterator]()
      const first = await iterator.next()
      expect(first.done).toBe(false)
      helperPid = Number(readFileSync(pidFile, "utf8").trim())
      expect(process.listenerCount("SIGTERM")).toBeGreaterThan(baseline)
      await expect(iterator.return?.()).rejects.toThrow(/unproven|custody/i)
      // Still alive at refusal time: the hold preserved the group rather than orphaning it silently.
      beAlive(helperPid)
      await waitForDeath(helperPid)
      // Late close is release: the forwarders come off and no stale group pid remains held.
      for (let attempt = 0; attempt < 200 && process.listenerCount("SIGTERM") !== baseline; attempt += 1) {
        await new Promise((settle) => setTimeout(settle, 25))
      }
      expect(process.listenerCount("SIGTERM")).toBe(baseline)
    } finally {
      if (helperPid !== undefined) {
        try {
          process.kill(helperPid, "SIGKILL")
        } catch (error) {
          // Cancellation already reaped the helper; other cleanup failures must surface.
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        }
      }
      await fixture.cleanup()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  // @failure A caller that already owns a process group (a deadline-and-RSS attempt runner) cannot have Gitomic
  //          spawn INTO that group: every bounded command and the history stream lead a group of their own, so the
  //          owner's census, deadline and forced kill miss Git's helpers, or Gitomic's own group signal hits a
  //          sibling the owner placed beside it.
  // @level l2
  // @consumer the km lifecycle rig's registered evidence children (#28234); every default caller stays standalone
  describe("lifetime", () => {
    /** What a fake Git recorded about itself: one "pid pgid" line per process, in start order. */
    function recorded(pidFile: string): Array<{ pid: number; pgid: number }> {
      return readFileSync(pidFile, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const [pid, pgid] = line.split(" ")
          return { pid: Number(pid), pgid: Number(pgid) }
        })
    }

    /** This process's own process-group id, from /proc (field 5 of stat, after the parenthesised comm). */
    function ownProcessGroup(): number {
      const stat = readFileSync("/proc/self/stat", "utf8")
      return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2])
    }

    async function drain(iterator: AsyncIterator<HistoryEdgeEvent>): Promise<void> {
      for (;;) {
        const step = await iterator.next()
        if (step.done) return
      }
    }

    function eperm(): NodeJS.ErrnoException {
      return Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" })
    }

    function killQuietly(pid: number | undefined): void {
      if (pid === undefined) return
      try {
        process.kill(pid, "SIGKILL")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      }
    }

    const RECORD_SELF = [
      'const fs = require("node:fs")',
      'const stat = fs.readFileSync("/proc/self/stat", "utf8")',
      'const pgid = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]',
      'fs.appendFileSync(process.env.FAKE_PID_FILE, process.pid + " " + pgid + "\\n")',
    ]
    const RECORD_PID = [
      'const fs = require("node:fs")',
      'fs.appendFileSync(process.env.FAKE_PID_FILE, process.pid + "\\n")',
    ]
    /** One complete history record as rev-list frames it: a commit, one parent, end. */
    const ONE_RECORD = '"\\n" + "a".repeat(40) + "\\0" + "b".repeat(40) + "\\0"'

    async function withFakeGit<T>(
      body: readonly string[],
      work: (fakeGit: string, pidFile: string) => Promise<T>,
    ): Promise<T> {
      const dir = mkdtempSync(join(tmpdir(), "gitomic-lifetime-"))
      try {
        return await work(writeFakeGit(dir, body), join(dir, "pids"))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    test.skipIf(process.platform !== "linux").each(["standalone", "inherit"] as const)(
      "%s: a bounded command and the history stream land in the promised process group; unbounded never detaches",
      async (lifetime) => {
        const fixture = await createBareRepo()
        const baseline = process.listenerCount("SIGTERM")
        try {
          await withFakeGit(
            [
              ...RECORD_SELF,
              'if (args.includes("rev-list")) {',
              "  process.stdout.write(" + ONE_RECORD + ")",
              "  setTimeout(() => process.exit(0), 300)",
              "} else {",
              '  process.stdout.write("a".repeat(40) + "\\n")',
              "  process.exit(0)",
              "}",
            ],
            async (fakeGit, pidFile) => {
              const baseEnv = { ...process.env, FAKE_PID_FILE: pidFile }
              const runtime = createShellRuntime({ gitExecutable: fakeGit, baseEnv, localTimeoutMs: 5_000, lifetime })
              // A bounded command: head runs rev-parse --verify under localTimeoutMs.
              expect(await runtime.backend.head(fixture.repo, "refs/heads/main")).toBe("a".repeat(40))
              // The stream: the fake lingers 300 ms past its record so the group is observable while it is live.
              const iterator = runtime.backend.readHistoryEdges!(fixture.repo, [fixture.initial])[
                Symbol.asyncIterator
              ]()
              expect((await iterator.next()).done).toBe(false)
              const forwardersWhileStreaming = process.listenerCount("SIGTERM")
              await drain(iterator)
              // An unbounded command never led a group and still does not, whatever the lifetime.
              const unbounded = createShellRuntime({ gitExecutable: fakeGit, baseEnv, lifetime })
              expect(await unbounded.backend.head(fixture.repo, "refs/heads/main")).toBe("a".repeat(40))
              const [command, stream, loose] = recorded(pidFile)
              if (command === undefined || stream === undefined || loose === undefined) {
                throw new Error("the fake Git recorded " + recorded(pidFile).length + " processes, expected 3")
              }
              if (lifetime === "standalone") {
                expect(command.pgid).toBe(command.pid)
                expect(stream.pgid).toBe(stream.pid)
                expect(forwardersWhileStreaming).toBeGreaterThan(baseline)
              } else {
                expect(command.pgid).toBe(ownProcessGroup())
                expect(stream.pgid).toBe(ownProcessGroup())
                expect(forwardersWhileStreaming).toBe(baseline)
              }
              expect(loose.pgid).toBe(ownProcessGroup())
            },
          )
          expect(process.listenerCount("SIGTERM")).toBe(baseline)
        } finally {
          await fixture.cleanup()
        }
      },
    )

    test.skipIf(process.platform !== "linux")(
      "inherit: a deadline and an early return stop the direct child only; a sibling in the group survives",
      async () => {
        const fixture = await createBareRepo()
        const sibling = childProcess.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" })
        const killSpy = vi.spyOn(process, "kill")
        const pids: number[] = []
        try {
          await withFakeGit(
            [
              ...RECORD_PID,
              'process.on("SIGTERM", () => {})',
              'if (args.includes("rev-list")) process.stdout.write(' + ONE_RECORD + ")",
              "setInterval(() => {}, 1000)",
            ],
            async (fakeGit, pidFile) => {
              const runtime = createShellRuntime({
                gitExecutable: fakeGit,
                baseEnv: { ...process.env, FAKE_PID_FILE: pidFile },
                localTimeoutMs: 300,
                lifetime: "inherit",
              })
              // The deadline: SIGTERM is ignored by the fake, so only the SIGKILL escalation ends it.
              const timedOut: unknown = await runtime.backend.head(fixture.repo, "refs/heads/main").then(
                () => undefined,
                (error: unknown) => error,
              )
              expect(timedOut).toBeInstanceOf(GitTimeout)
              // The error says what was stopped: only the child; its helpers stay in the caller's group.
              expect((timedOut as GitTimeout).stopped).toBe("child")
              expect((timedOut as GitTimeout).message).toMatch(
                /its process was stopped; helpers it started stay in the caller's process group$/,
              )
              // The early return: the finalizer must stop a child that ignores SIGTERM the same way.
              const iterator = runtime.backend.readHistoryEdges!(fixture.repo, [fixture.initial])[
                Symbol.asyncIterator
              ]()
              expect((await iterator.next()).done).toBe(false)
              await expect(iterator.return?.()).resolves.toMatchObject({ done: true })
              pids.push(...recorded(pidFile).map(({ pid }) => pid))
            },
          )
          expect(pids).toHaveLength(2)
          for (const pid of pids) {
            await waitForDeath(pid)
            beDead(pid)
          }
          if (sibling.pid !== undefined) beAlive(sibling.pid)
          // No signal went to a process GROUP: an inherited lifetime stops its direct child and nothing else.
          const groupTargets = killSpy.mock.calls.filter(([target]) => typeof target === "number" && target < 0)
          expect(groupTargets).toEqual([])
        } finally {
          killSpy.mockRestore()
          for (const pid of pids) killQuietly(pid)
          sibling.kill("SIGKILL")
          await fixture.cleanup()
        }
      },
      20_000,
    )

    test.skipIf(process.platform !== "linux").each(["standalone", "inherit"] as const)(
      "%s: a stop signal that fails is kept beside the walk's own failure, never thrown over it",
      async (lifetime) => {
        const fixture = await createBareRepo()
        const baseline = process.listenerCount("SIGTERM")
        const realKill = process.kill.bind(process)
        const spawnSpy = vi.spyOn(childProcess, "spawn")
        let killSpy: { mockRestore(): void } | undefined
        let pid: number | undefined
        try {
          await withFakeGit(
            [
              ...RECORD_PID,
              // Two records, then hang: the second record trips maxRecords: 1 after the test has the child in hand.
              "process.stdout.write(" + ONE_RECORD + ' + "\\n" + "c".repeat(40) + "\\0" + "\\0")',
              "setInterval(() => {}, 1000)",
            ],
            async (fakeGit, pidFile) => {
              const runtime = createShellRuntime({
                gitExecutable: fakeGit,
                baseEnv: { ...process.env, FAKE_PID_FILE: pidFile },
                lifetime,
              })
              const iterator = runtime.backend.readHistoryEdges!(fixture.repo, [fixture.initial], { maxRecords: 1 })[
                Symbol.asyncIterator
              ]()
              expect((await iterator.next()).done).toBe(false)
              pid = recorded(pidFile)[0]?.pid
              const child = spawnSpy.mock.results.at(-1)?.value as ChildProcess
              expect(child.pid).toBe(pid)
              if (lifetime === "standalone") {
                // The group route THROWS: process.kill(-pgid) fails for a reason other than "already gone".
                killSpy = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
                  if (typeof target === "number" && target < 0) throw eperm()
                  return realKill(target, signal)
                })
              } else {
                // The direct-child route REPORTS through the child's "error" event, as Node's kill does for EPERM.
                killSpy = vi.spyOn(child, "kill").mockImplementation(() => {
                  child.emit("error", eperm())
                  return false
                })
              }
              let refusal: unknown
              try {
                await drain(iterator)
              } catch (error) {
                refusal = error
              }
              expect(refusal).toBeInstanceOf(HistoryEdgesTeardown)
              const teardown = refusal as HistoryEdgesTeardown
              // The walk's own failure is the cause; the failed stop rides beside it and is named in the message.
              expect(teardown.cause).toBeInstanceOf(HistoryEdgesOverflow)
              expect((teardown.cleanup as NodeJS.ErrnoException).code).toBe("EPERM")
              expect(teardown.message).toMatch(/a stop signal failed: kill EPERM/)
              expect(teardown.message).toMatch(
                lifetime === "standalone"
                  ? /left process group \d+ unproven/
                  : /left its child \d+ unproven .*caller's process group/,
              )
              // Nothing was able to stop it, and the refusal says so: the child is still alive.
              if (pid !== undefined) beAlive(pid)
            },
          )
        } finally {
          killSpy?.mockRestore()
          spawnSpy.mockRestore()
          if (pid !== undefined) {
            killQuietly(pid)
            await waitForDeath(pid)
          }
          // Standalone retained custody at the refusal; the real close releases it. Inherit never held any.
          for (let attempt = 0; attempt < 200 && process.listenerCount("SIGTERM") !== baseline; attempt += 1) {
            await new Promise((settle) => setTimeout(settle, 25))
          }
          expect(process.listenerCount("SIGTERM")).toBe(baseline)
          await fixture.cleanup()
        }
      },
      20_000,
    )

    test.skipIf(process.platform !== "linux").each(["standalone", "inherit"] as const)(
      "%s: a stop that fails in the bounded runner's deadline path settles the command; a live group stays held until its real close",
      async (lifetime) => {
        const fixture = await createBareRepo()
        const baseline = process.listenerCount("SIGTERM")
        const realKill = process.kill.bind(process)
        const spawnSpy = vi.spyOn(childProcess, "spawn")
        let killSpy: { mockRestore(): void } | undefined
        let pid: number | undefined
        try {
          await withFakeGit([...RECORD_PID, "setInterval(() => {}, 1000)"], async (fakeGit, pidFile) => {
            const runtime = createShellRuntime({
              gitExecutable: fakeGit,
              baseEnv: { ...process.env, FAKE_PID_FILE: pidFile },
              localTimeoutMs: 300,
              lifetime,
            })
            const outcome = runtime.backend.head(fixture.repo, "refs/heads/main")
            // Catch the rev-parse child between its spawn and its 300 ms deadline, and make its stop fail.
            let child: ChildProcess | undefined
            for (let attempt = 0; attempt < 200 && child === undefined; attempt += 1) {
              child = spawnSpy.mock.results
                .map((result) => result.value as ChildProcess)
                .find((candidate) => candidate.spawnargs.includes("--verify"))
              if (child === undefined) await new Promise((settle) => setTimeout(settle, 5))
            }
            if (child === undefined) throw new Error("the bounded rev-parse child never spawned")
            const stubbed = child
            if (lifetime === "standalone") {
              // The group route THROWS: process.kill(-pgid) fails for a reason other than "already gone".
              killSpy = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
                if (typeof target === "number" && target < 0) throw eperm()
                return realKill(target, signal)
              })
            } else {
              // The direct-child route REPORTS through the child's "error" event, as Node's kill does for EPERM.
              killSpy = vi.spyOn(stubbed, "kill").mockImplementation(() => {
                stubbed.emit("error", eperm())
                return false
              })
            }
            // The command rejects promptly with the stop that failed, not with a timeout it could not enforce.
            await expect(outcome).rejects.toMatchObject({ code: "EPERM", syscall: "kill" })
            pid = recorded(pidFile)[0]?.pid
            expect(pid).toBe(stubbed.pid)
            // Past the escalation grace: a timer that escaped settlement would raise here as an unhandled error.
            await new Promise((settle) => setTimeout(settle, GROUP_STOP_GRACE_MS + 300))
            if (pid !== undefined) beAlive(pid)
            // Rejection did not drop custody: the live standalone group is still registered and forwarded to.
            // An inherited lifetime never held anything.
            if (lifetime === "standalone") {
              expect(process.listenerCount("SIGTERM")).toBeGreaterThan(baseline)
            } else {
              expect(process.listenerCount("SIGTERM")).toBe(baseline)
            }
          })
        } finally {
          killSpy?.mockRestore()
          spawnSpy.mockRestore()
          if (pid !== undefined) {
            killQuietly(pid)
            await waitForDeath(pid)
          }
          // The real close is the one release of a held group: the forwarders come off then, and only then.
          for (let attempt = 0; attempt < 200 && process.listenerCount("SIGTERM") !== baseline; attempt += 1) {
            await new Promise((settle) => setTimeout(settle, 25))
          }
          expect(process.listenerCount("SIGTERM")).toBe(baseline)
          await fixture.cleanup()
        }
      },
      20_000,
    )

    test.skipIf(process.platform !== "linux").each([
      ["standalone", "frozen"],
      ["standalone", "primitive"],
      ["inherit", "frozen"],
      ["inherit", "primitive"],
    ] as const)(
      "%s: a proven close after a failed stop refuses with the %s primary exactly as thrown, never mutated",
      async (lifetime, primaryKind) => {
        const fixture = await createBareRepo()
        const baseline = process.listenerCount("SIGTERM")
        const realKill = process.kill.bind(process)
        const spawnSpy = vi.spyOn(childProcess, "spawn")
        let killSpy: { mockRestore(): void } | undefined
        let pid: number | undefined
        try {
          await withFakeGit(
            [
              ...RECORD_PID,
              // One record, then the fake ends on its own 400 ms later: teardown is PROVEN by its real close.
              "process.stdout.write(" + ONE_RECORD + ")",
              "setTimeout(() => process.exit(0), 400)",
            ],
            async (fakeGit, pidFile) => {
              const runtime = createShellRuntime({
                gitExecutable: fakeGit,
                baseEnv: { ...process.env, FAKE_PID_FILE: pidFile },
                lifetime,
              })
              const iterator = runtime.backend.readHistoryEdges!(fixture.repo, [fixture.initial])[
                Symbol.asyncIterator
              ]()
              expect((await iterator.next()).done).toBe(false)
              pid = recorded(pidFile)[0]?.pid
              const child = spawnSpy.mock.results.at(-1)?.value as ChildProcess
              expect(child.pid).toBe(pid)
              if (lifetime === "standalone") {
                killSpy = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
                  if (typeof target === "number" && target < 0) throw eperm()
                  return realKill(target, signal)
                })
              } else {
                killSpy = vi.spyOn(child, "kill").mockImplementation(() => {
                  child.emit("error", eperm())
                  return false
                })
              }
              // The caller's own failure: a frozen Error can take no property, a primitive has none to take.
              const primary: unknown = primaryKind === "frozen" ? Object.freeze(new Error("primary")) : "primary"
              let refusal: unknown
              try {
                await iterator.throw!(primary)
              } catch (error) {
                refusal = error
              }
              // The walk did not end on Gitomic's terms, so the result is a teardown refusal: the exact primary is
              // its cause, the failed stop its cleanup, and the message names both. Nothing replaced either value.
              expect(refusal).toBeInstanceOf(HistoryEdgesTeardown)
              const teardown = refusal as HistoryEdgesTeardown
              expect(teardown.cause).toBe(primary)
              expect((teardown.cleanup as NodeJS.ErrnoException).code).toBe("EPERM")
              expect(teardown.message).toMatch(/closed on its own; a stop signal failed: kill EPERM$/)
              if (primaryKind === "frozen") {
                expect(Object.getOwnPropertyNames(primary as object)).not.toContain("cleanup")
              }
              // Proven means proven: the child is gone before the refusal is thrown.
              if (pid !== undefined) beDead(pid)
            },
          )
        } finally {
          killSpy?.mockRestore()
          spawnSpy.mockRestore()
          if (pid !== undefined) {
            killQuietly(pid)
            await waitForDeath(pid)
          }
          // Standalone released its hold at the real close; inherit never held any.
          for (let attempt = 0; attempt < 200 && process.listenerCount("SIGTERM") !== baseline; attempt += 1) {
            await new Promise((settle) => setTimeout(settle, 25))
          }
          expect(process.listenerCount("SIGTERM")).toBe(baseline)
          await fixture.cleanup()
        }
      },
      20_000,
    )

    test("inherit: a failed spawn rejects with its cause and never installs a signal forwarder", async () => {
      const fixture = await createBareRepo()
      const baseline = process.listenerCount("SIGTERM")
      const dir = mkdtempSync(join(tmpdir(), "gitomic-lifetime-"))
      try {
        const fakeGit = writeFakeGit(dir, ["process.exit(1)"])
        const runtime = createShellRuntime({ gitExecutable: fakeGit, lifetime: "inherit" })
        await runtime.resolveGitDir(fixture.repo)
        unlinkSync(fakeGit)
        await expect(edges(runtime.backend.readHistoryEdges!(fixture.repo, [fixture.initial]))).rejects.toThrow(
          /could not start/,
        )
        expect(process.listenerCount("SIGTERM")).toBe(baseline)
      } finally {
        rmSync(dir, { recursive: true, force: true })
        await fixture.cleanup()
      }
    })
  })

  test("an executable that disappears rejects loudly instead of raising an unhandled spawn error", async () => {
    const fixture = await createBareRepo()
    await using scratch = await tempTree("gitomic-edges-")
    const dir = scratch.path
    try {
      const fakeGit = writeFakeGit(dir, ["process.exit(1)"])
      const runtime = createShellRuntime({ gitExecutable: fakeGit })
      await runtime.resolveGitDir(fixture.repo)
      unlinkSync(fakeGit)
      await expect(edges(runtime.backend.readHistoryEdges!(fixture.repo, [fixture.initial]))).rejects.toThrow(
        /rev-list|cannot|could not|spawn|ENOENT/i,
      )
    } finally {
      await fixture.cleanup()
    }
  })

  test("a large stderr is drained but only a bounded tail is reported", async () => {
    const fixture = await createBareRepo()
    await using scratch = await tempTree("gitomic-edges-")
    const dir = scratch.path
    try {
      const fakeGit = writeFakeGit(dir, ["process.stderr.write('x'.repeat(256 * 1024))", "process.exitCode = 1"])
      const backend = createShellBackend({ gitExecutable: fakeGit })
      const failure = await edges(backend.readHistoryEdges!(fixture.repo, [fixture.initial])).then(
        () => undefined,
        (error: unknown) => error as Error,
      )
      expect(failure).toBeInstanceOf(Error)
      expect(failure!.message).toMatch(/rev-list edges failed/i)
      expect(failure!.message.length).toBeLessThan(64 * 1024)
    } finally {
      await fixture.cleanup()
    }
  })

  test("mem yields the same edge shape with no child process", async () => {
    const backend = createMemBackend() as GitomicBackend
    expect(backend.readHistoryEdges).toBeTypeOf("function")
    const store = await open({ repo: "edges-mem", ref: "main", backend })
    await store.transact(async (map) => map.set("a.txt", "one\n"), "first")
    const head = await backend.head("edges-mem", "refs/heads/main")
    const raw = await rawEvents(backend.readHistoryEdges!("edges-mem", [head]))
    expect(raw[0]).toEqual({ kind: "commit", oid: head })
    expect(raw.at(-1)).toEqual({ kind: "end" })
    expect(raw.filter((event) => event.kind === "commit")).toHaveLength(
      raw.filter((event) => event.kind === "end").length,
    )
    const list = await edges(backend.readHistoryEdges!("edges-mem", [head]))
    expect(list[0]?.oid).toBe(head)
    expect(list.length).toBeGreaterThanOrEqual(2)
    for (const edge of list) expect(Object.keys(edge).sort()).toEqual(["oid", "parents"])
  })

  /**
   * The ONE budget contract, checked against an INDEPENDENT oracle (not the production helper): a kept record costs
   * OID + ` <parent>` per parent + a terminating newline (@cto 9eeab5bd). Both backends must charge the SAME number,
   * so the same cap is the same wall whichever backend a caller happens to hold.
   */
  describe("budget parity across backends", () => {
    function canonicalBytes(list: readonly FoldedEdge[]): number {
      return list.reduce(
        (total, edge) => total + edge.oid.length + 1 + edge.parents.reduce((sum, parent) => sum + 1 + parent.length, 0),
        0,
      )
    }

    async function attempt(
      iterable: AsyncIterable<HistoryEdgeEvent>,
    ): Promise<{ events: HistoryEdgeEvent[]; error: unknown }> {
      const events: HistoryEdgeEvent[] = []
      try {
        for await (const event of iterable) events.push(event)
        return { events, error: undefined }
      } catch (error) {
        return { events, error }
      }
    }

    test("an invalid cap is refused by name, before any event, in both backends", async () => {
      const fixture = await createBareRepo()
      const mem = createMemBackend()
      const store = await open({ repo: "edges-parity-invalid", ref: "main", backend: mem })
      await store.transact(async (map) => map.set("a.txt", "one\n"), "first")
      const memHead = await mem.head("edges-parity-invalid", "refs/heads/main")
      try {
        const shell = createShellBackend()
        const invalid = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]
        for (const cap of invalid) {
          const streams: Array<[string, AsyncIterable<HistoryEdgeEvent>]> = [
            ["shell maxBytes", shell.readHistoryEdges!(fixture.repo, [fixture.initial], { maxBytes: cap })],
            ["shell maxRecords", shell.readHistoryEdges!(fixture.repo, [fixture.initial], { maxRecords: cap })],
            ["mem maxBytes", mem.readHistoryEdges!("edges-parity-invalid", [memHead], { maxBytes: cap })],
            ["mem maxRecords", mem.readHistoryEdges!("edges-parity-invalid", [memHead], { maxRecords: cap })],
          ]
          for (const [label, iterable] of streams) {
            const { events, error } = await attempt(iterable)
            expect(error, label).toBeInstanceOf(TypeError)
            expect(events, label).toEqual([])
          }
        }
      } finally {
        await fixture.cleanup()
      }
    })

    test("a root refuses at maxBytes = OID length in both backends, and yields one byte above", async () => {
      const fixture = await createBareRepo()
      const mem = createMemBackend()
      const store = await open({ repo: "edges-parity-root", ref: "main", backend: mem })
      const memRoot = await store.head()
      try {
        expect(memRoot).toHaveLength(fixture.initial.length)
        const shell = createShellBackend()
        const roots: Array<[string, string, (cap: number) => AsyncIterable<HistoryEdgeEvent>]> = [
          [
            "shell",
            fixture.initial,
            (cap) => shell.readHistoryEdges!(fixture.repo, [fixture.initial], { maxBytes: cap }),
          ],
          ["mem", memRoot, (cap) => mem.readHistoryEdges!("edges-parity-root", [memRoot], { maxBytes: cap })],
        ]
        for (const [label, oid, stream] of roots) {
          const refused = await attempt(stream(oid.length))
          expect(refused.error, label).toBeInstanceOf(HistoryEdgesOverflow)
          expect((refused.error as { code?: string }).code, label).toBe("history-edges-overflow")
          expect(refused.events, label).toEqual([])
          const admitted = await attempt(stream(oid.length + 1))
          expect(admitted.error, label).toBeUndefined()
          expect(admitted.events, label).toEqual([{ kind: "commit", oid }, { kind: "end" }])
        }
      } finally {
        await fixture.cleanup()
      }
    })

    test("both backends admit at exactly the canonical cost and refuse one byte below it", async () => {
      const fixture = await mergeFixture()
      const mem = createMemBackend()
      const store = await open({ repo: "edges-parity-cost", ref: "main", backend: mem })
      for (const name of ["b", "c", "d"]) {
        await store.transact(async (map) => map.set(`${name}.txt`, "one\n"), `commit ${name}`)
      }
      const memHead = await mem.head("edges-parity-cost", "refs/heads/main")
      try {
        const shell = createShellBackend()
        const targets: Array<[string, (cap?: number) => AsyncIterable<HistoryEdgeEvent>]> = [
          [
            "shell",
            (cap) => shell.readHistoryEdges!(fixture.repo, [fixture.merge], cap === undefined ? {} : { maxBytes: cap }),
          ],
          [
            "mem",
            (cap) => mem.readHistoryEdges!("edges-parity-cost", [memHead], cap === undefined ? {} : { maxBytes: cap }),
          ],
        ]
        for (const [label, stream] of targets) {
          const full = await edges(stream())
          expect(full.length, label).toBeGreaterThanOrEqual(3)
          const cost = canonicalBytes(full)
          const exact = await attempt(stream(cost))
          expect(exact.error, label).toBeUndefined()
          expect(exact.events, label).toEqual(await rawEvents(stream()))
          const under = await attempt(stream(cost - 1))
          expect(under.error, label).toBeInstanceOf(HistoryEdgesOverflow)
        }
      } finally {
        await fixture.cleanup()
      }
    })
  })
})
