// @failure Concurrent apply calls could merge or clobber same-file edits, drop a moved-base
// precondition on a disjoint rm/mv, silently overwrite a concurrently-created move destination,
// or regress into a slow per-file process-spawn path.
// @level l1
// @consumer concurrent agents applying edits to the same repo with no checkout

import { execFile } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createInterface } from "node:readline"
import { Buffer } from "node:buffer"
import { performance } from "node:perf_hooks"
import { promisify } from "node:util"

import { describe, expect, test } from "vitest"

import { apply, EditDoesNotApply, open, openRemoteRepository } from "../src/index.js"
import type { Committed } from "../src/index.js"
import { objectOid } from "../src/git-object.js"
import { createIsoBackend } from "../src/iso.js"
import { createBareRepo, git } from "./helpers/git.js"

const execFileAsync = promisify(execFile)

/** The blob oid of some content — what a caller reads and feeds back as `expect`. */
function oid(content: string): string {
  return objectOid("blob", Buffer.from(content, "utf8"))
}

/**
 * Race two applies that cannot both land against the same precondition. Returns
 * the winner's commit and the loser's rejection reason, keyed generically so the
 * caller never has to guess (or force) which of the two actually won the race.
 * Throws if the race did not settle to exactly one winner and one loser, which
 * would itself mean the CAS contract broke (both landed, or both refused).
 */
async function raceToOneWinner(
  first: Promise<Committed>,
  second: Promise<Committed>,
): Promise<{ winner: Committed; loserReason: unknown }> {
  const [a, b] = await Promise.allSettled([first, second])
  if (a.status === "fulfilled" && b.status === "rejected") return { winner: a.value, loserReason: b.reason }
  if (b.status === "fulfilled" && a.status === "rejected") return { winner: b.value, loserReason: a.reason }
  throw new Error(`expected exactly one winner and one loser, got ${a.status} and ${b.status}`)
}

/** Assert `rev-list --parents` shows one parent per commit and a rootless tip: no merge commit. */
function assertStrictlyLinear(parentsLog: string): void {
  const lines = parentsLog.split("\n")
  expect(lines.slice(0, -1).every((line) => line.split(" ").length === 2)).toBe(true)
  expect(lines.at(-1)?.split(" ")).toHaveLength(1)
}

const backends = [
  { name: "shell", backend: undefined },
  { name: "iso", backend: createIsoBackend() },
] as const

