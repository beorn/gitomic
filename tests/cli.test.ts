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
import type { GitomicBackend } from "../src/index.js"
import { createMemBackend } from "../src/mem.js"

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

  test("re-creating an already-present path (no --expect) refuses with exit 3", async () => {
    const backend = createMemBackend()
    await writeOne(backend, "a.md", "one\n")

    const result = await writeOne(backend, "a.md", "two\n")
    expect(result.code).toBe(3)
    expect(result.stderr).toContain("edit-does-not-apply")
    expect(result.stderr).toContain("precondition=blob-absent")

    expect((await run(backend, ["read", ADDRESS, "a.md"])).stdout).toBe("one\n")
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
