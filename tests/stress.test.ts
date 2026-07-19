// @failure Native ref-lock contention could lose, duplicate, or merge operations at sustained concurrency.
// @level l2
// @consumer shell backend CI acceptance

import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { describe, expect, test } from "vitest"

import type { Committed } from "../src/index.js"
import { createBareRepo, git } from "./helpers/git.js"

const execFileAsync = promisify(execFile)
const worker = fileURLToPath(new URL("fixtures/stress-writer.ts", import.meta.url))

type WorkerResult = {
  committed: Committed[]
  exhaustedCalls: number
}

describe("shell contention acceptance", () => {
  test("lands 3 writers x 100 exactly once on a strictly linear history", async () => {
    const fixture = await createBareRepo()
    const controller = new AbortController()
    try {
      const writerNames = ["writer-a", "writer-b", "writer-c"]
      const outputs = await Promise.all(
        writerNames.map(
          async (writerName) =>
            await execFileAsync("bun", [worker, fixture.repo, writerName, "100"], {
              encoding: "utf8",
              killSignal: "SIGKILL",
              maxBuffer: 10 * 1024 * 1024,
              signal: controller.signal,
              timeout: 270_000,
            }),
        ),
      )
      const results = outputs.map(({ stdout }) => JSON.parse(stdout) as WorkerResult)
      const committed = results.flatMap((result) => result.committed)

      expect(new Set(committed.map((result) => result.oid))).toHaveLength(300)
      expect(results.every((result) => result.exhaustedCalls >= 0)).toBe(true)
      expect(await git(fixture.repo, "show", "main:count")).toBe("300")
      expect(await git(fixture.repo, "rev-list", "--count", "main")).toBe("301")
      expect(await git(fixture.repo, "rev-list", "--min-parents=2", "main")).toBe("")
      const parents = (await git(fixture.repo, "rev-list", "--parents", "main")).split("\n")
      expect(parents.slice(0, -1).every((line) => line.split(" ").length === 2)).toBe(true)
      expect(parents.at(-1)?.split(" ")).toHaveLength(1)

      const messages = await git(fixture.repo, "log", "--format=%B%x00", "main")
      const operations = messages
        .split("\0")
        .map((message) => message.match(/Gitomic-Writer: ([^\n]+)\nGitomic-Seq: (\d+)\s*$/))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map((match) => `${match[1]}:${match[2]}`)
      expect(operations).toHaveLength(300)
      expect(new Set(operations)).toHaveLength(300)
      for (const writer of writerNames) {
        expect(operations.filter((operation) => operation.startsWith(`${writer}:`))).toHaveLength(100)
      }
    } finally {
      controller.abort()
      await fixture.cleanup()
    }
  }, 300_000)
})