describe.each(backends)("apply under concurrency — the $name backend", ({ name, backend }) => {
  test("disjoint-path apply: two writers on the same base both land in one strictly-linear history, no lock, nothing lost", async () => {
    const fixture = await createBareRepo()
    try {
      const writerA = await open({
        repo: fixture.repo,
        ref: "main",
        writer: `disjoint-a-${name}`,
        ...(backend === undefined ? {} : { backend }),
      })
      const writerB = await open({
        repo: fixture.repo,
        ref: "main",
        writer: `disjoint-b-${name}`,
        ...(backend === undefined ? {} : { backend }),
      })
      const base = await writerA.head()
      expect(await writerB.head()).toBe(base)

      // Interleaved apply calls on two independent stores: whichever's commit
      // lands first moves the ref, and the loser's disjoint-path precondition
      // (blob-absent on its OWN path) still holds when it replays on the new tip.
      const [committedA, committedB] = await Promise.all([
        apply(
          writerA,
          base,
          [{ kind: "put", path: "a.md", content: "from a\n", expect: null }],
          "writer a creates a.md",
        ),
        apply(
          writerB,
          base,
          [{ kind: "put", path: "b.md", content: "from b\n", expect: null }],
          "writer b creates b.md",
        ),
      ])

      expect(committedA.oid).not.toBe(base)
      expect(committedB.oid).not.toBe(base)
      const tip = await writerA.head()
      expect(await writerA.at(tip).get("a.md")).toBe("from a\n")
      expect(await writerA.at(tip).get("b.md")).toBe("from b\n")
      expect(await git(fixture.repo, "rev-list", "--count", "main")).toBe("3")
      assertStrictlyLinear(await git(fixture.repo, "rev-list", "--parents", "main"))
    } finally {
      await fixture.cleanup()
    }
  })

  test("same-path put refuses on replay even when the two edits touch different regions of the file — put is whole-file, there is no region merge", async () => {
    const fixture = await createBareRepo()
    try {
      const setup = await open({
        repo: fixture.repo,
        ref: "main",
        writer: `same-file-setup-${name}`,
        ...(backend === undefined ? {} : { backend }),
      })
      const original = "alpha\nbeta\ngamma\n"
      const created = await apply(
        setup,
        await setup.head(),
        [{ kind: "put", path: "doc.md", content: original, expect: null }],
        "seed doc.md",
      )

      const writerA = await open({
        repo: fixture.repo,
        ref: "main",
        writer: `same-file-a-${name}`,
        ...(backend === undefined ? {} : { backend }),
      })
      const writerB = await open({
        repo: fixture.repo,
        ref: "main",
        writer: `same-file-b-${name}`,
        ...(backend === undefined ? {} : { backend }),
      })
      // Two different regions of the same file: A edits only the first line, B
      // edits only the last line. A region-aware merge would land both edits;
      // `put`'s precondition is the whole blob, so only one whole-file write can win.
      const editedTop = "ALPHA (edited by a)\nbeta\ngamma\n"
      const editedBottom = "alpha\nbeta\nGAMMA (edited by b)\n"

      const { winner, loserReason } = await raceToOneWinner(
        apply(
          writerA,
          created.oid,
          [{ kind: "put", path: "doc.md", content: editedTop, expect: oid(original) }],
          "writer a edits the top line",
        ),
        apply(
          writerB,
          created.oid,
          [{ kind: "put", path: "doc.md", content: editedBottom, expect: oid(original) }],
          "writer b edits the bottom line",
        ),
      )

      const landedContent = await writerA.at(winner.oid).get("doc.md")
      if (landedContent === undefined) throw new Error("doc.md is missing after the race settled")
      expect([editedTop, editedBottom]).toContain(landedContent)
      // The loser refuses with facts naming exactly what changed underneath it —
      // never a merge of the two regions, never a partial write.
      expect(loserReason).toBeInstanceOf(EditDoesNotApply)
      expect(loserReason).toMatchObject({
        code: "edit-does-not-apply",
        kind: "put",
        preconditionType: "blob-identical",
        path: "doc.md",
        expected: oid(original),
        actual: oid(landedContent),
      })
    } finally {
      await fixture.cleanup()
    }
  })

  test("a moved base still lands a disjoint rm and a disjoint mv — the replay rule holds for every edit kind, not only put", async () => {
    const fixture = await createBareRepo()
    try {
      const setup = await open({
        repo: fixture.repo,
        ref: "main",
        writer: `moved-base-setup-${name}`,
        ...(backend === undefined ? {} : { backend }),
      })
      const created = await apply(
        setup,
        await setup.head(),
        [
          { kind: "put", path: "keep.md", content: "keep me\n", expect: null },
          { kind: "put", path: "from.md", content: "movable\n", expect: null },
        ],
        "seed keep.md and from.md",
      )

      const writerRm = await open({
        repo: fixture.repo,
        ref: "main",
        writer: `moved-base-rm-${name}`,
        ...(backend === undefined ? {} : { backend }),
      })
      const writerMv = await open({
        repo: fixture.repo,
        ref: "main",
        writer: `moved-base-mv-${name}`,
        ...(backend === undefined ? {} : { backend }),
      })

      // rm targets keep.md, mv targets from.md→to.md: disjoint from each other, so
      // whichever lands first, the other's precondition still holds on replay.
      const [rmCommitted, mvCommitted] = await Promise.all([
        apply(writerRm, created.oid, [{ kind: "rm", path: "keep.md", expect: oid("keep me\n") }], "rm keep.md"),
        apply(
          writerMv,
          created.oid,
          [{ kind: "mv", from: "from.md", to: "to.md", expect: oid("movable\n") }],
          "mv from.md to to.md",
        ),
      ])

      expect(rmCommitted.oid).not.toBe(created.oid)
      expect(mvCommitted.oid).not.toBe(created.oid)
      const tip = await writerRm.head()
      expect(await writerRm.at(tip).has("keep.md")).toBe(false)
      expect(await writerRm.at(tip).has("from.md")).toBe(false)
      expect(await writerRm.at(tip).get("to.md")).toBe("movable\n")
      expect(await git(fixture.repo, "rev-list", "--count", "main")).toBe("4")
      assertStrictlyLinear(await git(fixture.repo, "rev-list", "--parents", "main"))
    } finally {
      await fixture.cleanup()
    }
  })

  test("mv onto a path a concurrent writer just created refuses with destination-absent, not a silent overwrite", async () => {
    const fixture = await createBareRepo()
    try {
      const setup = await open({
        repo: fixture.repo,
        ref: "main",
        writer: `mv-dest-setup-${name}`,
        ...(backend === undefined ? {} : { backend }),
      })
      const created = await apply(
        setup,
        await setup.head(),
        [{ kind: "put", path: "from.md", content: "body\n", expect: null }],
        "seed from.md; to.md stays absent",
      )

      const mover = await open({
        repo: fixture.repo,
        ref: "main",
        writer: `mv-dest-mover-${name}`,
        ...(backend === undefined ? {} : { backend }),
      })
      const creator = await open({
        repo: fixture.repo,
        ref: "main",
        writer: `mv-dest-creator-${name}`,
        ...(backend === undefined ? {} : { backend }),
      })
      const base = created.oid
      expect(await mover.at(base).has("to.md")).toBe(false)

      // `mover` authored its mv against `base`, where to.md is absent. Before it
      // lands, a second writer concurrently creates to.md — landed here first so
      // the outcome is deterministic rather than a coin flip on process scheduling.
      await apply(
        creator,
        base,
        [{ kind: "put", path: "to.md", content: "occupied\n", expect: null }],
        "concurrently create to.md",
      )

      const error = await apply(
        mover,
        base,
        [{ kind: "mv", from: "from.md", to: "to.md", expect: oid("body\n") }],
        "mv onto what is now occupied",
      ).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(EditDoesNotApply)
      expect(error).toMatchObject({
        kind: "mv",
        preconditionType: "destination-absent",
        path: "to.md",
        expected: null,
        actual: oid("occupied\n"),
      })
      // Nothing moved: from.md is untouched, to.md keeps the concurrent writer's content.
      const tip = await mover.head()
      expect(await mover.at(tip).get("from.md")).toBe("body\n")
      expect(await mover.at(tip).get("to.md")).toBe("occupied\n")
    } finally {
      await fixture.cleanup()
    }
  })
})

