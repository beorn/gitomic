// @failure Native ref-lock contention could lose, duplicate, or merge operations at sustained concurrency.
// @level l2
// @consumer shell backend CI acceptance

import { execFile } from "node:child_process"
import { performance } from "node:perf_hooks"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { describe, expect, test } from "vitest"

import { apply, open, openRemoteRepository } from "../src/index.js"
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
      .map((message) => message.match(/Gitomic-Writer: ([^\n]+)\nGitomic-Instance: ([^\n]+)\nGitomic-Seq: (\d+)\s*$/))
      .filter((match): match is RegExpMatchArray => match !== null)
    expect(receipts).toHaveLength(expected)
    // Every transaction carries a receipt no other process could mint.
    expect(new Set(receipts.map((match) => `${match[2]}:${match[3]}`))).toHaveLength(expected)
    expect(new Set(receipts.map((match) => match[2]))).toHaveLength(writerCount)
    for (const writer of writerNames) {
      expect(receipts.filter((match) => match[1] === writer)).toHaveLength(operationsPerWriter)
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

describe("apply at scale (K2 at fleet scale, F14)", () => {
  test("fifty concurrent disjoint-path writers each land exactly once, in one strictly-linear history, none lost", async (context) => {
    const fixture = await createBareRepo()
    try {
      const writerCount = 50
      const url = pathToFileURL(fixture.repo).href

      // transact owns contention now — a time budget, not a counter — so there is
      // NO outer retry loop: each writer applies exactly once and transact keeps
      // racing until it lands within its budget (the budget resets on every observed
      // landing, so a burst that keeps making progress is never abandoned). The
      // disjoint blob-absent preconditions hold on whatever tip each attempt sees,
      // so all fifty land.
      const started = performance.now()
      const settled = await Promise.allSettled(
        Array.from({ length: writerCount }, async (_, index) => {
          using repository = await openRemoteRepository(url)
          const store = await open({ ...repository, ref: "main", writer: `scale-${index}` })
          return await apply(
            store,
            fixture.initial,
            [
              {
                kind: "put",
                path: `scale/writer-${String(index).padStart(2, "0")}.md`,
                content: `writer ${index}\n`,
                expect: null,
              },
            ],
            `writer ${index} lands`,
          )
        }),
      )
      const failures = settled.filter((result) => result.status === "rejected")
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((result) => result.reason),
          "K2 remote writers failed",
        )
      }
      const results = settled.map((result) => {
        if (result.status !== "fulfilled") throw new Error("K2 settlement unexpectedly missing a commit")
        return result.value
      })
      const elapsedMs = performance.now() - started
      const maxRetries = Math.max(...results.map((committed) => committed.retries))
      // Published per the design's F14 scale line: the observed numbers, not asserted.
      await context.annotate(
        `K2 remote scale: ${writerCount} concurrent URL-owned writers opened, landed and disposed in ${elapsedMs.toFixed(0)}ms ` +
          `(max ${maxRetries} CAS retries on one writer)`,
        "info",
      )

      // Every writer landed its own real commit — none lost, none duplicated.
      expect(results).toHaveLength(writerCount)
      expect(new Set(results.map((committed) => committed.oid))).toHaveLength(writerCount)
      expect(await git(fixture.repo, "rev-list", "--count", "main")).toBe(String(writerCount + 1))
      const parents = (await git(fixture.repo, "rev-list", "--parents", "main")).split("\n")
      expect(parents.slice(0, -1).every((line) => line.split(" ").length === 2)).toBe(true)
      expect(parents.at(-1)?.split(" ")).toHaveLength(1)

      const verifier = await open({ repo: fixture.repo, ref: "main", writer: "scale-verify" })
      const tip = await verifier.head()
      await Promise.all(
        Array.from({ length: writerCount }, async (_, index) => {
          const path = `scale/writer-${String(index).padStart(2, "0")}.md`
          expect(await verifier.at(tip).get(path)).toBe(`writer ${index}\n`)
        }),
      )
    } finally {
      await fixture.cleanup()
    }
    // Hosted runners measured 45 to 60 s for this burst; it lives in the stress
    // lane, run by CI after the check, and three times the observed time bounds it.
  }, 180_000)
})
