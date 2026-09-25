// @failure A write addressed to a checkout of a repository that publishes through a remote lands on the checkout's
// local ref and pushes nothing, so the checkout strands a commit origin never sees (hh, 2026-09-25: `gitomic apply
// /hh#main` held every km write for 17 minutes), or the guard refuses a write it has no reason to.
// @level l2
// @consumer hh STATE writes (/commit's `gitomic apply <origin>#main`); @cto c3fa1f60
// @testonly none: a real bare origin and a real non-bare clone of it, written through the real CLI entry.

import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { main } from "../src/bin.js"
import {
  CANDIDATE_CONFIG,
  createShellBackend,
  open,
  projectRemoteFirstFastForward,
  readRepositoryDeclaration,
  trustDeclaration,
  type GitomicBackend,
} from "../src/index.js"
import { createBareRepo, git, gitFrom } from "./helpers/git.js"

const execFileAsync = promisify(execFile)

function capture(): { write(chunk: string): void; text(): string } {
  const chunks: string[] = []
  return { write: (chunk: string) => void chunks.push(chunk), text: () => chunks.join("") }
}

async function run(
  backend: GitomicBackend | undefined,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = capture()
  const stderr = capture()
  async function* emptyStdin(): AsyncGenerator<string> {}
  const code = await main(args, { ...(backend === undefined ? {} : { backend }), stdin: emptyStdin(), stdout, stderr })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

const backend = createShellBackend()
const PUBLISH = "[publish]\n\tremote = origin\n"

let work: string
let origin: { repo: string; cleanup(): Promise<void> }

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "gitomic-cli-publish-"))
  origin = await createBareRepo()
})

afterEach(async () => {
  await origin.cleanup()
  await rm(work, { recursive: true, force: true })
})

async function file(name: string, content: string): Promise<string> {
  const path = join(work, name)
  await writeFile(path, content, "utf8")
  return path
}

/** Land `.gitomic.conf` at origin's main and trust it there, as the bootstrap does. */
async function declareAtOrigin(content: string): Promise<string> {
  const store = await open({ repo: origin.repo, ref: "main", writer: "fixture", backend })
  const declared = await store.transact(async (map) => map.set(CANDIDATE_CONFIG, content), "declare")
  await trustIn(origin.repo, declared.oid)
  return declared.oid
}

async function trustIn(repo: string, commit: string): Promise<void> {
  const declaration = await readRepositoryDeclaration(repo, commit)
  if (declaration === undefined) throw new Error(`no ${CANDIDATE_CONFIG} at ${commit}`)
  await trustDeclaration({ repo }, declaration.blob)
}

/** A non-bare clone of origin, the shape of /hh: a checkout whose main is a projection of origin's. */
async function cloneCheckout(): Promise<string> {
  const checkout = join(work, "checkout")
  await execFileAsync("git", ["clone", "--quiet", origin.repo, checkout])
  return checkout
}

const tip = (repo: string, ref = "main") => gitFrom(repo, "rev-parse", `refs/heads/${ref}`)

