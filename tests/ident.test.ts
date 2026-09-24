// @failure Every gitomic commit names `gitomic <gitomic@localhost>` as author and committer, so
// `git log --format=%an` answers "gitomic" for every agent's write and nobody can tell who acted
// without broadcasting to the whole fleet (who-acted WA-R13, 25073).
// @level l1
// @consumer km's rail writes, which must record the acting agent as author and km as committer

import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

import { describe, expect, test } from "vitest"

import { apply, identProblem, open } from "../src/index.js"
import type { CommitInput, GitomicBackend, Ident } from "../src/index.js"
import { openEvents } from "../src/events.js"
import { createIsoBackend } from "../src/iso.js"
import { createMemBackend } from "../src/mem.js"
import { createShellBackend } from "../src/shell.js"
import { appendEmptyHistory, createBareRepo, git, gitWithInput } from "./helpers/git.js"

const execFileAsync = promisify(execFile)
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const GITOMIC: Ident = { name: "gitomic", email: "gitomic@localhost" }
const KM: Ident = { name: "km", email: "km@main.hh.invalid" }
const AGENT: Ident = { name: "@dev/7", email: "dev-7@main.hh.invalid" }
const OTHER: Ident = { name: "@dev/3", email: "dev-3@main.hh.invalid" }

/** Gitomic's genesis: the same empty root on mem and on a git-made bare repo. */
const GENESIS = "8e818d1df6fa19bea8c854a46221adaa68738303"

function input(overrides: Partial<CommitInput> = {}): CommitInput {
  return {
    parent: GENESIS,
    changes: new Map([["a.md", "x\n"]]),
    message: "close 25060",
    writer: "km",
    instance: "00000000-0000-4000-8000-000000000000",
    seq: 0,
    ...overrides,
  }
}

type Leg = { name: string; backend: GitomicBackend; repo: string; cleanup(): Promise<void> }

async function legs(): Promise<Leg[]> {
  const shell = await createBareRepo()
  const iso = await createBareRepo()
  expect(shell.initial).toBe(GENESIS)
  return [
    { name: "mem", backend: createMemBackend(), repo: "vault", cleanup: async () => {} },
    { name: "iso", backend: createIsoBackend(), repo: iso.repo, cleanup: iso.cleanup },
    { name: "shell", backend: createShellBackend(), repo: shell.repo, cleanup: shell.cleanup },
  ]
}

