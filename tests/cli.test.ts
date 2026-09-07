// @failure The CLI could read a stale value, silently corrupt binary/invalid-UTF-8 content, apply a refused write anyway, ignore a --expect naming the wrong thing, or swallow a bad invocation instead of failing loudly with a distinct exit code.
// @level l1
// @consumer file-level-door CLI users — any agent or script reading and writing one repo by address, with no checkout

import { Buffer } from "node:buffer"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { main } from "../src/bin.js"
import { objectOid } from "../src/git-object.js"
import { createShellBackend, open, type CommitMeta, type GitomicBackend } from "../src/index.js"
import { createMemBackend } from "../src/mem.js"
import { createBareRepo, git, gitWithInput } from "./helpers/git.js"

const ADDRESS = "repo#main"

/** The blob oid of some content — independently computed, to check the CLI's own output against. */
function oidOf(content: string): string {
  return objectOid("blob", Buffer.from(content, "utf8"))
}

function capture(): { write(chunk: string): void; text(): string } {
  const chunks: string[] = []
  return {
    write(chunk: string) {
      chunks.push(chunk)
    },
    text: () => chunks.join(""),
  }
}

async function run(backend: GitomicBackend, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = capture()
  const stderr = capture()
  async function* emptyStdin(): AsyncGenerator<string> {}
  const code = await main(args, { backend, stdin: emptyStdin(), stdout, stderr })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

// `write`'s <path>=<file> pairs read from the local filesystem, so tests need real files.
let workdir: string

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "gitomic-cli-test-"))
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

async function fileWith(name: string, content: string): Promise<string> {
  const path = join(workdir, name)
  await writeFile(path, content, "utf8")
  return path
}

/** Convenience: `write` one path=content pair via a freshly written temp file. */
async function writeOne(
  backend: GitomicBackend,
  path: string,
  content: string,
  extra: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const file = await fileWith(path.replaceAll("/", "_"), content)
  return run(backend, ["write", ADDRESS, "-m", `write ${path}`, ...extra, `${path}=${file}`])
}

describe("gitomic CLI — read verbs", () => {
  test("read prints a path's exact content", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "a.md", "one\n")

    const result = await run(backend, ["read", ADDRESS, "a.md"])
    expect(result).toMatchObject({ code: 0, stdout: "one\n", stderr: "" })
  })

  test("read fails loudly on an absent path", async () => {
    const backend = createMemBackend()

    const result = await run(backend, ["read", ADDRESS, "missing.md"])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("missing.md")
  })

  test("ls with no glob lists every path, sorted", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "b.md", "b\n")
    await writeOne(backend, "a.md", "a\n")
    await writeOne(backend, "dir/c.md", "c\n")

    const result = await run(backend, ["ls", ADDRESS])
    expect(result.code).toBe(0)
    expect(result.stdout.trim().split("\n")).toEqual(["a.md", "b.md", "dir/c.md"])
  })

  test("ls filters by glob, including ** crossing directories", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "a.md", "a\n")
    await writeOne(backend, "dir/c.md", "c\n")
    await writeOne(backend, "dir/d.txt", "d\n")

    const flat = await run(backend, ["ls", ADDRESS, "*.md"])
    expect(flat.stdout.trim().split("\n")).toEqual(["a.md"])

    const deep = await run(backend, ["ls", ADDRESS, "**/*.md"])
    expect(deep.stdout.trim().split("\n")).toEqual(["a.md", "dir/c.md"])
  })

  test("--at reads a path as of an earlier commit, ignoring later writes", async () => {
    const backend = createMemBackend()
    const first = await writeOne(backend, "a.md", "one\n")
    await writeOne(backend, "a.md", "two\n", ["--expect", `a.md=${oidOf("one\n")}`])

    const atTip = await run(backend, ["read", ADDRESS, "a.md"])
    expect(atTip.stdout).toBe("two\n")

    const atFirst = await run(backend, ["read", ADDRESS, "a.md", "--at", first.stdout.trim()])
    expect(atFirst).toMatchObject({ code: 0, stdout: "one\n" })
  })

  test("grep prints path:line for every matching line, across matching paths", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "a.md", "hello world\nsecond line\n")
    await writeOne(backend, "b.md", "no match here\n")
    await writeOne(backend, "dir/c.md", "hello again\n")

    const result = await run(backend, ["grep", ADDRESS, "hello"])
    expect(result.code).toBe(0)
    expect(result.stdout.trim().split("\n")).toEqual(["a.md:hello world", "dir/c.md:hello again"])
  })

  test("grep narrows by glob and supports regex patterns", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "a.md", "value=42\n")
    await writeOne(backend, "a.txt", "value=42\n")

    const result = await run(backend, ["grep", ADDRESS, "value=\\d+", "*.md"])
    expect(result.stdout.trim().split("\n")).toEqual(["a.md:value=42"])
  })

  // grep's catch-and-skip-with-a-stderr-note path for a non-UTF-8 blob is not
  // exercised here: the mem backend's own storage is `ReadonlyMap<string,
  // string>` (see src/mem.ts's `MemCommit.files`), and gitomic's own `map.set`
  // rejects invalid UTF-8 at write time (`assertUtf8`), so there is no way to
  // get a real binary blob into a mem-backed tree. That path only exists for a
  // real git blob read back as `Uint8Array` (shell/iso backends) — see
  // tests/binary-blobs.test.ts for how those are constructed.

  test("an invalid grep pattern fails loudly as a usage error", async () => {
    const backend = createMemBackend()
    const result = await run(backend, ["grep", ADDRESS, "("])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("grep")
  })
})

