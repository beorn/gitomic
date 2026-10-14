// @failure The shell backend builds a commit's tree by loading the parent's WHOLE tree into a temp index (read-tree,
// update-index, write-tree): about 60 ms on a 30,000-path tree for a one-path write, paid twice per gated write. The
// builder that rewrites only the touched directories must give the same tree the index route gave for every shape
// (mode kept, emptied directory dropped, new directory, symlink and gitlink siblings, unusual names, many paths),
// or a commit silently changes paths nobody edited.
// @level l1
// @consumer 27155: the km daemon's candidate and final commits, and every gitomic apply
// @testonly none
/**
 * @reach fs-walk <fixture-only: Git tree reads use temporary bare repositories>
 */

import childProcess, { execFileSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test, vi } from "vitest"

import { createShellBackend, runGit, TreePathCollision, type CommitInput, type GitomicBackend } from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import { createMemBackend } from "../src/mem.js"
import { normalizePath } from "../src/path.js"
import { createBareRepo, git, gitWithInput } from "./helpers/git.js"

const T0 = 1_800_000_000
const INSTANCE = "00000000-0000-4000-8000-000000000000"

function input(parent: string, changes: [string, string | undefined][], extra: Partial<CommitInput> = {}): CommitInput {
  return {
    parent,
    time: T0,
    changes: new Map(changes),
    message: "tree build",
    writer: "tb",
    instance: INSTANCE,
    seq: 0,
    ...extra,
  }
}

/** The tree the retired index route builds for `changes` on `parent`: the oracle every row is compared with. */
async function indexRouteTree(repo: string, change: CommitInput): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gitomic-index-oracle-"))
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") }
  const run = (args: string[], stdin?: string | Buffer) =>
    execFileSync("git", ["--git-dir", repo, ...args], { env, input: stdin, maxBuffer: 1 << 26 })
  try {
    run(["read-tree", change.parent])
    const executables = new Set(
      run(["ls-files", "--stage", "-z"])
        .toString("utf8")
        .split("\0")
        .filter((record) => record.startsWith("100755 "))
        .map((record) => record.slice(record.indexOf("\t") + 1)),
    )
    const lines: Buffer[] = []
    for (const [path, content] of change.changes) {
      if (content === undefined) {
        lines.push(Buffer.from(`0 ${"0".repeat(change.parent.length)}\t${path}\0`, "utf8"))
        continue
      }
      const blob = run(["hash-object", "-w", "--stdin", "--no-filters"], Buffer.from(content)).toString().trim()
      const mode = executables.has(change.modeSources?.get(path) ?? path) ? "100755" : "100644"
      lines.push(Buffer.from(`${mode} ${blob}\t${path}\0`, "utf8"))
    }
    run(["update-index", "--add", "-z", "--index-info"], Buffer.concat(lines))
    return run(["write-tree"]).toString().trim()
  } finally {
    // raw-delete-allow: the oracle's own mkdtemp index; gitomic is standalone and takes no removely dependency
    await rm(dir, { recursive: true, force: true })
  }
}

/** A commit on `repo` whose tree is the given `ls-tree -z`-shaped records, nested by plain git mktree. */
async function seedTree(
  repo: string,
  parent: string,
  files: Record<string, { mode: string; type: string; oid: string }>,
) {
  type Dir = { files: Map<string, { mode: string; type: string; oid: string }>; dirs: Map<string, Dir> }
  const root: Dir = { files: new Map(), dirs: new Map() }
  for (const [path, entry] of Object.entries(files)) {
    const parts = path.split("/")
    let dir = root
    for (const part of parts.slice(0, -1)) {
      let next = dir.dirs.get(part)
      if (next === undefined) dir.dirs.set(part, (next = { files: new Map(), dirs: new Map() }))
      dir = next
    }
    dir.files.set(parts.at(-1)!, entry)
  }
  const write = async (dir: Dir): Promise<string> => {
    const records: Buffer[] = []
    for (const [name, child] of dir.dirs) {
      records.push(Buffer.from(`040000 tree ${await write(child)}\t${name}\0`, "utf8"))
    }
    for (const [name, entry] of dir.files) {
      records.push(Buffer.from(`${entry.mode} ${entry.type} ${entry.oid}\t${name}\0`, "utf8"))
    }
    return await gitWithInput(repo, Buffer.concat(records), "mktree", "-z")
  }
  return await git(repo, "commit-tree", await write(root), "-p", parent, "-m", "seed")
}