describe("author and committer are data, identical on every backend", () => {
  test("the shell uses its selected environment and explicit identities for both commit paths", async () => {
    const fixture = await createBareRepo()
    try {
      const tracePath = join(fixture.repo, "git-trace.jsonl")
      const backend = createShellBackend({
        baseEnv: {
          PATH: process.env.PATH,
          GIT_TRACE2_EVENT: tracePath,
          GIT_AUTHOR_NAME: "ambient author",
          GIT_AUTHOR_EMAIL: "ambient@author.invalid",
          GIT_COMMITTER_NAME: "ambient committer",
          GIT_COMMITTER_EMAIL: "ambient@committer.invalid",
        },
      })
      const changed = await backend.writeCommit(fixture.repo, input({ author: AGENT, committer: KM }))
      const empty = await backend.writeCommit(
        fixture.repo,
        input({ parent: changed, changes: new Map(), seq: 1, author: OTHER, committer: KM }),
      )
      expect(await backend.readCommit(fixture.repo, changed)).toMatchObject({ author: AGENT, committer: KM })
      expect(await backend.readCommit(fixture.repo, empty)).toMatchObject({ author: OTHER, committer: KM })
      expect(
        (await backend.readHistory!(fixture.repo, [empty], { limit: 2 })).map(({ author, committer }) => ({
          author,
          committer,
        })),
      ).toEqual([
        { author: OTHER, committer: KM },
        { author: AGENT, committer: KM },
      ])
      const trace = await readFile(tracePath, "utf8")
      const starts = trace
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event?: string; argv?: string[] })
        .filter((entry) => entry.event === "start")
      expect(starts.filter((entry) => entry.argv?.includes("commit-tree"))).toHaveLength(2)
      expect(starts.some((entry) => entry.argv?.includes("ls-files"))).toBe(true)
      expect(starts.some((entry) => entry.argv?.includes("rev-list"))).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  test("the same input gives the same oid and the same author and committer on mem, iso and shell", async () => {
    const all = await legs()
    try {
      const written = await Promise.all(
        all.map(async ({ backend, repo }) => {
          const oid = await backend.writeCommit(repo, input({ author: AGENT, committer: KM }))
          return { oid, meta: await backend.readCommit(repo, oid) }
        }),
      )
      expect(new Set(written.map(({ oid }) => oid)).size).toBe(1)
      for (const { meta } of written) {
        expect(meta.author).toEqual(AGENT)
        expect(meta.committer).toEqual(KM)
      }
      const shell = all.find((leg) => leg.name === "shell") as Leg
      const raw = await git(shell.repo, "cat-file", "-p", written[0]?.oid ?? "")
      expect(raw).toMatch(/^author @dev\/7 <dev-7@main\.hh\.invalid> 946684801 \+0000$/m)
      expect(raw).toMatch(/^committer km <km@main\.hh\.invalid> 946684801 \+0000$/m)
    } finally {
      await Promise.all(all.map((leg) => leg.cleanup()))
    }
  })

  test("with no author named, the author is the committer", async () => {
    const all = await legs()
    try {
      for (const { backend, repo } of all) {
        const meta = await backend.readCommit(repo, await backend.writeCommit(repo, input({ committer: KM })))
        expect(meta.author).toEqual(KM)
        expect(meta.committer).toEqual(KM)
      }
    } finally {
      await Promise.all(all.map((leg) => leg.cleanup()))
    }
  })

  test("with neither named, the commit is byte-identical to today's (pinned oid)", async () => {
    const all = await legs()
    try {
      for (const { backend, repo } of all) {
        const oid = await backend.writeCommit(repo, input({ message: "pin", writer: "pin-test" }))
        expect(oid).toBe("1bf181663ff340b7e91dc2c15e31589d5fa29b81")
        const meta = await backend.readCommit(repo, oid)
        expect(meta.author).toEqual(GITOMIC)
        expect(meta.committer).toEqual(GITOMIC)
      }
    } finally {
      await Promise.all(all.map((leg) => leg.cleanup()))
    }
  })

  test("genesis keeps gitomic's identity whatever the store's committer", async () => {
    const fixture = await createBareRepo()
    try {
      const events = await openEvents({ repo: fixture.repo, ref: "refs/events/genesis", committer: KM })
      const { head } = await events.append([{ type: "note" }], { expect: null, author: AGENT })
      const log = await git(fixture.repo, "rev-list", "--max-parents=0", head ?? "")
      const root = await git(fixture.repo, "cat-file", "-p", log)
      expect(root).toMatch(/^author gitomic <gitomic@localhost> 946684800 \+0000$/m)
      expect(root).toMatch(/^committer gitomic <gitomic@localhost> 946684800 \+0000$/m)
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("the store and the events API carry the idents", () => {
  test("open takes the committer, each transaction takes its own author, and log reads both back", async () => {
    const fixture = await createBareRepo()
    try {
      const store = await open({ repo: fixture.repo, ref: "main", writer: "km", committer: KM })
      await store.transact(async (map) => map.set("a.md", "a\n"), "close 25060", { author: AGENT })
      await store.transact(async (map) => map.set("b.md", "b\n"), "close 25061", { author: OTHER })
      await store.transact(async (map) => map.set("c.md", "c\n"), "sweep")
      const reader = await open({ repo: fixture.repo, ref: "main" })
      const shellLog = await createShellBackend().readHistory?.(fixture.repo, [await reader.head()], { limit: 3 })
      expect(shellLog?.map(({ author }) => author)).toEqual([KM, OTHER, AGENT])
      expect(shellLog?.map(({ committer }) => committer)).toEqual([KM, KM, KM])
      expect(await git(fixture.repo, "log", "--format=%an|%cn", "-3", "main")).toBe("km|km\n@dev/3|km\n@dev/7|km")
    } finally {
      await fixture.cleanup()
    }
  })

  test("events record the per-call author and the store's committer", async () => {
    const fixture = await createBareRepo()
    try {
      const events = await openEvents({ repo: fixture.repo, ref: "refs/events/who", committer: KM })
      const first = await events.append([{ type: "note" }], { expect: null, author: AGENT })
      await events.transact(() => [{ type: "note" }], "second", { author: OTHER })
      const read = await events.events()
      expect(read.map(({ author }) => author)).toEqual([AGENT, OTHER])
      expect(read.map(({ committer }) => committer)).toEqual([KM, KM])
      expect(first.events[0]?.id).toBe(read[0]?.id)
    } finally {
      await fixture.cleanup()
    }
  })

  test("apply records a named author, and without one the author is the committer", async () => {
    const backend = createMemBackend()
    const store = await open({ repo: "apply", ref: "main", writer: "km", committer: KM, backend })
    const named = await apply(
      store,
      await store.head(),
      [{ kind: "put", path: "a.md", content: "a\n", expect: null }],
      "named",
      {
        author: AGENT,
      },
    )
    const unnamed = await apply(
      store,
      named.oid,
      [{ kind: "put", path: "b.md", content: "b\n", expect: null }],
      "unnamed",
    )
    expect((await backend.readCommit("apply", named.oid)).author).toEqual(AGENT)
    expect((await backend.readCommit("apply", unnamed.oid)).author).toEqual(KM)
    expect((await backend.readCommit("apply", unnamed.oid)).committer).toEqual(KM)
  })

  test("the events API refuses a bad author before writing anything", async () => {
    const fixture = await createBareRepo()
    try {
      const events = await openEvents({ repo: fixture.repo, ref: "refs/events/refuse", committer: KM })
      await expect(
        events.append([{ type: "note" }], { expect: null, author: { name: "a<b", email: "a@b.invalid" } }),
      ).rejects.toThrow(new TypeError(`author ${identProblem({ name: "a<b", email: "a@b.invalid" }) ?? ""}`))
      expect(await events.head()).toBeNull()
    } finally {
      await fixture.cleanup()
    }
  })

  test("the author is captured at submit and survives a lost compare-and-swap", async () => {
    const backend = createMemBackend()
    const store = await open({ repo: "race", ref: "main", writer: "km", committer: KM, backend })
    const rival = await open({ repo: "race", ref: "main", writer: "rival", backend })
    const options = { author: { ...AGENT } }
    let attempts = 0
    const pending = store.transact(
      async (map) => {
        attempts += 1
        if (attempts === 1) await rival.transact(async (rivalMap) => rivalMap.set("rival.md", "r\n"), "rival")
        map.set("a.md", "a\n")
      },
      "close 25060",
      options,
    )
    options.author.name = "@dev/mutated-after-submit"
    const committed = await pending
    expect(committed.retries).toBeGreaterThanOrEqual(1)
    const meta = await backend.readCommit("race", committed.oid)
    expect(meta.author).toEqual(AGENT)
    expect(meta.committer).toEqual(KM)
  })
})

describe("history written before idents were data still reads", () => {
  test("git-made fixture commits read back as gitomic on every backend", async () => {
    const fixture = await createBareRepo()
    try {
      await appendEmptyHistory(fixture.repo, fixture.initial, 2)
      const tip = await git(fixture.repo, "rev-parse", "main")
      for (const backend of [createShellBackend(), createIsoBackend()]) {
        const meta = await backend.readCommit(fixture.repo, tip)
        expect(meta.author).toEqual(GITOMIC)
        expect(meta.committer).toEqual(GITOMIC)
      }
      const history = await createShellBackend().readHistory?.(fixture.repo, [tip])
      expect(history?.map(({ author }) => author)).toEqual([GITOMIC, GITOMIC, GITOMIC])
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("a commit header the reader cannot trust is refused, not guessed", () => {
  test("two author lines fail the read loudly on the object-parsing backends", async () => {
    const fixture = await createBareRepo()
    try {
      const body = `tree ${EMPTY_TREE}\nparent ${fixture.initial}\nauthor a <a@b.invalid> 946684801 +0000\nauthor b <b@b.invalid> 946684801 +0000\ncommitter c <c@b.invalid> 946684801 +0000\n\ntwo authors\n`
      const oid = await gitWithInput(fixture.repo, body, "hash-object", "-t", "commit", "-w", "--literally", "--stdin")
      for (const backend of [createShellBackend(), createIsoBackend()]) {
        await expect(backend.readCommit(fixture.repo, oid)).rejects.toThrow(
          /missing, duplicate or malformed author line/,
        )
      }
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("an ident git would rewrite is refused, never silently changed", () => {
  const refused: readonly [string, unknown][] = [
    ["empty name", { name: "", email: "a@b.invalid" }],
    ["empty email", { name: "a", email: "" }],
    ["< inside", { name: "a<b", email: "a@b.invalid" }],
    ["> inside", { name: "a", email: "a>b@b.invalid" }],
    ["newline inside", { name: "a\nb", email: "a@b.invalid" }],
    ["NUL inside", { name: "a\0b", email: "a@b.invalid" }],
    ["control character inside", { name: "a\tb", email: "a@b.invalid" }],
    ["leading space", { name: " a", email: "a@b.invalid" }],
    ["trailing dot", { name: "Jo Q.", email: "a@b.invalid" }],
    ["leading quote", { name: "'a", email: "a@b.invalid" }],
    ["trailing crud on the email", { name: "a", email: "a@b.invalid;" }],
    ["not an object", "a <a@b.invalid>"],
    ["unknown field", { name: "a", email: "a@b.invalid", date: 1 }],
    ["lone surrogate", { name: "a\uD800", email: "a@b.invalid" }],
  ]

  test.each(refused)("%s: identProblem names it", (_label, ident) => {
    expect(identProblem(ident)).toEqual(expect.any(String))
  })

  test.each(refused)("%s: a transaction naming it rejects with that same problem", async (_label, ident) => {
    const store = await open({ repo: "refuse", ref: "main", writer: "km", backend: createMemBackend() })
    const problem = identProblem(ident) as string
    await expect(
      store.transact(async (map) => map.set("a.md", "a\n"), "x", { author: ident as Ident }),
    ).rejects.toThrow(new TypeError(`author ${problem}`))
  })

  test.each(refused)("%s: open refuses it as the committer", async (_label, ident) => {
    await expect(
      open({ repo: "refuse", ref: "main", committer: ident as Ident, backend: createMemBackend() }),
    ).rejects.toThrow(TypeError)
  })

  test("the idents the design names pass, and so does a non-ASCII name", () => {
    for (const ident of [AGENT, KM, OTHER, { name: "Bjørn Stabell", email: "bjørn@example.invalid" }]) {
      expect(identProblem(ident)).toBeUndefined()
    }
  })

  test("git's commit-tree rewrites or rejects what the rule refuses, so passing it through would split the oids", async () => {
    const fixture = await createBareRepo()
    try {
      // Measured on git 2.55. A trailing "." is kept there, but it is refused as
      // well: older releases in the supported range stripped it.
      for (const name of [" a", "'a", "a:", "a<b", '"a"', "a\\"]) {
        const written = await execFileAsync(
          "git",
          ["--git-dir", fixture.repo, "commit-tree", EMPTY_TREE, "-m", "probe"],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              GIT_AUTHOR_NAME: name,
              GIT_AUTHOR_EMAIL: "a@b.invalid",
              GIT_COMMITTER_NAME: "c",
              GIT_COMMITTER_EMAIL: "c@b.invalid",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
            },
          },
        ).then(
          ({ stdout }) => stdout.trim(),
          () => null,
        )
        if (written !== null) expect(await git(fixture.repo, "log", "-1", "--format=%an", written)).not.toBe(name)
      }
    } finally {
      await fixture.cleanup()
    }
  })
})
