// @failure A caller asking which paths changed between two commits had to list both whole trees: on a 196,908-file
// tree one recut held 1,575,276 listed entries and its pass rose 364-401 MiB against a 256 MiB bound (#29809).
// @level l1
// @consumer #29809 C2: km's pending-state replay inspects each commit above the meeting point with one tree diff
/**
 * @reach fs-walk <fixture-only: Git tree reads use temporary bare repositories>
 * @testonly none: the three shipped backends on real Git repositories; the stubbed git answers diff-tree alone
 */

import { chmodSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { describe, expect, test } from "vitest"

import { createShellBackend, open, type GitomicBackend, type TreeChange, type TreeListing } from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import { createMemBackend } from "../src/mem.js"
import { createBareRepo, git, gitWithInput } from "./helpers/git.js"

type Entry = { readonly mode: "100644" | "100755" | "120000" | "160000"; readonly oid: string }

/** Write a tree holding exactly `entries` (path to mode and oid) with plain git, nested directories included. */
async function writeTree(repo: string, entries: Readonly<Record<string, Entry>>): Promise<string> {
  const here: string[] = []
  const below = new Map<string, Record<string, Entry>>()
  for (const [path, entry] of Object.entries(entries)) {
    const slash = path.indexOf("/")
    if (slash < 0) {
      here.push(`${entry.mode} ${entry.mode === "160000" ? "commit" : "blob"} ${entry.oid}\t${path}\0`)
      continue
    }
    const children = below.get(path.slice(0, slash)) ?? {}
    children[path.slice(slash + 1)] = entry
    below.set(path.slice(0, slash), children)
  }
  for (const [name, children] of below) here.push(`040000 tree ${await writeTree(repo, children)}\t${name}\0`)
  return gitWithInput(repo, here.join(""), "mktree", "-z", "--missing")
}

/** The answer two whole listings give: what readTreeDiff must equal without listing either tree. */
function listingDiff(before: TreeListing, after: TreeListing): TreeChange[] {
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
    const from = before.get(path)
    const to = after.get(path)
    return from?.oid === to?.oid && from?.mode === to?.mode ? [] : [{ path, from, to }]
  })
}

type Fixture = {
  repo: string
  blob(text: string): Promise<string>
  commit(entries: Record<string, Entry>): Promise<string>
}

async function withRepo(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const bare = await createBareRepo()
  try {
    await run({
      repo: bare.repo,
      blob: (text) => gitWithInput(bare.repo, text, "hash-object", "-w", "--stdin"),
      commit: async (entries) => git(bare.repo, "commit-tree", await writeTree(bare.repo, entries), "-m", "fixture"),
    })
  } finally {
    await bare.cleanup()
  }
}

type Row = {
  readonly name: string
  build(fixture: Fixture): Promise<{ from: string; to: string; expected: TreeChange[] }>
}

const regular = (oid: string): Entry => ({ mode: "100644", oid })

