// @failure The projector could falsely report current over stale files, lose uncommitted dirt, fail to report a stranded local commit with exit 4, or tear on a concurrent ref advance.
// @level l1
// @consumer gitomic project and apply --checkout callers, including state-checkout-sync and km create

import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { main } from "../src/bin.js"
import {
  projectCheckout,
  projectRemoteFirstFastForward,
  synchronizeCheckoutToCommit,
  worktreeDirtyPaths,
} from "../src/index.js"

const roots: string[] = []

beforeEach(() => {
  vi.stubEnv("GIT_AUTHOR_NAME", "CLI Test")
  vi.stubEnv("GIT_AUTHOR_EMAIL", "cli@example.org")
  vi.stubEnv("GIT_COMMITTER_NAME", "CLI Test")
  vi.stubEnv("GIT_COMMITTER_EMAIL", "cli@example.org")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  })
  if ((result.status ?? 1) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
  }
  return (result.stdout ?? "").trim()
}

function capture(): { write(chunk: string): void; text(): string } {
  const chunks: string[] = []
  return {
    write(chunk: string) {
      chunks.push(chunk)
    },
    text: () => chunks.join(""),
  }
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = capture()
  const stderr = capture()
  async function* emptyStdin(): AsyncGenerator<string> {}
  const code = await main(args, { stdin: emptyStdin(), stdout, stderr })
  return { code, stdout: stdout.text(), stderr: stderr.text() }
}

function runCliSubprocess(args: string[]): { code: number; stdout: string; stderr: string } {
  const binPath = new URL("../src/bin.ts", import.meta.url).pathname
  const result = spawnSync("bun", [binPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "CLI Test",
      GIT_AUTHOR_EMAIL: "cli@example.org",
      GIT_COMMITTER_NAME: "CLI Test",
      GIT_COMMITTER_EMAIL: "cli@example.org",
    },
  })
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  }
}

function remoteFixture(): {
  root: string
  bare: string
  checkout: string
  landAtOrigin: (path: string, content: string) => string
} {
  const root = mkdtempSync(join(tmpdir(), "gitomic-project-"))
  roots.push(root)
  const seed = join(root, "seed")
  git(root, "init", "-q", "--initial-branch=main", "seed")
  git(seed, "config", "user.email", "test@example.com")
  git(seed, "config", "user.name", "Test")
  writeFileSync(join(seed, "tracked.md"), "# original\n")
  writeFileSync(join(seed, "bystander.md"), "# bystander\n")
  git(seed, "add", ".")
  git(seed, "commit", "-qm", "baseline")
  const bare = join(root, "origin.git")
  git(root, "init", "-q", "--bare", "--initial-branch=main", "origin.git")
  git(seed, "remote", "add", "origin", bare)
  git(seed, "push", "-qu", "origin", "main")
  const checkout = join(root, "checkout")
  git(root, "clone", "-q", bare, "checkout")
  git(checkout, "config", "user.email", "test@example.com")
  git(checkout, "config", "user.name", "Test")
  let landerCount = 0
  const landAtOrigin = (path: string, content: string): string => {
    const name = `lander-${landerCount}`
    landerCount += 1
    const lander = join(root, name)
    git(root, "clone", "-q", bare, name)
    git(lander, "config", "user.email", "lander@example.invalid")
    git(lander, "config", "user.name", "Lander")
    writeFileSync(join(lander, path), content)
    git(lander, "add", path)
    git(lander, "commit", "-qm", `land ${path}`)
    git(lander, "push", "-q", "origin", "main")
    return git(lander, "rev-parse", "HEAD")
  }
  return { root, bare, checkout, landAtOrigin }
}

