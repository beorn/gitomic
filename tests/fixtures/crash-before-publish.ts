import { createShellBackend, open } from "../../src/index.js"
import type { GitomicBackend } from "../../src/index.js"

const repo = process.argv[2]
if (repo === undefined) throw new TypeError("repo argument is required")

const shell = createShellBackend()
const backend: GitomicBackend = {
  ...shell,
  async compareAndSwap(_repo, _ref, next): Promise<boolean> {
    process.stdout.write(`${JSON.stringify({ next })}\n`)
    return await new Promise<boolean>(() => undefined)
  },
}
const store = await open({ repo, ref: "main", writer: "crash-writer", backend })
await store.transact(async (map) => map.set("crash/value", "still reachable"), "crash before publish")