/** A real, one-path mem history; size includes its empty initial commit. */
async function historyOfSize(size: number) {
  const backend = createMemBackend()
  const store = await open({ repo: "repo", ref: "main", backend, writer: "history" })
  for (let index = 1; index < size; index += 1) {
    await store.transact(async (map) => map.set("counter", String(index)), `step ${index}`)
  }
  return { backend, store, tip: await store.head() }
}

describe("gitomic CLI — history reads", () => {
  test("log and diff expose anchored metadata and sorted blob changes in plain and JSON modes", async () => {
    const backend = createMemBackend()
    const store = await open({ repo: "repo", ref: "main", backend, writer: "history" })
    const initial = await store.head()
    const first = await store.transact(async (map) => {
      map.set("b.md", "before")
      map.set("dir/gone.txt", "gone")
    }, "first\n\nfull body")
    const second = await store.transact(async (map) => {
      map.set("b.md", "after")
      map.set("a.md", "added")
      map.delete("dir/gone.txt")
    }, "second")
    await store.transact(async (map) => map.set("noise", "later"), "third")

    const log = await run(backend, ["log", ADDRESS, "--at", second.oid, "--json"])
    expect(log).toMatchObject({ code: 0, stderr: "" })
    const records = JSON.parse(log.stdout) as CommitMeta[]
    expect(records.map(({ oid }) => oid)).toEqual([second.oid, first.oid, initial])
    expect(records[1]).toEqual({
      oid: first.oid,
      parent: initial,
      writer: "history",
      instance: expect.any(String),
      seq: 0,
      timestamp: 946_684_801,
      message: expect.stringMatching(/^history: first\n\nfull body\n\nGitomic-Writer: history\n/),
    })
    expect(records[2]).toEqual({
      oid: initial,
      parent: null,
      writer: null,
      instance: null,
      seq: null,
      message: "initial\n",
      timestamp: 946_684_800,
    })
    expect(await run(backend, ["log", ADDRESS, "--at", first.oid, "-n", "1"])).toEqual({
      code: 0,
      stdout: `${first.oid} history: first\n`,
      stderr: "",
    })
    const filtered = await run(backend, ["log", ADDRESS, "dir/*.txt", "-n", "2", "--json"])
    expect(filtered).toMatchObject({ code: 0, stderr: "" })
    expect((JSON.parse(filtered.stdout) as CommitMeta[]).map(({ oid }) => oid)).toEqual([second.oid, first.oid])

    // A root-complete short result is success, with explicit completeness context.
    for (const json of [false, true]) {
      const short = await run(backend, [
        "log",
        ADDRESS,
        "dir/*.txt",
        "--at",
        second.oid,
        "-n",
        "3",
        ...(json ? ["--json"] : []),
      ])
      expect(short.code).toBe(0)
      expect(short.stdout).toBe(
        json
          ? `${JSON.stringify([records[0], records[1]])}\n`
          : `${second.oid} history: second\n${first.oid} history: first\n`,
      )
      for (const fact of [ADDRESS, second.oid, "dir/*.txt", "2 of 3", "root after 3", "first-parent", "mode-only"]) {
        expect(short.stderr).toContain(fact)
      }
    }

    const diffArgs = ["diff", ADDRESS, "--base", first.oid, "--at", second.oid]
    expect(await run(backend, diffArgs)).toEqual({ code: 0, stdout: "A\ta.md\nM\tb.md\nD\tdir/gone.txt\n", stderr: "" })
    const diff = await run(backend, [...diffArgs, "--json"])
    expect(diff).toMatchObject({ code: 0, stderr: "" })
    expect(JSON.parse(diff.stdout)).toEqual([
      { path: "a.md", from: null, to: oidOf("added") },
      { path: "b.md", from: oidOf("before"), to: oidOf("after") },
      { path: "dir/gone.txt", from: oidOf("gone"), to: null },
    ])
    expect(await run(backend, [...diffArgs, "dir/**"])).toEqual({ code: 0, stdout: "D\tdir/gone.txt\n", stderr: "" })
    expect(await run(backend, ["diff", ADDRESS, "--base", second.oid, "noise"])).toEqual({
      code: 0,
      stdout: "A\tnoise\n",
      stderr: "",
    })
    expect(await run(backend, ["diff", ADDRESS, "--base", second.oid, "--at", second.oid, "--json"])).toEqual({
      code: 0,
      stdout: "[]\n",
      stderr: "",
    })
  })

  test("default log pins its start and requests fifty metadata reads, while -n requests only its count", async () => {
    const { backend, store, tip } = await historyOfSize(53)
    let reads = 0
    const observed: GitomicBackend = {
      ...backend,
      readCommit: async (repo, oid) => {
        reads += 1
        if (reads === 1) await store.transact(async (map) => map.set("late", "excluded"), "advance during log")
        return backend.readCommit(repo, oid)
      },
    }
    const result = await run(observed, ["log", ADDRESS, "--json"])
    expect(result).toMatchObject({ code: 0, stderr: "" })
    const records = JSON.parse(result.stdout) as CommitMeta[]
    expect(records).toHaveLength(50)
    expect(records[0]?.oid).toBe(tip)
    expect(reads).toBe(50)
    reads = 0
    const short = await run(observed, ["log", ADDRESS, "--at", tip, "-n", "2", "--json"])
    expect(short.code).toBe(0)
    expect((JSON.parse(short.stdout) as CommitMeta[]).map(({ oid }) => oid)).toEqual([tip, records[1]?.oid])
    expect(reads).toBe(2)
  })

  test("exactly 1024 records ending at parent=null succeeds and explains the empty filtered scope", async () => {
    const { backend, tip } = await historyOfSize(1_024)
    const result = await run(backend, ["log", ADDRESS, "absent/**", "-n", "1", "--json"])
    expect(result).toMatchObject({ code: 0, stdout: "[]\n" })
    for (const fact of [ADDRESS, tip, "absent/**", "root", "first-parent", "mode-only"]) {
      expect(result.stderr).toContain(fact)
    }
  })

  test("exactly 1024 records with a remaining parent fails before stdout unless the requested matches were found", async () => {
    const { backend, tip } = await historyOfSize(1_025)
    for (const json of [[], ["--json"]]) {
      const result = await run(backend, ["log", ADDRESS, "absent/**", "-n", "1", ...json])
      expect(result).toMatchObject({ code: 1, stdout: "" })
      for (const fact of [ADDRESS, tip, "absent/**", "1024", "first-parent"]) expect(result.stderr).toContain(fact)
    }
    let reads = 0
    const observed: GitomicBackend = {
      ...backend,
      readCommit: async (repo, oid) => {
        reads += 1
        return backend.readCommit(repo, oid)
      },
    }
    const matched = await run(observed, ["log", ADDRESS, "counter", "-n", "1", "--json"])
    expect(matched).toMatchObject({ code: 0, stderr: "" })
    expect((JSON.parse(matched.stdout) as CommitMeta[]).map(({ oid }) => oid)).toEqual([tip])
    expect(reads).toBe(1_024)
  })

  test("native root history and binary diff preserve object identity without decoding values", async () => {
    const fixture = await createBareRepo()
    try {
      const blob = await gitWithInput(fixture.repo, Uint8Array.of(0xff, 0x00, 0xfe), "hash-object", "-w", "--stdin")
      const tree = await gitWithInput(fixture.repo, `100644 blob ${blob}\timage.bin\0`, "mktree", "-z")
      const root = await git(fixture.repo, "commit-tree", tree, "-m", "binary root")
      const backend = createShellBackend()
      const log = await run(backend, ["log", fixture.repo, "*.bin", "--at", root, "--json"])
      expect(log.code).toBe(0)
      expect(log.stderr).toContain("1 of 50")
      expect(JSON.parse(log.stdout)).toEqual([
        {
          oid: root,
          parent: null,
          message: "binary root\n",
          writer: null,
          instance: null,
          seq: null,
          timestamp: 946_684_800,
        },
      ])
      const diff = await run(backend, ["diff", fixture.repo, "--base", fixture.initial, "--at", root, "--json"])
      expect(diff).toMatchObject({ code: 0, stderr: "" })
      expect(JSON.parse(diff.stdout)).toEqual([{ path: "image.bin", from: null, to: blob }])
    } finally {
      await fixture.cleanup()
    }
  })

  test.each([false, true])("history usage errors leave stdout empty before backend reads (json=%s)", async (asJson) => {
    const oid = "a".repeat(40)
    const cases: Array<[string[], string]> = [
      [["log"], "address"],
      [["log", ADDRESS, "--at"], "--at"],
      [["log", ADDRESS, "--at", "short"], "--at"],
      [["log", ADDRESS, "--at", "A".repeat(40)], "--at"],
      [["log", ADDRESS, "-n"], "-n"],
      [["log", ADDRESS, "-n", "0"], "-n"],
      [["log", ADDRESS, "-n", "-1"], "-n"],
      [["log", ADDRESS, "-n", "1.5"], "-n"],
      [["log", ADDRESS, "-n", "1025"], "-n"],
      [["log", ADDRESS, "-n", "9007199254740992"], "-n"],
      [["log", ADDRESS, "-n", "nope"], "-n"],
      [["log", ADDRESS, "one", "two"], "extra"],
      [["log", ADDRESS, "--bogus"], "--bogus"],
      [["log", "repo#"], "ref"],
      [["diff", ADDRESS], "--base"],
      [["diff", ADDRESS, "--base"], "--base"],
      [["diff", ADDRESS, "--base", "short"], "--base"],
      [["diff", ADDRESS, "--base", oid, "--at", "short"], "--at"],
      [["diff", ADDRESS, "--base", oid, "one", "two"], "extra"],
      [["diff", ADDRESS, "--base", oid, "-n", "1"], "-n"],
    ]
    let reads = 0
    const mem = createMemBackend()
    const backend: GitomicBackend = {
      ...mem,
      head: async (repo, ref) => {
        reads += 1
        return mem.head(repo, ref)
      },
    }
    for (const [args, fact] of cases) {
      const result = await run(backend, [...args, ...(asJson ? ["--json"] : [])])
      expect(result, args.join(" ")).toMatchObject({ code: 2, stdout: "" })
      expect(result.stderr, args.join(" ")).toContain(fact)
    }
    expect(reads).toBe(0)
  })

  test.each([false, true])("late history failures never publish partial records (json=%s)", async (asJson) => {
    const { backend, tip } = await historyOfSize(4)
    const json = asJson ? ["--json"] : []
    let metadata = 0
    const failingLog: GitomicBackend = {
      ...backend,
      readCommit: async (repo, oid) => {
        if (++metadata === 2) throw new Error("later metadata unavailable")
        return backend.readCommit(repo, oid)
      },
    }
    const log = await run(failingLog, ["log", ADDRESS, "-n", "3", ...json])
    expect(log).toMatchObject({ code: 1, stdout: "" })
    expect(log.stderr).toContain("later metadata unavailable")
    let files = 0
    const failingFilter: GitomicBackend = {
      ...backend,
      readFiles: async (repo, oid, prefix) => {
        if (++files === 3) throw new Error("later tree unavailable")
        return backend.readFiles(repo, oid, prefix)
      },
    }
    const filtered = await run(failingFilter, ["log", ADDRESS, "counter", "-n", "2", ...json])
    expect(filtered).toMatchObject({ code: 1, stdout: "" })
    expect(filtered.stderr).toContain("later tree unavailable")
    const missing = "f".repeat(40)
    for (const args of [
      ["log", ADDRESS, "--at", missing],
      ["diff", ADDRESS, "--base", tip, "--at", missing],
      ["diff", ADDRESS, "--base", missing, "--at", missing],
    ]) {
      const failed = await run(backend, [...args, ...json])
      expect(failed).toMatchObject({ code: 1, stdout: "" })
      expect(failed.stderr).toContain(missing)
    }
  })
})

