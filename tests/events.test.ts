// @failure gitomic/events could lose or double-write an event on a race, drop the commit an
// event keeps, silently regress into one git process per commit, or make an unchanged
// `apply` land an empty commit.
// @level l1
// @consumer yrd's event chains (slice 3b, @i/10-yrd/25040) and anything reading refs like Redis keys
//
// Acceptance of @i/10-yrd/25039. Each describe block names the acceptance row it proves.

import childProcess from "node:child_process"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { afterEach, describe, expect, test, vi } from "vitest"

import { chainsUnder, listRefs, openEvents } from "../src/events.js"
import type { EventInput } from "../src/events.js"
import { apply, Conflict, open } from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import { createMemBackend } from "../src/mem.js"
import { createShellBackend } from "../src/shell.js"
import type { GitomicBackend, Oid } from "../src/types.js"
import { createBareRepo, git } from "./helpers/git.js"

const CHAIN = "refs/events/demo"

type Target = { name: string; repo: string; backend: GitomicBackend; cleanup(): Promise<void> }

async function targets(): Promise<Target[]> {
  const shell = await createBareRepo()
  const iso = await createBareRepo()
  return [
    { name: "shell", repo: shell.repo, backend: createShellBackend(), cleanup: shell.cleanup },
    { name: "iso", repo: iso.repo, backend: createIsoBackend(), cleanup: iso.cleanup },
    { name: "mem", repo: "events-mem", backend: createMemBackend(), cleanup: async () => {} },
  ]
}

async function withTargets(run: (target: Target) => Promise<void>): Promise<void> {
  for (const target of await targets()) {
    try {
      await run(target)
    } finally {
      await target.cleanup()
    }
  }
}

/** A work commit on refs/heads/main that an event can keep. */
async function workCommit(target: Target, path: string): Promise<Oid> {
  const store = await open({ repo: target.repo, ref: "refs/heads/main", writer: "work", backend: target.backend })
  const committed = await store.transact(async (map) => map.set(path, `${path}\n`), `write ${path}`)
  return committed.oid
}