describe("apply with no checkout (K1)", () => {
  test("apply lands in a bare repo with no working checkout, invoked from an unrelated cwd, addressed by repo path only", async () => {
    const fixture = await createBareRepo()
    const unrelatedDir = await mkdtemp(join(tmpdir(), "gitomic-unrelated-cwd-"))
    try {
      expect(await readdir(unrelatedDir)).toEqual([])

      // A separate OS process, cwd'd into a directory with no relationship to the
      // repo, importing gitomic only by absolute source path and addressing the
      // repo only by its filesystem path — no `cd` into it, no ambient env var.
      const indexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url))
      const script = [
        `const { open, apply } = await import(${JSON.stringify(indexPath)})`,
        `const store = await open({ repo: ${JSON.stringify(fixture.repo)}, ref: "main", writer: "k1-no-checkout" })`,
        "const base = await store.head()",
        `const committed = await apply(store, base, [{ kind: "put", path: "from-nowhere.md", content: "no checkout needed\\n", expect: null }], "K1: land with no checkout, from an unrelated cwd")`,
        "process.stdout.write(JSON.stringify({ oid: committed.oid, cwd: process.cwd() }))",
      ].join("\n")

      const { stdout } = await execFileAsync("bun", ["-e", script], { cwd: unrelatedDir, encoding: "utf8" })
      const result = JSON.parse(stdout) as { oid: string; cwd: string }

      // Ran from the unrelated directory — the door needed no checkout to get there.
      expect(result.cwd).toBe(unrelatedDir)
      // The ref actually moved: this was a real write, not a dry run.
      expect(result.oid).not.toBe(fixture.initial)
      expect(await git(fixture.repo, "rev-parse", "main")).toBe(result.oid)
      expect(await git(fixture.repo, "show", `${result.oid}:from-nowhere.md`)).toBe("no checkout needed")

      // No worktree materialized anywhere as a side effect: the unrelated cwd is
      // still empty, and the bare repo is still only Git's object/ref database —
      // no `.git`, no `index`, no checked-out files.
      expect(await readdir(unrelatedDir)).toEqual([])
      const repoEntries = await readdir(fixture.repo)
      expect(repoEntries).not.toContain(".git")
      expect(repoEntries).not.toContain("index")
    } finally {
      await rm(unrelatedDir, { recursive: true, force: true })
      await fixture.cleanup()
    }
  })
})

