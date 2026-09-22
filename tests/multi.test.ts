// @failure gitomic could land half of a multi-ref publish (the event without the branch it
// names, or the reverse), retry forever on a rival that moved the other ref, or read a
// remote queue one chain per git process.
// @level l1
// @consumer yrd's submit (branch head plus opened event in one push) and runner tick (every
// chain under a queue in one fetch), 25040 3b
//
// Acceptance of @i/10-yrd/25055 (3a.1: MULTI and batched fetch) and @i/10-yrd/25056 (3a.2: a
// leased delete in the same publish, for 3b's drop: the cancelled event and the branch delete).

import childProcess from "node:child_process"

import { afterEach, describe, expect, test, vi } from "vitest"

import { chainsUnder, listRefs, openEvents } from "../src/events.js"
import { Conflict, open } from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import { createMemBackend } from "../src/mem.js"
import { createShellBackend, fetchedNamespace } from "../src/shell.js"
import type { GitomicBackend, Oid } from "../src/types.js"
import { createBareRepo, git } from "./helpers/git.js"

const CHAIN = "refs/events/demo"
const BRANCH = "refs/heads/feature"
const ZERO = "0".repeat(40)

type Target = { name: string; repo: string; backend: GitomicBackend; cleanup(): Promise<void> }

async function targets(): Promise<Target[]> {
  const shell = await createBareRepo()
  const iso = await createBareRepo()
  return [
    { name: "shell", repo: shell.repo, backend: createShellBackend(), cleanup: shell.cleanup },
    { name: "iso", repo: iso.repo, backend: createIsoBackend(), cleanup: iso.cleanup },
    { name: "mem", repo: "multi-mem", backend: createMemBackend(), cleanup: async () => {} },
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

/** A work commit on refs/heads/main, usable as a branch tip. */
async function workCommit(repo: string, backend: GitomicBackend, path: string): Promise<Oid> {
  const store = await open({ repo, ref: "refs/heads/main", writer: "work", backend })
  return (await store.transact(async (map) => map.set(path, `${path}\n`), `write ${path}`)).oid
}

async function tipOf(repo: string, backend: GitomicBackend, ref: string, remote?: string): Promise<Oid | undefined> {
  const listed = await listRefs(ref, { repo, backend, ...(remote === undefined ? {} : { remote }) })
  return listed.get(ref)
}

function gitSpawns(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((call) => call[0] === "git").length
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("MULTI: the backend publishes many refs atomically, all or none", () => {
  test("every ref lands when every lease holds; one lost lease lands none, and names the ref, expect and tip", async () => {
    await withTargets(async ({ name, repo, backend }) => {
      const one = await workCommit(repo, backend, "one")
      const two = await workCommit(repo, backend, "two")
      const publish = backend.publish as NonNullable<GitomicBackend["publish"]>
      expect(
        await publish(repo, [
          { ref: "refs/heads/a", expect: ZERO, oid: one },
          { ref: "refs/heads/b", expect: ZERO, oid: one },
        ]),
        name,
      ).toEqual({
        outcomes: [
          { ref: "refs/heads/a", outcome: "updated" },
          { ref: "refs/heads/b", outcome: "updated" },
        ],
      })

      const lost = publish(repo, [
        { ref: "refs/heads/a", expect: one, oid: two },
        { ref: "refs/heads/b", expect: two, oid: two },
      ])
      await expect(lost, name).rejects.toBeInstanceOf(Conflict)
      await expect(lost, name).rejects.toMatchObject({ refs: ["refs/heads/b"] })
      // Atomic: a, whose lease held, did not move either.
      expect(await tipOf(repo, backend, "refs/heads/a"), name).toBe(one)
      expect(await tipOf(repo, backend, "refs/heads/b"), name).toBe(one)
    })
  })

  test("(a) a same-oid ref with a stale lease plus a real update: success, outcomes [unchanged, updated]", async () => {
    await withTargets(async ({ name, repo, backend }) => {
      const a = await workCommit(repo, backend, "a")
      const b = await workCommit(repo, backend, "b")
      const event = await workCommit(repo, backend, "event")
      const publish = backend.publish as NonNullable<GitomicBackend["publish"]>
      await publish(repo, [{ ref: BRANCH, expect: ZERO, oid: b }])
      expect(
        await publish(repo, [
          { ref: BRANCH, expect: a, oid: b },
          { ref: "refs/events/e", expect: ZERO, oid: event },
        ]),
        name,
      ).toEqual({
        outcomes: [
          { ref: BRANCH, outcome: "unchanged" },
          { ref: "refs/events/e", outcome: "updated" },
        ],
      })
      expect(await tipOf(repo, backend, "refs/events/e"), name).toBe(event)
      expect(await tipOf(repo, backend, BRANCH), name).toBe(b)
    })
  })

  test("(b) a same-oid ref plus a real update whose lease is stale: Conflict naming the second ref, nothing moved", async () => {
    await withTargets(async ({ name, repo, backend }) => {
      const a = await workCommit(repo, backend, "a")
      const b = await workCommit(repo, backend, "b")
      const c = await workCommit(repo, backend, "c")
      const publish = backend.publish as NonNullable<GitomicBackend["publish"]>
      await publish(repo, [
        { ref: BRANCH, expect: ZERO, oid: b },
        { ref: "refs/heads/other", expect: ZERO, oid: a },
      ])
      const refused = publish(repo, [
        { ref: BRANCH, expect: a, oid: b },
        { ref: "refs/heads/other", expect: b, oid: c },
      ])
      await expect(refused, name).rejects.toBeInstanceOf(Conflict)
      await expect(refused, name).rejects.toMatchObject({ refs: ["refs/heads/other"] })
      await expect(refused, name).rejects.toThrow(`refs/heads/other is at ${a}, not ${b}`)
      expect(await tipOf(repo, backend, BRANCH), name).toBe(b)
      expect(await tipOf(repo, backend, "refs/heads/other"), name).toBe(a)
    })
  })

  test("(c) create of a ref already at oid is unchanged; at another oid it is a Conflict", async () => {
    await withTargets(async ({ name, repo, backend }) => {
      const a = await workCommit(repo, backend, "a")
      const b = await workCommit(repo, backend, "b")
      const publish = backend.publish as NonNullable<GitomicBackend["publish"]>
      await publish(repo, [{ ref: BRANCH, expect: ZERO, oid: a }])
      expect(await publish(repo, [{ ref: BRANCH, expect: ZERO, oid: a }]), name).toEqual({
        outcomes: [{ ref: BRANCH, outcome: "unchanged" }],
      })
      const refused = publish(repo, [{ ref: BRANCH, expect: ZERO, oid: b }])
      await expect(refused, name).rejects.toMatchObject({ refs: [BRANCH] })
      await expect(refused, name).rejects.toThrow(`${BRANCH} is at ${a}, not absent`)
      expect(await tipOf(repo, backend, BRANCH), name).toBe(a)
    })
  })

  test("(d) an all-unchanged publish is a success, and publishing the same list twice succeeds twice", async () => {
    await withTargets(async ({ name, repo, backend }) => {
      const a = await workCommit(repo, backend, "a")
      const b = await workCommit(repo, backend, "b")
      const publish = backend.publish as NonNullable<GitomicBackend["publish"]>
      const list = [
        { ref: "refs/heads/x", expect: ZERO, oid: a },
        { ref: "refs/heads/y", expect: ZERO, oid: b },
      ]
      expect(
        (await publish(repo, list)).outcomes.map(({ outcome }) => outcome),
        name,
      ).toEqual(["updated", "updated"])
      expect(
        (await publish(repo, list)).outcomes.map(({ outcome }) => outcome),
        name,
      ).toEqual(["unchanged", "unchanged"])
    })
  })

  test("a lock held by another writer is a Conflict on that ref, observed locked; released, the publish lands", async () => {
    const fixture = await createBareRepo()
    try {
      const backend = createShellBackend()
      const one = await workCommit(fixture.repo, backend, "one")
      const publish = backend.publish as NonNullable<GitomicBackend["publish"]>
      const { mkdir, rm, writeFile } = await import("node:fs/promises")
      const { join } = await import("node:path")
      await mkdir(join(fixture.repo, "refs", "heads"), { recursive: true })
      const lock = join(fixture.repo, "refs", "heads", "a.lock")
      await writeFile(lock, "")
      const held = publish(fixture.repo, [
        { ref: "refs/heads/a", expect: ZERO, oid: one },
        { ref: "refs/heads/b", expect: ZERO, oid: one },
      ])
      await expect(held).rejects.toBeInstanceOf(Conflict)
      await expect(held).rejects.toMatchObject({ refs: ["refs/heads/a"] })
      await expect(held).rejects.toThrow("refs/heads/a is at locked")
      expect(await tipOf(fixture.repo, backend, "refs/heads/b")).toBeUndefined()
      await rm(lock)
      expect(
        (
          await publish(fixture.repo, [
            { ref: "refs/heads/a", expect: ZERO, oid: one },
            { ref: "refs/heads/b", expect: ZERO, oid: one },
          ])
        ).outcomes.map(({ outcome }) => outcome),
      ).toEqual(["updated", "updated"])
    } finally {
      await fixture.cleanup()
    }
  })

  test("a malformed publish is refused before anything is written", async () => {
    await withTargets(async ({ name, repo, backend }) => {
      const one = await workCommit(repo, backend, "one")
      const publish = backend.publish as NonNullable<GitomicBackend["publish"]>
      await expect(publish(repo, []), name).rejects.toThrow("at least one ref")
      await expect(
        publish(repo, [
          { ref: "refs/heads/a", expect: ZERO, oid: one },
          { ref: "refs/heads/a", expect: ZERO, oid: one },
        ]),
        name,
      ).rejects.toThrow("more than once")
      expect(await tipOf(repo, backend, "refs/heads/a"), name).toBeUndefined()
    })
  })
})

describe("events: append and transact publish `also` refs in the same atomic publish", () => {
  test("the event and the branch land together on every backend", async () => {
    await withTargets(async ({ name, repo, backend }) => {
      const work = await workCommit(repo, backend, "work")
      const events = await openEvents({ repo, ref: CHAIN, backend })
      const appended = await events.append([{ type: "opened", keeps: [work] }], {
        expect: null,
        also: [{ ref: BRANCH, expect: null, oid: work }],
      })
      expect(await events.head(), name).toBe(appended.head)
      expect(await tipOf(repo, backend, BRANCH), name).toBe(work)
    })
  })

  test("a rival that moved the branch refuses the whole append: Conflict names the branch, nothing lands", async () => {
    await withTargets(async ({ name, repo, backend }) => {
      const work = await workCommit(repo, backend, "work")
      const rival = await workCommit(repo, backend, "rival")
      const publish = backend.publish as NonNullable<GitomicBackend["publish"]>
      await publish(repo, [{ ref: BRANCH, expect: ZERO, oid: rival }])

      const events = await openEvents({ repo, ref: CHAIN, backend })
      const refused = events.append([{ type: "opened" }], {
        expect: null,
        also: [{ ref: BRANCH, expect: null, oid: work }],
      })
      await expect(refused, name).rejects.toBeInstanceOf(Conflict)
      await expect(refused, name).rejects.toThrow(BRANCH)
      expect(await events.head(), name).toBeNull()
      expect(await tipOf(repo, backend, BRANCH), name).toBe(rival)
    })
  })

  test("transact re-decides on a rival event and still lands its branch; a rival branch is a Conflict", async () => {
    const backend = createMemBackend()
    const repo = "multi-transact"
    const work = await workCommit(repo, backend, "work")
    const mine = await openEvents({ repo, ref: CHAIN, writer: "mine", backend })
    const theirs = await openEvents({ repo, ref: CHAIN, writer: "theirs", backend })

    const seen: number[] = []
    let release: () => void = () => {}
    const theirsLanded = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = mine.transact(
      async (events) => {
        seen.push(events.length)
        if (seen.length === 1) await theirsLanded
        return [{ type: "admitted" }]
      },
      "admit and publish the branch",
      { also: [{ ref: BRANCH, expect: null, oid: work }] },
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    await theirs.append([{ type: "rival" }], { expect: null })
    release()
    const outcome = await run
    expect(seen).toEqual([0, 1])
    expect(outcome.retries).toBeGreaterThanOrEqual(1)
    expect(await tipOf(repo, backend, BRANCH)).toBe(work)

    // The branch is at `work`; asking it to go from absent to `other` is stale.
    const other = await workCommit(repo, backend, "other")
    await expect(
      mine.transact(() => [{ type: "again" }], "stale branch", { also: [{ ref: BRANCH, expect: null, oid: other }] }),
    ).rejects.toThrow(BRANCH)
    expect((await mine.events()).map((event) => event.type)).toEqual(["rival", "admitted"])
  })

  test("an `also` ref that is the chain itself, or named twice, is refused", async () => {
    const backend = createMemBackend()
    const events = await openEvents({ repo: "multi-refused", ref: CHAIN, backend })
    const work = await workCommit("multi-refused", backend, "work")
    await expect(
      events.append([{ type: "x" }], { expect: null, also: [{ ref: CHAIN, expect: null, oid: work }] }),
    ).rejects.toThrow("the chain itself")
    await expect(
      events.append([{ type: "x" }], {
        expect: null,
        also: [
          { ref: BRANCH, expect: null, oid: work },
          { ref: BRANCH, expect: null, oid: work },
        ],
      }),
    ).rejects.toThrow("more than once")
    expect(await events.head()).toBeNull()
  })
})

describe("remote: one atomic push, one fetch", () => {
  async function remotePair() {
    const origin = await createBareRepo()
    const local = await createBareRepo()
    await git(local.repo, "remote", "add", "origin", origin.repo)
    return {
      origin,
      local,
      cleanup: async () => {
        await origin.cleanup()
        await local.cleanup()
      },
    }
  }

  test("a rival CAS on the remote branch refuses the whole remote append; nothing lands there", async () => {
    const pair = await remotePair()
    try {
      const backend = createShellBackend()
      const work = await workCommit(pair.local.repo, backend, "work")
      const rival = await workCommit(pair.origin.repo, backend, "rival")
      await git(pair.origin.repo, "update-ref", BRANCH, rival)
      const events = await openEvents({ repo: pair.local.repo, ref: CHAIN, remote: "origin", backend })
      const refused = events.append([{ type: "submitted" }], {
        expect: null,
        also: [{ ref: BRANCH, expect: null, oid: work }],
      })
      await expect(refused).rejects.toThrow(BRANCH)
      expect(await tipOf(pair.origin.repo, backend, CHAIN)).toBeUndefined()
      expect(await tipOf(pair.origin.repo, backend, BRANCH)).toBe(rival)

      const landed = await events.append([{ type: "submitted" }], {
        expect: null,
        also: [{ ref: BRANCH, expect: rival, oid: work }],
      })
      expect(await tipOf(pair.origin.repo, backend, CHAIN)).toBe(landed.head)
      expect(await tipOf(pair.origin.repo, backend, BRANCH)).toBe(work)
    } finally {
      await pair.cleanup()
    }
  })

  test("remotely, (a) a same-oid stale lease reads unchanged and the rest lands; (b) a real stale lease refuses all", async () => {
    const pair = await remotePair()
    try {
      const backend = createShellBackend()
      const a = await workCommit(pair.local.repo, backend, "a")
      const b = await workCommit(pair.local.repo, backend, "b")
      const c = await workCommit(pair.local.repo, backend, "c")
      const event = await workCommit(pair.local.repo, backend, "event")
      const publish = backend.publish as NonNullable<GitomicBackend["publish"]>
      await publish(pair.local.repo, [{ ref: BRANCH, expect: ZERO, oid: b }], "origin")
      expect(
        await publish(
          pair.local.repo,
          [
            { ref: BRANCH, expect: a, oid: b },
            { ref: "refs/events/e", expect: ZERO, oid: event },
          ],
          "origin",
        ),
      ).toEqual({
        outcomes: [
          { ref: BRANCH, outcome: "unchanged" },
          { ref: "refs/events/e", outcome: "updated" },
        ],
      })
      expect(await tipOf(pair.origin.repo, backend, "refs/events/e")).toBe(event)

      const refused = publish(
        pair.local.repo,
        [
          { ref: "refs/events/f", expect: ZERO, oid: event },
          { ref: BRANCH, expect: a, oid: c },
        ],
        "origin",
      )
      await expect(refused).rejects.toBeInstanceOf(Conflict)
      await expect(refused).rejects.toMatchObject({ refs: [BRANCH] })
      expect(await tipOf(pair.origin.repo, backend, "refs/events/f")).toBeUndefined()
      expect(await tipOf(pair.origin.repo, backend, BRANCH)).toBe(b)
      // Publishing the same list twice succeeds twice, remotely too.
      const again = [{ ref: "refs/events/e", expect: ZERO, oid: event }]
      expect(await publish(pair.local.repo, again, "origin")).toEqual({
        outcomes: [{ ref: "refs/events/e", outcome: "unchanged" }],
      })
    } finally {
      await pair.cleanup()
    }
  })

  test("one git process per publish, local and remote", async () => {
    const pair = await remotePair()
    try {
      const backend = createShellBackend()
      const one = await workCommit(pair.local.repo, backend, "one")
      const publish = backend.publish as NonNullable<GitomicBackend["publish"]>
      // Warm the per-repository probes so the count is the publish alone.
      await publish(pair.local.repo, [{ ref: "refs/heads/warm", expect: ZERO, oid: one }])
      await publish(pair.local.repo, [{ ref: "refs/heads/warm", expect: ZERO, oid: one }], "origin")

      const spy = vi.spyOn(childProcess, "spawn")
      await publish(pair.local.repo, [
        { ref: "refs/heads/a", expect: ZERO, oid: one },
        { ref: "refs/heads/b", expect: ZERO, oid: one },
      ])
      expect(gitSpawns(spy)).toBe(1)
      spy.mockClear()
      await publish(
        pair.local.repo,
        [
          { ref: "refs/heads/a", expect: ZERO, oid: one },
          { ref: "refs/heads/b", expect: ZERO, oid: one },
        ],
        "origin",
      )
      expect(gitSpawns(spy)).toBe(1)

      // (e) the local failure path costs at most three: transaction, for-each-ref, re-run.
      const two = await workCommit(pair.local.repo, backend, "two")
      spy.mockClear()
      await publish(pair.local.repo, [
        { ref: "refs/heads/a", expect: ZERO, oid: one },
        { ref: "refs/heads/c", expect: ZERO, oid: two },
      ])
      expect(gitSpawns(spy)).toBeLessThanOrEqual(3)
      spy.mockClear()
      await expect(publish(pair.local.repo, [{ ref: "refs/heads/a", expect: ZERO, oid: two }])).rejects.toBeInstanceOf(
        Conflict,
      )
      expect(gitSpawns(spy)).toBeLessThanOrEqual(3)
    } finally {
      await pair.cleanup()
    }
  })

  test("fetchRefs brings every ref under a prefix in one process, and names what it read", async () => {
    for (const make of [createShellBackend, createIsoBackend]) {
      const pair = await remotePair()
      try {
        const backend = make()
        const name = make === createShellBackend ? "shell" : "iso"
        const writer = createShellBackend()
        for (const branch of ["a", "b"]) {
          const chain = await openEvents({
            repo: pair.origin.repo,
            ref: `refs/yrd/q/changes/${branch}`,
            backend: writer,
          })
          await chain.append([{ type: "submitted" }], { expect: null })
        }
        const fetchRefs = backend.fetchRefs as NonNullable<GitomicBackend["fetchRefs"]>
        const there = await listRefs("refs/yrd/q/changes/", { repo: pair.origin.repo, backend: writer })
        // Warm the per-repository probes so the count is the fetch alone.
        await listRefs("refs/yrd/", { repo: pair.local.repo, backend })

        const spy = vi.spyOn(childProcess, "spawn")
        const fetched = await fetchRefs(pair.local.repo, "refs/yrd/q/changes/", "origin")
        expect(gitSpawns(spy), name).toBe(1)
        spy.mockRestore()
        expect([...fetched], name).toEqual([...there])
        // Unchanged tips are still reported, and a deleted remote ref drops out.
        expect([...(await fetchRefs(pair.local.repo, "refs/yrd/q/changes/", "origin"))], name).toEqual([...there])
        await git(pair.origin.repo, "update-ref", "-d", "refs/yrd/q/changes/a")
        expect([...(await fetchRefs(pair.local.repo, "refs/yrd/q/changes/", "origin")).keys()], name).toEqual([
          "refs/yrd/q/changes/b",
        ])
        // Named refs: a missing one fails loudly, naming it.
        await expect(
          fetchRefs(pair.local.repo, ["refs/yrd/q/changes/b", "refs/yrd/q/changes/nope"], "origin"),
          name,
        ).rejects.toThrow("refs/yrd/q/changes/nope")
        // No application ref moved: fetchRefs writes only gitomic's private namespace.
        expect(await tipOf(pair.local.repo, writer, "refs/yrd/q/changes/b"), name).toBeUndefined()
      } finally {
        await pair.cleanup()
      }
    }
  })

  test("chainsUnder a remote prefix reads every chain in two processes and matches the remote's own read", async () => {
    const pair = await remotePair()
    try {
      const backend = createShellBackend()
      for (const branch of ["a", "b", "c"]) {
        const chain = await openEvents({ repo: pair.origin.repo, ref: `refs/yrd/q/changes/${branch}`, backend })
        await chain.append([{ type: "submitted" }, { type: "verifying" }], { expect: null })
      }
      const expected = await chainsUnder("refs/yrd/q/changes/", { repo: pair.origin.repo, backend })
      await chainsUnder("refs/yrd/q/changes/", { repo: pair.local.repo, remote: "origin", backend })

      const spy = vi.spyOn(childProcess, "spawn")
      const read = await chainsUnder("refs/yrd/q/changes/", { repo: pair.local.repo, remote: "origin", backend })
      expect(gitSpawns(spy)).toBe(2)
      expect(read).toEqual(expected)
    } finally {
      await pair.cleanup()
    }
  })

  test("a failure that is not a per-ref rejection is an Error with git's text, never a Conflict", async () => {
    const pair = await remotePair()
    try {
      const backend = createShellBackend()
      const one = await workCommit(pair.local.repo, backend, "one")
      await git(pair.local.repo, "remote", "add", "gone", `${pair.origin.repo}-does-not-exist`)
      const publish = backend.publish as NonNullable<GitomicBackend["publish"]>
      const failed = publish(pair.local.repo, [{ ref: "refs/heads/a", expect: ZERO, oid: one }], "gone")
      await expect(failed).rejects.toThrow(/git push failed/)
      await expect(failed).rejects.not.toBeInstanceOf(Conflict)

      const events = await openEvents({ repo: pair.local.repo, ref: CHAIN, remote: "gone", backend })
      await expect(events.append([{ type: "x" }], { expect: null })).rejects.not.toBeInstanceOf(Conflict)
    } finally {
      await pair.cleanup()
    }
  })

  test("the private namespace keeps a ref-safe remote name and encodes anything else, always a valid ref", async () => {
    const fixture = await createBareRepo()
    try {
      expect(fetchedNamespace("origin")).toBe("refs/gitomic/fetched/origin/")
      for (const remote of ["origin.", "a..b", "x.lock", "/srv/git/q.git", "https://host/q.git"]) {
        const namespace = fetchedNamespace(remote)
        expect(namespace, remote).toMatch(/^refs\/gitomic\/fetched\/url-[A-Za-z0-9_-]+\/$/)
        await git(fixture.repo, "check-ref-format", `${namespace}refs/heads/x`)
      }
    } finally {
      await fixture.cleanup()
    }
  })

  test("mem has no remote and says so", async () => {
    const backend = createMemBackend()
    await expect(
      (backend.fetchRefs as NonNullable<GitomicBackend["fetchRefs"]>)("multi-mem", "refs/yrd/", "origin"),
    ).rejects.toThrow("no remotes")
  })
})

describe("a leased delete rides the same atomic publish (oid null)", () => {
  test("(a) an append whose `also` deletes the branch lands atomically; the kept commit stays readable", async () => {
    await withTargets(async ({ name, repo, backend }) => {
      const work = await workCommit(repo, backend, "work")
      const publish = backend.publish as NonNullable<GitomicBackend["publish"]>
      await publish(repo, [{ ref: BRANCH, expect: ZERO, oid: work }])
      const events = await openEvents({ repo, ref: CHAIN, backend })
      const appended = await events.append([{ type: "cancelled", keeps: [work] }], {
        expect: null,
        also: [{ ref: BRANCH, expect: work, oid: null }],
      })
      expect(await events.head(), name).toBe(appended.head)
      expect(await tipOf(repo, backend, BRANCH), name).toBeUndefined()
      // The event keeps the branch's last head, so the commit outlives the branch.
      expect((await events.events()).at(-1)?.links, name).toEqual([work])
      expect((await backend.readCommit(repo, work)).oid, name).toBe(work)
      if (name !== "mem") await git(repo, "cat-file", "-e", `${work}^{commit}`)
    })
  })

  test("(b) a stale delete lease is a Conflict naming the observed tip; the event and the branch do not move", async () => {
    await withTargets(async ({ name, repo, backend }) => {
      const work = await workCommit(repo, backend, "work")
      const rival = await workCommit(repo, backend, "rival")
      const publish = backend.publish as NonNullable<GitomicBackend["publish"]>
      await publish(repo, [{ ref: BRANCH, expect: ZERO, oid: rival }])
      const events = await openEvents({ repo, ref: CHAIN, backend })
      const refused = events.append([{ type: "cancelled", keeps: [work] }], {
        expect: null,
        also: [{ ref: BRANCH, expect: work, oid: null }],
      })
      await expect(refused, name).rejects.toBeInstanceOf(Conflict)
      await expect(refused, name).rejects.toMatchObject({ refs: [BRANCH] })
      await expect(refused, name).rejects.toThrow(`${BRANCH} is at ${rival}, not ${work}`)
      expect(await events.head(), name).toBeNull()
      expect(await tipOf(repo, backend, BRANCH), name).toBe(rival)
    })
  })

  test("(c) deleting an absent ref is a Conflict observed absent, never unchanged", async () => {
    await withTargets(async ({ name, repo, backend }) => {
      const work = await workCommit(repo, backend, "work")
      const publish = backend.publish as NonNullable<GitomicBackend["publish"]>
      const refused = publish(repo, [
        { ref: "refs/heads/kept", expect: ZERO, oid: work },
        { ref: BRANCH, expect: work, oid: null },
      ])
      await expect(refused, name).rejects.toBeInstanceOf(Conflict)
      await expect(refused, name).rejects.toMatchObject({ refs: [BRANCH] })
      await expect(refused, name).rejects.toThrow(`${BRANCH} is at absent, not ${work}`)
      expect(await tipOf(repo, backend, "refs/heads/kept"), name).toBeUndefined()
    })
  })

  test("(d) a delete with a zero expect is a caller mistake, refused before anything is written", async () => {
    await withTargets(async ({ name, repo, backend }) => {
      const publish = backend.publish as NonNullable<GitomicBackend["publish"]>
      await expect(publish(repo, [{ ref: BRANCH, expect: ZERO, oid: null }]), name).rejects.toBeInstanceOf(TypeError)
      const events = await openEvents({ repo, ref: CHAIN, backend })
      await expect(
        events.append([{ type: "x" }], { expect: null, also: [{ ref: BRANCH, expect: null, oid: null }] }),
        name,
      ).rejects.toBeInstanceOf(TypeError)
      expect(await events.head(), name).toBeNull()
      expect(await tipOf(repo, backend, BRANCH), name).toBeUndefined()
    })
  })

  test("(e) one update and one delete in a single publish: outcomes [updated, deleted]", async () => {
    await withTargets(async ({ name, repo, backend }) => {
      const work = await workCommit(repo, backend, "work")
      const event = await workCommit(repo, backend, "event")
      const publish = backend.publish as NonNullable<GitomicBackend["publish"]>
      await publish(repo, [{ ref: BRANCH, expect: ZERO, oid: work }])
      expect(
        await publish(repo, [
          { ref: "refs/events/e", expect: ZERO, oid: event },
          { ref: BRANCH, expect: work, oid: null },
        ]),
        name,
      ).toEqual({
        outcomes: [
          { ref: "refs/events/e", outcome: "updated" },
          { ref: BRANCH, outcome: "deleted" },
        ],
      })
      expect(await tipOf(repo, backend, "refs/events/e"), name).toBe(event)
      expect(await tipOf(repo, backend, BRANCH), name).toBeUndefined()
    })
  })

  test("remotely: (e) update plus delete in one push, (a) through `also`, (b) stale and (c) absent are Conflicts", async () => {
    const origin = await createBareRepo()
    const local = await createBareRepo()
    try {
      await git(local.repo, "remote", "add", "origin", origin.repo)
      const backend = createShellBackend()
      const work = await workCommit(local.repo, backend, "work")
      const event = await workCommit(local.repo, backend, "event")
      const rival = await workCommit(local.repo, backend, "rival")
      const publish = backend.publish as NonNullable<GitomicBackend["publish"]>
      await publish(
        local.repo,
        [
          { ref: BRANCH, expect: ZERO, oid: work },
          { ref: "refs/heads/other", expect: ZERO, oid: work },
          // The rival commit must exist on the remote for a rival to move a ref there.
          { ref: "refs/heads/rival", expect: ZERO, oid: rival },
        ],
        "origin",
      )

      // (e) one push: an update and a delete, each from git's own porcelain.
      const spy = vi.spyOn(childProcess, "spawn")
      expect(
        await publish(
          local.repo,
          [
            { ref: "refs/events/e", expect: ZERO, oid: event },
            { ref: BRANCH, expect: work, oid: null },
          ],
          "origin",
        ),
      ).toEqual({
        outcomes: [
          { ref: "refs/events/e", outcome: "updated" },
          { ref: BRANCH, outcome: "deleted" },
        ],
      })
      expect(gitSpawns(spy)).toBe(1)
      spy.mockRestore()
      expect(await tipOf(origin.repo, backend, BRANCH)).toBeUndefined()

      // (c) the branch is gone now: deleting it again is a Conflict observed absent.
      const absent = publish(local.repo, [{ ref: BRANCH, expect: work, oid: null }], "origin")
      await expect(absent).rejects.toBeInstanceOf(Conflict)
      await expect(absent).rejects.toThrow(`${BRANCH} is at absent, not ${work}`)

      // (b) a rival moved the other branch: the delete lease is stale, nothing lands.
      await git(origin.repo, "update-ref", "refs/heads/other", rival)
      const events = await openEvents({ repo: local.repo, ref: CHAIN, remote: "origin", backend })
      const stale = events.append([{ type: "cancelled", keeps: [work] }], {
        expect: null,
        also: [{ ref: "refs/heads/other", expect: work, oid: null }],
      })
      await expect(stale).rejects.toBeInstanceOf(Conflict)
      await expect(stale).rejects.toThrow(`refs/heads/other is at ${rival}, not ${work}`)
      expect(await tipOf(origin.repo, backend, CHAIN)).toBeUndefined()
      expect(await tipOf(origin.repo, backend, "refs/heads/other")).toBe(rival)

      // (a) with the right lease the cancelled event and the delete land together.
      const landed = await events.append([{ type: "cancelled", keeps: [rival] }], {
        expect: null,
        also: [{ ref: "refs/heads/other", expect: rival, oid: null }],
      })
      expect(await tipOf(origin.repo, backend, CHAIN)).toBe(landed.head)
      expect(await tipOf(origin.repo, backend, "refs/heads/other")).toBeUndefined()
      await git(origin.repo, "cat-file", "-e", `${rival}^{commit}`)
    } finally {
      await origin.cleanup()
      await local.cleanup()
    }
  })
})

describe("the README and CHANGELOG document MULTI and the batched fetch", () => {
  test("MULTI is no longer planned, and the private namespace and its prune are stated", async () => {
    const { readFile } = await import("node:fs/promises")
    const { fileURLToPath } = await import("node:url")
    const readme = await readFile(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8")
    const changelog = await readFile(fileURLToPath(new URL("../CHANGELOG.md", import.meta.url)), "utf8")
    expect(readme).toMatch(/\| `MULTI` +\| `also` on `append` \/ `transact` +\|/)
    expect(readme).not.toContain("(planned)")
    expect(readme).toContain("refs/gitomic/fetched/")
    expect(readme).toMatch(/never\s+an application ref/)
    expect(readme).toMatch(/`expect` is a lease, not an\s+assertion/)
    expect(readme).toMatch(/as advertised at push time, not\s+locked/)
    expect(readme).toMatch(/`updated`, `unchanged` or\s+`deleted`/)
    expect(changelog).toContain("GitomicBackend.publish")
    expect(changelog).toContain("GitomicBackend.fetchRefs")
    expect(changelog).toMatch(/leased delete/)
  })
})
