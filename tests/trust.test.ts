// @failure A repository's declared commands ran on the first write with no opt-in, so a hostile repository's gate ran
// on whoever wrote to it; or a trusted declaration kept running after an edit nobody reviewed; or a URL write could
// never be trusted because its clone keeps no config; or a read verb demanded trust.
// @level l2
// @consumer 25325: STATE's gate runs only once its declaration is trusted, before 24168 A4 hands gitomic to the fleet
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { main } from "../src/bin.js"
import { CANDIDATE_CONFIG, createShellBackend, open, TRUST_CONFIG, type GitomicBackend } from "../src/index.js"
import { createBareRepo, git } from "./helpers/git.js"

function capture(): { write(chunk: string): void; text(): string } {
  const chunks: string[] = []
  return { write: (chunk: string) => void chunks.push(chunk), text: () => chunks.join("") }
}

/** One CLI run. `backend` undefined takes the real address path, where a URL opens a throwaway clone. */
async function run(
  args: string[],
  backend?: GitomicBackend,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = capture()
  const stderr = capture()
  async function* emptyStdin(): AsyncGenerator<string> {}
  const code = await main(args, { ...(backend === undefined ? {} : { backend }), stdin: emptyStdin(), stdout, stderr })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

let work: string
let fixture: { repo: string; cleanup(): Promise<void> }
let ran: string
const shell = createShellBackend()

beforeEach(async () => {
  // A runner carrying GITOMIC_CACHE_DIR (hh's timers do) must not move URL rows onto its kept copy (hh 25615).
  vi.stubEnv("GITOMIC_CACHE_DIR", "")
  work = await mkdtemp(join(tmpdir(), "gitomic-trust-"))
  fixture = await createBareRepo()
  ran = join(work, "check-ran")
  // A URL address's trust lives in the caller's global git config: a scratch file, never the real one.
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(work, "global-gitconfig"))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await fixture.cleanup()
  await rm(work, { recursive: true, force: true })
})

async function file(name: string, content: string, mode?: number): Promise<string> {
  const path = join(work, name)
  await writeFile(path, content, "utf8")
  if (mode !== undefined) await chmod(path, mode)
  return path
}

/** Declare a check that leaves a marker when it runs, in the gate's own write; returns the declaration's blob. */
async function declare(checkBody = "exit 0"): Promise<string> {
  const check = await file("check.sh", `#!/bin/sh\ntouch ${ran}\n${checkBody}\n`, 0o755)
  const store = await open({ repo: fixture.repo, ref: "main", writer: "fixture", backend: shell })
  await store.transact(async (map) => map.set(CANDIDATE_CONFIG, `[candidate]\n\tcheck = ${check}\n`), "gate")
  return git(fixture.repo, "rev-parse", `main:${CANDIDATE_CONFIG}`)
}

async function checkRan(): Promise<boolean> {
  return access(ran).then(
    () => true,
    () => false,
  )
}

const path = () => `${fixture.repo}#main`
const url = () => `${pathToFileURL(fixture.repo).href}#main`
const localTrust = async () =>
  (await git(fixture.repo, "config", "--local", "--get-all", TRUST_CONFIG).catch(() => "")).trim()

