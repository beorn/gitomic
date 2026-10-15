// @failure A repository's declared gate could be skipped, read from the write it is judging (so a write disables its own
// gate), smuggled inside a content write, hang a writer forever, or judge a tree without the files its derive step adds.
// @level l2
// @consumer 24168 slice A: STATE declares `.gitomic.conf` and every prose/config write runs it; km's writes use it too

import { existsSync } from "node:fs"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { CandidateRefused } from "../src/errors.js"
import {
  CANDIDATE_CONFIG,
  createShellBackend,
  open,
  readCandidateCommands,
  readRepositoryDeclaration,
  repositoryCandidate,
  trustDeclaration,
  type CandidateRun,
  type InProcessCommand,
  type InProcessOptions,
  type Store,
} from "../src/index.js"
import { runCommand } from "../src/shell.js"
import { createBareRepo } from "./helpers/git.js"

let scripts: string
let fixture: { repo: string; cleanup(): Promise<void> }
let store: Store

beforeEach(async () => {
  scripts = await mkdtemp(join(tmpdir(), "gitomic-candidate-scripts-"))
  fixture = await createBareRepo()
  store = await open({
    repo: fixture.repo,
    ref: "main",
    writer: "candidate-repository-test",
    backend: createShellBackend(),
  })
})

afterEach(async () => {
  await fixture.cleanup()
  await rm(scripts, { recursive: true, force: true })
})

