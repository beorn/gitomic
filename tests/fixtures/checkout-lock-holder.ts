// Run under Bun by checkout-lock.test.ts. Holds `<repo>`'s checkout lock until stdin closes.
//
//   bun checkout-lock-holder.ts <repo> hold      take it through holdCheckoutLock (records pid and argv)
//   bun checkout-lock-holder.ts <repo> silent    take it without recording itself, as a foreign writer would
//   bun checkout-lock-holder.ts <repo> borrow <checkout> [pass|keep] -- <gitomic args...>
//       hold it, run `bun src/bin.ts <gitomic args>` with the descriptor inherited as fd 3 (`pass`) or not
//       (`keep`), print the child's outcome as one JSON line, and exit
import { spawnSync } from "node:child_process"

import { tryAcquireFlock } from "@bearly/flock"

import { CHECKOUT_LOCK_FD_ENV, checkoutLockPath, holdCheckoutLock } from "../../src/checkout-lock.js"

const [repo, mode, ...rest] = process.argv.slice(2)
if (repo === undefined || mode === undefined) throw new Error("usage: checkout-lock-holder.ts <repo> <mode> ...")

if (mode === "borrow") {
  const [pass, separator, ...gitomicArgs] = rest.slice(1)
  if (separator !== "--") throw new Error("borrow: expected -- before the gitomic arguments")
  const held = holdCheckoutLock(repo, { timeoutMs: 0 })
  if (!held.ok) throw new Error(held.error)
  const bin = new URL("../../src/bin.ts", import.meta.url).pathname
  const child = spawnSync("bun", [bin, ...gitomicArgs], {
    encoding: "utf8",
    stdio: pass === "pass" ? ["ignore", "pipe", "pipe", held.lock.fd] : ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(pass === "pass" ? { [CHECKOUT_LOCK_FD_ENV]: "3" } : {}) },
  })
  process.stdout.write(`${JSON.stringify({ code: child.status, stdout: child.stdout, stderr: child.stderr })}\n`)
  held.lock.release()
} else {
  let release: () => void
  if (mode === "hold") {
    const held = holdCheckoutLock(repo, { timeoutMs: 0 })
    if (!held.ok) throw new Error(held.error)
    release = () => held.lock.release()
  } else if (mode === "silent") {
    const lock = tryAcquireFlock(checkoutLockPath(repo))
    if (lock === null) throw new Error("silent: the checkout lock is already held")
    release = () => lock.release()
  } else {
    throw new Error(`unknown mode ${mode}`)
  }
  process.stdout.write(`held ${process.pid}\n`)
  process.stdin.on("end", () => {
    release()
    process.exit(0)
  })
  process.stdin.resume()
}
