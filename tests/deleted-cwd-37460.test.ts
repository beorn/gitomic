// @failure a caller whose own working directory was just deleted (yrd env close run from inside the
// environment it removes) gets `fatal: Unable to read current working directory` from every bare-store
// command: gitomic names the store with `--git-dir` and its Git child inherits the caller's cwd, which
// Git reads at startup. The store itself is intact, so the read must still succeed (hh 37460).
// @level l2: a real Git child in a real child process whose cwd is removed before the call.
// @consumer yrd's post-close branch retirement (readRemoteCommit -> fetchRefs), and any long-lived caller
// that outlives its cwd.
// @testonly none — fetchRefs and head are production surface.

import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"

import { createRemoteRepos } from "./helpers/git.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

test("bare-store reads and fetches succeed after the caller's cwd is deleted (37460)", async () => {
  const repos = await createRemoteRepos()
  cleanups.push(repos.cleanup)
  const scratch = await mkdtemp(join(tmpdir(), "gitomic-deleted-cwd-"))
  const gone = join(scratch, "gone")
  await mkdir(gone)
  const script = join(scratch, "probe.ts")
  const shell = fileURLToPath(new URL("../src/shell.ts", import.meta.url))
  await writeFile(
    script,
    `import { rmdirSync } from "node:fs"
import { createShellBackend } from ${JSON.stringify(shell)}
const [gone, left, remote] = process.argv.slice(2)
process.chdir(gone)
rmdirSync(gone)
const backend = createShellBackend()
const fetched = await backend.fetchRefs(left, ["refs/heads/main"], remote)
const read = await backend.head(left, "refs/heads/main")
console.log(JSON.stringify({ fetched: fetched.get("refs/heads/main"), read }))
`,
  )
  cleanups.push(async () => {
    const { rm } = await import("node:fs/promises")
    await rm(scratch, { recursive: true, force: true })
  })
  const result = spawnSync("bun", [script, gone, repos.left, repos.remote], { encoding: "utf8", timeout: 60_000 })
  expect(result.stderr).not.toContain("Unable to read current working directory")
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout.trim())).toEqual({ fetched: repos.initial, read: repos.initial })
})