describe("gitomic CLI — write", () => {
  test("a path with no --expect creates it, and prints the landed commit oid", async () => {
    const backend = createMemBackend()

    const result = await writeOne(backend, "a.md", "one\n")
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout.trim().length).toBeGreaterThan(0)

    const read = await run(backend, ["read", ADDRESS, "a.md"])
    expect(read.stdout).toBe("one\n")
  })

  test("a present path with no --expect/--create auto-reads its current oid and replaces it", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "a.md", "one\n")

    const result = await writeOne(backend, "a.md", "two\n")
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("")
    expect((await run(backend, ["read", ADDRESS, "a.md"])).stdout).toBe("two\n")
  })

  test("write --create refuses when the path already exists, landing nothing", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "a.md", "one\n")

    const result = await writeOne(backend, "a.md", "two\n", ["--create", "a.md"])
    expect(result.code).toBe(3)
    expect(result.stderr).toContain("edit-does-not-apply")
    expect(result.stderr).toContain("precondition=blob-absent")
    expect((await run(backend, ["read", ADDRESS, "a.md"])).stdout).toBe("one\n")
  })

  test("write --create succeeds on an absent path, same as the default create", async () => {
    const backend = createMemBackend()

    const result = await writeOne(backend, "a.md", "one\n", ["--create", "a.md"])
    expect(result.code).toBe(0)
    expect((await run(backend, ["read", ADDRESS, "a.md"])).stdout).toBe("one\n")
  })

  test("--create and --expect together for the same path is a usage error", async () => {
    const backend = createMemBackend()
    const file = await fileWith("a.md", "one\n")
    const result = await run(backend, [
      "write",
      ADDRESS,
      "-m",
      "contradiction",
      "--expect",
      `a.md=${oidOf("one\n")}`,
      "--create",
      "a.md",
      `a.md=${file}`,
    ])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("a.md")
  })

  test("several <path>=<file> pairs land as one commit", async () => {
    const backend = createMemBackend()
    const fileA = await fileWith("a.md", "a\n")
    const fileB = await fileWith("dir_b.md", "b\n")

    const result = await run(backend, ["write", ADDRESS, "-m", "two files", `a.md=${fileA}`, `dir/b.md=${fileB}`])
    expect(result.code).toBe(0)

    expect((await run(backend, ["read", ADDRESS, "a.md"])).stdout).toBe("a\n")
    expect((await run(backend, ["read", ADDRESS, "dir/b.md"])).stdout).toBe("b\n")
  })

  test("`-` as the file reads that pair's content from stdin", async () => {
    const backend = createMemBackend()
    const stdout = capture()
    const stderr = capture()
    async function* stdinOf(): AsyncGenerator<string> {
      yield "from stdin\n"
    }
    const code = await main(["write", ADDRESS, "-m", "from stdin", "a.md=-"], {
      backend,
      stdin: stdinOf(),
      stdout,
      stderr,
    })
    expect(code).toBe(0)
    expect((await run(backend, ["read", ADDRESS, "a.md"])).stdout).toBe("from stdin\n")
  })

  test("write with a wrong --expect refuses with exit 3 and refusal facts on stderr, landing nothing", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "a.md", "one\n")

    const result = await writeOne(backend, "a.md", "two\n", ["--expect", `a.md=${oidOf("not-this")}`])
    expect(result.code).toBe(3)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("edit-does-not-apply")
    expect(result.stderr).toContain("kind=put")
    expect(result.stderr).toContain("path=a.md")
    expect(result.stderr).toContain("precondition=blob-identical")

    expect((await run(backend, ["read", ADDRESS, "a.md"])).stdout).toBe("one\n")
  })

  test("the correct oid read from an earlier write, fed back as --expect, lands", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "a.md", "one\n")

    const replaced = await writeOne(backend, "a.md", "two\n", ["--expect", `a.md=${oidOf("one\n")}`])
    expect(replaced.code).toBe(0)
    expect((await run(backend, ["read", ADDRESS, "a.md"])).stdout).toBe("two\n")
  })

  test("--writer passes an interim identity label through to open()", async () => {
    const backend = createMemBackend()
    const result = await writeOne(backend, "a.md", "one\n", ["--writer", "cli-test"])
    expect(result.code).toBe(0)
    expect((await backend.readCommit("repo", result.stdout.trim())).writer).toBe("cli-test")
  })

  test("--expect naming a path not being written is a usage error", async () => {
    const backend = createMemBackend()
    const file = await fileWith("a.md", "one\n")
    const result = await run(backend, [
      "write",
      ADDRESS,
      "-m",
      "mismatched expect",
      "--expect",
      `other.md=${oidOf("x")}`,
      `a.md=${file}`,
    ])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("other.md")
  })

  test("a duplicate target path in one write is a usage error", async () => {
    const backend = createMemBackend()
    const file = await fileWith("a.md", "one\n")
    const result = await run(backend, ["write", ADDRESS, "-m", "dup", `a.md=${file}`, `a.md=${file}`])
    expect(result.code).toBe(2)
  })

  test("write requires at least one <path>=<file> pair", async () => {
    const backend = createMemBackend()
    const result = await run(backend, ["write", ADDRESS, "-m", "nothing to write"])
    expect(result.code).toBe(2)
  })

  test("write fails loudly when the local file does not exist", async () => {
    const backend = createMemBackend()
    const result = await run(backend, [
      "write",
      ADDRESS,
      "-m",
      "missing file",
      `a.md=${join(workdir, "does-not-exist.md")}`,
    ])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("does-not-exist.md")
  })
})