/** Every row is a pair of real Git trees; shell and iso must answer it exactly, and equal the listings' answer. */
const rows: readonly Row[] = [
  {
    name: "no change",
    async build({ blob, commit }) {
      const tree = { "a.md": regular(await blob("a\n")), "dir/b.md": regular(await blob("b\n")) }
      const from = await commit(tree)
      return { from, to: await commit(tree), expected: [] }
    },
  },
  {
    name: "added",
    async build({ blob, commit }) {
      const a = regular(await blob("a\n"))
      const b = regular(await blob("b\n"))
      return {
        from: await commit({ "a.md": a }),
        to: await commit({ "a.md": a, "dir/b.md": b }),
        expected: [{ path: "dir/b.md", from: undefined, to: b }],
      }
    },
  },
  {
    name: "deleted",
    async build({ blob, commit }) {
      const a = regular(await blob("a\n"))
      const b = regular(await blob("b\n"))
      return {
        from: await commit({ "a.md": a, "dir/b.md": b }),
        to: await commit({ "a.md": a }),
        expected: [{ path: "dir/b.md", from: b, to: undefined }],
      }
    },
  },
  {
    name: "modified, beside an unchanged directory",
    async build({ blob, commit }) {
      const kept = { "dir/a.md": regular(await blob("a\n")), "dir/deep/b.md": regular(await blob("b\n")) }
      const before = regular(await blob("one\n"))
      const after = regular(await blob("two\n"))
      return {
        from: await commit({ ...kept, "top.md": before }),
        to: await commit({ ...kept, "top.md": after }),
        expected: [{ path: "top.md", from: before, to: after }],
      }
    },
  },
  {
    name: "mode-only",
    async build({ blob, commit }) {
      const oid = await blob("#!/bin/sh\n")
      return {
        from: await commit({ "run.sh": { mode: "100644", oid } }),
        to: await commit({ "run.sh": { mode: "100755", oid } }),
        expected: [{ path: "run.sh", from: { mode: "100644", oid }, to: { mode: "100755", oid } }],
      }
    },
  },
  {
    name: "symlink added, and a file that becomes a symlink",
    async build({ blob, commit }) {
      const target = await blob("a.md")
      const file = regular(target)
      return {
        from: await commit({ "a.md": regular(await blob("a\n")), "was-file": file }),
        to: await commit({
          "a.md": regular(await blob("a\n")),
          link: { mode: "120000", oid: target },
          "was-file": { mode: "120000", oid: target },
        }),
        expected: [
          { path: "link", from: undefined, to: { mode: "120000", oid: target } },
          { path: "was-file", from: file, to: { mode: "120000", oid: target } },
        ],
      }
    },
  },
  {
    name: "gitlink moved",
    async build({ repo, commit }) {
      const empty = await gitWithInput(repo, "", "mktree")
      const one = await git(repo, "commit-tree", empty, "-m", "one")
      const two = await git(repo, "commit-tree", empty, "-m", "two")
      return {
        from: await commit({ sub: { mode: "160000", oid: one } }),
        to: await commit({ sub: { mode: "160000", oid: two } }),
        expected: [{ path: "sub", from: { mode: "160000", oid: one }, to: { mode: "160000", oid: two } }],
      }
    },
  },
  {
    name: "a file that becomes a directory",
    async build({ blob, commit }) {
      const file = regular(await blob("x\n"))
      const child = regular(await blob("y\n"))
      return {
        from: await commit({ x: file }),
        to: await commit({ "x/y": child }),
        expected: [
          { path: "x", from: file, to: undefined },
          { path: "x/y", from: undefined, to: child },
        ],
      }
    },
  },
]

const gitBackends: readonly { name: string; backend: GitomicBackend }[] = [
  { name: "shell", backend: createShellBackend() },
  { name: "iso", backend: createIsoBackend() },
]

describe.each(gitBackends)("readTreeDiff through the $name backend", ({ backend }) => {
  test.each(rows)("$name", async (row) => {
    await withRepo(async (fixture) => {
      const { from, to, expected } = await row.build(fixture)
      const changes = await backend.readTreeDiff(fixture.repo, from, to)
      expect(changes).toEqual(expected)
      expect(changes).toEqual(
        listingDiff(await backend.readTree(fixture.repo, from), await backend.readTree(fixture.repo, to)),
      )
    })
  })

  test("a commit the repository does not hold throws naming it", async () => {
    await withRepo(async ({ repo, blob, commit }) => {
      const present = await commit({ "a.md": regular(await blob("a\n")) })
      const missing = "f".repeat(40)
      for (const [from, to] of [
        [missing, present],
        [present, missing],
        [missing, missing],
      ] as const) {
        await expect(backend.readTreeDiff(repo, from, to)).rejects.toThrow(missing)
      }
    })
  })
})

describe("readTreeDiff through the mem backend", () => {
  // The mem backend holds content only, so every entry it lists is 100644: the mode-only, symlink and gitlink rows
  // have no mem spelling. The rows it can hold answer exactly as shell and iso do, and equal its listings.
  test("added, deleted, modified, no change, and a file that becomes a directory", async () => {
    const mem = createMemBackend()
    const repo = "tree-diff-mem"
    const store = await open({ repo, ref: "main", backend: mem })
    const first = await store.transact(async (map) => {
      map.set("keep.md", "keep\n")
      map.set("change.md", "before\n")
      map.set("remove.md", "gone\n")
      map.set("x", "file\n")
    }, "first")
    const second = await store.transact(async (map) => {
      map.set("change.md", "after\n")
      map.delete("remove.md")
      map.set("add.md", "new\n")
      map.delete("x")
      map.set("x/y", "child\n")
    }, "second")
    const before = await mem.readTree(repo, first.oid)
    const after = await mem.readTree(repo, second.oid)
    const changes = await mem.readTreeDiff(repo, first.oid, second.oid)

    expect(changes.map(({ path }) => path)).toEqual(["add.md", "change.md", "remove.md", "x", "x/y"])
    expect(changes).toEqual(listingDiff(before, after))
    expect(changes.find(({ path }) => path === "x")).toEqual({ path: "x", from: before.get("x"), to: undefined })
    expect(await mem.readTreeDiff(repo, second.oid, second.oid)).toEqual([])
  })

  test("a commit the repository does not hold throws naming it", async () => {
    const mem = createMemBackend()
    const store = await open({ repo: "tree-diff-mem-missing", ref: "main", backend: mem })
    const present = await store.head()
    const missing = "f".repeat(40)
    for (const [from, to] of [
      [missing, present],
      [present, missing],
      [missing, missing],
    ] as const) {
      await expect(mem.readTreeDiff("tree-diff-mem-missing", from, to)).rejects.toThrow(missing)
    }
  })
})

