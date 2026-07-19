// @failure Shell plumbing could scan all history, depend on localized porcelain, or hide a real ref-update failure as contention.
// @level l1
// @consumer default shell-backend users

import { spawn } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { describe, expect, test } from "vitest"

import { createShellBackend, open } from "../src/index.js"
import { createBareRepo } from "./helpers/git.js"

const TRANSACTION_SEARCH_LIMIT = 1_024

type TraceEvent = {
  event?: string
  argv?: string[]
}

function replaceEnvironment(values: Record<string, string | undefined>): () => void {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function createGitWrapper(): Promise<{
  bin: string
  log: string
  cleanup(): Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), "gitomic-git-wrapper-"))
  const bin = join(directory, "bin")
  const wrapper = join(bin, "git")
  const log = join(directory, "environment.log")
  await mkdir(bin)
  await writeFile(
    wrapper,
    [
      "#!/usr/bin/env node",
      'const { appendFileSync } = require("node:fs")',
      "const args = process.argv.slice(2)",
      "const log = process.env.GITOMIC_GIT_ENV_LOG",
      'if (log) appendFileSync(log, `${process.env.LC_ALL ?? "<unset>"}\\n`)',
      'if (args.includes("--absolute-git-dir")) {',
      "  process.stdout.write(`${process.env.GITOMIC_FAKE_GITDIR}\\n`)",
      "  process.exit(0)",
      "}",
      'const updateRef = args.indexOf("update-ref")',
      'if (updateRef >= 0 && process.env.GITOMIC_FAIL_UPDATE_REF === "true") {',
      '  process.stderr.write("fatal: simulated persistent update-ref failure\\n")',
      "  process.exit(1)",
      "}",
      'if (args.includes("rev-parse")) {',
      "  process.stdout.write(`${process.env.GITOMIC_FAKE_HEAD}\\n`)",
      "  process.exit(0)",
      "}",
      "process.stderr.write(`unexpected fake git arguments: ${JSON.stringify(args)}\\n`)",
      "process.exit(2)",
      "",
    ].join("\n"),
    "utf8",
  )
  await chmod(wrapper, 0o755)
  return {
    bin,
    log,
    cleanup: async () => await rm(directory, { recursive: true, force: true }),
  }
}

async function runWithInput(command: string, args: string[], input: string): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] })
    const stderr: Buffer[] = []
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
    child.once("error", rejectRun)
    child.once("close", (code) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${command} exited ${code ?? 1}: ${Buffer.concat(stderr).toString("utf8").trim()}`))
    })
    child.stdin.end(input)
  })
}

async function appendEmptyHistory(repo: string, initial: string, count: number): Promise<void> {
  const stream: string[] = []
  for (let index = 0; index < count; index += 1) {
    const mark = index + 1
    const parent = index === 0 ? initial : `:${index}`
    const message = `history ${mark}\n`
    stream.push(
      `commit refs/heads/main\nmark :${mark}\ncommitter gitomic <gitomic@localhost> ${946_684_801 + index} +0000\ndata ${Buffer.byteLength(message)}\n${message}from ${parent}\n\n`,
    )
  }
  stream.push("done\n")
  await runWithInput("git", ["--git-dir", repo, "fast-import", "--quiet"], stream.join(""))
}

describe.sequential("shell backend failure boundaries", () => {
  test("finds an acknowledged transaction with one bounded history process", async () => {
    const fixture = await createBareRepo()
    const previousTrace = process.env.GIT_TRACE2_EVENT
    try {
      const store = await open({ repo: fixture.repo, ref: "main", writer: "worker-a" })
      const first = await store.transact(async (map) => map.set("first", "1"), "first")
      await store.transact(async (map) => map.set("second", "2"), "second")
      const trace = join(fixture.repo, "find-transaction-trace.json")
      process.env.GIT_TRACE2_EVENT = trace

      const found = await createShellBackend().findTransaction(fixture.repo, await store.head(), "worker-a", 1)

      expect(found).toBe(first.oid)
      const events = (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as TraceEvent)
      const starts = events.filter((event) => event.event === "start")
      const revLists = starts.filter((event) => event.argv?.includes("rev-list"))
      const messageShows = starts.filter(
        (event) => event.argv?.includes("show") && event.argv.some((argument) => argument.includes("%B")),
      )
      expect(revLists).toHaveLength(1)
      expect(revLists[0]?.argv).toContain(`--max-count=${TRANSACTION_SEARCH_LIMIT + 1}`)
      expect(revLists[0]?.argv?.some((argument) => argument.startsWith("--format="))).toBe(true)
      expect(messageShows).toHaveLength(0)
    } finally {
      if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT
      else process.env.GIT_TRACE2_EVENT = previousTrace
      await fixture.cleanup()
    }
  })

  test("fails loudly when an ambiguous acknowledgement is older than the bounded walk", async () => {
    const fixture = await createBareRepo()
    try {
      await appendEmptyHistory(fixture.repo, fixture.initial, TRANSACTION_SEARCH_LIMIT + 1)
      const backend = createShellBackend()
      const tip = await backend.head(fixture.repo, "refs/heads/main")

      await expect(backend.findTransaction(fixture.repo, tip, "missing-writer", 1)).rejects.toThrow(
        `exceeded ${TRANSACTION_SEARCH_LIMIT} first-parent commits`,
      )
    } finally {
      await fixture.cleanup()
    }
  }, 30_000)

  test("pins every Git subprocess to the C locale", async () => {
    const wrapper = await createGitWrapper()
    const expected = "1".repeat(40)
    const restore = replaceEnvironment({
      GITOMIC_FAKE_GITDIR: "/tmp/gitomic-fake.git",
      GITOMIC_FAKE_HEAD: expected,
      GITOMIC_GIT_ENV_LOG: wrapper.log,
      LC_ALL: "gitomic-test-locale",
      PATH: `${wrapper.bin}${delimiter}${process.env.PATH ?? ""}`,
    })
    try {
      expect(await createShellBackend().head("ignored", "refs/heads/main")).toBe(expected)
      const locales = (await readFile(wrapper.log, "utf8")).trim().split("\n")
      expect(new Set(locales)).toEqual(new Set(["C"]))
    } finally {
      restore()
      await wrapper.cleanup()
    }
  })

  test("does not misclassify a non-CAS update-ref error after a concurrent move", async () => {
    const wrapper = await createGitWrapper()
    const expected = "1".repeat(40)
    const next = "2".repeat(40)
    const winner = "3".repeat(40)
    const restore = replaceEnvironment({
      GITOMIC_FAIL_UPDATE_REF: "true",
      GITOMIC_FAKE_GITDIR: "/tmp/gitomic-fake.git",
      GITOMIC_FAKE_HEAD: winner,
      LC_ALL: "C",
      PATH: `${wrapper.bin}${delimiter}${process.env.PATH ?? ""}`,
    })
    try {
      const backend = createShellBackend()
      await expect(backend.compareAndSwap("ignored", "refs/heads/main", next, expected)).rejects.toThrow(
        "simulated persistent update-ref failure",
      )
      expect(await backend.head("ignored", "refs/heads/main")).toBe(winner)
    } finally {
      restore()
      await wrapper.cleanup()
    }
  })
})