describe("gitomic CLI — rm", () => {
  test("rm with an explicit --expect removes the path", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "a.md", "one\n")

    const result = await run(backend, ["rm", ADDRESS, "-m", "rm a", "--expect", `a.md=${oidOf("one\n")}`, "a.md"])
    expect(result.code).toBe(0)
    expect((await run(backend, ["read", ADDRESS, "a.md"])).code).toBe(1)
  })

  test("rm with no --expect auto-reads the current oid and removes the path", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "a.md", "one\n")

    const result = await run(backend, ["rm", ADDRESS, "-m", "rm a", "a.md"])
    expect(result.code).toBe(0)
    expect((await run(backend, ["read", ADDRESS, "a.md"])).code).toBe(1)
  })

  test("rm removes several paths as one commit", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "a.md", "a\n")
    await writeOne(backend, "b.md", "b\n")

    const result = await run(backend, ["rm", ADDRESS, "-m", "rm both", "a.md", "b.md"])
    expect(result.code).toBe(0)
    expect((await run(backend, ["read", ADDRESS, "a.md"])).code).toBe(1)
    expect((await run(backend, ["read", ADDRESS, "b.md"])).code).toBe(1)
  })

  test("rm on a path that was already moved out from under it (wrong --expect) refuses with exit 3, landing nothing", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "a.md", "one\n")
    await writeOne(backend, "a.md", "two\n", ["--expect", `a.md=${oidOf("one\n")}`])

    const result = await run(backend, ["rm", ADDRESS, "-m", "stale rm", "--expect", `a.md=${oidOf("one\n")}`, "a.md"])
    expect(result.code).toBe(3)
    expect(result.stderr).toContain("kind=rm")
    expect((await run(backend, ["read", ADDRESS, "a.md"])).stdout).toBe("two\n")
  })

  test("rm on an absent path with no --expect fails loudly (nothing to auto-read)", async () => {
    const backend = createMemBackend()
    const result = await run(backend, ["rm", ADDRESS, "-m", "rm missing", "missing.md"])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("missing.md")
  })

  test("rm requires at least one <path>", async () => {
    const backend = createMemBackend()
    const result = await run(backend, ["rm", ADDRESS, "-m", "nothing"])
    expect(result.code).toBe(2)
  })
})

