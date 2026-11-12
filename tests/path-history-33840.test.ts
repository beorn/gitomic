/**
 * @failure  #33840: a literal-path `gitomic log` asked two snapshot reads per commit along the whole first-parent
 *           chain, so a path changed 13 times in a 147,162-commit history ran past 300 s with no output.
 * @level    l2 — the real shell backend on bare repositories built with git plumbing; no daemon.
 * @consumer gitomic log <addr> <path> (logGlobMatches), the state-history reads seats run.
 * @reach    fs-walk <fixture-only: the shell backend runs against temporary Git repositories>
 * @testonly none
 */
import { Buffer } from "node:buffer"

import { describe, expect, test } from "vitest"
import { logGlobMatches } from "../src/bin.js"
import { createShellBackend, openReader, type GitomicBackend } from "../src/index.js"
import { createBareRepo, git, gitWithInput } from "./helpers/git.js"

type Fixture = Awaited<ReturnType<typeof createBareRepo>>

/** Build first-parent history from tree snapshots: each step is { path: content | null } over the previous tree. */
async function history(
  fixture: Fixture,
  steps: Array<{ message: string; files: Record<string, string | null>; mode?: Record<string, string>; side?: number }>,
): Promise<string[]> {
  const blob = (content: string) => gitWithInput(fixture.repo, content, "hash-object", "-w", "--stdin")
  const files = new Map<string, { oid: string; mode: string }>()
  const commits: string[] = []
  for (const step of steps) {
    for (const [path, content] of Object.entries(step.files)) {
      if (content === null) files.delete(path)
      else files.set(path, { oid: await blob(content), mode: step.mode?.[path] ?? "100644" })
    }
    for (const [path, mode] of Object.entries(step.mode ?? {})) {
      const entry = files.get(path)
      if (entry !== undefined) files.set(path, { ...entry, mode })
    }
    const tree = await mktreeNested(fixture, files)
    const parents = [
      ...(commits.length === 0 ? [] : [commits.at(-1) as string]),
      ...(step.side === undefined ? [] : [commits[step.side] as string]),
    ]
    commits.push(
      await git(fixture.repo, "commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", step.message),
    )
  }
  await git(fixture.repo, "update-ref", "refs/heads/main", commits.at(-1) as string)
  return commits
}

/** mktree for paths with at most one directory level (enough for the directory row). */
async function mktreeNested(fixture: Fixture, files: Map<string, { oid: string; mode: string }>): Promise<string> {
  const top = new Map<string, string>()
  const dirs = new Map<string, string[]>()
  for (const [path, { oid, mode }] of files) {
    const slash = path.indexOf("/")
    if (slash === -1) top.set(path, `${mode} blob ${oid}\t${path}\n`)
    else {
      const dir = path.slice(0, slash)
      dirs.set(dir, [...(dirs.get(dir) ?? []), `${mode} blob ${oid}\t${path.slice(slash + 1)}\n`])
    }
  }
  for (const [dir, lines] of dirs) {
    top.set(dir, `040000 tree ${await gitWithInput(fixture.repo, lines.join(""), "mktree")}\t${dir}\n`)
  }
  return gitWithInput(fixture.repo, [...top.values()].join(""), "mktree")
}

/** The shell backend without its narrowed walk: the per-commit route every backend had before #33840. */
function perCommitRoute(backend: GitomicBackend): GitomicBackend {
  const { countHistory: _count, ...rest } = backend
  return rest
}

async function subjects(backend: GitomicBackend, repo: string, path: string, limit = 25) {
  const reader = await openReader({ repo, ref: "main", backend })
  const tip = await reader.head()
  const matched = await logGlobMatches({ reader, from: tip, limit, glob: path, pageSize: 3 })
  return {
    narrowed: reader.pathLog !== undefined,
    subjects: matched.commits.map((commit) => commit.message.trim()),
    walked: matched.walked,
    reachedRoot: matched.reachedRoot,
  }
}

