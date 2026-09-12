// @failure Git plumbing could scan all history, normalize commit metadata, or hide a real ref-update failure as contention.
// @level l1
// @consumer default shell-backend users and optional iso reader users

import { spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { describe, expect, test } from "vitest"

import { apply, createShellBackend, open, openReader } from "../src/index.js"
import type { GitomicBackend } from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import { isRemoteCompareAndSwapRejection } from "../src/shell.js"
import { appendEmptyHistory, createBareRepo, git, gitWithInput } from "./helpers/git.js"

const TRANSACTION_SEARCH_LIMIT = 1_024
const gitInitHelp = spawnSync("git", ["init", "-h"], { encoding: "utf8" })
const supportsReftable = `${gitInitHelp.stdout}${gitInitHelp.stderr}`.includes("--ref-format")
const supportsObjectFormat = `${gitInitHelp.stdout}${gitInitHelp.stderr}`.includes("--object-format")

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
      'if (args[0] === "--version") {',
      '  process.stdout.write(`git version ${process.env.GITOMIC_FAKE_GIT_VERSION ?? "2.39.0"}\\n`)',
      "  process.exit(0)",
      "}",
      'if (args.includes("--git-common-dir")) {',
      "  process.stdout.write(`${process.env.GITOMIC_FAKE_GITDIR}\\n`)",
      "  process.exit(0)",
      "}",
      'const updateRef = args.indexOf("update-ref")',
      "if (updateRef >= 0 && process.env.GITOMIC_UPDATE_REF_ERROR) {",
      "  process.stderr.write(process.env.GITOMIC_UPDATE_REF_ERROR)",
      "  process.exit(128)",
      "}",
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

describe.sequential("shell backend failure boundaries", () => {
  test("fails open when Git is too old for the durability contract", async () => {
    const wrapper = await createGitWrapper()
    const restore = replaceEnvironment({
      GITOMIC_FAKE_GIT_VERSION: "2.35.9",
      LC_ALL: "C",
      PATH: `${wrapper.bin}${delimiter}${process.env.PATH ?? ""}`,
    })
    try {
      await expect(createShellBackend().head("ignored", "refs/heads/main")).rejects.toThrow(
        "Git 2.36 or newer is required",
      )
    } finally {
      restore()
      await wrapper.cleanup()
    }
  })

  test("accepts the standard Git for Windows version suffix", async () => {
    const wrapper = await createGitWrapper()
    const expected = "1".repeat(40)
    const restore = replaceEnvironment({
      GITOMIC_FAKE_GITDIR: "/tmp/gitomic-fake.git",
      GITOMIC_FAKE_GIT_VERSION: "2.45.2.windows.1",
      GITOMIC_FAKE_HEAD: expected,
      LC_ALL: "C",
      PATH: `${wrapper.bin}${delimiter}${process.env.PATH ?? ""}`,
    })
    try {
      await expect(createShellBackend().head("ignored", "refs/heads/main")).resolves.toBe(expected)
    } finally {
      restore()
      await wrapper.cleanup()
    }
  })

  test("passes repository durability config on every transaction write command", async () => {
    const fixture = await createBareRepo()
    const previousTrace = process.env.GIT_TRACE2_EVENT
    try {
      const trace = join(fixture.repo, "write-durability-trace.json")
      const store = await open({ repo: fixture.repo, ref: "main", writer: "durable-writer" })
      await store.transact(async (map) => map.set("obsolete", "remove me"), "seed deletion")
      process.env.GIT_TRACE2_EVENT = trace

      await store.transact(async (map) => {
        map.set("first", "durable")
        map.set("second", "durable")
        map.set("third", "durable")
        map.delete("obsolete")
      }, "durable write")

      const events = (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as TraceEvent)
      const writeCommands = ["hash-object", "update-index", "write-tree", "commit-tree", "update-ref"]
      for (const command of writeCommands) {
        const starts = events.filter((event) => event.event === "start" && event.argv?.includes(command))
        expect(starts.length, `${command} did not run`).toBeGreaterThan(0)
        for (const event of starts) {
          expect(event.argv).toContain("core.fsync=loose-object,reference")
          expect(event.argv).toContain("core.fsyncMethod=fsync")
        }
      }
      expect(events.filter((event) => event.event === "start" && event.argv?.includes("hash-object"))).toHaveLength(1)
      expect(events.filter((event) => event.event === "start" && event.argv?.includes("update-index"))).toHaveLength(1)
      // One ref write per transaction: the publish. No pin, no unpin, no
      // multi-command ref transaction to sequence them.
      const refWrites = events.filter((event) => event.event === "start" && event.argv?.includes("update-ref"))
      expect(refWrites).toHaveLength(1)
      expect(refWrites[0]?.argv).not.toContain("--stdin")
    } finally {
      if (previousTrace === undefined) delete process.env.GIT_TRACE2_EVENT
      else process.env.GIT_TRACE2_EVENT = previousTrace
      await fixture.cleanup()
    }
  })

  test.runIf(supportsReftable)("transacts in a reftable repository without a ref-storage special case", async () => {
    const fixture = await createBareRepo({ refFormat: "reftable" })
    try {
      const store = await open({ repo: fixture.repo, ref: "main", writer: "reftable-writer" })

      const committed = await store.transact(async (map) => map.set("value", "reftable"), "write reftable state")

      expect(await store.head()).toBe(committed.oid)
      expect(await store.at().get("value")).toBe("reftable")
      expect(await git(fixture.repo, "for-each-ref", "refs/gitomic")).toBe("")
    } finally {
      await fixture.cleanup()
    }
  })

  test.runIf(supportsObjectFormat)("supports SHA-256 object ids in the shell backend", async () => {
    const fixture = await createBareRepo({ objectFormat: "sha256" })
    try {
      const store = await open({ repo: fixture.repo, ref: "main", writer: "sha256-shell" })

      const written = await store.transact(async (map) => map.set("value", "sha256"), "write SHA-256 state")
      expect(written.oid).toMatch(/^[0-9a-f]{64}$/)
      expect(await store.at().get("value")).toBe("sha256")

      const removed = await store.transact(async (map) => map.delete("value"), "delete SHA-256 state")
      expect(removed.oid).toMatch(/^[0-9a-f]{64}$/)
      expect(await store.at().has("value")).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  test.each(["sha1", "sha256"] as const)(
    "snapshot oids match native %s Git for text and binary bytes",
    async (objectFormat) => {
      const fixture = await createBareRepo({ objectFormat })
      try {
        // Native Git supplies the independent identity oracle, including bytes
        // that Snapshot.get cannot decode. The mem-only oid tests cannot prove it.
        const textOid = await gitWithInput(fixture.repo, "native text\n", "hash-object", "-w", "--stdin")
        const binaryOid = await gitWithInput(
          fixture.repo,
          Uint8Array.of(0xff, 0xfe, 0x00, 0x80),
          "hash-object",
          "-w",
          "--stdin",
        )
        const tree = await gitWithInput(
          fixture.repo,
          `100644 blob ${textOid}\ttext\n100644 blob ${binaryOid}\tbinary\n`,
          "mktree",
        )
        const commit = await git(fixture.repo, "commit-tree", tree, "-p", fixture.initial, "-m", "native blobs")
        const store = await open({ repo: fixture.repo, ref: "main", writer: "native-oids" })
        const snapshot = store.at(commit)

        expect.soft(await snapshot.oid("text")).toBe(textOid)
        expect.soft(await snapshot.oid("binary")).toBe(binaryOid)
        await expect(snapshot.get("binary")).rejects.toThrow("valid UTF-8")
        expect(await snapshot.oid("missing")).toBeUndefined()
      } finally {
        await fixture.cleanup()
      }
    },
  )

  test.each(["sha1", "sha256"] as const)("apply accepts native %s anchors for put, mv and rm", async (objectFormat) => {
    const fixture = await createBareRepo({ objectFormat })
    try {
      const store = await open({ repo: fixture.repo, ref: "main", writer: "native-apply" })
      const written = await store.transact(async (map) => map.set("value", "before\n"), "seed native anchor")
      const beforeOid = await git(fixture.repo, "rev-parse", `${written.oid}:value`)
      // The attempted head selects the hash, never the expectation's format.
      await expect(
        apply(
          store,
          written.oid,
          [{ kind: "put", path: "value", content: "wrong\n", expect: "0".repeat(objectFormat === "sha256" ? 40 : 64) }],
          "refuse wrong-format anchor",
        ),
      ).rejects.toMatchObject({ code: "edit-does-not-apply", actual: beforeOid, head: written.oid })
      expect(await store.head()).toBe(written.oid)
      // A native anchor must work independently of Snapshot.oid; matching
      // read-side and write-side mistakes must not make this control green.
      const replaced = await apply(
        store,
        written.oid,
        [{ kind: "put", path: "value", content: "after\n", expect: beforeOid }],
        "replace native anchor",
      )
      expect(await store.at(replaced.oid).get("value")).toBe("after\n")
      const afterOid = await git(fixture.repo, "rev-parse", `${replaced.oid}:value`)
      const moved = await apply(
        store,
        replaced.oid,
        [{ kind: "mv", from: "value", to: "moved", expect: afterOid }],
        "move native anchor",
      )
      expect(await git(fixture.repo, "rev-parse", `${moved.oid}:moved`)).toBe(afterOid)
      expect(await store.at(moved.oid).has("value")).toBe(false)
      const removed = await apply(
        store,
        moved.oid,
        [{ kind: "rm", path: "moved", expect: afterOid }],
        "remove native anchor",
      )
      expect(await store.at(removed.oid).has("moved")).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  test.each([
    { name: "shell", createBackend: createShellBackend },
    { name: "iso", createBackend: createIsoBackend },
  ])("$name reads ordinary/root metadata and walks the first parent of a real merge", async ({ createBackend }) => {
    const fixture = await createBareRepo()
    try {
      const tree = await git(fixture.repo, "rev-parse", `${fixture.initial}^{tree}`)
      const message = "ordinary subject\n\nfull body with ünicode\n\n"
      // Distinct clocks make using author time instead of committer time fail.
      const first = await gitWithInput(
        fixture.repo,
        `tree ${tree}\nparent ${fixture.initial}\nauthor Author <author@example.invalid> 946684801 +0000\ncommitter Committer <committer@example.invalid> 946684900 +0000\n\n${message}`,
        "hash-object",
        "-t",
        "commit",
        "-w",
        "--stdin",
      )
      const side = await git(fixture.repo, "commit-tree", tree, "-p", fixture.initial, "-m", "side")
      const merge = await git(fixture.repo, "commit-tree", tree, "-p", first, "-p", side, "-m", "merge")
      const backend = createBackend()
      const reader = await openReader({ repo: fixture.repo, backend })
      const history = await reader.log({ from: merge })
      expect(history.map(({ oid }) => oid)).toEqual([merge, first, fixture.initial])
      expect(history[1]).toEqual({
        oid: first,
        parent: fixture.initial,
        message,
        writer: null,
        instance: null,
        seq: null,
        provenance: null,
        timestamp: 946_684_900,
      })
      expect(history[2]).toEqual({
        oid: fixture.initial,
        parent: null,
        message: "initial\n",
        writer: null,
        instance: null,
        seq: null,
        provenance: null,
        timestamp: 946_684_800,
      })
      const partialMessage = "partial\n\nGitomic-Writer: ordinary-writer\n"
      const partial = await gitWithInput(fixture.repo, partialMessage, "commit-tree", tree, "-p", first)
      expect(await backend.readCommit(fixture.repo, partial)).toMatchObject({
        message: partialMessage,
        writer: "ordinary-writer",
        instance: null,
        seq: null,
        provenance: null,
      })
      const provenanceMessage =
        "provenance\n\nGitomic-Actor: original-actor\nGitomic-Actor-Session: 0198b5e8-cdd2-7a63-8a81-2fdc8144e6a4\nGitomic-Actor-Generation: 7\nGitomic-Actor-Run: run-0198b5e8\n"
      const provenanceCommit = await gitWithInput(fixture.repo, provenanceMessage, "commit-tree", tree, "-p", first)
      await expect(backend.readCommit(fixture.repo, provenanceCommit)).resolves.toMatchObject({
        provenance: {
          actor: "original-actor",
          session: "0198b5e8-cdd2-7a63-8a81-2fdc8144e6a4",
          generation: 7,
          run: "run-0198b5e8",
        },
      })
      // Missing fields are null; recognized present values must not be silently lost.
      for (const trailer of [
        "Gitomic-Seq: nope",
        "Gitomic-Seq: -1",
        "Gitomic-Seq: 9007199254740992",
        "Gitomic-Instance: ",
        "Gitomic-Writer: a\nGitomic-Writer: b",
        "Gitomic-Actor: original-actor",
        "Gitomic-Actor: original-actor\nGitomic-Actor-Session: session\nGitomic-Actor-Generation: -1",
        "Gitomic-Actor: original-actor\nGitomic-Actor-Session: session\nGitomic-Actor-Generation: nope",
        "Gitomic-Actor: original-actor\nGitomic-Actor-Session: session\nGitomic-Actor-Generation: 9007199254740992",
        "Gitomic-Actor: original-actor\nGitomic-Actor-Session: session\nGitomic-Actor-Generation: 1\nGitomic-Actor: another-actor",
        "Gitomic-Actor: original-actor\nGitomic-Actor-Session: session\nGitomic-Actor-Generation: 1\nGitomic-Actor-Run: \u0001",
      ]) {
        const malformed = await gitWithInput(
          fixture.repo,
          `bad metadata\n\n${trailer}\n`,
          "commit-tree",
          tree,
          "-p",
          first,
        )
        await expect(backend.readCommit(fixture.repo, malformed)).rejects.toThrow("Gitomic-")
      }
      await expect(backend.readCommit(fixture.repo, "f".repeat(40))).rejects.toThrow()
      await expect(backend.readCommit(fixture.repo, tree)).rejects.toThrow()
    } finally {
      await fixture.cleanup()
    }
  })

  test("finds an acknowledged transaction with one bounded history process", async () => {
    const fixture = await createBareRepo()
    const previousTrace = process.env.GIT_TRACE2_EVENT
    try {
      const shell = createShellBackend()
      const instances: string[] = []
      const backend: GitomicBackend = {
        ...shell,
        writeCommit: async (repo, input) => {
          instances.push(input.instance)
          return await shell.writeCommit(repo, input)
        },
      }
      const store = await open({ repo: fixture.repo, ref: "main", writer: "worker-a", backend })
      const first = await store.transact(async (map) => map.set("first", "1"), "first")
      await store.transact(async (map) => map.set("second", "2"), "second")
      const trace = join(fixture.repo, "find-transaction-trace.json")
      process.env.GIT_TRACE2_EVENT = trace

      const found = await createShellBackend().findTransaction(
        fixture.repo,
        await store.head(),
        fixture.initial,
        instances[0] as string,
        0,
      )

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

  test("fails loudly when a receipt search runs past its horizon without reaching its base", async () => {
    const fixture = await createBareRepo()
    try {
      await appendEmptyHistory(fixture.repo, fixture.initial, TRANSACTION_SEARCH_LIMIT + 1)
      const backend = createShellBackend()
      const tip = await backend.head(fixture.repo, "refs/heads/main")

      await expect(backend.findTransaction(fixture.repo, tip, fixture.initial, "missing-instance", 1)).rejects.toThrow(
        `exceeded ${TRANSACTION_SEARCH_LIMIT} first-parent commits`,
      )
    } finally {
      await fixture.cleanup()
    }
  }, 30_000)

  test("reads only the commits after its base, however deep the history is", async () => {
    const fixture = await createBareRepo()
    try {
      await appendEmptyHistory(fixture.repo, fixture.initial, TRANSACTION_SEARCH_LIMIT + 1)
      const backend = createShellBackend()
      const tip = await backend.head(fixture.repo, "refs/heads/main")

      await expect(backend.findTransaction(fixture.repo, tip, tip, "missing-instance", 1)).resolves.toBeUndefined()
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

  test("replays when another update-ref process temporarily owns the ref lock", async () => {
    const wrapper = await createGitWrapper()
    const expected = "1".repeat(40)
    const next = "2".repeat(40)
    const restore = replaceEnvironment({
      GITOMIC_FAKE_GITDIR: "/tmp/gitomic-fake.git",
      GITOMIC_UPDATE_REF_ERROR:
        "fatal: prepare: cannot lock ref 'refs/heads/main': Unable to create '/tmp/gitomic-fake.git/refs/heads/main.lock': File exists.\n",
      LC_ALL: "C",
      PATH: `${wrapper.bin}${delimiter}${process.env.PATH ?? ""}`,
    })
    try {
      await expect(createShellBackend().compareAndSwap("ignored", "refs/heads/main", next, expected)).resolves.toBe(
        false,
      )
    } finally {
      restore()
      await wrapper.cleanup()
    }
  })

  test("classifies both client-side and server-side lease losses as CAS contention", () => {
    expect(isRemoteCompareAndSwapRejection("!\trefs/heads/main:refs/heads/main\t[rejected] (stale info)\nDone\n")).toBe(
      true,
    )
    expect(
      isRemoteCompareAndSwapRejection(
        "!\tabc123:refs/heads/main\t[remote rejected] (incorrect old value provided)\nDone\n",
      ),
    ).toBe(true)
    expect(
      isRemoteCompareAndSwapRejection("!\tabc123:refs/heads/main\t[remote rejected] (policy denied)\nDone\n"),
    ).toBe(false)
  })
})
