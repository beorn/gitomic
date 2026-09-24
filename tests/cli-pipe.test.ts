// @failure The CLI could exit before a slow pipe drained, handing the reader the first 65536 bytes of a value with exit 0, or report success when the reader closed early and the rest of the output was lost.
// @level l1
// @consumer every script or agent that reads a value through `gitomic read … | …` or `gitomic read … > file`

import { execFile } from "node:child_process"
import fs from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { createBareRepo, git, gitWithInput } from "./helpers/git.js"

const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
// Past the kernel's 64 KiB pipe buffer, so a write the process does not wait
// for is still pending when `main` returns (25382).
const SIZE = 300_000

let fixture: Awaited<ReturnType<typeof createBareRepo>>
let workdir: string

beforeEach(async () => {
  fixture = await createBareRepo()
  workdir = await mkdtemp(join(tmpdir(), "gitomic-pipe-"))
  const blob = await gitWithInput(fixture.repo, "y".repeat(SIZE - 1) + "\n", "hash-object", "-w", "--stdin")
  const tree = await gitWithInput(fixture.repo, `100644 blob ${blob}\tbig.txt\n`, "mktree")
  await git(fixture.repo, "update-ref", "refs/heads/main", await git(fixture.repo, "commit-tree", tree, "-m", "big"))
})

afterEach(async () => {
  await fixture.cleanup()
  await rm(workdir, { recursive: true, force: true })
})

/** Run `script` under bash with the CLI and address in its environment; its stdout is the script's report. */
async function shell(script: string): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)("bash", ["-c", script], {
    cwd: workdir,
    env: { ...process.env, BIN, ADDRESS: `${fixture.repo}#main`, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
  })
}

describe("gitomic read — output reaches the reader whole, or the command fails", () => {
  test("a reader that waits before draining a pipe still receives every byte, exit 0", async () => {
    expect(Number(await git(fixture.repo, "cat-file", "-s", "main:big.txt"))).toBe(SIZE)
    const { stdout } = await shell(
      'bun "$BIN" read "$ADDRESS" big.txt | { sleep 1; cat > out.txt; }; echo "${PIPESTATUS[0]}"',
    )
    expect({ exit: stdout.trim(), bytes: fs.statSync(join(workdir, "out.txt")).size }).toEqual({
      exit: "0",
      bytes: SIZE,
    })
  })

  test("a file redirect receives every byte, exit 0 (the /commit recipe)", async () => {
    const { stdout } = await shell('bun "$BIN" read "$ADDRESS" big.txt > out.txt; echo "$?"')
    expect({ exit: stdout.trim(), bytes: fs.statSync(join(workdir, "out.txt")).size }).toEqual({
      exit: "0",
      bytes: SIZE,
    })
  })

  test("a reader that closes early makes the read fail, naming EPIPE and the path", async () => {
    const { stdout } = await shell(
      'bun "$BIN" read "$ADDRESS" big.txt 2> err.txt | { sleep 1; head -c 100 > /dev/null; }; echo "${PIPESTATUS[0]}"',
    )
    const stderr = fs.readFileSync(join(workdir, "err.txt"), "utf8")
    expect(stdout.trim()).toBe("1")
    expect(stderr).toContain("EPIPE")
    expect(stderr).toContain("big.txt")
  })
})