function gitSpawns(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((call) => call[0] === "git").length
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("an absent chain", () => {
  test("reads as no head and no events on every backend", async () => {
    await withTargets(async (target) => {
      const events = await openEvents({ repo: target.repo, ref: CHAIN, backend: target.backend })
      expect(await events.head(), target.name).toBeNull()
      expect(await events.events(), target.name).toEqual([])
    })
  })
})

describe("acceptance: a transacted event reads back with its trailers and its kept commit as a parent", () => {
  test("on shell, iso and mem", async () => {
    await withTargets(async (target) => {
      const kept = await workCommit(target, "work.txt")
      const events = await openEvents({ repo: target.repo, ref: CHAIN, writer: "queue", backend: target.backend })
      const input: EventInput = {
        type: "opened",
        title: "task/demo@abc opened",
        content: "a body paragraph\n\nand a second one",
        props: [
          ["Commit", kept],
          ["Reason", "first"],
          ["Reason", "duplicates are kept"],
        ],
        keeps: [kept],
      }
      const appended = await events.transact(() => [input], "open the change")
      expect(appended.events, target.name).toHaveLength(1)

      const [event] = await events.events()
      expect(event, target.name).toMatchObject({
        parent: null,
        links: [kept],
        type: "opened",
        title: "task/demo@abc opened",
        content: "a body paragraph\n\nand a second one",
        props: input.props,
        writer: "queue",
      })
      expect(event?.instance, target.name).toMatch(/^[0-9a-f-]{36}$/)
      expect(event?.seq, target.name).toBe(0)

      // The kept commit is a real git parent, not only a trailer.
      const meta = await target.backend.readCommit(target.repo, event?.id as Oid)
      expect(meta.parents, target.name).toHaveLength(2)
      expect(meta.parents[1], target.name).toBe(kept)
      expect(meta.trailers, target.name).toEqual([...(input.props ?? []), ["Event", "opened"]])
    })
  })

  test("the first parent chain never walks into a kept work commit", async () => {
    await withTargets(async (target) => {
      const kept = await workCommit(target, "work.txt")
      const events = await openEvents({ repo: target.repo, ref: CHAIN, backend: target.backend })
      await events.append([{ type: "opened", keeps: [kept] }], { expect: null })
      const head = await events.head()
      await events.append([{ type: "note" }], { expect: head })
      const read = await events.events()
      expect(
        read.map((event) => event.type),
        target.name,
      ).toEqual(["opened", "note"])
      expect(read[1]?.parent, target.name).toBe(read[0]?.id)
    })
  })
})

describe("CAS contract: an all-zero expected means the ref must be absent (ruling D)", () => {
  test("create-if-absent succeeds once; the second creator and an all-zero on an existing ref get false", async () => {
    await withTargets(async (target) => {
      const parent = await target.backend.head(target.repo, "refs/heads/main")
      const input = {
        parent,
        changes: new Map<string, string | undefined>(),
        message: "create",
        writer: "w",
        instance: "3f9d1c02-5b7a-4e18-9c44-0a2b6d8e1f30",
        seq: 0,
      }
      const next = await target.backend.writeCommit(target.repo, input)
      const zero = "0".repeat(parent.length)
      const ref = "refs/events/absent-then-created"
      expect(await target.backend.compareAndSwap(target.repo, ref, next, zero), target.name).toBe(true)
      expect(await target.backend.compareAndSwap(target.repo, ref, next, zero), target.name).toBe(false)
      expect(await target.backend.compareAndSwap(target.repo, "refs/heads/main", next, zero), target.name).toBe(false)
    })
  })
})

describe("reserved trailer keys are refused loudly at append (ruling A)", () => {
  test("a caller key spelled Event or Gitomic-* is refused, and nothing lands", async () => {
    await withTargets(async (target) => {
      const events = await openEvents({ repo: target.repo, ref: CHAIN, backend: target.backend })
      for (const key of ["Event", "Gitomic-Seq", "Gitomic-Writer"]) {
        await expect(
          events.append([{ type: "x", props: [[key, "forged"]] }], { expect: null }),
          `${target.name} ${key}`,
        ).rejects.toThrow(/reserved/)
      }
      expect(await events.head(), target.name).toBeNull()
    })
  })
})

describe("the equivalence suite: parents and trailers serialize byte-identically on shell, iso and mem", () => {
  test("the same CommitInput with keeps and trailers yields one oid and one CommitMeta", async () => {
    const all = await targets()
    try {
      const identity = { writer: "same", instance: "3f9d1c02-5b7a-4e18-9c44-0a2b6d8e1f30" }
      const oids: Oid[] = []
      const metas: unknown[] = []
      for (const target of all) {
        const parent = await target.backend.head(target.repo, "refs/heads/main")
        const kept = await target.backend.writeCommit(target.repo, {
          ...identity,
          parent,
          seq: 0,
          message: "work",
          changes: new Map([["work.txt", "work\n"]]),
        })
        const event = await target.backend.writeCommit(target.repo, {
          ...identity,
          parent,
          parents: [parent, kept],
          seq: 1,
          message: "an event",
          changes: new Map<string, string | undefined>(),
          allowEmpty: true,
          trailers: [
            ["Commit", kept],
            ["Reason", "one"],
            ["Reason", "two"],
          ],
        })
        oids.push(event)
        metas.push(await target.backend.readCommit(target.repo, event))
      }
      // Agreement alone is vacuous (three backends ignoring parents would agree too):
      // the keep and the trailers must actually be in the object.
      expect(metas[0]).toMatchObject({
        parents: [expect.any(String), expect.any(String)],
        trailers: [
          ["Commit", expect.any(String)],
          ["Reason", "one"],
          ["Reason", "two"],
        ],
      })
      expect(new Set(oids)).toHaveLength(1)
      expect(metas[1]).toEqual(metas[0])
      expect(metas[2]).toEqual(metas[0])
    } finally {
      for (const target of all) await target.cleanup()
    }
  })
})

describe("acceptance: a race re-runs decide on the winner's events and writes the loser's input once", () => {
  test("two writers on one chain (mem)", async () => {
    const backend = createMemBackend()
    const repo = "events-race"
    const first = await openEvents({ repo, ref: CHAIN, writer: "first", backend })
    const second = await openEvents({ repo, ref: CHAIN, writer: "second", backend })

    const seenBySecond: number[] = []
    let release: () => void = () => {}
    const firstMayLand = new Promise<void>((resolve) => {
      release = resolve
    })
    const secondRun = second.transact(async (events) => {
      seenBySecond.push(events.length)
      // Hold the first attempt open until the other writer has landed.
      if (seenBySecond.length === 1) await firstMayLand
      return [{ type: "from-second" }]
    }, "second writes")
    await new Promise((resolve) => setTimeout(resolve, 10))
    await first.transact(() => [{ type: "from-first" }], "first writes")
    release()
    const outcome = await secondRun

    expect(outcome.retries).toBeGreaterThanOrEqual(1)
    // decide ran again, and the second run saw the winner's event.
    expect(seenBySecond).toEqual([0, 1])
    const types = (await first.events()).map((event) => event.type)
    expect(types).toEqual(["from-first", "from-second"])
    expect(types.filter((type) => type === "from-second")).toHaveLength(1)
  })

  test("append at a stale tip throws Conflict and writes nothing", async () => {
    await withTargets(async (target) => {
      const events = await openEvents({ repo: target.repo, ref: CHAIN, backend: target.backend })
      await events.append([{ type: "one" }], { expect: null })
      await expect(events.append([{ type: "two" }], { expect: null }), target.name).rejects.toBeInstanceOf(Conflict)
      expect(
        (await events.events()).map((event) => event.type),
        target.name,
      ).toEqual(["one"])
    })
  })
})

describe("acceptance: spawn counts on the shell backend", () => {
  test("at most two git processes read a 50-event chain", async () => {
    const fixture = await createBareRepo()
    try {
      const events = await openEvents({ repo: fixture.repo, ref: CHAIN, backend: createShellBackend() })
      const inputs = Array.from({ length: 50 }, (_, index) => ({ type: "tick", title: `tick ${index}` }))
      await events.append(inputs, { expect: null })
      const spy = vi.spyOn(childProcess, "spawn")
      const read = await events.events()
      expect(read).toHaveLength(50)
      expect(gitSpawns(spy)).toBeLessThanOrEqual(2)
    } finally {
      await fixture.cleanup()
    }
  })

  test("one walk reads every chain under a prefix", async () => {
    const fixture = await createBareRepo()
    try {
      const backend = createShellBackend()
      for (const name of ["a", "b", "c"]) {
        const events = await openEvents({ repo: fixture.repo, ref: `refs/events/many/${name}`, backend })
        await events.append([{ type: "opened" }, { type: `note-${name}` }], { expect: null })
      }
      const spy = vi.spyOn(childProcess, "spawn")
      const chains = await chainsUnder("refs/events/many/", { repo: fixture.repo, backend })
      expect([...chains.keys()].sort()).toEqual(["refs/events/many/a", "refs/events/many/b", "refs/events/many/c"])
      expect(chains.get("refs/events/many/b")?.map((event) => event.type)).toEqual(["opened", "note-b"])
      const walks = spy.mock.calls.filter(
        (call) => call[0] === "git" && (call[1] as string[]).some((arg) => arg === "rev-list" || arg === "log"),
      )
      expect(walks).toHaveLength(1)
      expect(gitSpawns(spy)).toBeLessThanOrEqual(2)
      await expect(chainsUnder("refs/events/many/", { repo: fixture.repo, backend, limit: 1025 })).rejects.toThrow(
        /1024/,
      )
    } finally {
      await fixture.cleanup()
    }
  })

  test("at most five git processes per append", async () => {
    const fixture = await createBareRepo()
    try {
      const events = await openEvents({ repo: fixture.repo, ref: CHAIN, backend: createShellBackend() })
      await events.append([{ type: "opened" }], { expect: null })
      const head = await events.head()
      const spy = vi.spyOn(childProcess, "spawn")
      await events.append([{ type: "note", props: [["Reason", "counted"]] }], { expect: head })
      // Acceptance says at most five; @cto's accepted budget is three: read the
      // parent, write the commit, compare-and-swap. Hold the tighter one.
      expect(gitSpawns(spy)).toBeLessThanOrEqual(3)
      spy.mockClear()
      await events.transact(() => [{ type: "decided" }], "transact is append plus the two-process read")
      expect(gitSpawns(spy)).toBeLessThanOrEqual(5)
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("acceptance: listRefs answers locally and through ls-remote --refs", () => {
  test("local for-each-ref and a remote ls-remote agree", async () => {
    const remote = await createBareRepo()
    const local = await createBareRepo()
    try {
      const backend = createShellBackend()
      const events = await openEvents({ repo: remote.repo, ref: "refs/events/x/one", backend })
      await events.append([{ type: "opened" }], { expect: null })
      const tip = (await events.head()) as Oid

      const here = await listRefs("refs/events/x/", { repo: remote.repo, backend })
      expect([...here]).toEqual([["refs/events/x/one", tip]])

      await git(local.repo, "remote", "add", "origin", remote.repo)
      const there = await listRefs("refs/events/x/", { repo: local.repo, remote: "origin", backend })
      expect([...there]).toEqual([["refs/events/x/one", tip]])

      expect(await listRefs("refs/events/none/", { repo: remote.repo, backend })).toEqual(new Map())
    } finally {
      await remote.cleanup()
      await local.cleanup()
    }
  })

  test("mem and iso list refs too", async () => {
    for (const target of (await targets()).filter((candidate) => candidate.name !== "shell")) {
      try {
        const events = await openEvents({ repo: target.repo, ref: "refs/events/y/one", backend: target.backend })
        await events.append([{ type: "opened" }], { expect: null })
        const listed = await listRefs("refs/events/y/", { repo: target.repo, backend: target.backend })
        expect([...listed.keys()], target.name).toEqual(["refs/events/y/one"])
      } finally {
        await target.cleanup()
      }
    }
  })
})

describe("acceptance: apply on an unchanged tree is still a no-op; empty commits are opt-in", () => {
  test("an edit list that changes nothing lands no commit", async () => {
    await withTargets(async (target) => {
      const store = await open({ repo: target.repo, ref: "refs/heads/main", backend: target.backend })
      const before = await store.head()
      const committed = await apply(store, before, [], "nothing to do")
      expect(committed.oid, target.name).toBe(before)
      expect(await store.head(), target.name).toBe(before)
    })
  })

  // The no-op lives in transact (index.ts), not in the backend: writeCommit has always
  // landed an unchanged tree. So the discriminating check is at the API level — an event
  // lands on an unchanged (empty) tree where a store transaction does not.
  test("an event lands on an unchanged tree where a store transaction does not", async () => {
    await withTargets(async (target) => {
      const store = await open({ repo: target.repo, ref: "refs/heads/main", backend: target.backend })
      const before = await store.head()
      expect((await store.transact(async () => {}, "no change")).oid, target.name).toBe(before)

      const events = await openEvents({ repo: target.repo, ref: CHAIN, backend: target.backend })
      await events.append([{ type: "one" }], { expect: null })
      const first = (await events.head()) as Oid
      await events.append([{ type: "two" }], { expect: first })
      const second = (await events.head()) as Oid
      expect(second, target.name).not.toBe(first)
      expect((await target.backend.readFiles(target.repo, second)).size, target.name).toBe(0)
    })
  })
})

describe("acceptance: the README and CHANGELOG document events", () => {
  test("the README has an events section with the Redis table", async () => {
    const readme = await readFile(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8")
    expect(readme).toMatch(/^## Events/m)
    for (const row of ["listRefs", "transact", "append", "events", "watch"]) {
      expect(readme).toContain(row)
    }
    for (const redis of ["KEYS", "SCAN", "WATCH", "XADD", "XRANGE", "SUBSCRIBE"]) {
      expect(readme).toContain(redis)
    }
  })

  test("the CHANGELOG names the four backend additions", async () => {
    const changelog = await readFile(fileURLToPath(new URL("../CHANGELOG.md", import.meta.url)), "utf8")
    for (const addition of ["parents", "allowEmpty", "trailers", "listRefs"]) {
      expect(changelog).toContain(addition)
    }
  })
})

describe("readHistory returns exactly what readCommit returns (ruling C: Reader.log rides on it)", () => {
  test("messages with blank lines, trailers, a merge and a root read identically on every backend", async () => {
    await withTargets(async (target) => {
      const kept = await workCommit(target, "work.txt")
      const events = await openEvents({ repo: target.repo, ref: CHAIN, writer: "fidelity", backend: target.backend })
      await events.append(
        [
          {
            type: "opened",
            title: "subject line",
            content: "para one\n\npara two with Key: looks-like-a-trailer\n\n\ntrailing blank lines",
            props: [["Reason", "a value: with a colon"]],
            keeps: [kept],
          },
        ],
        { expect: null },
      )
      const tip = (await events.head()) as Oid
      const history = await target.backend.readHistory?.(target.repo, [tip, kept])
      expect(history, target.name).toBeDefined()
      for (const meta of history ?? []) {
        expect(meta, `${target.name} ${meta.oid}`).toEqual(await target.backend.readCommit(target.repo, meta.oid))
      }
      // The walk reached both roots-of-interest: the genesis and the work chain's root.
      expect((history ?? []).filter((meta) => meta.parents.length === 0).length, target.name).toBeGreaterThanOrEqual(1)
    })
  })
})

describe("reads that must reach a boundary refuse loudly when they do not (CTO verdict number 1)", () => {
  const many = (count: number): EventInput[] => Array.from({ length: count }, (_, index) => ({ type: `e${index}` }))

  test("transact on a chain longer than 1024 events throws naming the ref and the bound; 1024 still works", async () => {
    const backend = createMemBackend()
    const full = await openEvents({ repo: "events-bound-full", ref: CHAIN, backend })
    await full.append(many(1_024), { expect: null })
    const seen: number[] = []
    await full.transact((events) => {
      seen.push(events.length)
      return []
    }, "count a full chain")
    expect(seen).toEqual([1_024])

    const over = await openEvents({ repo: "events-bound-over", ref: CHAIN, backend })
    await over.append(many(1_025), { expect: null })
    let decided = false
    const refused = over.transact(() => {
      decided = true
      return [{ type: "never" }]
    }, "decide on a truncated chain")
    await expect(refused).rejects.toThrow(CHAIN)
    await expect(refused).rejects.toThrow("1024")
    expect(decided).toBe(false)
    expect((await over.events({ limit: 1, order: "newest-first" }))[0]?.type).toBe("e1024")
  })

  test("watch refuses a tip that moved more than 1024 events past the last one it saw", async () => {
    const backend = createMemBackend()
    const events = await openEvents({ repo: "events-bound-watch", ref: CHAIN, backend })
    const first = await events.append([{ type: "start" }], { expect: null })
    const controller = new AbortController()
    const changes = events.watch({ signal: controller.signal, pollIntervalMs: 1 })[Symbol.asyncIterator]()
    const pending = changes.next()
    await events.append(many(1_025), { expect: first.head })
    await expect(pending).rejects.toThrow(CHAIN)
    controller.abort()
  })
})

describe("an event's subject defaults to its type (CTO verdict number 2)", () => {
  test("append and transact write '<writer>: <type>' when no title is given", async () => {
    const backend = createMemBackend()
    const repo = "events-default-title"
    const events = await openEvents({ repo, ref: CHAIN, writer: "queue", backend })
    const appended = await events.append([{ type: "queued" }], { expect: null })
    const transacted = await events.transact(() => [{ type: "admitted" }], "admit the change")
    const subject = async (oid: Oid) => (await backend.readCommit(repo, oid)).message.split("\n")[0]
    expect(await subject(appended.events[0]?.id as Oid)).toBe("queue: queued")
    expect(await subject(transacted.events[0]?.id as Oid)).toBe("queue: admitted")
    expect((await events.events()).map((event) => event.title)).toEqual(["queued", "admitted"])
  })
})

describe("the genesis commit is one object on every backend (CTO verdict number 3)", () => {
  test("writeGenesis returns the same oid on shell, iso and mem", async () => {
    const oids: string[] = []
    await withTargets(async (target) => {
      const genesis = await target.backend.writeGenesis?.(target.repo)
      expect(genesis, target.name).toMatch(/^[0-9a-f]{40}$/)
      oids.push(genesis as string)
    })
    expect(new Set(oids).size).toBe(1)
  })

  test("a chain written by one backend reads identically on another", async () => {
    const fixture = await createBareRepo()
    try {
      const shell = createShellBackend()
      const iso = createIsoBackend()
      const byShell = await openEvents({ repo: fixture.repo, ref: CHAIN, writer: "shell", backend: shell })
      const first = await byShell.append([{ type: "opened", props: [["Amount", "1"]] }], { expect: null })
      const byIso = await openEvents({ repo: fixture.repo, ref: CHAIN, writer: "iso", backend: iso })
      await byIso.append([{ type: "paid", content: "by iso" }], { expect: first.head })
      const readByShell = await byShell.events()
      expect(readByShell.map((event) => [event.type, event.writer])).toEqual([
        ["opened", "shell"],
        ["paid", "iso"],
      ])
      expect(readByShell[0]?.parent).toBeNull()
      expect(await byIso.events()).toEqual(readByShell)
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("the README events example runs as written", () => {
  test("appends, transacts once, and reads back", async () => {
    const readme = await readFile(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8")
    const block = [...readme.matchAll(/```ts\n([\s\S]*?)\n```/g)]
      .map((match) => match[1] ?? "")
      .find((candidate) => candidate.includes("openEvents"))
    expect(block).toBeDefined()
    const body = (block ?? "").replace(/^import[^\n]+\n\n/, "")
    const fixture = await createBareRepo()
    try {
      const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
        ...args: string[]
      ) => (...values: unknown[]) => Promise<unknown>
      const pointed = (options: Parameters<typeof openEvents>[0]) => openEvents({ ...options, repo: fixture.repo })
      const quiet = { log: () => {} }
      await new AsyncFunction("openEvents", "console", body)(pointed, quiet)
      // Run it again: the transact must not record a second payment.
      const chain = await openEvents({ repo: fixture.repo, ref: "refs/events/orders/42" })
      await chain.transact(
        (events) => (events.some((event) => event.type === "paid") ? [] : [{ type: "paid" }]),
        "again",
      )
      expect((await chain.events()).map((event) => event.type)).toEqual(["opened", "paid"])
    } finally {
      await fixture.cleanup()
    }
  })
})