describe("gitomic project and checkout synchronization", () => {
  describe("library routines", () => {
    test("worktreeDirtyPaths reports tracked and untracked files, ignoring ignored ones", () => {
      const { checkout } = remoteFixture()
      expect(worktreeDirtyPaths(checkout)).toEqual([])

      writeFileSync(join(checkout, "tracked.md"), "# changed\n")
      writeFileSync(join(checkout, "new-untracked.md"), "# untracked\n")
      writeFileSync(join(checkout, ".gitignore"), "ignored.md\n")
      writeFileSync(join(checkout, "ignored.md"), "# should be ignored\n")

      expect(worktreeDirtyPaths(checkout)).toEqual([".gitignore", "new-untracked.md", "tracked.md"])
    })

    test("synchronizeCheckoutToCommit reports bare for a bare repository", () => {
      const { bare } = remoteFixture()
      const outcome = synchronizeCheckoutToCommit({
        repoRoot: bare,
        from: "0".repeat(40),
        to: "1".repeat(40),
        ref: "refs/heads/main",
        expectedDirtyPaths: [],
      })
      expect(outcome).toEqual({ ok: true, kind: "bare" })
    })

    test("synchronizeCheckoutToCommit refuses when on wrong branch", () => {
      const { checkout } = remoteFixture()
      git(checkout, "checkout", "-qb", "feature")
      const outcome = synchronizeCheckoutToCommit({
        repoRoot: checkout,
        from: git(checkout, "rev-parse", "HEAD"),
        to: "1".repeat(40),
        ref: "refs/heads/main",
        expectedDirtyPaths: [],
      })
      expect(outcome.ok).toBe(false)
      expect(outcome.kind).toBe("wrong-branch")
    })
  })

  describe("Witness 1: behind by one commit -> project fast-forwards clean tree", () => {
    test("gitomic project fast-forwards checkout to origin tip with no reverse-delta dirt", async () => {
      const { checkout, landAtOrigin } = remoteFixture()
      const tipBefore = git(checkout, "rev-parse", "HEAD")
      const landed = landAtOrigin("tracked.md", "# updated at remote\n")
      expect(landed).not.toBe(tipBefore)

      const result = await runCli(["project", checkout, "--remote", "origin", "--ref", "refs/heads/main"])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("kind=synchronized")
      expect(result.stdout).toContain(`local=${tipBefore}`)
      expect(result.stdout).toContain(`to=${landed}`)
      expect(result.stderr).toBe("")

      expect(git(checkout, "rev-parse", "HEAD")).toBe(landed)
      expect(readFileSync(join(checkout, "tracked.md"), "utf8")).toBe("# updated at remote\n")
      // Clean tree: no reverse-delta dirt
      expect(worktreeDirtyPaths(checkout)).toEqual([])
    })
  })

  describe("Witness 2: local-only commit -> exit 4, stranded-local-commits, nothing changed", () => {
    test("a local-only commit causes exit 4 with stranded-local-commits and leaves tree untouched", async () => {
      const { checkout } = remoteFixture()
      writeFileSync(join(checkout, "local.md"), "# local only\n")
      git(checkout, "add", "local.md")
      git(checkout, "commit", "-qm", "local commit")
      const localTip = git(checkout, "rev-parse", "HEAD")
      const indexHashBefore = git(checkout, "write-tree")
      const treeHashBefore = git(checkout, "rev-parse", `${localTip}^{tree}`)

      const result = await runCli(["project", checkout])
      expect(result.code).toBe(4)
      expect(result.stderr).toContain("stranded-local-commits")
      expect(result.stderr).toContain(`kind=stranded-local-commits local=${localTip}`)
      expect(result.stderr).toContain(`localOnly=["${localTip}"]`)

      // HEAD, index, and tree hashes identical
      expect(git(checkout, "rev-parse", "HEAD")).toBe(localTip)
      expect(git(checkout, "write-tree")).toBe(indexHashBefore)
      expect(git(checkout, "rev-parse", "HEAD^{tree}")).toBe(treeHashBefore)
    })

    test("diverged local commit reports exit 4 with landed-but-unsynchronized", async () => {
      const { checkout, landAtOrigin } = remoteFixture()
      writeFileSync(join(checkout, "local.md"), "# local only\n")
      git(checkout, "add", "local.md")
      git(checkout, "commit", "-qm", "local commit")
      const localTip = git(checkout, "rev-parse", "HEAD")

      landAtOrigin("tracked.md", "# remote advance\n")

      const result = await runCli(["project", checkout])
      expect(result.code).toBe(4)
      expect(result.stderr).toContain("landed-but-unsynchronized")
      expect(result.stderr).toContain(`kind=landed-but-unsynchronized local=${localTip}`)
    })
  })

  describe("Witness 3: pre-existing dirt on untouched path survives exactly", () => {
    test("unrelated dirty file is preserved after projection", async () => {
      const { checkout, landAtOrigin } = remoteFixture()
      writeFileSync(join(checkout, "bystander.md"), "# local uncommitted edit\n")
      writeFileSync(join(checkout, "untracked.md"), "# local untracked file\n")
      const landed = landAtOrigin("tracked.md", "# new remote content\n")

      const result = await runCli(["project", checkout])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("kind=synchronized")

      expect(git(checkout, "rev-parse", "HEAD")).toBe(landed)
      expect(readFileSync(join(checkout, "tracked.md"), "utf8")).toBe("# new remote content\n")
      expect(readFileSync(join(checkout, "bystander.md"), "utf8")).toBe("# local uncommitted edit\n")
      expect(readFileSync(join(checkout, "untracked.md"), "utf8")).toBe("# local untracked file\n")
      expect(worktreeDirtyPaths(checkout)).toEqual(["bystander.md", "untracked.md"])
    })
  })

  describe("Witness 4: apply --checkout projects in the same invocation", () => {
    test("apply with --checkout lands write and projects checkout to new tip", async () => {
      const { bare, checkout } = remoteFixture()
      const tipBefore = git(checkout, "rev-parse", "HEAD")

      const tempFile = join(tmpdir(), `apply-test-${Date.now()}.txt`)
      writeFileSync(tempFile, "# written via gitomic apply\n")

      const result = await runCli([
        "apply",
        `${bare}#main`,
        "-m",
        "commit from apply",
        "--checkout",
        checkout,
        "put",
        "tracked.md",
        tempFile,
      ])

      rmSync(tempFile, { force: true })
      expect(result.code).toBe(0)
      const landedOid = result.stdout.trim()
      expect(landedOid).toMatch(/^[0-9a-f]{40}$/u)
      expect(landedOid).not.toBe(tipBefore)

      expect(git(checkout, "rev-parse", "HEAD")).toBe(landedOid)
      expect(readFileSync(join(checkout, "tracked.md"), "utf8")).toBe("# written via gitomic apply\n")
      expect(worktreeDirtyPaths(checkout)).toEqual([])
    })

    test("apply with --checkout to checkout's own repository (local case) succeeds without false dirt-changed", async () => {
      const { checkout } = remoteFixture()
      writeFileSync(join(checkout, "local-dirt.md"), "# local dirt\n")
      expect(worktreeDirtyPaths(checkout)).toEqual(["local-dirt.md"])

      const tempFile = join(tmpdir(), `apply-local-${Date.now()}.txt`)
      writeFileSync(tempFile, "# written directly to local repo\n")

      const result = await runCli([
        "apply",
        `${checkout}#main`,
        "-m",
        "commit from local apply",
        "--checkout",
        checkout,
        "put",
        "tracked.md",
        tempFile,
      ])

      rmSync(tempFile, { force: true })
      expect(result.code).toBe(0)
      const landedOid = result.stdout.trim()
      expect(landedOid).toMatch(/^[0-9a-f]{40}$/u)

      expect(git(checkout, "rev-parse", "HEAD")).toBe(landedOid)
      expect(readFileSync(join(checkout, "tracked.md"), "utf8")).toBe("# written directly to local repo\n")
      expect(worktreeDirtyPaths(checkout)).toEqual(["local-dirt.md"])
      expect(result.stderr).not.toContain("projection failed")
    })

    test("apply with --checkout and --json includes projection outcome in receipt", async () => {
      const { checkout } = remoteFixture()
      const tempFile = join(tmpdir(), `apply-json-${Date.now()}.txt`)
      writeFileSync(tempFile, "# json projection test\n")

      const result = await runCli([
        "apply",
        `${checkout}#main`,
        "-m",
        "commit with json receipt",
        "--checkout",
        checkout,
        "--json",
        "put",
        "tracked.md",
        tempFile,
      ])

      rmSync(tempFile, { force: true })
      expect(result.code).toBe(0)
      const receipt = JSON.parse(result.stdout.trim()) as {
        oid: string
        retries: number
        report: string[]
        projection: string
      }
      expect(receipt.oid).toMatch(/^[0-9a-f]{40}$/u)
      expect(receipt.projection).toBe("synchronized")
    })

    test("apply with --checkout reports projection failure on colliding uncommitted work while write lands", async () => {
      const { checkout } = remoteFixture()
      writeFileSync(join(checkout, "tracked.md"), "# local edit that collides\n")

      const tempFile = join(tmpdir(), `apply-fail-${Date.now()}.txt`)
      writeFileSync(tempFile, "# write that collides\n")

      const result = await runCli([
        "apply",
        `${checkout}#main`,
        "-m",
        "colliding write",
        "--checkout",
        checkout,
        "--json",
        "put",
        "tracked.md",
        tempFile,
      ])

      rmSync(tempFile, { force: true })
      expect(result.code).toBe(0)
      const receipt = JSON.parse(result.stdout.trim()) as { oid: string; projection: string }
      expect(receipt.projection).toBe("worktree-update-refused")
      expect(result.stderr).toContain("gitomic: projection failed:")
      expect(result.stderr).toContain("kind=worktree-update-refused")
    })

    test("apply reports repository inspection failure after landing the write", async () => {
      const { root, bare, checkout } = remoteFixture()
      const shim = join(root, "git-shim")
      mkdirSync(shim)
      const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim()
      writeFileSync(
        join(shim, "git"),
        `#!/bin/sh\nif [ "$2" = "${checkout}" ] && [ "$3" = rev-parse ] && [ "$4" = --path-format=absolute ]; then\n  echo inspection unavailable >&2\n  exit 74\nfi\nexec ${realGit} "$@"\n`,
        { mode: 0o755 },
      )
      vi.stubEnv("PATH", `${shim}:${process.env.PATH}`)
      const content = join(root, "inspection.txt")
      writeFileSync(content, "# committed before projection\n")

      const result = await runCli([
        "apply",
        `${bare}#main`,
        "-m",
        "inspection failure",
        "--checkout",
        checkout,
        "--json",
        "put",
        "tracked.md",
        content,
      ])

      expect(result.code).toBe(0)
      const receipt = JSON.parse(result.stdout.trim()) as { oid: string; projection: string }
      expect(receipt.projection).toBe("repository-inspection-failed")
      expect(git(bare, "rev-parse", "refs/heads/main")).toBe(receipt.oid)
      expect(result.stderr).toContain(`cannot inspect repository "${checkout}"`)
      expect(result.stderr).toContain("inspection unavailable")
      expect(result.stderr).toContain("kind=repository-inspection-failed")
    })
  })

  describe("Witness 5: mid-flight ref advance (beforeRefAdvance) -> ref-advance-refused", () => {
    test("a concurrent ref advance during projection refuses honestly without tearing", async () => {
      const { checkout, landAtOrigin } = remoteFixture()
      writeFileSync(join(checkout, "bystander.md"), "# local work\n")
      const tipBefore = git(checkout, "rev-parse", "HEAD")
      const landed = landAtOrigin("tracked.md", "# first remote landing\n")

      let descendant = ""
      const outcome = await projectRemoteFirstFastForward({
        repoRoot: checkout,
        to: landed,
        remote: "origin",
        ref: "refs/heads/main",
        expectedDirtyPaths: ["bystander.md"],
        beforeRefAdvance: () => {
          descendant = landAtOrigin("second.md", "# concurrent second landing\n")
          git(checkout, "fetch", "-q", "origin", "main")
          git(checkout, "update-ref", "refs/heads/main", descendant)
        },
      })

      expect(outcome.ok).toBe(false)
      expect(outcome.kind).toBe("ref-advance-refused")
      // Ref holds the concurrent mover's tip, not torn or overwriting
      expect(git(checkout, "rev-parse", "refs/heads/main")).toBe(descendant)
      expect(git(checkout, "rev-parse", "refs/heads/main")).not.toBe(tipBefore)

      // Repeating projection from this state heals the checkout cleanly
      const repeat = await projectRemoteFirstFastForward({
        repoRoot: checkout,
        to: landed,
        remote: "origin",
        ref: "refs/heads/main",
        expectedDirtyPaths: ["bystander.md"],
      })
      expect(repeat.ok).toBe(true)
      expect(repeat.kind).toBe("synchronized")
      expect(git(checkout, "rev-parse", "refs/heads/main")).toBe(descendant)
      expect(readFileSync(join(checkout, "second.md"), "utf8")).toBe("# concurrent second landing\n")
      expect(readFileSync(join(checkout, "tracked.md"), "utf8")).toBe("# first remote landing\n")
      expect(readFileSync(join(checkout, "bystander.md"), "utf8")).toBe("# local work\n")
      expect(worktreeDirtyPaths(checkout)).toEqual(["bystander.md"])
    })
  })

  describe("CLI project exit codes", () => {
    test("exit 0 when checkout is already current", async () => {
      const { checkout } = remoteFixture()
      const tip = git(checkout, "rev-parse", "HEAD")
      const result = await runCli(["project", checkout])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("kind=already-current")
      expect(result.stdout).toContain(`local=${tip} to=${tip}`)
    })

    test("exit 1 when remote fetch fails", async () => {
      const { checkout, bare } = remoteFixture()
      rmSync(bare, { recursive: true, force: true })
      const result = await runCli(["project", checkout])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("fetch-failed")
    })

    test("exit 1 when checkout is on wrong branch", async () => {
      const { checkout } = remoteFixture()
      git(checkout, "checkout", "-qb", "other")
      const result = await runCli(["project", checkout])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain("wrong-branch")
    })

    test("exit 2 on usage error (missing path)", async () => {
      const result = await runCli(["project"])
      expect(result.code).toBe(2)
      expect(result.stderr).toContain("missing <path>")
    })

    test("exit 2 on unknown flag", async () => {
      const { checkout } = remoteFixture()
      const result = await runCli(["project", checkout, "--bad-flag"])
      expect(result.code).toBe(2)
      expect(result.stderr).toContain("unrecognized flag")
    })

    test("exit 4 with worktree-update-refused when uncommitted local changes collide with incoming remote commit", async () => {
      const { checkout, landAtOrigin } = remoteFixture()
      writeFileSync(join(checkout, "tracked.md"), "# conflicting local dirt\n")
      landAtOrigin("tracked.md", "# incoming remote landing\n")

      const result = await runCli(["project", checkout])
      expect(result.code).toBe(4)
      expect(result.stderr).toContain("kind=worktree-update-refused")
    })

    test("exit 2 on malformed or non-positive --timeout", async () => {
      const { checkout } = remoteFixture()
      const resAlpha = await runCli(["project", checkout, "--timeout", "abc"])
      expect(resAlpha.code).toBe(2)
      expect(resAlpha.stderr).toContain("--timeout must be a positive integer")

      const resZero = await runCli(["project", checkout, "--timeout", "0"])
      expect(resZero.code).toBe(2)
      expect(resZero.stderr).toContain("--timeout must be a positive integer")

      const resNeg = await runCli(["project", checkout, "--timeout", "-10"])
      expect(resNeg.code).toBe(2)
      expect(resNeg.stderr).toContain("--timeout must be a positive integer")
    })
  })

  describe("Fresh-process CLI load (owed receipt 7)", () => {
    test("fresh process gitomic project exits 0 on current checkout", () => {
      const { checkout } = remoteFixture()
      const tip = git(checkout, "rev-parse", "HEAD")
      const result = runCliSubprocess(["project", checkout])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("kind=already-current")
      expect(result.stdout).toContain(`local=${tip} to=${tip}`)
    })

    test("fresh process gitomic apply --checkout projects successfully", () => {
      const { checkout } = remoteFixture()
      const tempFile = join(tmpdir(), `apply-fresh-${Date.now()}.txt`)
      writeFileSync(tempFile, "# fresh process write\n")

      const result = runCliSubprocess([
        "apply",
        `${checkout}#main`,
        "-m",
        "commit from fresh process apply",
        "--checkout",
        checkout,
        "--json",
        "put",
        "fresh.md",
        tempFile,
      ])

      rmSync(tempFile, { force: true })
      expect(result.code).toBe(0)
      const receipt = JSON.parse(result.stdout.trim()) as { oid: string; projection: string }
      expect(receipt.oid).toMatch(/^[0-9a-f]{40}$/u)
      expect(receipt.projection).toBe("synchronized")
      expect(readFileSync(join(checkout, "fresh.md"), "utf8")).toBe("# fresh process write\n")
    })
  })
})