describe("gitomic trust — a repository's declared commands run only once their exact blob is trusted (25325)", () => {
  test("an untrusted declaration refuses a write with exit 4, runs nothing, and names its blob and the command", async () => {
    const blob = await declare()
    const before = await git(fixture.repo, "rev-parse", "main")

    const result = await run(["write", path(), "-m", "untrusted", `a.md=${await file("a.md", "a\n")}`], shell)
    expect(result.code).toBe(4)
    expect(result.stderr).toContain(`${CANDIDATE_CONFIG} ${blob} at ${before} is not trusted to run`)
    expect(result.stderr).toContain(`${TRUST_CONFIG} is unset`)
    expect(result.stderr).toContain(`run: gitomic trust '${path()}'`)
    expect(result.stderr).toMatch(/^code=candidate-refused base=[0-9a-f]{40} reasons=\[/mu)
    expect(await checkRan()).toBe(false)
    expect(await git(fixture.repo, "rev-parse", "main")).toBe(before)
  })

  test("`gitomic trust` prints the declared commands, then records the blob; the write then runs the gate", async () => {
    const blob = await declare()
    const trusted = await run(["trust", path()], shell)
    expect(trusted.code).toBe(0)
    expect(trusted.stdout).toContain(`${CANDIDATE_CONFIG} ${blob} at`)
    expect(trusted.stdout).toContain(`  candidate.check=${join(work, "check.sh")}`)
    expect(trusted.stdout.indexOf("candidate.check")).toBeLessThan(trusted.stdout.indexOf("trusted:"))
    expect(trusted.stdout).toContain(`trusted: ${TRUST_CONFIG} = ${blob} (local git config)`)
    expect(await localTrust()).toBe(blob)

    const landed = await run(["write", path(), "-m", "trusted", `a.md=${await file("a.md", "a\n")}`], shell)
    expect(landed.code).toBe(0)
    expect(await checkRan()).toBe(true)
  })

  test("a later edit of the declaration is a new blob, refused until it is trusted again", async () => {
    const first = await declare()
    await run(["trust", path()], shell)
    // The edit stands alone, and the trusted first declaration judges it, so it lands.
    const edited = await file("edited.conf", `[candidate]\n\tcheck = ${join(work, "check.sh")}\n\ttimeoutMs = 5000\n`)
    expect((await run(["write", path(), "-m", "edit the gate", `${CANDIDATE_CONFIG}=${edited}`], shell)).code).toBe(0)
    const second = await git(fixture.repo, "rev-parse", `main:${CANDIDATE_CONFIG}`)
    expect(second).not.toBe(first)
    await rm(ran, { force: true })

    const refused = await run(["write", path(), "-m", "after the edit", `a.md=${await file("a.md", "a\n")}`], shell)
    expect(refused.code).toBe(4)
    expect(refused.stderr).toContain(`${CANDIDATE_CONFIG} ${second} at`)
    expect(refused.stderr).toContain(`${TRUST_CONFIG} is ${first}`)
    expect(await checkRan()).toBe(false)

    expect((await run(["trust", path()], shell)).code).toBe(0)
    expect(await localTrust()).toBe(second)
    expect((await run(["write", path(), "-m", "retrusted", `a.md=${await file("a.md", "a\n")}`], shell)).code).toBe(0)
    expect(await checkRan()).toBe(true)
  })

  test("read verbs never need trust", async () => {
    await declare()
    const store = await open({ repo: fixture.repo, ref: "main", writer: "fixture", backend: shell })
    await store.transact(async (map) => map.set("docs/a.md", "a\n"), "content under the gate's base")

    expect(await run(["read", path(), "docs/a.md"], shell)).toMatchObject({ code: 0, stdout: "a\n" })
    expect((await run(["ls", path()], shell)).code).toBe(0)
    expect((await run(["log", path()], shell)).code).toBe(0)
    expect((await run(["grep", path(), "a"], shell)).code).toBe(0)
    expect(await checkRan()).toBe(false)
    expect(await localTrust()).toBe("")
  })

  test("a URL address keeps its trust in the caller's global config, keyed by the URL; the path scope is separate", async () => {
    const blob = await declare()
    const address = url()
    const refused = await run(["write", address, "-m", "untrusted", `a.md=${await file("a.md", "a\n")}`])
    expect(refused.code).toBe(4)
    expect(refused.stderr).toContain(`run: gitomic trust '${address}'`)
    expect(await checkRan()).toBe(false)

    const trusted = await run(["trust", address])
    expect(trusted.code).toBe(0)
    const key = `gitomic.${pathToFileURL(fixture.repo).href}.trust`
    expect(trusted.stdout).toContain(`trusted: ${key} = ${blob} (global git config)`)
    expect(await git(fixture.repo, "config", "--file", join(work, "global-gitconfig"), "--get", key)).toBe(blob)
    expect(await localTrust()).toBe("")

    expect((await run(["write", address, "-m", "trusted", `a.md=${await file("a.md", "a\n")}`])).code).toBe(0)
    expect(await checkRan()).toBe(true)
    // The same repository addressed by path has its own, unset scope.
    const byPath = await run(["write", path(), "-m", "by path", `b.md=${await file("b.md", "b\n")}`], shell)
    expect(byPath.code).toBe(4)
    expect(byPath.stderr).toContain(`run: gitomic trust '${path()}'`)
  })

  test("`gitomic trust` on an address that declares nothing exits 1 and records nothing", async () => {
    const result = await run(["trust", path()], shell)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`declares no ${CANDIDATE_CONFIG} at`)
    expect(result.stderr).toContain("nothing to trust")
    expect(await localTrust()).toBe("")
  })
})