/**
 * A git executable that answers `diff-tree` with `output` and hands every other command to the real git, so the
 * shell backend's parser meets a record real Git never writes. Git canonicalizes every tree mode it reads, which is
 * why an out-of-vocabulary mode or an unknown status reaches the shell backend only this way.
 */
async function withDiffTreeOutput(output: string, run: (backend: GitomicBackend, repo: string) => Promise<void>) {
  await withRepo(async ({ repo }) => {
    // Beside the bare repository, inside the fixture's directory, so the fixture's own cleanup removes it.
    const fakeGit = join(dirname(repo), "fake-git.cjs")
    writeFileSync(
      fakeGit,
      [
        "#!/usr/bin/env node",
        'const { spawnSync } = require("node:child_process")',
        "const args = process.argv.slice(2)",
        'if (args.includes("diff-tree")) {',
        `  process.stdout.write(${JSON.stringify(output)})`,
        "  process.exit(0)",
        "}",
        'const result = spawnSync("git", args, { stdio: "inherit", env: process.env })',
        "process.exit(result.status ?? 1)",
        "",
      ].join("\n"),
    )
    chmodSync(fakeGit, 0o755)
    await run(createShellBackend({ gitExecutable: fakeGit }), repo)
  })
}

const a = "a".repeat(40)
const b = "b".repeat(40)
const zero = "0".repeat(40)

describe("the shell backend refuses a diff-tree record it cannot read", () => {
  test("a changed entry with an out-of-vocabulary mode is refused by mode, path and commit", async () => {
    await withDiffTreeOutput(`:100644 123456 ${a} ${b} M\0f.md\0`, async (backend, repo) => {
      await expect(backend.readTreeDiff(repo, a, b)).rejects.toThrow(
        `Git tree ${b} has unsupported mode 123456 at "f.md"`,
      )
    })
  })

  test.each([
    ["a rename, which --no-renames rules out", `:100644 100644 ${a} ${b} R100\0old.md\0new.md\0`],
    ["an unknown status", `:100644 100644 ${a} ${b} X\0f.md\0`],
    ["a record missing its path", `:100644 100644 ${a} ${b} M\0`],
    ["metadata missing a field", `:100644 100644 ${a} M\0f.md\0`],
    ["a record without its leading colon", `100644 100644 ${a} ${b} M\0f.md\0`],
    ["an absent mode beside a real oid", `:000000 100644 ${a} ${b} A\0f.md\0`],
    ["a real mode beside the zero oid", `:100644 100644 ${zero} ${b} M\0f.md\0`],
    ["a status that disagrees with the sides", `:100644 100644 ${a} ${b} A\0f.md\0`],
  ])("%s", async (_name, output) => {
    await withDiffTreeOutput(output, async (backend, repo) => {
      await expect(backend.readTreeDiff(repo, a, b)).rejects.toThrow("git diff-tree returned")
    })
  })
})

describe("the iso backend refuses an out-of-vocabulary mode", () => {
  test("a literal tree holding mode 123456 is refused naming the mode", async () => {
    await withRepo(async ({ repo, blob, commit }) => {
      const oid = await blob("x\n")
      const before = await commit({ "f.md": regular(oid) })
      const raw = Buffer.concat([Buffer.from("123456 f.md\0"), Buffer.from(oid, "hex")])
      const tree = await gitWithInput(repo, raw, "hash-object", "-t", "tree", "-w", "--literally", "--stdin")
      const after = await git(repo, "commit-tree", tree, "-m", "odd mode")
      await expect(createIsoBackend().readTreeDiff(repo, before, after)).rejects.toThrow("123456")
    })
  })
})
