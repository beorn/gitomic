// @failure A repository's declared gate could be skipped, read from the write it is judging (so a write disables its own
// gate), smuggled inside a content write, hang a writer forever, or judge a tree without the files its derive step adds.
// @level l2
// @consumer 24168 slice A: STATE declares `.gitomic.conf` and every prose/config write runs it; km's writes use it too

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { CandidateRefused } from "../src/errors.js"
import { CANDIDATE_CONFIG, createShellBackend, open, repositoryCandidate, type Store } from "../src/index.js"
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

/** Declare the gate in its own write, the bootstrap commit that runs no gate because its base has none. */
async function declare(config: string): Promise<void> {
  await store.transact(async (map) => map.set(CANDIDATE_CONFIG, config), "declare the gate")
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