/** A shell script the gate config can name. It reads the candidate with git, as a real check does. */
async function script(name: string, body: string): Promise<string> {
  const path = join(scripts, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`, "utf8")
  await chmod(path, 0o755)
  return path
}

/**
 * Declare the gate in its own write, the bootstrap commit that runs no gate because its base has none, and trust it
 * (25325): nothing a repository declares runs until its exact blob is trusted.
 */
async function declare(config: string): Promise<void> {
  const declared = await store.transact(async (map) => map.set(CANDIDATE_CONFIG, config), "declare the gate")
  await trustAt({ repo: fixture.repo }, declared.oid)
}

/** Trust the declaration at `commit`, as `gitomic trust` does after showing it (the bootstrap's step). */
async function trustAt(scope: { repo: string; url?: string }, commit: string): Promise<void> {
  const declaration = await readRepositoryDeclaration(scope.repo, commit)
  if (declaration === undefined) throw new Error(`no ${CANDIDATE_CONFIG} at ${commit}`)
  await trustDeclaration(scope, declaration.blob)
}

async function write(path: string, content: string) {
  return store.transact(async (map) => map.set(path, content), `write ${path}`, {
    candidate: repositoryCandidate({ repo: fixture.repo }),
  })
}

describe("repositoryCandidate — the gate the repository's trusted base declares", () => {
  test("with no .gitomic.conf in the base, a write lands and reports nothing", async () => {
    const committed = await write("docs/a.md", "a\n")
    expect(committed.report).toEqual([])
    expect(await store.at(committed.oid).get("docs/a.md")).toBe("a\n")
  })

  test("a check that exits 1 refuses with its own lines, and the ref does not move", async () => {
    const check = await script("check.sh", 'echo "docs/a.md: heading missing"; echo "docs/a.md: second"; exit 1')
    await declare(`[candidate]\n\tcheck = ${check}\n`)
    const before = await store.head()

    const refused = write("docs/a.md", "a\n")
    await expect(refused).rejects.toBeInstanceOf(CandidateRefused)
    await expect(refused).rejects.toMatchObject({ reasons: ["docs/a.md: heading missing", "docs/a.md: second"] })
    expect(await store.head()).toBe(before)
  })

  test("a check that exits 0 lands the write, and its stdout lines are the report", async () => {
    const check = await script("check.sh", 'echo "pm-plan.md: 25228 closed, plan row still open"; exit 0')
    await declare(`[candidate]\n\tcheck = ${check}\n`)

    const committed = await write("docs/a.md", "a\n")
    expect(committed.report).toEqual(["pm-plan.md: 25228 closed, plan row still open"])
  })

  test("the check reads the materialized candidate and gets the changed paths on stdin, NUL-separated", async () => {
    const check = await script(
      "check.sh",
      [
        'content=$(git --git-dir="$GITOMIC_REPO" show "$GITOMIC_CANDIDATE:docs/a.md")',
        'paths=$(tr "\\0" " ")',
        'echo "saw [$content] base=${GITOMIC_BASE:+set} paths=[$paths]"',
      ].join("\n"),
    )
    await declare(`[candidate]\n\tcheck = ${check}\n`)

    const committed = await write("docs/a.md", "hello\n")
    expect(committed.report).toEqual(["saw [hello] base=set paths=[docs/a.md ]"])
  })

  test("derive adds files that land in the same commit, and the check sees them", async () => {
    const derive = await script(
      "derive.sh",
      [
        'master=$(git --git-dir="$GITOMIC_REPO" show "$GITOMIC_CANDIDATE:.claude/x.md")',
        'printf \'{"put":{".agents/x.md":"mirror: %s\\\\n"}}\' "$master"',
      ].join("\n"),
    )
    const check = await script(
      "check.sh",
      'git --git-dir="$GITOMIC_REPO" show "$GITOMIC_CANDIDATE:.agents/x.md" >/dev/null 2>&1 || { echo "mirror missing"; exit 1; }',
    )
    await declare(`[candidate]\n\tderive = ${derive}\n\tcheck = ${check}\n`)

    const committed = await write(".claude/x.md", "master")
    const landed = store.at(committed.oid)
    expect(await landed.get(".claude/x.md")).toBe("master")
    expect(await landed.get(".agents/x.md")).toBe("mirror: master\n")
  })

  test.each([
    { name: "empty output", output: "", perAttempt: 1 },
    { name: "empty edits", output: '{"put":{},"rm":[]}', perAttempt: 1 },
    { name: "put", output: '{"put":{"derived.md":"derived"}}', perAttempt: 2 },
    { name: "remove", output: '{"rm":["remove.md"]}', perAttempt: 2 },
  ])(
    "materializes once for $name derive, invalidates edits, and starts fresh after a CAS retry",
    async ({ output, perAttempt }) => {
      await store.transact(async (map) => map.set("remove.md", "remove"), "seed removal")
      const derive = await script("derive.sh", `printf '%s' '${output}'`)
      const check = await script(
        "check.sh",
        ['git --git-dir="$GITOMIC_REPO" show "$GITOMIC_CANDIDATE:rival.md" 2>/dev/null || printf absent'].join("\n"),
      )
      await declare(`[candidate]\n\tderive = ${derive}\n\tcheck = ${check}\n`)
      const rival = await open({ repo: fixture.repo, ref: "main", writer: "rival", backend: createShellBackend() })
      const gate = repositoryCandidate({ repo: fixture.repo })
      let attempts = 0
      let materializations = 0
      const committed = await store.transact(async (map) => map.set("own.md", "own"), "reuse candidate", {
        candidate: async (context) => {
          attempts++
          const verdict = await gate({
            ...context,
            materialize: async () => {
              materializations++
              return context.materialize()
            },
          })
          if (attempts === 1) await rival.transact(async (map) => map.set("rival.md", "rival"), "win the CAS")
          return verdict
        },
      })
      expect(attempts).toBe(2)
      expect(committed.retries).toBe(1)
      expect(materializations).toBe(perAttempt * attempts)
      expect(committed.report).toEqual(["rival"])
      const landed = store.at(committed.oid)
      expect(await landed.get("own.md")).toBe("own")
      expect(await landed.get("rival.md")).toBe("rival")
      expect(await landed.get("derived.md")).toBe(output.includes('"derived.md"') ? "derived" : undefined)
      expect(await landed.get("remove.md")).toBe(output.includes('"remove.md"') ? undefined : "remove")
    },
  )

  test.each([
    {
      name: "exit 1 with reasons",
      body: 'echo "docs/a.md: first"; echo "docs/a.md: second"; exit 1',
      reasons: ["docs/a.md: first", "docs/a.md: second"],
    },
    {
      name: "exit 1 without reasons",
      body: 'echo "diagnostic" >&2; exit 1',
      reasons: [expect.stringMatching(/derive .*refused without a reason: diagnostic/u)],
    },
    {
      name: "exit 2",
      body: 'echo "diagnostic" >&2; exit 2',
      reasons: [expect.stringMatching(/derive .*could not run \(exit 2\): diagnostic/u)],
    },
  ])("a derive $name refuses before the ref moves", async ({ body, reasons }) => {
    const derive = await script("derive.sh", body)
    await declare(`[candidate]\n\tderive = ${derive}\n`)
    const before = await store.head()
    await expect(write("docs/a.md", "a\n")).rejects.toMatchObject({ reasons })
    expect(await store.head()).toBe(before)
  })

  test("onStep times every step of a derive-and-check run, each command's spawn inside its run (27155)", async () => {
    const derive = await script("derive.sh", 'printf \'{"put":{"docs/derived.md":"d\\\\n"}}\'')
    const check = await script("check.sh", "exit 0")
    await declare(`[candidate]\n\tderive = ${derive}\n\tcheck = ${check}\n`)
    const steps: [string, number][] = []
    const committed = await store.transact(async (map) => map.set("docs/a.md", "a\n"), "timed write", {
      candidate: repositoryCandidate({ repo: fixture.repo, onStep: (step, ms) => steps.push([step, ms]) }),
    })
    expect(await store.at(committed.oid).get("docs/derived.md")).toBe("d\n")
    // derive edited, so check materializes the derived candidate again: two materializations.
    expect(steps.map(([step]) => step)).toEqual([
      "declaration",
      "trust",
      "declaration",
      "gitDir",
      "materialize",
      "deriveSpawn",
      "derive",
      "materialize",
      "checkSpawn",
      "check",
    ])
    for (const [step, ms] of steps) expect(Number.isFinite(ms) && ms >= 0, `${step} ${ms}`).toBe(true)
    const ms = (name: string) => steps.find(([step]) => step === name)?.[1] ?? Number.NaN
    expect(ms("deriveSpawn")).toBeLessThanOrEqual(ms("derive"))
    expect(ms("checkSpawn")).toBeLessThanOrEqual(ms("check"))
  })

  test("a check past its timeout refuses naming the check and the limit", async () => {
    const check = await script("check.sh", "sleep 30")
    await declare(`[candidate]\n\tcheck = ${check}\n\ttimeoutMs = 300\n`)
    const before = await store.head()

    const refused = write("docs/a.md", "a\n")
    await expect(refused).rejects.toMatchObject({
      reasons: [expect.stringMatching(/check .*check\.sh.* did not finish within its 300 ms limit/u)],
    })
    expect(await store.head()).toBe(before)
  })

  test("a check that cannot run refuses with its exit code and stderr, never as a pass", async () => {
    await declare(`[candidate]\n\tcheck = ${join(scripts, "absent.sh")}\n`)
    await expect(write("docs/a.md", "a\n")).rejects.toMatchObject({
      reasons: [expect.stringMatching(/check .*absent\.sh.* could not run \(exit 127\)/u)],
    })
  })

  test("a command that exits without reading its stdin resolves with its own exit code, never the closed pipe", async () => {
    // A gate may ignore the changed paths on stdin. Whether the write meets the closed pipe (EPIPE) before the exit is
    // a race, lost about half the time, so ten runs make a regression near-certain to show.
    const input = "x".repeat(200_000)
    const codes: number[] = []
    for (let run = 0; run < 10; run++) {
      codes.push((await runCommand("sh", ["-c", `exit ${run % 2}`], { input, timeoutMs: 5_000 })).code)
    }
    expect(codes).toEqual([0, 1, 0, 1, 0, 1, 0, 1, 0, 1])
  })

  test("a write that changes .gitomic.conf and anything else is refused; alone it lands", async () => {
    const check = await script("check.sh", "exit 0")
    await declare(`[candidate]\n\tcheck = ${check}\n`)
    const candidate = repositoryCandidate({ repo: fixture.repo })

    const smuggled = store.transact(
      async (map) => {
        map.set(CANDIDATE_CONFIG, `[candidate]\n\tcheck = true\n`)
        map.set("docs/a.md", "a\n")
      },
      "a gate change inside a content write",
      { candidate },
    )
    await expect(smuggled).rejects.toMatchObject({
      reasons: [
        `${CANDIDATE_CONFIG}: a write that changes the gate must change nothing else; this one changes 2 paths`,
      ],
    })

    const alone = await store.transact(
      async (map) => map.set(CANDIDATE_CONFIG, `[candidate]\n\tcheck = true\n`),
      "loosen",
      {
        candidate,
      },
    )
    expect(await store.at(alone.oid).get(CANDIDATE_CONFIG)).toBe(`[candidate]\n\tcheck = true\n`)
  })

  test("the gate is read from the BASE: a gate edit applies from the next write, never to itself", async () => {
    const refusing = await script("refuse.sh", 'echo "refused by the old gate"; exit 1')
    await declare(`[candidate]\n\tcheck = ${refusing}\n`)
    const candidate = repositoryCandidate({ repo: fixture.repo })

    // The gate edit itself is judged by the OLD gate, which refuses it.
    await expect(
      store.transact(async (map) => map.set(CANDIDATE_CONFIG, `[candidate]\n\tcheck = true\n`), "loosen", {
        candidate,
      }),
    ).rejects.toMatchObject({ reasons: ["refused by the old gate"] })
  })

  test("an unknown key in [candidate] refuses loudly instead of being ignored", async () => {
    await declare(`[candidate]\n\tchek = true\n`)
    await expect(write("docs/a.md", "a\n")).rejects.toMatchObject({
      reasons: [expect.stringMatching(/\.gitomic\.conf: unknown key candidate\.chek/u)],
    })
  })
})

/**
 * 27155 (iii), @cto 67b6d4c1 item 2: a caller may run a declared command in its own process. gitomic still reads and
 * trusts the declaration itself and hands the caller the exact declared command; only a command the caller claims runs
 * in process, with the inputs a spawned command gets, and every other command runs as declared.
 */
describe("repositoryCandidate — a declared command the caller runs in process (27155)", () => {
  /** A declared check that leaves a marker, so a row can tell whether it was spawned. */
  async function markingCheck(exit: number): Promise<{ readonly command: string; readonly marker: string }> {
    const marker = join(scripts, "check-ran")
    return { command: await script("check.sh", `: > "${marker}"\necho "declared said ${exit}"\nexit ${exit}`), marker }
  }

  function writeWith(inProcess: InProcessOptions, path = "docs/a.md", content = "a\n") {
    return store.transact(async (map) => map.set(path, content), `write ${path}`, {
      candidate: repositoryCandidate({ repo: fixture.repo, inProcess }),
    })
  }

  test("use: a claimed check runs in process and decides; the declared command is never spawned", async () => {
    const check = await markingCheck(1)
    await declare(`[candidate]\n\tcheck = ${check.command}\n`)
    const asked: [string, string][] = []
    const committed = await writeWith({
      mode: "use",
      resolve: (kind, command) => {
        asked.push([kind, command])
        return command === check.command
          ? async () => ({ code: 0, stdout: "in process said ok\n", stderr: "" })
          : undefined
      },
    })
    expect(committed.report).toEqual(["in process said ok"])
    expect(asked, "the resolver is handed the exact declared command").toEqual([["check", check.command]])
    expect(existsSync(check.marker), "the declared check was not spawned").toBe(false)
  })

  test("shadow: a resolver that rejects leaves the verdict and the ref to the declared command, and compare is told", async () => {
    const check = await markingCheck(0)
    await declare(`[candidate]\n\tcheck = ${check.command}\n`)
    const seen: (CandidateRun | { error: string })[] = []
    const committed = await writeWith({
      mode: "shadow",
      resolve: async () => {
        throw new Error("candidate read failed")
      },
      compare: (_kind, _command, { inProcess }) => seen.push(inProcess),
    })
    expect(committed.report, "the declared check decided").toEqual(["declared said 0"])
    expect(existsSync(check.marker), "the declared check ran").toBe(true)
    expect(await store.head()).toBe(committed.oid)
    expect(seen).toEqual([{ error: "resolve: candidate read failed" }])
  })

  test("use: a resolver that rejects fails the write naming its kind and command, and the ref does not move", async () => {
    const check = await markingCheck(0)
    await declare(`[candidate]\n\tcheck = ${check.command}\n`)
    const before = await store.head()
    const thrown = new Error("candidate read failed")
    const failed = writeWith({
      mode: "use",
      resolve: async () => {
        throw thrown
      },
    })
    await expect(failed).rejects.toThrow(`check \`${check.command}\` failed in process: resolve: candidate read failed`)
    await expect(failed).rejects.toMatchObject({ cause: thrown })
    expect(existsSync(check.marker), "nothing was spawned").toBe(false)
    expect(await store.head()).toBe(before)
  })

  test("use: a resolver that answers with a promise is awaited, and its command decides", async () => {
    const check = await markingCheck(1)
    await declare(`[candidate]\n\tcheck = ${check.command}\n`)
    const committed = await writeWith({
      mode: "use",
      resolve: async (_kind, _command, context) => {
        const content = await context.map.get("docs/a.md")
        return content === "a\n"
          ? async () => ({ code: 0, stdout: "read the candidate first\n", stderr: "" })
          : undefined
      },
    })
    expect(committed.report).toEqual(["read the candidate first"])
    expect(existsSync(check.marker), "the declared check was not spawned").toBe(false)
  })

  test("a command the resolver does not claim runs as declared", async () => {
    const check = await markingCheck(0)
    await declare(`[candidate]\n\tcheck = ${check.command}\n`)
    const committed = await writeWith({ mode: "use", resolve: () => undefined })
    expect(committed.report).toEqual(["declared said 0"])
    expect(existsSync(check.marker)).toBe(true)
  })

  test("the in-process command gets the spawned command's inputs: git dir, base, candidate and changed paths", async () => {
    const check = await script(
      "check.sh",
      'paths=$(tr "\\0" " ")\necho "$GITOMIC_REPO|$GITOMIC_BASE|$GITOMIC_CANDIDATE|$paths"',
    )
    await declare(`[candidate]\n\tcheck = ${check}\n`)
    const runs: { declared: CandidateRun; inProcess: CandidateRun | { error: string } }[] = []
    const echo: InProcessCommand = async (input) => ({
      code: 0,
      stdout: `${input.gitDir}|${input.base}|${input.candidate}|${input.changed.map((path) => `${path} `).join("")}\n`,
      stderr: "",
    })
    await writeWith(
      { mode: "shadow", resolve: () => echo, compare: (_kind, _command, both) => runs.push(both) },
      "docs/b.md",
    )
    expect(runs).toHaveLength(1)
    const [{ declared, inProcess }] = runs as [(typeof runs)[number]]
    expect("code" in declared && declared.code).toBe(0)
    expect(inProcess, "the same four inputs, byte for byte").toEqual(declared)
  })

  test("shadow: the declared command decides, and compare sees both runs", async () => {
    const check = await markingCheck(1)
    await declare(`[candidate]\n\tcheck = ${check.command}\n`)
    const compared: [string, CandidateRun, CandidateRun | { error: string }][] = []
    const before = await store.head()
    const refused = writeWith({
      mode: "shadow",
      resolve: () => async () => ({ code: 0, stdout: "in process said ok\n", stderr: "" }),
      compare: (kind, _command, { declared, inProcess }) => compared.push([kind, declared, inProcess]),
    })
    await expect(refused).rejects.toMatchObject({ reasons: ["declared said 1"] })
    expect(await store.head()).toBe(before)
    expect(existsSync(check.marker)).toBe(true)
    expect(compared).toEqual([
      [
        "check",
        { code: 1, stdout: "declared said 1\n", stderr: "" },
        { code: 0, stdout: "in process said ok\n", stderr: "" },
      ],
    ])
  })

  test("shadow: an in-process command that throws is reported to compare, and the declared verdict stands", async () => {
    const check = await markingCheck(0)
    await declare(`[candidate]\n\tcheck = ${check.command}\n`)
    const seen: (CandidateRun | { error: string })[] = []
    const committed = await writeWith({
      mode: "shadow",
      resolve: () => async () => {
        throw new Error("checker module failed")
      },
      compare: (_kind, _command, { inProcess }) => seen.push(inProcess),
    })
    expect(committed.report).toEqual(["declared said 0"])
    expect(seen).toEqual([{ error: "checker module failed" }])
  })

  test("use: an in-process command that throws fails the write naming its kind and command, and the ref does not move", async () => {
    const check = await markingCheck(0)
    await declare(`[candidate]\n\tcheck = ${check.command}\n`)
    const before = await store.head()
    const thrown = new Error("checker module failed")
    const failed = writeWith({
      mode: "use",
      resolve: () => async () => {
        throw thrown
      },
    })
    await expect(failed).rejects.toThrow(`check \`${check.command}\` failed in process: checker module failed`)
    await expect(failed).rejects.toMatchObject({ cause: thrown })
    expect(await store.head()).toBe(before)
  })

  test("use: an in-process command that answers { declared } runs the declared command, whose verdict decides", async () => {
    const check = await markingCheck(1)
    await declare(`[candidate]\n\tcheck = ${check.command}\n`)
    const before = await store.head()
    const refused = writeWith({ mode: "use", resolve: () => async () => ({ declared: "worker crashed" }) })
    await expect(refused).rejects.toMatchObject({ reasons: ["declared said 1"] })
    expect(existsSync(check.marker), "the declared check was spawned").toBe(true)
    expect(await store.head()).toBe(before)
  })

  test("shadow: an in-process command that answers { declared } leaves the declared verdict, and compare is not told", async () => {
    const check = await markingCheck(0)
    await declare(`[candidate]\n\tcheck = ${check.command}\n`)
    const compared: unknown[] = []
    const committed = await writeWith({
      mode: "shadow",
      resolve: () => async () => ({ declared: "worker hung" }),
      compare: (_kind, _command, runs) => void compared.push(runs),
    })
    expect(committed.report).toEqual(["declared said 0"])
    expect(compared, "no in-process run to compare").toEqual([])
  })

  test("use: an in-process command past the declared timeout refuses naming the check and the limit", async () => {
    const check = await markingCheck(0)
    await declare(`[candidate]\n\tcheck = ${check.command}\n\ttimeoutMs = 300\n`)
    const refused = writeWith({ mode: "use", resolve: () => () => new Promise(() => {}) })
    await expect(refused).rejects.toMatchObject({
      reasons: [expect.stringMatching(/check .*check\.sh.* did not finish within its 300 ms limit/u)],
    })
  })

  test("use: an in-process command that finishes past the limit is a timeout, never a pass, and the ref does not move", async () => {
    const check = await markingCheck(0)
    await declare(`[candidate]\n\tcheck = ${check.command}\n\ttimeoutMs = 10\n`)
    const before = await store.head()
    // Synchronous work holds the thread, so the limit's timer cannot fire before the result is in (@dev/review2 REVISE).
    const refused = writeWith({
      mode: "use",
      resolve: () => async () => {
        const end = performance.now() + 60
        while (performance.now() < end) {
          // busy: a synchronous checker over its limit
        }
        return { code: 0, stdout: "late but fine\n", stderr: "" }
      },
    })
    await expect(refused).rejects.toMatchObject({
      reasons: [expect.stringMatching(/check .*check\.sh.* did not finish within its 10 ms limit/u)],
    })
    expect(await store.head()).toBe(before)
  })

  test("use: a claimed derive runs in process and its edits land in the same commit", async () => {
    const derive = await script("derive.sh", "exit 7")
    const check = await script("check.sh", 'git --git-dir="$GITOMIC_REPO" show "$GITOMIC_CANDIDATE:docs/derived.md"')
    await declare(`[candidate]\n\tderive = ${derive}\n\tcheck = ${check}\n`)
    const committed = await writeWith({
      mode: "use",
      resolve: (kind) =>
        kind === "derive"
          ? async () => ({ code: 0, stdout: '{"put":{"docs/derived.md":"d\\n"}}', stderr: "" })
          : undefined,
    })
    expect(await store.at(committed.oid).get("docs/derived.md")).toBe("d\n")
    expect(committed.report, "the declared check read the derived candidate").toEqual(["d"])
  })

  test("onStep times a shadowed command's in-process run as its own step", async () => {
    const check = await markingCheck(0)
    await declare(`[candidate]\n\tcheck = ${check.command}\n`)
    const steps: string[] = []
    await store.transact(async (map) => map.set("docs/a.md", "a\n"), "timed shadow write", {
      candidate: repositoryCandidate({
        repo: fixture.repo,
        onStep: (step) => steps.push(step),
        inProcess: { mode: "shadow", resolve: () => async () => ({ code: 0, stdout: "", stderr: "" }) },
      }),
    })
    expect(steps).toEqual([
      "declaration",
      "trust",
      "declaration",
      "gitDir",
      "materialize",
      "checkSpawn",
      "check",
      "checkInProcess",
    ])
  })
})

