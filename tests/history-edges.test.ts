/**
 * @failure A cold write-log ancestry walk would rebuild the whole kept DAG in memory; the bounded all-parent
 *          edge stream is the missing lower capability.
 * @level l1
 * @consumer km-storage's one bounded cold ancestry owner (#27349)
 * @reach fs-walk <fixture-only: the shell backend runs against temporary Git repositories>
 * @testonly none: shell + mem backends against temporary Git repositories; no production symbol exists for tests.
 */

import childProcess, { type ChildProcess } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test, vi } from "vitest"

import { createShellBackend, open } from "../src/index.js"
import type { GitomicBackend, HistoryEdge } from "../src/index.js"
import { createMemBackend } from "../src/mem.js"
import { createShellRuntime } from "../src/shell.js"
import { appendEmptyHistory, createBareRepo, git } from "./helpers/git.js"

async function edges(iterable: AsyncIterable<HistoryEdge>): Promise<HistoryEdge[]> {
  const collected: HistoryEdge[] = []
  for await (const edge of iterable) collected.push(edge)
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
    const list = await edges(backend.readHistoryEdges!("edges-mem", [head]))
    expect(list[0]?.oid).toBe(head)
    expect(list.length).toBeGreaterThanOrEqual(2)
    for (const edge of list) expect(Object.keys(edge).sort()).toEqual(["oid", "parents"])
  })
})
