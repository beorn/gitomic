// Run under Node after build, over the published files and a disposable real checkout.
// Native checkout ownership must work and refuse a competing child before it writes.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

if (typeof globalThis.Bun !== "undefined") throw new Error("node-smoke.mjs must run under Node, not Bun")

const dist = new URL("../dist/", import.meta.url)
for (const entry of ["index.js", "adapters.js", "checkout-lock.js", "events.js", "iso.js", "mem.js"]) {
  await import(new URL(entry, dist).href)
}

const bin = fileURLToPath(new URL("bin.js", dist))
const root = mkdtempSync(join(tmpdir(), "gitomic-node-smoke-"))
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "Node Smoke",
  GIT_AUTHOR_EMAIL: "smoke@example.invalid",
  GIT_COMMITTER_NAME: "Node Smoke",
  GIT_COMMITTER_EMAIL: "smoke@example.invalid",
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", env })
  if (result.error) throw result.error
  return result
}
function git(args) {
  const result = run("git", args)
  if (result.status !== 0) throw new Error(`smoke git ${args[0]} failed: ${result.stderr}`)
  return result.stdout.trim()
}
try {
  const bare = join(root, "origin.git")
  const checkout = join(root, "checkout")
  git(["init", "--bare", "--initial-branch=main", bare])
  git(["clone", bare, checkout])
  writeFileSync(join(checkout, "tracked.md"), "# original\n")
  git(["-C", checkout, "add", "tracked.md"])
  git(["-C", checkout, "commit", "-m", "baseline"])
  git(["-C", checkout, "push", "origin", "main"])
  const projected = run(process.execPath, [bin, "project", checkout])
  if (projected.status !== 0 || !projected.stdout.includes("kind=already-current")) {
    throw new Error(`Node project failed: exit=${projected.status}; ${projected.stderr}`)
  }
  const content = join(root, "content.md")
  writeFileSync(content, "# Node projection\n")
  const applied = run(process.execPath, [
    bin,
    "apply",
    `${bare}#main`,
    "-m",
    "node smoke",
    "--checkout",
    checkout,
    "put",
    "tracked.md",
    content,
  ])
  if (applied.status !== 0 || readFileSync(join(checkout, "tracked.md"), "utf8") !== "# Node projection\n") {
    throw new Error(`Node apply --checkout failed: exit=${applied.status}; ${applied.stderr}`)
  }
  const { holdCheckoutLock } = await import(new URL("checkout-lock.js", dist).href)
  const held = holdCheckoutLock(checkout, { timeoutMs: 0 })
  if (!held.ok) throw new Error(`Node smoke cannot hold checkout lock: ${held.error}`)
  try {
    const blocked = run(process.execPath, [bin, "project", checkout, "--lock-timeout", "0"])
    if (blocked.status !== 5 || !blocked.stderr.includes("kind=checkout-lock-busy")) {
      throw new Error(`Node child bypassed held lock: exit=${blocked.status}; ${blocked.stderr}`)
    }
  } finally {
    held.lock.release()
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
process.stdout.write(
  "node-smoke: public entries import; Node projects/applies and a competing child refuses the held lock\n",
)