describe("readCandidateCommands — what a write at a base would run, read and trusted as the gate reads it (27155)", () => {
  test("a trusted declaration's derive and check, and nothing for a base that declares none", async () => {
    const empty = await store.transact(async (map) => map.set("docs/a.md", "a\n"), "no gate yet")
    expect(await readCandidateCommands({ repo: fixture.repo }, empty.oid)).toEqual({})
    await declare("[candidate]\n\tderive = derive-it --flag\n\tcheck = check-it --state-root /x\n")
    expect(await readCandidateCommands({ repo: fixture.repo }, await store.head())).toEqual({
      derive: "derive-it --flag",
      check: "check-it --state-root /x",
    })
  })

  test("an untrusted declaration returns the refusal a write would get, naming gitomic trust", async () => {
    const declared = await store.transact(
      async (map) => map.set(CANDIDATE_CONFIG, "[candidate]\n\tcheck = never-trusted\n"),
      "declare without trusting",
    )
    const read = await readCandidateCommands({ repo: fixture.repo }, declared.oid)
    expect(read).toEqual({ refuse: [expect.stringMatching(/is not trusted to run .*run: gitomic trust '/u)] })
  })

  test("a base whose declaration refuses gets the same refusal from the reader and from a write", async () => {
    // One sequence reads and trusts the declaration for both (@cto 15e1c1ac): an untrusted one, then a bad key.
    const untrusted = await store.transact(
      async (map) => map.set(CANDIDATE_CONFIG, "[candidate]\n\tcheck = never-trusted\n"),
      "declare without trusting",
    )
    // Each case reads the reader at the head a write builds on, then makes that write.
    async function sameRefusal(label: string, base: string): Promise<void> {
      const read = await readCandidateCommands({ repo: fixture.repo }, base)
      if (!("refuse" in read)) throw new Error(`${label}: the reader did not refuse`)
      const written = await write("docs/a.md", `${label}\n`).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(written, label).toBeInstanceOf(CandidateRefused)
      expect((written as CandidateRefused).reasons, label).toEqual(read.refuse)
    }
    await sameRefusal("untrusted", untrusted.oid)
    await declare("[candidate]\n\tcheck = check-it\n\tchek = typo\n")
    await sameRefusal("a bad key", await store.head())
  })

  test("an unknown key refuses as the gate refuses it", async () => {
    await declare("[candidate]\n\tcheck = check-it\n\tchek = typo\n")
    expect(await readCandidateCommands({ repo: fixture.repo }, await store.head())).toEqual({
      refuse: [expect.stringContaining("unknown key candidate.chek")],
    })
  })
})