describe("apply from separate processes (K2)", () => {
  test("two URL-only processes publish disjoint edits from one base through separately owned object repos", async () => {
    const fixture = await createBareRepo()
    const dirs: string[] = []
    const jobs: ReturnType<typeof execFileAsync>[] = []
    try {
      const url = pathToFileURL(fixture.repo).href
      const indexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url))
      dirs.push(...(await Promise.all(["a", "b"].map(() => mkdtemp(join(tmpdir(), "gitomic-k2-process-"))))))
      const ready = []
      for (const [index, name] of ["a", "b"].entries()) {
        const cwd = dirs[index]!
        const script = [
          `const { open, apply, openRemoteRepository } = await import(${JSON.stringify(indexPath)})`,
          `using repository = openRemoteRepository(${JSON.stringify(url)})`,
          `const store = await open({ ...repository, ref: "main", writer: ${JSON.stringify(name)} })`,
          "const base = await store.head()",
          'process.stdout.write(JSON.stringify({ pid: process.pid, repo: repository.repo, cwd: process.cwd(), base }) + "\\n")',
          'await new Promise(resolve => process.stdin.once("data", resolve))',
          "process.stdin.destroy()",
          "const startedAt = Date.now()",
          `const committed = await apply(store, base, [{ kind: "put", path: "${name}.md", content: "from ${name}\\n", expect: null }], "K2 writer ${name}")`,
          'process.stdout.write(JSON.stringify({ oid: committed.oid, retries: committed.retries, startedAt }) + "\\n")',
        ].join("\n")
        const job = execFileAsync("bun", ["-e", script], {
          cwd,
          encoding: "utf8",
          env: { ...process.env, TMPDIR: cwd },
          timeout: 30_000,
        })
        jobs.push(job)
        if (job.child.stdout === null) throw new Error("K2 child stdout is missing")
        const lines = createInterface({ input: job.child.stdout })
        ready.push(
          Promise.race([
            once(lines, "line").then(
              ([line]) =>
                JSON.parse(String(line)) as {
                  pid: number
                  repo: string
                  cwd: string
                  base: string
                },
            ),
            job.then(() => {
              throw new Error(`K2 writer ${name} exited without its ready witness`)
            }),
          ]).finally(() => lines.close()),
        )
      }

      // Both processes have read the same remote base before either may write.
      // This start barrier coordinates only the experiment, never publication.
      const witnesses = await Promise.all(ready)
      expect(witnesses.map((witness) => witness.base)).toEqual([fixture.initial, fixture.initial])
      expect(witnesses.map((witness) => witness.cwd)).toEqual(dirs)
      expect(new Set(witnesses.map((witness) => witness.pid))).toHaveLength(2)
      expect(witnesses.every((witness) => witness.pid !== process.pid)).toBe(true)
      expect(new Set(witnesses.map((witness) => witness.repo))).toHaveLength(2)
      for (const witness of witnesses) {
        expect(witness.repo).not.toBe(fixture.repo)
        expect(await git(witness.repo, "rev-parse", "--is-bare-repository")).toBe("true")
      }
      for (const job of jobs) {
        if (job.child.stdin === null) throw new Error("K2 child stdin is missing")
        job.child.stdin.end("start\n")
      }
      const results = await Promise.all(jobs)
      const commits = results.map(({ stdout }) => {
        const lines = stdout.toString().trim().split("\n")
        expect(lines).toHaveLength(2)
        return JSON.parse(lines[1]!) as { oid: string; retries: number; startedAt: number }
      })
      expect(Math.abs(commits[0]!.startedAt - commits[1]!.startedAt)).toBeLessThan(1000)

      // Native remote facts are independent of each process's local receipt.
      const history = (await git(fixture.repo, "rev-list", "--parents", "main")).split("\n")
      expect(history).toHaveLength(3)
      expect(new Set(commits.map((commit) => commit.oid))).toHaveLength(2)
      expect(new Set(history.slice(0, 2).map((line) => line.split(" ")[0]))).toEqual(
        new Set(commits.map((commit) => commit.oid)),
      )
      expect(history[0]!.split(" ")[1]).toBe(history[1]!.split(" ")[0])
      expect(history[1]!.split(" ")[1]).toBe(fixture.initial)
      expect(history[2]).toBe(fixture.initial)
      assertStrictlyLinear(history.join("\n"))
      expect(await git(fixture.repo, "show", "main:a.md")).toBe("from a")
      expect(await git(fixture.repo, "show", "main:b.md")).toBe("from b")
      expect(await git(fixture.repo, "show", `${commits[0]!.oid}:a.md`)).toBe("from a")
      expect(await git(fixture.repo, "show", `${commits[1]!.oid}:b.md`)).toBe("from b")
      for (const witness of witnesses) await expect(readdir(witness.repo)).rejects.toMatchObject({ code: "ENOENT" })
      for (const cwd of dirs) expect(await readdir(cwd)).toEqual([])
      console.log(`K2 processes: ${JSON.stringify({ witnesses, commits })}`)
    } finally {
      for (const job of jobs) if (job.child.exitCode === null) job.child.kill()
      await Promise.allSettled(jobs)
      for (const cwd of dirs) await rm(cwd, { recursive: true, force: true })
      await fixture.cleanup()
    }
  }, 40_000)
})

