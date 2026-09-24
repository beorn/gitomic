// @failure The projector could falsely report current over stale files, lose uncommitted dirt, fail to report a stranded local commit with exit 4, or tear on a concurrent ref advance.
// @level l1
// @consumer gitomic project and apply --checkout callers, including state-checkout-sync and km create

import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest"

import { projectRemoteFirstFastForward, synchronizeCheckoutToCommit, worktreeDirtyPaths } from "../src/index.js"
import { gitOutcomeForTest } from "../src/project.js"

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

/**
 * `project` and `apply --checkout` hold the checkout lock, which needs Bun, and
 * this suite's runner is Node: every CLI call here runs the real `bun` binary.
 */
async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCliSubprocess(args)
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

  /**
   * 25393: a commit hook advanced the ref, then its checkout update was refused (another git held index.lock), so
   * the index and tree stayed at the parent: `git status` shows the commit's whole inverse delta. Once the commit
   * was pushed, `project` said already-current over that stale index, because it judged only the ref.
   */
  describe("Witness 6: an index left at the pre-advance tree is carried forward, never reported current", () => {
    function commitThenLeaveIndexAtParent(checkout: string): { parent: string; head: string } {
      const parent = git(checkout, "rev-parse", "HEAD")
      writeFileSync(join(checkout, "tracked.md"), "# committed by the hook\n")
      writeFileSync(join(checkout, "added.md"), "# added by the hook\n")
      git(checkout, "add", "tracked.md", "added.md")
      git(checkout, "commit", "-qm", "hook commit")
      const head = git(checkout, "rev-parse", "HEAD")
      // The refused worktree update: the ref moved, the index and tree did not.
      git(checkout, "read-tree", "-m", "-u", head, parent)
      expect(worktreeDirtyPaths(checkout)).toEqual(["added.md", "tracked.md"])
      return { parent, head }
    }

    test("after the commit is pushed, project repairs the index to HEAD and reports it", async () => {
      const { checkout } = remoteFixture()
      const { parent, head } = commitThenLeaveIndexAtParent(checkout)
      git(checkout, "push", "-q", "origin", "main")

      const result = await runCli(["project", checkout])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(`repaired-from=${parent}`)
      expect(git(checkout, "rev-parse", "HEAD")).toBe(head)
      expect(worktreeDirtyPaths(checkout)).toEqual([])
      expect(readFileSync(join(checkout, "tracked.md"), "utf8")).toBe("# committed by the hook\n")
      expect(readFileSync(join(checkout, "added.md"), "utf8")).toBe("# added by the hook\n")
    })

    test("when origin has moved on, project repairs the index and then fast-forwards", async () => {
      const { checkout, landAtOrigin } = remoteFixture()
      const { parent } = commitThenLeaveIndexAtParent(checkout)
      git(checkout, "push", "-q", "origin", "main")
      const landed = landAtOrigin("bystander.md", "# landed after the hook\n")

      const result = await runCli(["project", checkout])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain("kind=synchronized")
      expect(result.stdout).toContain(`repaired-from=${parent}`)
      expect(git(checkout, "rev-parse", "HEAD")).toBe(landed)
      expect(worktreeDirtyPaths(checkout)).toEqual([])
    })

    test("unrelated dirt survives the repair exactly", async () => {
      const { checkout } = remoteFixture()
      commitThenLeaveIndexAtParent(checkout)
      git(checkout, "push", "-q", "origin", "main")
      writeFileSync(join(checkout, "bystander.md"), "# local uncommitted edit\n")
      writeFileSync(join(checkout, "untracked.md"), "# local untracked file\n")

      const result = await runCli(["project", checkout])
      expect(result.code).toBe(0)
      expect(worktreeDirtyPaths(checkout)).toEqual(["bystander.md", "untracked.md"])
      expect(readFileSync(join(checkout, "bystander.md"), "utf8")).toBe("# local uncommitted edit\n")
    })

    test("an edit on top of the stale tree refuses, exit 4, and changes nothing", async () => {
      const { checkout } = remoteFixture()
      const { head } = commitThenLeaveIndexAtParent(checkout)
      git(checkout, "push", "-q", "origin", "main")
      writeFileSync(join(checkout, "tracked.md"), "# a local edit nobody committed\n")
      const indexBefore = git(checkout, "write-tree")

      const result = await runCli(["project", checkout])
      expect(result.code).toBe(4)
      expect(result.stderr).toContain("kind=worktree-update-refused")
      expect(git(checkout, "rev-parse", "HEAD")).toBe(head)
      expect(git(checkout, "write-tree")).toBe(indexBefore)
      expect(readFileSync(join(checkout, "tracked.md"), "utf8")).toBe("# a local edit nobody committed\n")
    })

    test("an index two commits behind is repaired from tip~2", async () => {
      const { checkout } = remoteFixture()
      const { parent } = commitThenLeaveIndexAtParent(checkout)
      // A later landing that commits without the index, as `gitomic apply` does.
      const tree = git(checkout, "rev-parse", "HEAD^{tree}")
      const later = git(checkout, "commit-tree", tree, "-p", "HEAD", "-m", "later landing")
      git(checkout, "update-ref", "refs/heads/main", later)
      git(checkout, "push", "-q", "origin", "main")

      const result = await runCli(["project", checkout])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(`repaired-from=${parent}`)
      expect(git(checkout, "rev-parse", "HEAD~2")).toBe(parent)
      expect(worktreeDirtyPaths(checkout)).toEqual([])
      // The index's tree was read from a copy, and the copy is gone.
      const gitDir = git(checkout, "rev-parse", "--absolute-git-dir")
      expect(readdirSync(gitDir).filter((name) => name.startsWith("index") && name !== "index")).toEqual([])
    })

    // 1 is inside the first window, 300 the second, 5,000 the third (256, then 4,096, then 10,000 commits).
    test.each([1, 300, 5_000])(
      "an index %i behind in a history too long for one read is repaired: the walk pages",
      (behind) => {
        const root = mkdtempSync(join(tmpdir(), "gitomic-long-history-"))
        roots.push(root)
        const repo = join(root, "long")
        git(root, "init", "-q", "--initial-branch=main", "long")
        // 13,500 first-parent commits print about 1.1 MB of `%H %T` lines, past spawnSync's 1 MiB default.
        const commits = 13_500
        const stream: string[] = []
        for (let i = 1; i <= commits; i += 1) {
          const body = `${i}\n`
          stream.push(
            "commit refs/heads/main",
            `mark :${i}`,
            `committer Test <test@example.com> ${1_700_000_000 + i} +0000`,
            "data 2",
            "c",
            ...(i === 1 ? [] : [`from :${i - 1}`]),
            "M 644 inline counter.md",
            `data ${Buffer.byteLength(body)}`,
            body,
          )
        }
        const imported = spawnSync("git", ["-C", repo, "fast-import", "--quiet"], {
          input: `${stream.join("\n")}\n`,
          encoding: "utf8",
        })
        expect(imported.status, imported.stderr).toBe(0)
        git(repo, "read-tree", "--reset", "-u", "HEAD")
        const head = git(repo, "rev-parse", "HEAD")
        const parent = git(repo, "rev-parse", `HEAD~${behind}`)
        git(repo, "read-tree", "-m", "-u", head, parent)
        expect(worktreeDirtyPaths(repo)).toEqual(["counter.md"])

        const outcome = synchronizeCheckoutToCommit({
          repoRoot: repo,
          from: head,
          to: head,
          ref: "refs/heads/main",
          expectedDirtyPaths: ["counter.md"],
        })
        expect(outcome).toEqual({ ok: true, kind: "synchronized", dirtyPaths: [], repairedIndexFrom: parent })
        expect(readFileSync(join(repo, "counter.md"), "utf8")).toBe(`${commits}\n`)
      },
    )

    test("a git read past the output limit names ENOBUFS, never its truncated output", () => {
      const root = mkdtempSync(join(tmpdir(), "gitomic-enobufs-"))
      roots.push(root)
      git(root, "init", "-q", "--initial-branch=main", "big")
      const repo = join(root, "big")
      writeFileSync(join(root, "big.bin"), "x".repeat(1_536 * 1024))
      const blob = git(repo, "hash-object", "-w", join(root, "big.bin"))

      const read = gitOutcomeForTest(repo, ["cat-file", "-p", blob])
      expect(read.status).not.toBe(0)
      expect(read.stderr).toContain("ENOBUFS")
      expect(read.stdout).toBe("")
    })

    test("a projection with index.lock held succeeds on the healthy path and leaves the lock untouched", async () => {
      const { checkout } = remoteFixture()
      const lockFile = join(git(checkout, "rev-parse", "--absolute-git-dir"), "index.lock")
      // Another git holds the index: its lock file exists, with whatever it has written so far.
      writeFileSync(lockFile, "another git's half-written index\n")
      try {
        const result = await runCli(["project", checkout])
        expect(result.stderr).toBe("")
        expect(result.code).toBe(0)
        expect(result.stdout).toContain("kind=already-current")
        expect(readFileSync(lockFile, "utf8")).toBe("another git's half-written index\n")

        const head = git(checkout, "rev-parse", "HEAD")
        const outcome = synchronizeCheckoutToCommit({
          repoRoot: checkout,
          from: head,
          to: head,
          ref: "refs/heads/main",
          expectedDirtyPaths: [],
        })
        expect(outcome).toEqual({ ok: true, kind: "already-current", dirtyPaths: [] })
        expect(readFileSync(lockFile, "utf8")).toBe("another git's half-written index\n")
      } finally {
        rmSync(lockFile, { force: true })
      }
    })

    test("staged changes matching no ancestor refuse, exit 4, and are never called current", async () => {
      const { checkout } = remoteFixture()
      writeFileSync(join(checkout, "tracked.md"), "# staged by hand\n")
      git(checkout, "add", "tracked.md")
      const indexBefore = git(checkout, "write-tree")

      const result = await runCli(["project", checkout])
      expect(result.code).toBe(4)
      expect(result.stderr).toContain("kind=dirt-unverifiable")
      expect(result.stderr).toContain(`first-parent ancestors`)
      expect(result.stdout).not.toContain("already-current")
      expect(git(checkout, "write-tree")).toBe(indexBefore)
      expect(readFileSync(join(checkout, "tracked.md"), "utf8")).toBe("# staged by hand\n")
    })

    test("an index 70 commits behind is repaired: the search has no depth cliff", async () => {
      const { checkout } = remoteFixture()
      const { parent } = commitThenLeaveIndexAtParent(checkout)
      // 69 later landings that commit without the index, as `gitomic apply` does.
      const tree = git(checkout, "rev-parse", "HEAD^{tree}")
      let tip = git(checkout, "rev-parse", "HEAD")
      for (let i = 0; i < 69; i += 1) tip = git(checkout, "commit-tree", tree, "-p", tip, "-m", `landing ${i}`)
      git(checkout, "update-ref", "refs/heads/main", tip)
      git(checkout, "push", "-q", "origin", "main")

      const result = await runCli(["project", checkout])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain(`repaired-from=${parent}`)
      expect(worktreeDirtyPaths(checkout)).toEqual([])
    })

    test("apply --checkout over a stale index repairs it first and never mixes the stale entries in", async () => {
      const { bare, checkout } = remoteFixture()
      commitThenLeaveIndexAtParent(checkout)
      git(checkout, "push", "-q", "origin", "main")
      const file = join(tmpdir(), `apply-stale-${Date.now()}.txt`)
      writeFileSync(file, "# written through apply --checkout\n")

      const result = await runCli([
        "apply",
        `${bare}#main`,
        "-m",
        "over a stale index",
        "--checkout",
        checkout,
        "put",
        "bystander.md",
        file,
      ])
      rmSync(file, { force: true })
      expect(result.code).toBe(0)
      const landed = result.stdout.trim()
      expect(git(checkout, "rev-parse", "HEAD")).toBe(landed)
      expect(worktreeDirtyPaths(checkout)).toEqual([])
      expect(readFileSync(join(checkout, "added.md"), "utf8")).toBe("# added by the hook\n")
      expect(readFileSync(join(checkout, "bystander.md"), "utf8")).toBe("# written through apply --checkout\n")
    })

    test("HEAD at the tip over a stale index is repaired, never reported current as it stands, even to the library", () => {
      const { checkout } = remoteFixture()
      const { parent, head } = commitThenLeaveIndexAtParent(checkout)
      const outcome = synchronizeCheckoutToCommit({
        repoRoot: checkout,
        from: head,
        to: head,
        ref: "refs/heads/main",
        expectedDirtyPaths: worktreeDirtyPaths(checkout),
      })
      expect(outcome).toMatchObject({ ok: true, kind: "synchronized", repairedIndexFrom: parent })
      expect(git(checkout, "write-tree")).toBe(git(checkout, "rev-parse", `${head}^{tree}`))
      expect(worktreeDirtyPaths(checkout)).toEqual([])
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
      // The first common-dir read resolves the checkout lock; the inspection that
      // fails is the one after the write lands.
      const seen = join(root, "lock-resolved")
      writeFileSync(
        join(shim, "git"),
        `#!/bin/sh\nif [ "$2" = "${checkout}" ] && [ "$3" = rev-parse ] && [ "$4" = --path-format=absolute ]; then\n  if [ -e "${seen}" ]; then\n    echo inspection unavailable >&2\n    exit 74\n  fi\n  : > "${seen}"\nfi\nexec ${realGit} "$@"\n`,
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

    test("apply --checkout that cannot resolve the checkout lock refuses before writing", async () => {
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
      const before = git(bare, "rev-parse", "refs/heads/main")
      const content = join(root, "inspection.txt")
      writeFileSync(content, "# never committed\n")

      const result = await runCli([
        "apply",
        `${bare}#main`,
        "-m",
        "lock unresolvable",
        "--checkout",
        checkout,
        "put",
        "tracked.md",
        content,
      ])

      expect(result.code).toBe(1)
      expect(result.stderr).toContain(`cannot resolve the checkout lock of "${checkout}"`)
      expect(result.stderr).toContain("inspection unavailable")
      expect(git(bare, "rev-parse", "refs/heads/main")).toBe(before)
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

  // 25350 S3 (@cto 7473e4ec): a write authored IN the checkout lands the files the caller already wrote, so the
  // projection must stage exactly those paths — after proving they are the landing — and never write one.
  describe("authoredPaths: the checkout's content IS the landing", () => {
    /** Land `files` at origin from a fresh clone; a null content removes the path. Returns the landed commit. */
    function landFiles(bare: string, root: string, name: string, files: Record<string, string | null>): string {
      git(root, "clone", "-q", bare, name)
      const lander = join(root, name)
      git(lander, "config", "user.email", "lander@example.invalid")
      git(lander, "config", "user.name", "Lander")
      for (const [path, content] of Object.entries(files)) {
        if (content === null) git(lander, "rm", "-q", path)
        else {
          writeFileSync(join(lander, path), content)
          git(lander, "add", path)
        }
      }
      git(lander, "commit", "-qm", `land ${Object.keys(files).join(" ")}`)
      git(lander, "push", "-q", "origin", "main")
      return git(lander, "rev-parse", "HEAD")
    }
    const indexHolds = (checkout: string, commit: string): boolean =>
      gitOutcomeForTest(checkout, ["diff-index", "--cached", "--quiet", commit, "--"]).status === 0

    test("a clean landing of an authored put and rm ends clean, with the index at the landing's tree", async () => {
      const { root, bare, checkout } = remoteFixture()
      writeFileSync(join(checkout, "tracked.md"), "# authored\n")
      rmSync(join(checkout, "bystander.md"))
      const expectedDirtyPaths = worktreeDirtyPaths(checkout)
      const to = landFiles(bare, root, "author", { "tracked.md": "# authored\n", "bystander.md": null })

      const outcome = await projectRemoteFirstFastForward({
        repoRoot: checkout,
        to,
        ref: "refs/heads/main",
        remote: "origin",
        expectedDirtyPaths,
        authoredPaths: ["tracked.md", "bystander.md"],
      })

      expect(outcome).toMatchObject({ ok: true, kind: "synchronized", dirtyPaths: [] })
      expect(git(checkout, "rev-parse", "HEAD")).toBe(to)
      expect(indexHolds(checkout, to)).toBe(true)
      expect(worktreeDirtyPaths(checkout)).toEqual([])
    })

    test("a landing that also carries another writer's path (a CAS retry) ends clean at the landing's tree", async () => {
      const { root, bare, checkout } = remoteFixture()
      writeFileSync(join(checkout, "tracked.md"), "# authored\n")
      const expectedDirtyPaths = worktreeDirtyPaths(checkout)
      landFiles(bare, root, "peer", { "bystander.md": "# the peer's write\n" })
      const to = landFiles(bare, root, "author", { "tracked.md": "# authored\n" })

      const outcome = await projectRemoteFirstFastForward({
        repoRoot: checkout,
        to,
        ref: "refs/heads/main",
        remote: "origin",
        expectedDirtyPaths,
        authoredPaths: ["tracked.md"],
      })

      expect(outcome).toMatchObject({ ok: true, kind: "synchronized", dirtyPaths: [] })
      expect(indexHolds(checkout, to)).toBe(true)
      expect(readFileSync(join(checkout, "bystander.md"), "utf8")).toBe("# the peer's write\n")
      expect(worktreeDirtyPaths(checkout)).toEqual([])
    })

    test("a checkout path that disagrees with the landing refuses with both oids, staging nothing", async () => {
      const { root, bare, checkout } = remoteFixture()
      const before = git(checkout, "rev-parse", "HEAD")
      writeFileSync(join(checkout, "tracked.md"), "# what the checkout holds\n")
      const expectedDirtyPaths = worktreeDirtyPaths(checkout)
      const to = landFiles(bare, root, "author", { "tracked.md": "# what landed\n" })

      const outcome = await projectRemoteFirstFastForward({
        repoRoot: checkout,
        to,
        ref: "refs/heads/main",
        remote: "origin",
        expectedDirtyPaths,
        authoredPaths: ["tracked.md"],
      })

      expect(outcome).toMatchObject({
        ok: false,
        kind: "authored-mismatch",
        path: "tracked.md",
        checkoutOid: git(checkout, "hash-object", "tracked.md"),
        landedOid: git(checkout, "rev-parse", `${to}:tracked.md`),
      })
      expect(git(checkout, "rev-parse", "HEAD")).toBe(before)
      expect(indexHolds(checkout, before)).toBe(true)
      expect(readFileSync(join(checkout, "tracked.md"), "utf8")).toBe("# what the checkout holds\n")
    })

    test("an authored path the landing did not change refuses, naming it, staging nothing", async () => {
      const { root, bare, checkout } = remoteFixture()
      const before = git(checkout, "rev-parse", "HEAD")
      writeFileSync(join(checkout, "tracked.md"), "# authored\n")
      const expectedDirtyPaths = worktreeDirtyPaths(checkout)
      const to = landFiles(bare, root, "author", { "tracked.md": "# authored\n" })

      const outcome = await projectRemoteFirstFastForward({
        repoRoot: checkout,
        to,
        ref: "refs/heads/main",
        remote: "origin",
        expectedDirtyPaths,
        authoredPaths: ["tracked.md", "bystander.md"],
      })

      expect(outcome).toMatchObject({ ok: false, kind: "authored-mismatch", path: "bystander.md" })
      expect(outcome.ok ? "" : outcome.error).toContain("the landing did not change that path")
      expect(git(checkout, "rev-parse", "HEAD")).toBe(before)
      expect(indexHolds(checkout, before)).toBe(true)
    })

    test("synchronizeCheckoutToCommit stages the authored paths of an object-side landing and ends clean", () => {
      const { root, bare, checkout } = remoteFixture()
      const from = git(checkout, "rev-parse", "HEAD")
      writeFileSync(join(checkout, "tracked.md"), "# authored\n")
      const expectedDirtyPaths = worktreeDirtyPaths(checkout)
      const to = landFiles(bare, root, "author", { "tracked.md": "# authored\n" })
      git(checkout, "fetch", "-q", "origin")
      git(checkout, "update-ref", "refs/heads/main", to, from)

      const outcome = synchronizeCheckoutToCommit({
        repoRoot: checkout,
        from,
        to,
        ref: "refs/heads/main",
        expectedDirtyPaths,
        authoredPaths: ["tracked.md"],
      })

      expect(outcome).toMatchObject({ ok: true, kind: "synchronized", dirtyPaths: [] })
      expect(indexHolds(checkout, to)).toBe(true)
    })
  })
})