describe("a repository that declares [publish] refuses a write addressed to its checkout", () => {
  test("apply to <checkout>#main exits 2 naming /commit's one form, and neither the checkout nor origin moves", async () => {
    const declared = await declareAtOrigin(PUBLISH)
    const checkout = await cloneCheckout()
    await trustIn(checkout, declared)

    const result = await run(backend, ["apply", `${checkout}#main`, "-m", "x", "put", "a.md", await file("a", "a\n")])

    expect(result.code).toBe(2)
    expect(result.stderr).toContain(
      `${checkout} publishes through remote 'origin' (${CANDIDATE_CONFIG} [publish] at base ${declared}), so a write ` +
        "addressed to the checkout would land on its local main and push nothing. Write to the remote instead: " +
        `gitomic apply '${origin.repo}#main' --base <oid> --writer '@seat' -m <message> put <path> <file>`,
    )
    expect(await tip(checkout)).toBe(declared)
    expect(await git(origin.repo, "rev-parse", "refs/heads/main")).toBe(declared)
  })

  test("every write verb refuses the same way", async () => {
    const declared = await declareAtOrigin(PUBLISH)
    const checkout = await cloneCheckout()
    await trustIn(checkout, declared)
    const path = await file("a", "a\n")

    for (const args of [
      ["write", `${checkout}#main`, "-m", "x", `a.md=${path}`],
      ["rm", `${checkout}#main`, "-m", "x", CANDIDATE_CONFIG],
      ["mv", `${checkout}#main`, "-m", "x", CANDIDATE_CONFIG, "moved.conf"],
    ]) {
      const result = await run(backend, args)
      expect(result.code, args[0]).toBe(2)
      expect(result.stderr, args[0]).toContain("publishes through remote 'origin'")
    }
    expect(await tip(checkout)).toBe(declared)
  })

  test("a file:// address to the checkout is the checkout, and refuses the same way", async () => {
    const declared = await declareAtOrigin(PUBLISH)
    const checkout = await cloneCheckout()
    await trustIn(checkout, declared)

    const url = pathToFileURL(checkout).href
    const result = await run(undefined, ["apply", `${url}#main`, "-m", "x", "put", "a.md", await file("a", "a\n")])

    expect(result.code).toBe(2)
    expect(result.stderr).toContain(`${checkout} publishes through remote 'origin'`)
    expect(await tip(checkout)).toBe(declared)
  })

  test("a declared remote the checkout does not configure is said instead of an address", async () => {
    const declared = await declareAtOrigin(PUBLISH)
    const checkout = await cloneCheckout()
    await trustIn(checkout, declared)
    await gitFrom(checkout, "remote", "remove", "origin")

    const result = await run(backend, ["apply", `${checkout}#main`, "-m", "x", "put", "a.md", await file("a", "a\n")])

    expect(result.code).toBe(2)
    expect(result.stderr).toContain(
      `${checkout} publishes through remote 'origin' (${CANDIDATE_CONFIG} [publish] at base ${declared}), but ` +
        `remote.origin.url is not set in ${checkout}, so there is no address to name`,
    )
    expect(await tip(checkout)).toBe(declared)
  })
})

describe("what [publish] does not refuse", () => {
  test("the remote itself: apply to origin lands, and the checkout projects to it", async () => {
    const declared = await declareAtOrigin(PUBLISH)
    const checkout = await cloneCheckout()
    await trustIn(checkout, declared)

    const result = await run(backend, [
      "apply",
      `${origin.repo}#main`,
      "-m",
      "x",
      "put",
      "a.md",
      await file("a", "a\n"),
    ])

    expect(result.code, result.stderr).toBe(0)
    const landed = result.stdout.trim()
    expect(await git(origin.repo, "rev-parse", "refs/heads/main")).toBe(landed)
    // The library projection, which takes no lock: the `project` verb needs Bun's flock, and this suite runs anywhere.
    const projected = await projectRemoteFirstFastForward({
      repoRoot: checkout,
      to: landed,
      ref: "refs/heads/main",
      remote: "origin",
      expectedDirtyPaths: [],
    })
    expect(projected.ok, JSON.stringify(projected)).toBe(true)
    expect(await tip(checkout)).toBe(landed)
  })

  test("a checkout whose base declares no [publish] writes locally, as before", async () => {
    const declared = await declareAtOrigin("[candidate]\n")
    const checkout = await cloneCheckout()
    await trustIn(checkout, declared)

    const result = await run(backend, ["apply", `${checkout}#main`, "-m", "x", "put", "a.md", await file("a", "a\n")])

    expect(result.code, result.stderr).toBe(0)
    expect(await tip(checkout)).toBe(result.stdout.trim())
  })

  test("a branch [publish] does not declare is not refused", async () => {
    const declared = await declareAtOrigin(PUBLISH)
    const checkout = await cloneCheckout()
    await trustIn(checkout, declared)
    await gitFrom(checkout, "branch", "scratch", "main")

    const result = await run(backend, [
      "apply",
      `${checkout}#scratch`,
      "-m",
      "x",
      "put",
      "a.md",
      await file("a", "a\n"),
    ])

    expect(result.code, result.stderr).toBe(0)
    expect(await tip(checkout, "scratch")).toBe(result.stdout.trim())
  })

  // The declaration reaches a checkout through the sync, the documented order: until then its base has none.
  test("a [publish] at origin that the write's base does not carry yet is not refused", async () => {
    const checkout = await cloneCheckout()
    await declareAtOrigin(PUBLISH)

    const result = await run(backend, ["apply", `${checkout}#main`, "-m", "x", "put", "a.md", await file("a", "a\n")])

    expect(result.code, result.stderr).toBe(0)
    expect(await tip(checkout)).toBe(result.stdout.trim())
  })
})
