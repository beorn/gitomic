// @failure gitomic could land half of a multi-ref publish (the event without the branch it
// names, or the reverse), retry forever on a rival that moved the other ref, or read a
// remote queue one chain per git process.
// @level l1
// @consumer yrd's submit (branch head plus opened event in one push) and runner tick (every
// chain under a queue in one fetch), 25040 3b
//
// Acceptance of @i/10-yrd/25055 (3a.1: MULTI and batched fetch).

import childProcess from "node:child_process"

import { afterEach, describe, expect, test, vi } from "vitest"

import { chainsUnder, listRefs, openEvents } from "../src/events.js"
import { Conflict, open } from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import { createMemBackend } from "../src/mem.js"
import { createShellBackend } from "../src/shell.js"
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
  test("every ref lands when every expectation holds; one stale expectation lands none, and names it", async () => {
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
      ).toEqual({ landed: true })

      const stale = await publish(repo, [
        { ref: "refs/heads/a", expect: one, oid: two },
        { ref: "refs/heads/b", expect: two, oid: two },
      ])
      expect(stale, name).toEqual({ landed: false, stale: ["refs/heads/b"] })
      // Atomic: a, whose expectation held, did not move either.
      expect(await tipOf(repo, backend, "refs/heads/a"), name).toBe(one)
      expect(await tipOf(repo, backend, "refs/heads/b"), name).toBe(one)
    })
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
      expect(await publish(repo, [{ ref: BRANCH, expect: ZERO, oid: rival }]), name).toEqual({ landed: true })

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

    await expect(
      mine.transact(() => [{ type: "again" }], "stale branch", { also: [{ ref: BRANCH, expect: null, oid: work }] }),
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

  test("mem has no remote and says so", async () => {
    const backend = createMemBackend()
    await expect(
      (backend.fetchRefs as NonNullable<GitomicBackend["fetchRefs"]>)("multi-mem", "refs/yrd/", "origin"),
    ).rejects.toThrow("no remotes")
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
    expect(changelog).toContain("GitomicBackend.publish")
    expect(changelog).toContain("GitomicBackend.fetchRefs")
  })
})
