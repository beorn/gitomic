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
}

async function expectLinearContention(writerCount: number, operationsPerWriter: number): Promise<void> {
  const fixture = await createBareRepo()
  const controller = new AbortController()
  const writerNames = Array.from({ length: writerCount }, (_, index) => `writer-${index + 1}`)
  const expected = writerCount * operationsPerWriter
  try {
    const outputs = await Promise.all(
      writerNames.map(
        async (writerName) =>
          await execFileAsync("bun", [worker, fixture.repo, writerName, String(operationsPerWriter)], {
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

    expect(new Set(committed.map((result) => result.oid))).toHaveLength(expected)
    expect(await git(fixture.repo, "show", "main:count")).toBe(String(expected))
    expect(await git(fixture.repo, "rev-list", "--count", "main")).toBe(String(expected + 1))
    expect(await git(fixture.repo, "rev-list", "--min-parents=2", "main")).toBe("")
    const parents = (await git(fixture.repo, "rev-list", "--parents", "main")).split("\n")
    expect(parents.slice(0, -1).every((line) => line.split(" ").length === 2)).toBe(true)
    expect(parents.at(-1)?.split(" ")).toHaveLength(1)

    const messages = await git(fixture.repo, "log", "--format=%B%x00", "main")
    const receipts = messages
      .split("\0")
      .map((message) => {
        const normalized = message.trim()
        const subject = normalized.split("\n", 1)[0] ?? ""
        const identity = /^Gitomic-Instance: ([^\n]+)\nGitomic-Seq: (\d+)$/mu.exec(normalized)
        const separator = subject.indexOf(":")
        return identity === null || separator < 1
          ? null
          : { writer: subject.slice(0, separator), instance: identity[1] as string, seq: identity[2] as string }
      })
      .filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== null)
    expect(receipts).toHaveLength(expected)
    // Every transaction carries a receipt no other process could mint.
    expect(new Set(receipts.map((receipt) => `${receipt.instance}:${receipt.seq}`))).toHaveLength(expected)
    expect(new Set(receipts.map((receipt) => receipt.instance))).toHaveLength(writerCount)
    for (const writer of writerNames) {
      expect(receipts.filter((receipt) => receipt.writer === writer)).toHaveLength(operationsPerWriter)
    }
  } finally {
    controller.abort()
    await fixture.cleanup()
  }
}

describe("shell contention acceptance", () => {
  test("lands 3 writers x 100 exactly once on a strictly linear history", async () => {
    await expectLinearContention(3, 100)
  }, 300_000)

  test("absorbs a 12-writer burst without duplicates, merges, or lost state", async () => {
    await expectLinearContention(12, 25)
  }, 300_000)
})
