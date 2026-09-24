// Run under Node after `build`, over dist/ — the files the package publishes. The root entry and every subpath except
// the Bun-only checkout lock must import under Node, and the two verbs that hold the lock must refuse with exit 6
// rather than fail as a crash. A Node runtime that the release verify retries under Bun would hide the first failure.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

if (typeof globalThis.Bun !== "undefined") throw new Error("node-smoke.mjs must run under Node, not Bun")

const dist = new URL("../dist/", import.meta.url)
for (const entry of ["index.js", "adapters.js", "events.js", "iso.js", "mem.js"]) {
  await import(new URL(entry, dist).href)
}

const bin = fileURLToPath(new URL("bin.js", dist))
const projected = spawnSync(process.execPath, [bin, "project", fileURLToPath(new URL("..", import.meta.url))], {
  encoding: "utf8",
})
if (projected.status !== 6 || !projected.stderr.includes("project needs Bun")) {
  throw new Error(
    `under Node, \`gitomic project\` must exit 6 naming Bun; it exited ${projected.status}: ${projected.stderr}`,
  )
}
process.stdout.write("node-smoke: the root entry and its Node subpaths import; project refuses with exit 6\n")