describe("apply at scale (K2 at fleet scale, F14)", () => {
  test("fifty concurrent disjoint-path writers each land exactly once, in one strictly-linear history, none lost", async () => {
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
          using repository = openRemoteRepository(url)
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
      console.log(
        `K2 remote scale: ${writerCount} concurrent URL-owned writers opened, landed and disposed in ${elapsedMs.toFixed(0)}ms ` +
          `(max ${maxRetries} CAS retries on one writer)`,
      )

      // Every writer landed its own real commit — none lost, none duplicated.
      expect(results).toHaveLength(writerCount)
      expect(new Set(results.map((committed) => committed.oid))).toHaveLength(writerCount)
      expect(await git(fixture.repo, "rev-list", "--count", "main")).toBe(String(writerCount + 1))
      assertStrictlyLinear(await git(fixture.repo, "rev-list", "--parents", "main"))

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
  }, 60_000)
})

describe("apply latency", () => {
  test("a single apply round-trip against a real bare repo (shell backend) lands well under the 2s latency gate", async () => {
    const fixture = await createBareRepo()
    try {
      const store = await open({ repo: fixture.repo, ref: "main", writer: "latency-gate" })
      const base = await store.head()

      const started = performance.now()
      await apply(store, base, [{ kind: "put", path: "latency.md", content: "timed\n", expect: null }], "timed apply")
      const elapsedMs = performance.now() - started
      // Published per the brief: the measured number, not just the pass/fail —
      // this is a gate, not a target, so a slow number is reported, not hidden.
      console.log(`apply latency: ${elapsedMs.toFixed(2)}ms (gate: < 2000ms)`)

      // A real `git` subprocess round-trip (read tree, write blob/tree/commit
      // objects, update-ref) lands in tens of milliseconds locally; 2000ms is a
      // generous ceiling that only a per-file process-spawn regression would hit.
      expect(elapsedMs).toBeLessThan(2000)
    } finally {
      await fixture.cleanup()
    }
  })
})