describe("gitomic CLI — mv", () => {
  test("mv moves the content and clears the source (no --expect flag exists)", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "from.md", "body\n")

    const result = await run(backend, ["mv", ADDRESS, "-m", "mv", "from.md", "to.md"])
    expect(result.code).toBe(0)
    expect((await run(backend, ["read", ADDRESS, "from.md"])).code).toBe(1)
    expect((await run(backend, ["read", ADDRESS, "to.md"])).stdout).toBe("body\n")
  })

  test("mv refuses with exit 3 when the destination is already occupied, landing nothing", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "from.md", "body\n")
    await writeOne(backend, "to.md", "occupied\n")

    const result = await run(backend, ["mv", ADDRESS, "-m", "mv", "from.md", "to.md"])
    expect(result.code).toBe(3)
    expect(result.stderr).toContain("kind=mv")
    expect(result.stderr).toContain("precondition=destination-absent")
    expect((await run(backend, ["read", ADDRESS, "from.md"])).stdout).toBe("body\n")
    expect((await run(backend, ["read", ADDRESS, "to.md"])).stdout).toBe("occupied\n")
  })

  test("mv fails loudly on an absent source", async () => {
    const backend = createMemBackend()
    const result = await run(backend, ["mv", ADDRESS, "-m", "mv", "missing.md", "to.md"])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("missing.md")
  })
})

