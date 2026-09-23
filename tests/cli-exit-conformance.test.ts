// @failure A stale write or a gate refusal could exit with a code that also means something else, print a receipt, or
// move the ref on one backend or address kind while the others refuse cleanly — so a seat scripting the door would
// read a refusal as a landing (or the reverse) depending on where the repository lives.
// @level l2
// @consumer 24168 slice A: STATE writers branch on exit 3 (re-read and retry) versus 4 (fix the content), through a
// remote address as well as a local one; A3's projector reads the same table

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { main } from "../src/bin.js"
import { CANDIDATE_CONFIG, createShellBackend, open, type GitomicBackend } from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import { createBareRepo, git, gitWithInput } from "./helpers/git.js"

type Target = {
  readonly name: string
  /** The backend the CLI is handed; `undefined` runs the real address path (a URL opens a remote). */
  readonly backend: GitomicBackend | undefined
  readonly address: (repo: string) => string
}

const targets: readonly Target[] = [
  { name: "a local path on shell", backend: createShellBackend(), address: (repo) => `${repo}#main` },
  { name: "a local path on iso", backend: createIsoBackend(), address: (repo) => `${repo}#main` },
  { name: "a file URL (remote)", backend: undefined, address: (repo) => `${pathToFileURL(repo).href}#main` },
]

let work: string
let fixture: { repo: string; cleanup(): Promise<void> }

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "gitomic-exit-conformance-"))
  fixture = await createBareRepo()
})

afterEach(async () => {
  await fixture.cleanup()
  await rm(work, { recursive: true, force: true })
})

async function file(name: string, content: string): Promise<string> {
  const path = join(work, name)
  await writeFile(path, content, "utf8")
  return path
}

async function cli(target: Target, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = []
  const err: string[] = []
  async function* emptyStdin(): AsyncGenerator<string> {}
  const code = await main(args, {
    ...(target.backend === undefined ? {} : { backend: target.backend }),
    stdin: emptyStdin(),
    stdout: { write: (chunk: string) => void out.push(chunk) },
    stderr: { write: (chunk: string) => void err.push(chunk) },
  })
  return { code, stdout: out.join(""), stderr: err.join("") }
}

const tip = async () => ({
  ref: await git(fixture.repo, "rev-parse", "main"),
  tree: await git(fixture.repo, "rev-parse", "main^{tree}"),
})

describe.each(targets)("the CLI exit contract on $name", (target) => {
  test("a stale --expect exits 3 with facts only, prints no receipt, and leaves the ref and tree unchanged", async () => {
    const address = target.address(fixture.repo)
    const seeded = await cli(target, ["write", address, "-m", "seed", `a.md=${await file("one.md", "one\n")}`])
    expect(seeded.code).toBe(0)
    const original = await gitWithInput(fixture.repo, "one\n", "hash-object", "--stdin")
    const replaced = await cli(target, [
      "write",
      address,
      "-m",
      "fresh edit",
      "--expect",
      `a.md=${original}`,
      `a.md=${await file("two.md", "two\n")}`,
    ])
    expect(replaced.code).toBe(0)
    const before = await tip()

    // The witness: this edit was authored against the ORIGINAL blob, which the fresh edit replaced.
    const stale = await cli(target, [
      "write",
      address,
      "-m",
      "stale edit",
      "--expect",
      `a.md=${original}`,
      `a.md=${await file("three.md", "three\n")}`,
    ])
    expect(stale.code).toBe(3)
    expect(stale.stdout).toBe("")
    expect(stale.stderr).toContain("kind=put")
    expect(stale.stderr).toContain(`expected=${original}`)
    expect(await tip()).toEqual(before)
    expect(await git(fixture.repo, "show", "main:a.md")).toBe("two")
  })

  test("a gate refusal through apply exits 4 with the machine line, prints no receipt, and the ref does not move", async () => {
    const check = join(work, "check.sh")
    await writeFile(check, '#!/bin/sh\necho "a.md: refused by the gate"\nexit 1\n', "utf8")
    await chmod(check, 0o755)
    const declarer = await open({ repo: fixture.repo, ref: "main", writer: "declare", backend: createShellBackend() })
    await declarer.transact(async (map) => map.set(CANDIDATE_CONFIG, `[candidate]\n\tcheck = ${check}\n`), "gate")
    const before = await tip()

    const refused = await cli(target, [
      "apply",
      target.address(fixture.repo),
      "-m",
      "refused",
      "put",
      "a.md",
      await file("a.md", "a\n"),
    ])
    expect(refused.code).toBe(4)
    expect(refused.stdout).toBe("")
    expect(refused.stderr).toContain(`code=candidate-refused base=${before.ref} reasons=["a.md: refused by the gate"]`)
    expect(await tip()).toEqual(before)
  })
})
