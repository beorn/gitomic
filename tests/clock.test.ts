/**
 * 25486: commit times are the wall clock, never earlier than the parent's; determinism is asked for by name.
 *
 * Before this, every backend dated a commit one second after its parent, so a busy STATE chain's dates fell hours
 * behind the clock (316 commits made over five hours carried five minutes of dates). Now a store's `clock` dates
 * its commits, the wall clock by default, and `max(clock(), parent + 1)` keeps a chain monotonic; an injected fixed
 * clock keeps commit ids identical across shell, iso and mem and across a retry.
 */
import { describe, expect, test } from "vitest"
import { commitTimestamp, INITIAL_TIMESTAMP } from "../src/git-object.js"
import { open } from "../src/index.js"
import type { CommitInput, GitomicBackend } from "../src/index.js"
import { openEvents } from "../src/events.js"
import { createIsoBackend } from "../src/iso.js"
import { createMemBackend } from "../src/mem.js"
import { createShellBackend } from "../src/shell.js"
import { createBareRepo } from "./helpers/git.js"

const GENESIS = "8e818d1df6fa19bea8c854a46221adaa68738303"
const T0 = 1_800_000_000

describe("commit times track the store's clock and never run backwards", () => {
  test("two commits a known interval apart read both dates; a clock that goes backwards still moves the chain forward", async () => {
    const backend = createMemBackend()
    let now = T0
    const store = await open({ repo: "clock", ref: "main", backend, clock: () => now })
    const first = await store.transact(async (map) => {
      map.set("a.md", "one\n")
    }, "first")
    now = T0 + 3600
    const second = await store.transact(async (map) => {
      map.set("a.md", "two\n")
    }, "second")
    expect((await backend.readCommit("clock", first.oid)).timestamp).toBe(T0)
    expect((await backend.readCommit("clock", second.oid)).timestamp).toBe(T0 + 3600)
    // A clock reading earlier than the parent (clock skew, a stepped-back host) never dates a child before it.
    now = T0
    const third = await store.transact(async (map) => {
      map.set("a.md", "three\n")
    }, "third")
    expect((await backend.readCommit("clock", third.oid)).timestamp).toBe(T0 + 3601)
  })

  test("the default clock is the wall clock, for stores and for event chains", async () => {
    const backend = createMemBackend()
    const before = Math.floor(Date.now() / 1000)
    const store = await open({ repo: "wall", ref: "main", backend })
    const committed = await store.transact(async (map) => {
      map.set("a.md", "x\n")
    }, "now")
    const events = await openEvents({ repo: "wall", ref: "refs/events/wall", backend })
    const appended = await events.append([{ type: "noted" }], { expect: null })
    const after = Math.floor(Date.now() / 1000)
    for (const oid of [committed.oid, appended.events[0]?.id ?? ""]) {
      const { timestamp } = await backend.readCommit("wall", oid)
      expect(timestamp).toBeGreaterThanOrEqual(before)
      expect(timestamp).toBeLessThanOrEqual(after)
    }
    // The genesis keeps its fixed time on every backend.
    expect((await backend.readCommit("wall", GENESIS)).timestamp).toBe(INITIAL_TIMESTAMP)
  })

  test("under one injected clock the same input has one commit id on shell, iso and mem, and a retry the same id", async () => {
    const shell = await createBareRepo()
    const iso = await createBareRepo()
    expect(shell.initial).toBe(GENESIS)
    const legs: Array<{ name: string; backend: GitomicBackend; repo: string; cleanup: () => Promise<void> }> = [
      { name: "mem", backend: createMemBackend(), repo: "vault", cleanup: async () => {} },
      { name: "iso", backend: createIsoBackend(), repo: iso.repo, cleanup: iso.cleanup },
      { name: "shell", backend: createShellBackend(), repo: shell.repo, cleanup: shell.cleanup },
    ]
    try {
      const input: CommitInput = {
        parent: GENESIS,
        time: T0,
        changes: new Map([["a.md", "x\n"]]),
        message: "close 25486",
        writer: "km",
        instance: "00000000-0000-4000-8000-000000000000",
        seq: 0,
      }
      const oids = new Set<string>()
      for (const leg of legs) {
        const oid = await leg.backend.writeCommit(leg.repo, input)
        const again = await leg.backend.writeCommit(leg.repo, input)
        expect(again, `${leg.name}: a retry of the same input under the same clock`).toBe(oid)
        expect((await leg.backend.readCommit(leg.repo, oid)).timestamp).toBe(T0)
        oids.add(oid)
      }
      expect([...oids], "one id across the three backends").toHaveLength(1)
    } finally {
      for (const leg of legs) await leg.cleanup()
    }
  })

  test("a clock that is not an integer of unix seconds, or a parent time git could not read, is a fault by name", async () => {
    expect(() => commitTimestamp(Number.NaN, T0)).toThrow(/parent commit's time is not a number/u)
    expect(() => commitTimestamp(INITIAL_TIMESTAMP, 1.5)).toThrow(
      /clock returned 1\.5; an integer of unix seconds is required/u,
    )
    expect(commitTimestamp(INITIAL_TIMESTAMP, T0)).toBe(T0)
    expect(commitTimestamp(T0 + 10, T0)).toBe(T0 + 11)
    const backend = createMemBackend()
    const store = await open({ repo: "bad-clock", ref: "main", backend, clock: () => 1.5 })
    await expect(
      store.transact(async (map) => {
        map.set("a.md", "x\n")
      }, "bad"),
    ).rejects.toThrow(/integer of unix seconds/u)
  })
})