describe("gitomic CLI — apply", () => {
  test("apply lands a mixed put/append/rm/mv edit list as one commit", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "keep.md", "keep\n")
    await writeOne(backend, "gone.md", "bye\n")
    await writeOne(backend, "moved-from.md", "moving\n")
    await writeOne(backend, "log.md", "line1\n")
    const putFile = await fileWith("new.md", "new content\n")
    const appendFile = await fileWith("log-append.md", "line2\n")

    const result = await run(backend, [
      "apply",
      ADDRESS,
      "-m",
      "mixed batch",
      "put",
      "new.md",
      putFile,
      "append",
      "log.md",
      appendFile,
      "rm",
      "gone.md",
      "mv",
      "moved-from.md",
      "moved-to.md",
    ])
    expect(result.code).toBe(0)
    expect(result.stdout.trim().length).toBeGreaterThan(0)

    expect((await run(backend, ["read", ADDRESS, "new.md"])).stdout).toBe("new content\n")
    expect((await run(backend, ["read", ADDRESS, "log.md"])).stdout).toBe("line1\nline2\n")
    expect((await run(backend, ["read", ADDRESS, "gone.md"])).code).toBe(1)
    expect((await run(backend, ["read", ADDRESS, "moved-from.md"])).code).toBe(1)
    expect((await run(backend, ["read", ADDRESS, "moved-to.md"])).stdout).toBe("moving\n")
    expect((await run(backend, ["read", ADDRESS, "keep.md"])).stdout).toBe("keep\n")
  })

  test("the overwrite-move: rm before mv frees the destination, landing both edits in one commit", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "from.md", "body\n")
    await writeOne(backend, "to.md", "occupied\n")

    const result = await run(backend, [
      "apply",
      ADDRESS,
      "-m",
      "overwrite move",
      "rm",
      "to.md",
      "mv",
      "from.md",
      "to.md",
    ])
    expect(result.code).toBe(0)
    expect((await run(backend, ["read", ADDRESS, "to.md"])).stdout).toBe("body\n")
    expect((await run(backend, ["read", ADDRESS, "from.md"])).code).toBe(1)
  })

  test("clause order matters: mv before rm refuses because the destination is still occupied", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "from.md", "body\n")
    await writeOne(backend, "to.md", "occupied\n")

    const result = await run(backend, ["apply", ADDRESS, "-m", "wrong order", "mv", "from.md", "to.md", "rm", "to.md"])
    expect(result.code).toBe(3)
    expect(result.stderr).toContain("kind=mv")
    expect(result.stderr).toContain("precondition=destination-absent")
    expect((await run(backend, ["read", ADDRESS, "from.md"])).stdout).toBe("body\n")
    expect((await run(backend, ["read", ADDRESS, "to.md"])).stdout).toBe("occupied\n")
  })

  test("a refused clause aborts the whole apply, landing nothing from an earlier clause either", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "a.md", "one\n")
    await writeOne(backend, "a.md", "two\n", ["--expect", `a.md=${oidOf("one\n")}`])
    const putFile = await fileWith("b.md", "b content\n")

    // "put b.md" (clause 0) would succeed alone; "rm a.md" (clause 1) carries a
    // stale --expect (a.md moved to "two\n" above) and refuses. Because apply is
    // all-or-nothing, clause 0's put must not land either.
    const result = await run(backend, [
      "apply",
      ADDRESS,
      "-m",
      "should abort",
      "put",
      "b.md",
      putFile,
      "rm",
      "a.md",
      "--expect",
      oidOf("one\n"),
    ])
    expect(result.code).toBe(3)
    expect(result.stderr).toContain("kind=rm")
    expect((await run(backend, ["read", ADDRESS, "b.md"])).code).toBe(1)
    expect((await run(backend, ["read", ADDRESS, "a.md"])).stdout).toBe("two\n")
  })

  test("--base anchors auto-read at an earlier commit, refusing instead of silently using the live tip", async () => {
    const backend = createMemBackend()
    const first = await writeOne(backend, "a.md", "one\n")
    await writeOne(backend, "a.md", "two\n", ["--expect", `a.md=${oidOf("one\n")}`])
    const putFile = await fileWith("a-again.md", "three\n")

    const result = await run(backend, [
      "apply",
      ADDRESS,
      "-m",
      "stale base",
      "--base",
      first.stdout.trim(),
      "put",
      "a.md",
      putFile,
    ])
    expect(result.code).toBe(3)
    expect(result.stderr).toContain("kind=put")
    expect(result.stderr).toContain("path=a.md")
    expect(result.stderr).toContain("precondition=blob-identical")
    expect((await run(backend, ["read", ADDRESS, "a.md"])).stdout).toBe("two\n")
  })

  test("apply requires at least one clause", async () => {
    const backend = createMemBackend()
    const result = await run(backend, ["apply", ADDRESS, "-m", "nothing to do"])
    expect(result.code).toBe(2)
  })

  test("an unknown apply clause keyword fails loudly instead of being misread as a path", async () => {
    const backend = createMemBackend()
    const result = await run(backend, ["apply", ADDRESS, "-m", "bad clause", "frobnicate", "a.md"])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("frobnicate")
  })
})

