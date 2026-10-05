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

import { createShellBackend, HistoryEdgesOverflow, open } from "../src/index.js"
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

  test("an executable that disappears rejects loudly instead of raising an unhandled spawn error", async () => {
    const fixture = await createBareRepo()
    const dir = mkdtempSync(join(tmpdir(), "gitomic-edges-"))
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
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("a large stderr is drained but only a bounded tail is reported", async () => {
    const fixture = await createBareRepo()
    const dir = mkdtempSync(join(tmpdir(), "gitomic-edges-"))
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
      rmSync(dir, { recursive: true, force: true })
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
