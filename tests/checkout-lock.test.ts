// @failure Two writers could project one checkout at once, a busy lock could read as a broken checkout or name no holder, a borrowed lock could deadlock its own child, and Node and Bun writers could fail to share the same lock.
// @level l1
// @consumer gitomic project and apply --checkout callers: the checkout-sync timer, Tent and km writers that borrow the lock

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, describe, expect, test } from "vitest"

import { main } from "../src/bin.js"
import { fileURLToPath } from "node:url"

const roots: string[] = []
const holders: ChildProcessWithoutNullStreams[] = []
const holderScript = fileURLToPath(new URL("./fixtures/checkout-lock-holder.ts", import.meta.url))
const binPath = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Lock Test",
  GIT_AUTHOR_EMAIL: "lock@example.org",
  GIT_COMMITTER_NAME: "Lock Test",
  GIT_COMMITTER_EMAIL: "lock@example.org",
}

afterEach(() => {
  for (const holder of holders.splice(0)) holder.stdin.end()
})

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env })
  if ((result.status ?? 1) !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
  return (result.stdout ?? "").trim()
}

function gitomic(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync("bun", [binPath, ...args], { encoding: "utf8", env })
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

/** A bare origin and a clone of it, one commit each. */
function fixture(): { root: string; bare: string; checkout: string } {
  const root = mkdtempSync(join(tmpdir(), "gitomic-lock-"))
  roots.push(root)
  const bare = join(root, "origin.git")
  git(root, "init", "-q", "--bare", "--initial-branch=main", "origin.git")
  const checkout = join(root, "checkout")
  git(root, "clone", "-q", bare, "checkout")
  writeFileSync(join(checkout, "tracked.md"), "# original\n")
  git(checkout, "add", "tracked.md")
  git(checkout, "commit", "-qm", "baseline")
  git(checkout, "push", "-q", "origin", "main")
  return { root, bare, checkout }
}

/** Start a Bun process holding `repo`'s checkout lock; resolves with its pid once it holds it. */
async function holdLock(repo: string, mode: "hold" | "silent"): Promise<number> {
  const holder = spawn("bun", [holderScript, repo, mode], { env })
  holders.push(holder)
  return await new Promise<number>((resolve, reject) => {
    let out = ""
    let err = ""
    holder.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8")
      const held = /^held (\d+)$/mu.exec(out)
      if (held?.[1] !== undefined) resolve(Number(held[1]))
    })
    holder.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8")
    })
    holder.on("exit", (code) => reject(new Error(`holder exited ${code} before holding the lock: ${err}`)))
  })
}