describe("gitomic CLI — apply keyword-named paths (./ escape)", () => {
  test("./name addresses a path spelled exactly like a clause keyword", async () => {
    const backend = createMemBackend()
    const putFile = await fileWith("put-content.md", "i am the file named put\n")

    // A bare `put` in path position would start a second clause; `./put` is the path.
    const result = await run(backend, ["apply", ADDRESS, "-m", "keyword-named path", "put", "./put", putFile])
    expect(result.code).toBe(0)

    // The escape names exactly `put` — not `./put`, which is not a valid gitomic path.
    expect((await run(backend, ["read", ADDRESS, "put"])).stdout).toBe("i am the file named put\n")
    expect((await run(backend, ["ls", ADDRESS])).stdout.trim().split("\n")).toEqual(["put"])
  })

  test("mv renames between keyword-named paths, both escaped with ./", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "rm", "body\n") // a path literally named `rm`

    const result = await run(backend, ["apply", ADDRESS, "-m", "rename keyword path", "mv", "./rm", "./mv"])
    expect(result.code).toBe(0)
    expect((await run(backend, ["read", ADDRESS, "rm"])).code).toBe(1)
    expect((await run(backend, ["read", ADDRESS, "mv"])).stdout).toBe("body\n")
  })

  test("a bare keyword in path position is read as a new clause — the ./ escape is required", async () => {
    const backend = createMemBackend()
    const putFile = await fileWith("f.md", "x\n")

    // `put put <file>`: the second bare `put` starts a new (malformed) clause, not a path.
    const result = await run(backend, ["apply", ADDRESS, "-m", "unescaped keyword", "put", "put", putFile])
    expect(result.code).toBe(2)
  })
})

