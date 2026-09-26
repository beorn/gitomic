// @failure A remote lease rejection that a retry absorbs leaves no record, so the fleet's rejected compare-and-swaps
//          an hour cannot be counted (hh 25626 row 1: NOT MEASURED); or a journal that cannot be written turns a
//          retryable rejection into a terminal error, or fails without saying where.
// @level l1
// @consumer tools/cas-rejections.ts (hh 25626), the census receipt's rejected compare-and-swaps row

import { describe, expect, test, vi } from "vitest"
import { basename, join } from "node:path"
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises"

import { open } from "../src/index.js"
import { createRemoteRepos, git } from "./helpers/git.js"

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type Rejection = {
  schema: string
  at: string
  pid: number
  by: string
  remote: string
  site: string
  refs: { ref: string; expect: string; observed?: string }[]
}

/** Every line of every day's journal under `repo`'s gitomic folder; none when the folder was never made. */
async function journal(repo: string): Promise<Rejection[]> {
  const dir = join(repo, "gitomic")
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  const rows: Rejection[] = []
  for (const name of names.filter((entry) => /^lease-rejections\.\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry)).sort()) {
    const text = await readFile(join(dir, name), "utf8")
    for (const line of text.split("\n")) if (line !== "") rows.push(JSON.parse(line) as Rejection)
  }
  return rows
}

/** Two writers on one origin; `left`'s first attempt loses the lease to `right` and its retry lands. */
async function raceOnce(left: string, right: string): Promise<void> {
  const leftStore = await open({ repo: left, ref: "main", writer: "left", remote: "origin" })
  const rightStore = await open({ repo: right, ref: "main", writer: "right", remote: "origin" })
  const entered = deferred()
  const release = deferred()
  let attempts = 0
  const losing = leftStore.transact(async (map) => {
    attempts += 1
    if (attempts === 1) {
      entered.resolve()
      await release.promise
    }
    map.set("left", String(attempts))
  }, "left write")
  await entered.promise
  await rightStore.transact(async (map) => map.set("right", "1"), "right write")
  release.resolve()
  expect((await losing).retries).toBe(1)
}

describe("remote lease rejections are journaled (hh 25626, @cto 96930a63)", () => {
  test("a rejected lease that the retry absorbs is one line in the writer's day journal", async () => {
    const fixture = await createRemoteRepos()
    try {
      await raceOnce(fixture.left, fixture.right)

      const rows = await journal(fixture.left)
      expect(rows).toHaveLength(1)
      const [row] = rows
      expect(row?.schema).toBe("lease-rejections/1")
      expect(row?.remote).toBe("origin")
      expect(["compareAndSwapRemote", "publishRemote"]).toContain(row?.site)
      expect(row?.pid).toBe(process.pid)
      expect(row?.by).toBe(basename(process.argv[1] ?? ""))
      expect(Number.isNaN(Date.parse(row?.at ?? ""))).toBe(false)
      // The day file is named by the line's own UTC date.
      const names = await readdir(join(fixture.left, "gitomic"))
      expect(names).toEqual([`lease-rejections.${row?.at.slice(0, 10)}.jsonl`])
      const main = row?.refs.find((entry) => entry.ref === "refs/heads/main")
      expect(main?.expect).toBe(fixture.initial)
      // `observed` is written only where gitomic already read the remote's tip (publishRemote): reading it for the
      // journal alone would add a session to the count this journal exists to measure.
      if (main?.observed !== undefined) expect(main.observed).toBe(await git(fixture.remote, "rev-parse", "main^"))
      // The winner's write was accepted, so it journals nothing.
      await expect(journal(fixture.right)).resolves.toEqual([])
    } finally {
      await fixture.cleanup()
    }
  }, 30_000)

  test("a policy rejection is not a lease rejection and journals nothing", async () => {
    const fixture = await createRemoteRepos()
    try {
      const store = await open({ repo: fixture.left, ref: "main", writer: "policy", remote: "origin" })
      const hook = join(fixture.remote, "hooks", "pre-receive")
      await writeFile(hook, '#!/bin/sh\necho "policy denied" >&2\nexit 1\n', "utf8")
      await chmod(hook, 0o755)

      await expect(store.transact(async (map) => map.set("blocked", "write"), "blocked")).rejects.toThrow(
        "policy denied",
      )
      await expect(journal(fixture.left)).resolves.toEqual([])
    } finally {
      await fixture.cleanup()
    }
  })

  test("a journal that cannot be written says so on stderr with its path, and the rejection still retries", async () => {
    const fixture = await createRemoteRepos()
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      const dir = join(fixture.left, "gitomic")
      await mkdir(dir, { recursive: true })
      await chmod(dir, 0o500)
      try {
        // The Conflict is still what the caller sees, so its retry lands as if the journal were healthy.
        await raceOnce(fixture.left, fixture.right)
      } finally {
        await chmod(dir, 0o700)
      }
      const said = stderr.mock.calls.map(([chunk]) => String(chunk)).join("")
      expect(said).toContain(join(dir, "lease-rejections."))
      expect(said).toContain("lease rejection not journaled")
      await expect(journal(fixture.left)).resolves.toEqual([])
    } finally {
      stderr.mockRestore()
      await fixture.cleanup()
    }
  }, 30_000)
})