describe("the checkout lock", () => {
  test("project waits out a busy lock, exits 5, and names the path and the holder", async () => {
    const { checkout } = fixture()
    const lockPath = join(
      git(checkout, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      "km-state-write.lock",
    )
    const pid = await holdLock(checkout, "hold")

    const result = gitomic(["project", checkout, "--lock-timeout", "200"])

    expect(result.code).toBe(5)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(`the checkout lock ${lockPath} is held by pid ${pid} [`)
    expect(result.stderr).toContain("after 200 ms; nothing was written")
    expect(result.stderr).toContain(`kind=checkout-lock-busy path=${lockPath}`)
  })

  test("a linked worktree contends on the main checkout's lock", async () => {
    const { root, checkout } = fixture()
    const linked = join(root, "linked")
    git(checkout, "worktree", "add", "-q", "-b", "side", linked)
    await holdLock(checkout, "hold")

    const result = gitomic(["project", linked, "--ref", "side", "--lock-timeout", "100"])

    expect(result.code).toBe(5)
    expect(result.stderr).toContain(join(git(checkout, "rev-parse", "--absolute-git-dir"), "km-state-write.lock"))
  })

  test("a holder that does not record itself is never misnamed by an older body", async () => {
    const { checkout } = fixture()
    const lockPath = join(git(checkout, "rev-parse", "--absolute-git-dir"), "km-state-write.lock")
    const gone = spawnSync("true")
    writeFileSync(lockPath, `${JSON.stringify({ pid: gone.pid, argv: ["an", "earlier", "writer"] })}\n`)
    await holdLock(checkout, "silent")

    const result = gitomic(["project", checkout, "--lock-timeout", "100"])

    expect(result.code).toBe(5)
    expect(result.stderr).toContain(`the recorded holder pid ${gone.pid} is no longer running`)
    expect(result.stderr).not.toContain("earlier")
  })

  test("apply --checkout against a busy lock exits 5 and writes nothing, not even the commit", async () => {
    const { root, bare, checkout } = fixture()
    const before = git(bare, "rev-parse", "refs/heads/main")
    const content = join(root, "content.md")
    writeFileSync(content, "# never landed\n")
    await holdLock(checkout, "hold")

    const result = gitomic([
      "apply",
      `${bare}#main`,
      "-m",
      "busy",
      "--checkout",
      checkout,
      "--lock-timeout",
      "100",
      "put",
      "tracked.md",
      content,
    ])

    expect(result.code).toBe(5)
    expect(result.stderr).toContain("kind=checkout-lock-busy")
    expect(git(bare, "rev-parse", "refs/heads/main")).toBe(before)
    expect(readFileSync(join(checkout, "tracked.md"), "utf8")).toBe("# original\n")
  })

  test("a child given the held descriptor adopts it; the same child without it waits and exits 5", () => {
    const { checkout } = fixture()
    const run = (pass: "pass" | "keep"): { code: number; stdout: string; stderr: string } => {
      const parent = spawnSync(
        "bun",
        [holderScript, checkout, "borrow", checkout, pass, "--", "project", checkout, "--lock-timeout", "200"],
        { encoding: "utf8", env },
      )
      expect(parent.status, parent.stderr).toBe(0)
      return JSON.parse(parent.stdout) as { code: number; stdout: string; stderr: string }
    }

    const borrowed = run("pass")
    expect(borrowed.stderr).toBe("")
    expect(borrowed.code).toBe(0)
    expect(borrowed.stdout).toContain("kind=already-current")

    const refused = run("keep")
    expect(refused.code).toBe(5)
    expect(refused.stderr).toContain("kind=checkout-lock-busy")
  })

  test("a malformed borrowed descriptor fails loudly, naming the variable", () => {
    const { checkout } = fixture()
    const result = spawnSync("bun", [binPath, "project", checkout], {
      encoding: "utf8",
      env: { ...env, GITOMIC_CHECKOUT_LOCK_FD: "stdin" },
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("GITOMIC_CHECKOUT_LOCK_FD must name an inherited descriptor >= 3 holding")
    expect(result.stderr).toContain('got "stdin"')
  })

  // Native Node runs the real lock while the existing holder fixture runs Bun.
  test.runIf(!("Bun" in globalThis))(
    "Node projects and applies under the shared lock, and a Bun holder refuses its write",
    async () => {
      const { root, bare, checkout } = fixture()
      const chunks: string[] = []
      const stderr = { write: (chunk: string) => chunks.push(chunk) }
      const stdout = { write: (chunk: string) => chunks.push(chunk) }
      async function* empty(): AsyncGenerator<string> {}
      const io = { stdin: empty(), stdout, stderr }

      expect(await main(["project", checkout], io)).toBe(0)
      expect(chunks.join("")).toContain("kind=already-current")
      const content = join(root, "content.md")
      writeFileSync(content, "# node write\n")
      chunks.length = 0
      expect(
        await main(["apply", `${bare}#main`, "-m", "node", "--checkout", checkout, "put", "tracked.md", content], io),
      ).toBe(0)
      expect(readFileSync(join(checkout, "tracked.md"), "utf8")).toBe("# node write\n")
      expect(git(checkout, "rev-parse", "HEAD")).toBe(git(bare, "rev-parse", "refs/heads/main"))

      const before = git(bare, "rev-parse", "refs/heads/main")
      await holdLock(checkout, "hold")
      writeFileSync(content, "# refused write\n")
      chunks.length = 0
      expect(
        await main(
          [
            "apply",
            `${bare}#main`,
            "-m",
            "busy node",
            "--checkout",
            checkout,
            "--lock-timeout",
            "100",
            "put",
            "tracked.md",
            content,
          ],
          io,
        ),
      ).toBe(5)
      expect(chunks.join("")).toContain("kind=checkout-lock-busy")
      expect(git(bare, "rev-parse", "refs/heads/main")).toBe(before)
      expect(readFileSync(join(checkout, "tracked.md"), "utf8")).toBe("# node write\n")
    },
  )
})