describe("gitomic CLI — --json receipt on write verbs", () => {
  test("write --json prints a one-line {oid, retries} receipt instead of the bare oid", async () => {
    const backend = createMemBackend()

    const result = await writeOne(backend, "a.md", "one\n", ["--json"])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(1)
    const receipt = JSON.parse(result.stdout.trim()) as { oid: string; retries: number }
    expect(receipt.oid).toMatch(/^[0-9a-f]{40}$/)
    expect(receipt.retries).toBe(0)
    expect((await run(backend, ["read", ADDRESS, "a.md"])).stdout).toBe("one\n")
  })

  test("rm --json prints the {oid, retries} receipt", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "a.md", "one\n")

    const result = await run(backend, ["rm", ADDRESS, "-m", "json rm", "--json", "a.md"])
    expect(result.code).toBe(0)
    expect((JSON.parse(result.stdout.trim()) as { oid: string }).oid).toMatch(/^[0-9a-f]{40}$/)
  })

  test("mv --json prints the {oid, retries} receipt", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "from.md", "body\n")

    const result = await run(backend, ["mv", ADDRESS, "-m", "json mv", "--json", "from.md", "to.md"])
    expect(result.code).toBe(0)
    expect((JSON.parse(result.stdout.trim()) as { oid: string }).oid).toMatch(/^[0-9a-f]{40}$/)
  })

  test("apply --json prints the {oid, retries} receipt", async () => {
    const backend = createMemBackend()
    const putFile = await fileWith("new.md", "new\n")

    const result = await run(backend, ["apply", ADDRESS, "-m", "json apply", "--json", "put", "new.md", putFile])
    expect(result.code).toBe(0)
    const receipt = JSON.parse(result.stdout.trim()) as { oid: string; retries: number }
    expect(receipt.oid).toMatch(/^[0-9a-f]{40}$/)
    expect(receipt.retries).toBe(0)
  })

  test("--json leaves a refusal facts-only on stderr (exit 3), with no JSON on stdout", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "a.md", "one\n")

    const result = await writeOne(backend, "a.md", "two\n", ["--json", "--expect", `a.md=${oidOf("not-this")}`])
    expect(result.code).toBe(3)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("edit-does-not-apply")
    expect(result.stderr).toContain("kind=put")
  })
})

describe("gitomic CLI — usage errors (exit 2, never silent)", () => {
  test("an unknown verb fails loudly, naming itself", async () => {
    const backend = createMemBackend()
    const result = await run(backend, ["frobnicate", ADDRESS])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("frobnicate")
  })

  test("a missing verb fails loudly", async () => {
    const backend = createMemBackend()
    const result = await run(backend, [])
    expect(result.code).toBe(2)
    expect(result.stderr.length).toBeGreaterThan(0)
  })

  test("a bad address (empty ref after '#') fails loudly", async () => {
    const backend = createMemBackend()
    const result = await run(backend, ["read", "repo#", "a.md"])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("ref")
  })

  test("a missing positional argument fails loudly, naming what is missing", async () => {
    const backend = createMemBackend()
    const result = await run(backend, ["read", ADDRESS])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("path")
  })

  test("an unrecognized flag fails loudly instead of being read as a positional", async () => {
    const backend = createMemBackend()
    const result = await run(backend, ["ls", ADDRESS, "--bogus"])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("--bogus")
  })
})