async function blob(repo: string, content: string): Promise<{ mode: string; type: string; oid: string }> {
  return { mode: "100644", type: "blob", oid: await gitWithInput(repo, content, "hash-object", "-w", "--stdin") }
}

async function treeOf(repo: string, commit: string): Promise<string> {
  return await git(repo, "rev-parse", `${commit}^{tree}`)
}

/** Write `change` through the shell backend and the index-route oracle; both trees must be one tree. */
async function expectSameTree(repo: string, change: CommitInput, label: string): Promise<string> {
  const oracle = await indexRouteTree(repo, change)
  const built = await treeOf(repo, await createShellBackend().writeCommit(repo, change))
  expect(built, label).toBe(oracle)
  return built
}

describe("the shell backend builds a commit's tree from the touched directories only", () => {
  test("a one-path write never loads the parent's whole tree into an index", async () => {
    const fixture = await createBareRepo()
    const wrapperDir = await mkdtemp(join(tmpdir(), "gitomic-tree-build-git-"))
    try {
      const files: Record<string, { mode: string; type: string; oid: string }> = {}
      for (let index = 0; index < 50; index += 1) {
        files[`pm/area-${index % 5}/bead-${index}.md`] = await blob(fixture.repo, `${index}\n`)
      }
      const parent = await seedTree(fixture.repo, fixture.initial, files)
      const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim()
      const log = join(wrapperDir, "argv.log")
      const wrapper = join(wrapperDir, "git")
      await writeFile(wrapper, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`)
      await chmod(wrapper, 0o755)
      const backend: GitomicBackend = createShellBackend({ gitExecutable: wrapper })
      const change = input(parent, [["pm/area-2/bead-7.md", "edited\n"]])
      const built = await treeOf(fixture.repo, await backend.writeCommit(fixture.repo, change))
      expect(built).toBe(await indexRouteTree(fixture.repo, change))
      const commands = (await readFile(log, "utf8")).split("\n").filter(Boolean)
      expect(commands.filter((line) => /(^| )(read-tree|update-index|write-tree)( |$)/u.test(line))).toEqual([])
      // Only the touched directories are listed, each by its own tree id, never recursively (@cto 6c9330ac).
      const listed = commands.filter((line) => / ls-tree( |$)/u.test(line))
      expect(listed.filter((line) => / -r( |$)/u.test(line))).toEqual([])
      const touched = [
        await treeOf(fixture.repo, parent),
        await git(fixture.repo, "rev-parse", `${parent}:pm`),
        await git(fixture.repo, "rev-parse", `${parent}:pm/area-2`),
      ]
      expect(listed.map((line) => line.split(" ").at(-1)).sort()).toEqual([...touched].sort())
      for (const line of listed) expect(line).toContain("--full-tree")
    } finally {
      // raw-delete-allow: a test's own mkdtemp scratch; gitomic is standalone and takes no removely dependency
      await rm(wrapperDir, { recursive: true, force: true })
      await fixture.cleanup()
    }
  })

  test("an inherited work tree and a subdirectory cwd never scope the listing (@cto 6c9330ac)", async () => {
    const fixture = await createBareRepo()
    const work = await mkdtemp(join(tmpdir(), "gitomic-tree-build-worktree-"))
    try {
      const parent = await seedTree(fixture.repo, fixture.initial, {
        "top.md": await blob(fixture.repo, "top\n"),
        "other/kept.md": await blob(fixture.repo, "kept\n"),
        "pm/a.md": await blob(fixture.repo, "a\n"),
      })
      execFileSync("mkdir", ["-p", join(work, "pm")])
      const change = input(parent, [["pm/a.md", "edited\n"]])
      // Run the write in a child whose cwd is the work tree's pm/ with GIT_WORK_TREE inherited, as a hook would.
      const script = [
        `const { createShellBackend } = await import(${JSON.stringify(join(import.meta.dirname, "..", "src", "index.ts"))})`,
        `const input = JSON.parse(process.env.TB_INPUT)`,
        `input.changes = new Map(input.changes)`,
        `console.log(await createShellBackend().writeCommit(${JSON.stringify(fixture.repo)}, input))`,
      ].join("\n")
      const oid = execFileSync("bun", ["-e", script], {
        cwd: join(work, "pm"),
        env: {
          ...process.env,
          GIT_WORK_TREE: work,
          TB_INPUT: JSON.stringify({ ...change, changes: [...change.changes] }),
        },
      })
        .toString()
        .trim()
      expect(await treeOf(fixture.repo, oid)).toBe(await indexRouteTree(fixture.repo, change))
      expect((await git(fixture.repo, "ls-tree", "-r", "--name-only", oid)).split("\n").sort()).toEqual([
        "other/kept.md",
        "pm/a.md",
        "top.md",
      ])
    } finally {
      // raw-delete-allow: a test's own mkdtemp scratch; gitomic is standalone and takes no removely dependency
      await rm(work, { recursive: true, force: true })
      await fixture.cleanup()
    }
  })

  test("every backend's writeCommit refuses each path git cannot hold, by name (@cto 6c9330ac)", async () => {
    const shell = await createBareRepo()
    const iso = await createBareRepo()
    const legs: { name: string; backend: GitomicBackend; repo: string }[] = [
      { name: "shell", backend: createShellBackend(), repo: shell.repo },
      { name: "iso", backend: createIsoBackend(), repo: iso.repo },
      { name: "mem", backend: createMemBackend(), repo: "tree-build-paths" },
    ]
    const forms = [
      "",
      "/lead.md",
      "trail/",
      "a//b.md",
      "./a.md",
      "a/./b.md",
      "a/../b.md",
      "..",
      ".git/config",
      "a/.GIT/x.md",
      "a/.Git./x.md",
      "a/.git  /x.md",
      "a/GIT~1/x.md",
      "a\0b.md",
    ]
    try {
      for (const form of forms) {
        expect(() => normalizePath(form), `normalizePath ${JSON.stringify(form)}`).toThrow(
          `invalid git tree path: ${JSON.stringify(form)}`,
        )
        for (const leg of legs) {
          await expect(
            leg.backend.writeCommit(leg.repo, input(shell.initial, [[form, "x\n"]])),
            `${leg.name} ${JSON.stringify(form)}`,
          ).rejects.toThrow(`invalid git tree path: ${JSON.stringify(form)}`)
        }
      }
      // Names that only look like the forms above are ordinary paths.
      for (const name of [".gitignore", ".gitmodules", "a/.gitx/y.md", "git~2/z.md", "..x/y.md"]) {
        expect(normalizePath(name)).toBe(name)
        for (const leg of legs) await leg.backend.writeCommit(leg.repo, input(shell.initial, [[name, "x\n"]]))
      }
    } finally {
      await Promise.all([shell.cleanup(), iso.cleanup()])
    }
  })

  test("a write touching hundreds of sibling directories lists them inside a small descriptor budget", async () => {
    const fixture = await createBareRepo()
    try {
      const files: Record<string, { mode: string; type: string; oid: string }> = {}
      const shared = await blob(fixture.repo, "x\n")
      for (let index = 0; index < 300; index += 1) files[`pm/d${index}/x.md`] = shared
      const parent = await seedTree(fixture.repo, fixture.initial, files)
      const change = input(
        parent,
        Array.from({ length: 300 }, (_, index): [string, string] => [`pm/d${index}/x.md`, `edited ${index}\n`]),
      )
      const script = [
        `const { createShellBackend } = await import(${JSON.stringify(join(import.meta.dirname, "..", "src", "index.ts"))})`,
        `const input = JSON.parse(process.env.TB_INPUT)`,
        `input.changes = new Map(input.changes)`,
        `console.log(await createShellBackend().writeCommit(${JSON.stringify(fixture.repo)}, input))`,
      ].join("\n")
      // 256 descriptors: 300 ls-tree children at once (three pipes each) cannot fit; a bounded batch does.
      const oid = execFileSync("sh", ["-c", 'ulimit -n 256 && exec bun -e "$TB_SCRIPT"'], {
        env: {
          ...process.env,
          TB_SCRIPT: script,
          TB_INPUT: JSON.stringify({ ...change, changes: [...change.changes] }),
        },
        maxBuffer: 1 << 26,
      })
        .toString()
        .trim()
      expect(await treeOf(fixture.repo, oid)).toBe(await indexRouteTree(fixture.repo, change))
    } finally {
      await fixture.cleanup()
    }
  })

  test("a child that cannot start rejects loudly and never leaves an unheard error event (@cto 6c9330ac)", async () => {
    const failure = Object.assign(new Error("spawn git EMFILE"), { code: "EMFILE", syscall: "spawn git" })
    const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => {
      // What node returns when it could not create the child's pipes: no stdio, an "error" on the next tick.
      const child = Object.assign(new EventEmitter(), { pid: undefined, stdin: null, stdout: null, stderr: null })
      process.nextTick(() => child.emit("error", failure))
      return child as unknown as ReturnType<typeof childProcess.spawn>
    })
    try {
      await expect(runGit(["--version"])).rejects.toThrow(/could not start|EMFILE/u)
      // Let the scheduled "error" fire: with no listener it would throw out of the event loop and fail the run.
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      spawn.mockRestore()
    }
  })

  test("an empty subtree in a rebuilt directory is dropped, and a put over one replaces it, as the index route", async () => {
    const fixture = await createBareRepo()
    try {
      const emptyTree = await gitWithInput(fixture.repo, "", "mktree", "-z")
      const parent = await seedTree(fixture.repo, fixture.initial, {
        "pm/a.md": await blob(fixture.repo, "a\n"),
        "pm/hollow": { mode: "040000", type: "tree", oid: emptyTree },
        slot: { mode: "040000", type: "tree", oid: emptyTree },
      })
      await expectSameTree(fixture.repo, input(parent, [["pm/a.md", "edited\n"]]), "a sibling empty subtree")
      await expectSameTree(fixture.repo, input(parent, [["slot", "now a file\n"]]), "a put over an empty subtree")
    } finally {
      await fixture.cleanup()
    }
  })

  test("modes, new and emptied directories and a no-op delete give the index route's tree", async () => {
    const fixture = await createBareRepo()
    try {
      const script = { ...(await blob(fixture.repo, "#!/bin/sh\n")), mode: "100755" }
      const parent = await seedTree(fixture.repo, fixture.initial, {
        "top.md": await blob(fixture.repo, "top\n"),
        "hooks/guard.sh": script,
        "a/b/c/deep.md": await blob(fixture.repo, "deep\n"),
        "a/b/only.md": await blob(fixture.repo, "only\n"),
        "a/keep.md": await blob(fixture.repo, "keep\n"),
      })
      const rows: [string, CommitInput][] = [
        ["edit an executable keeps 100755", input(parent, [["hooks/guard.sh", "#!/bin/sh\nexit 0\n"]])],
        ["a new file in a new directory chain is 100644", input(parent, [["x/y/z/new.md", "new\n"]])],
        ["deleting the last file drops the emptied directories", input(parent, [["a/b/c/deep.md", undefined]])],
        [
          "emptying a whole subtree drops every emptied ancestor",
          input(parent, [
            ["a/b/c/deep.md", undefined],
            ["a/b/only.md", undefined],
            ["a/keep.md", undefined],
          ]),
        ],
        ["deleting an absent path changes nothing", input(parent, [["a/missing.md", undefined]])],
        ["deleting a directory's name deletes nothing", input(parent, [["a/b", undefined]])],
        [
          "a move keeps its source's executable mode in another directory",
          input(
            parent,
            [
              ["bin/moved.sh", "#!/bin/sh\n"],
              ["hooks/guard.sh", undefined],
            ],
            {
              modeSources: new Map([["bin/moved.sh", "hooks/guard.sh"]]),
            },
          ),
        ],
        [
          "deleting everything gives the empty tree",
          input(parent, [
            ["top.md", undefined],
            ["hooks/guard.sh", undefined],
            ["a/b/c/deep.md", undefined],
            ["a/b/only.md", undefined],
            ["a/keep.md", undefined],
          ]),
        ],
      ]
      for (const [label, change] of rows) await expectSameTree(fixture.repo, change, label)
      const unchanged = await expectSameTree(fixture.repo, input(parent, [["a/missing.md", undefined]]), "no-op")
      expect(unchanged).toBe(await treeOf(fixture.repo, parent))
    } finally {
      await fixture.cleanup()
    }
  })

  test("a directory and a file swap places in one commit, in either clause order", async () => {
    const fixture = await createBareRepo()
    try {
      const parent = await seedTree(fixture.repo, fixture.initial, {
        "a/x.md": await blob(fixture.repo, "x\n"),
        b: await blob(fixture.repo, "b\n"),
      })
      const removalFirst = input(parent, [
        ["a/x.md", undefined],
        ["a", "now a file\n"],
        ["b", undefined],
        ["b/y.md", "now a directory\n"],
      ])
      const swapped = await expectSameTree(fixture.repo, removalFirst, "removal first")
      // A put that precedes its removal is the order a replayed diff lists them in ("a" sorts before "a/x.md").
      const putFirst = input(parent, [
        ["a", "now a file\n"],
        ["a/x.md", undefined],
        ["b/y.md", "now a directory\n"],
        ["b", undefined],
      ])
      expect(await expectSameTree(fixture.repo, putFirst, "put first")).toBe(swapped)
    } finally {
      await fixture.cleanup()
    }
  })

  // The one intended difference from the index route. Handed a tree that is not a tree, `update-index --index-info`
  // replaces the colliding entries without a word, so the commit drops a path nobody deleted. Transactions never
  // reach this (assertNextTree refuses first); a direct writeCommit caller, such as a replay onto a parent that gained
  // a child under the replayed file's name, now gets the same TreePathCollision a transaction does.
  test("a file that would also be a directory is refused as a tree path collision", async () => {
    const fixture = await createBareRepo()
    try {
      const parent = await seedTree(fixture.repo, fixture.initial, {
        "a/x.md": await blob(fixture.repo, "x\n"),
        b: await blob(fixture.repo, "b\n"),
      })
      for (const [label, change, file, descendant] of [
        ["a file over a directory that keeps a child", input(parent, [["a", "file\n"]]), "a", "a/x.md"],
        ["a child under a file that stays", input(parent, [["b/y.md", "child\n"]]), "b", "b/y.md"],
      ] as const) {
        const silent = await indexRouteTree(fixture.repo, change)
        const kept = await git(fixture.repo, "ls-tree", "-r", "--name-only", silent)
        expect(kept.split("\n"), `${label}: the index route drops one side silently`).not.toEqual(
          expect.arrayContaining([file, descendant]),
        )
        const refused = await createShellBackend()
          .writeCommit(fixture.repo, change)
          .then(
            () => undefined,
            (error: unknown) => error,
          )
        expect(refused, label).toBeInstanceOf(TreePathCollision)
        expect(refused, label).toMatchObject({ file, descendant })
      }
    } finally {
      await fixture.cleanup()
    }
  })

  test("symlink and gitlink siblings and unusual names are carried byte for byte", async () => {
    const fixture = await createBareRepo()
    try {
      const link = {
        mode: "120000",
        type: "blob",
        oid: await gitWithInput(fixture.repo, "target.md", "hash-object", "-w", "--stdin"),
      }
      // A submodule pin: the commit object is NOT in this repository, as with any gitlink.
      const gitlink = { mode: "160000", type: "commit", oid: "1234567890abcdef1234567890abcdef12345678" }
      const odd = [
        "new\nline.md",
        "tab\there.md",
        'quote"and\\back.md',
        "-leading-dash.md",
        "glob*[x]?.md",
        "é-nfc.md",
        "sp ace.md",
      ]
      const files: Record<string, { mode: string; type: string; oid: string }> = {
        "dir/link.md": link,
        "dir/vendor": gitlink,
        "dir/plain.md": await blob(fixture.repo, "plain\n"),
        "root-link": link,
      }
      for (const name of odd) files[`dir/${name}`] = await blob(fixture.repo, `${name}\n`)
      const parent = await seedTree(fixture.repo, fixture.initial, files)
      await expectSameTree(
        fixture.repo,
        input(parent, [["dir/plain.md", "edited\n"]]),
        "edit beside a symlink, a gitlink and odd names",
      )
      await expectSameTree(
        fixture.repo,
        input(parent, [["dir/link.md", "a regular file now\n"]]),
        "content over a symlink is 100644",
      )
      await expectSameTree(
        fixture.repo,
        input(parent, [
          ["dir/sp ace.md", undefined],
          ["dir/tab\there.md", "edited\n"],
        ]),
        "edit and delete odd names",
      )
      await expectSameTree(fixture.repo, input(parent, [["dir/vendor", undefined]]), "delete a gitlink")
      // A name that is not UTF-8 survives untouched beside the edit.
      const raw = Buffer.concat([
        Buffer.from(`100644 blob ${(await blob(fixture.repo, "raw\n")).oid}\t`, "utf8"),
        Buffer.from([0x62, 0xff, 0xfe, 0x2e, 0x6d, 0x64]),
        Buffer.from([0]),
        Buffer.from(`100644 blob ${(await blob(fixture.repo, "plain\n")).oid}\tplain.md\0`, "utf8"),
      ])
      const sub = await gitWithInput(fixture.repo, raw, "mktree", "-z")
      const rawRoot = await gitWithInput(fixture.repo, `040000 tree ${sub}\tdir\0`, "mktree", "-z")
      const rawParent = await git(fixture.repo, "commit-tree", rawRoot, "-p", fixture.initial, "-m", "raw name")
      await expectSameTree(fixture.repo, input(rawParent, [["dir/plain.md", "edited\n"]]), "a non-UTF-8 sibling name")
    } finally {
      await fixture.cleanup()
    }
  })

  test("twenty-five paths across many directories give the index route's tree", async () => {
    const fixture = await createBareRepo()
    try {
      const files: Record<string, { mode: string; type: string; oid: string }> = {}
      for (let index = 0; index < 120; index += 1) {
        files[`pm/g${index % 6}/i${index % 4}/bead-${index}.md`] = await blob(fixture.repo, `${index}\n`)
      }
      const parent = await seedTree(fixture.repo, fixture.initial, files)
      const changes: [string, string | undefined][] = []
      for (let index = 0; index < 25; index += 1) {
        if (index % 5 === 0) changes.push([`pm/g${index % 6}/i${index % 4}/bead-${index}.md`, undefined])
        else if (index % 5 === 1) changes.push([`pm/new-${index}/deep/bead.md`, `new ${index}\n`])
        else changes.push([`pm/g${index % 6}/i${index % 4}/bead-${index}.md`, `edit ${index}\n`])
      }
      await expectSameTree(fixture.repo, input(parent, changes), "25 mixed puts and deletes")
    } finally {
      await fixture.cleanup()
    }
  })

  test("the same input has one commit id on shell, iso and mem", async () => {
    const shell = await createBareRepo()
    const iso = await createBareRepo()
    const legs: { name: string; backend: GitomicBackend; repo: string }[] = [
      { name: "shell", backend: createShellBackend(), repo: shell.repo },
      { name: "iso", backend: createIsoBackend(), repo: iso.repo },
      { name: "mem", backend: createMemBackend(), repo: "tree-build" },
    ]
    try {
      const chain: [string, string | undefined][][] = [
        [
          ["a/b/c/one.md", "one\n"],
          ["a/b/two.md", "two\n"],
          ["top.md", "top\n"],
          ["z/far.md", "far\n"],
        ],
        [
          ["a/b/c/one.md", "edited\n"],
          ["x/y/new.md", "new\n"],
        ],
        [
          ["a/b/c/one.md", undefined],
          ["a/b/two.md", undefined],
        ],
        [
          ["z/far.md", undefined],
          ["z", "now a file\n"],
        ],
      ]
      const heads = new Map<string, string>()
      for (const [step, changes] of chain.entries()) {
        const oids = new Set<string>()
        for (const leg of legs) {
          const parent = heads.get(leg.name) ?? shell.initial
          const oid = await leg.backend.writeCommit(leg.repo, input(parent, changes, { seq: step }))
          heads.set(leg.name, oid)
          oids.add(oid)
        }
        expect([...oids], `step ${step}: one id across the three backends`).toHaveLength(1)
      }
    } finally {
      await Promise.all([shell.cleanup(), iso.cleanup()])
    }
  })
})