describe("gitomic log on one literal path reads one narrowed walk (#33840)", () => {
  test("the narrowed walk answers exactly what the per-commit walk answers, edge cases included", async () => {
    const fixture = await createBareRepo()
    try {
      await history(fixture, [
        { message: "root", files: { "plan.md": "v1", "dir/a.md": "a1", "lit*[?].md": "x1", ":colon.md": "c1" } },
        { message: "noise 1", files: { "noise.md": "n1" } },
        { message: "plan v2", files: { "plan.md": "v2" } },
        { message: "plan mode only", files: {}, mode: { "plan.md": "100755" } },
        { message: "plan deleted", files: { "plan.md": null } },
        { message: "noise 2", files: { "noise.md": "n2", "litX.md": "decoy" } },
        { message: "plan re-added", files: { "plan.md": "v3" } },
        { message: "dir changed", files: { "dir/a.md": "a2" } },
        { message: "literal name changed", files: { "lit*[?].md": "x2", "lita.md": "decoy" } },
        { message: "colon name changed", files: { ":colon.md": "c2" } },
        // A merge whose first parent already has this plan.md: it is no change on the first-parent chain.
        { message: "side touches plan", files: { "plan.md": "side" } },
        { message: "back", files: { "plan.md": "v3" } },
        { message: "merge side", files: {}, side: 10 },
        // A merge whose plan.md equals its SECOND parent's but not its first: git's default simplification would
        // call it TREESAME to that parent; on the first-parent chain it is a change.
        { message: "merge brings v2", files: { "plan.md": "v2" }, side: 2 },
        { message: "noise 3", files: { "noise.md": "n3" } },
      ])
      const shell = createShellBackend()
      for (const path of ["plan.md", "dir", "dir/a.md", "lit*[?].md", ":colon.md", "never.md"]) {
        const narrowed = await subjects(shell, fixture.repo, path)
        const perCommit = await subjects(perCommitRoute(shell), fixture.repo, path)
        expect(narrowed.narrowed, path).toBe(true)
        expect(perCommit.narrowed, path).toBe(false)
        expect(narrowed.subjects, path).toEqual(perCommit.subjects)
        // Every read here reaches root, so the walked count is the whole chain on both routes.
        expect(narrowed.walked, path).toBe(perCommit.walked)
        expect(narrowed.reachedRoot, path).toBe(true)
      }
      // The answers the parity rests on, spelled out: mode-only is excluded, delete and re-add both count, a
      // directory path matches nothing (a directory has no blob), and a leading `:` is a name, not pathspec magic.
      expect((await subjects(shell, fixture.repo, "plan.md")).subjects).toEqual([
        "merge brings v2",
        "back",
        "side touches plan",
        "plan re-added",
        "plan deleted",
        "plan v2",
        "root",
      ])
      expect((await subjects(shell, fixture.repo, "dir")).subjects).toEqual([])
      expect((await subjects(shell, fixture.repo, ":colon.md")).subjects).toEqual(["colon name changed", "root"])
      // A limit that fills stops early on both routes.
      expect((await subjects(shell, fixture.repo, "plan.md", 2)).subjects).toEqual(["merge brings v2", "back"])
      // gitomic reads `*?[` as a glob, so such a name never reaches the narrowed walk from `log`; the backend's own
      // narrowing still matches it literally (condition a): only that file, never `litX.md` or `lita.md`.
      const reader = await openReader({ repo: fixture.repo, ref: "main", backend: shell })
      const literal = await reader.pathLog?.({ from: await reader.head(), path: "lit*[?].md", limit: 25 })
      expect(literal?.commits.map((commit) => commit.message.trim())).toEqual(["literal name changed", "root"])
    } finally {
      await fixture.cleanup()
    }
  }, 60_000)

  test("a long history with three touches costs a bounded number of backend reads, not two per commit", async () => {
    const fixture = await createBareRepo()
    try {
      // 2,000 commits in one fast-import process, continuing main; plan.md changes at commits 1, 700 and 1,600.
      const lines: string[] = []
      for (let index = 1; index <= 2_000; index += 1) {
        const touch = index === 1 || index === 700 || index === 1_600
        const content = touch ? `plan ${index}\n` : `noise ${index}\n`
        const path = touch ? "plan.md" : "noise.md"
        lines.push(
          "commit refs/heads/main",
          `committer t <t@example.invalid> ${946_684_800 + index} +0000`,
          `data ${`c${index}`.length}`,
          `c${index}`,
          ...(index === 1 ? [`from ${fixture.initial}`] : []),
          `M 100644 inline ${path}`,
          `data ${Buffer.byteLength(content)}`,
          content,
        )
      }
      await gitWithInput(fixture.repo, `${lines.join("\n")}\n`, "fast-import", "--quiet")
      let calls = 0
      const shell = createShellBackend()
      const counted = new Proxy(shell, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver) as unknown
          return typeof value === "function"
            ? (...args: unknown[]) => {
                calls += 1
                return (value as (...a: unknown[]) => unknown).apply(target, args)
              }
            : value
        },
      }) as GitomicBackend
      const reader = await openReader({ repo: fixture.repo, ref: "main", backend: counted })
      const tip = await reader.head()
      calls = 0
      const started = Date.now()
      const matched = await logGlobMatches({ reader, from: tip, limit: 25, glob: "plan.md" })
      expect(matched.commits.map((commit) => commit.message.trim())).toEqual(["c1600", "c700", "c1"])
      // 2,000 commits on top of the fixture's empty initial commit.
      expect(matched.walked).toBe(2_001)
      expect(matched.reachedRoot).toBe(true)
      // One narrowed walk, one count, and the exact rule on three candidates (two snapshot reads each, plus each
      // snapshot's own base read). The per-commit route makes about 4,000 here.
      expect(calls).toBeLessThanOrEqual(20)
      expect(Date.now() - started).toBeLessThan(20_000)
    } finally {
      await fixture.cleanup()
    }
  }, 120_000)

  test("a stop-at read keeps the per-commit walk; a stop-at on the root commit includes the root and is consumed", async () => {
    const fixture = await createBareRepo()
    try {
      const [root] = await history(fixture, [
        { message: "root", files: { "plan.md": "v1" } },
        { message: "noise", files: { "noise.md": "n" } },
        { message: "plan v2", files: { "plan.md": "v2" } },
      ])
      const reader = await openReader({ repo: fixture.repo, ref: "main", backend: createShellBackend() })
      expect(reader.pathLog).toBeDefined()
      const tip = await reader.head()
      const matched = await logGlobMatches({ reader, from: tip, limit: 25, glob: "plan.md", stopAt: root })
      expect(matched.commits.map((commit) => commit.message.trim())).toEqual(["plan v2", "root"])
      expect(matched.anchorConsumed).toBe(true)
      expect(matched.reachedRoot).toBe(false)
      expect(matched.walked).toBe(3)
    } finally {
      await fixture.cleanup()
    }
  }, 60_000)
})
