/**
 * The checkout lock: one flock per repository that serializes every process
 * that writes a checkout's index or working tree.
 *
 * It lives in the git common dir, so linked worktrees and the main checkout
 * contend on the same file. POSIX flock is released by the kernel when the
 * holding open file description closes — including on SIGKILL — so the file
 * on disk is only the inode, never proof that anyone holds it.
 *
 * The name is the one the existing writers already take (Tent, km-beads
 * create, the checkout-sync timer), so every caller serializes on ONE path at
 * every moment. A rename happens only once no caller names the old path.
 *
 * Borrowing: a parent that already holds the lock passes its descriptor to a
 * child `gitomic` as an inherited fd named by {@link CHECKOUT_LOCK_FD_ENV}.
 * The child adopts that descriptor instead of opening the file again; a second
 * open would be a second open file description, which waits on the parent's
 * lock and deadlocks until the timeout.
 *
 * The library's projection functions never take this lock: they run under the
 * caller's lock. The CLI's `project` and `apply --checkout` take it.
 */

import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { adoptInheritedFlock, tryAcquireFlock, type FlockHandle } from "@bearly/flock"

/** The lock file's name inside the git common dir. */
export const CHECKOUT_LOCK_NAME = "km-state-write.lock"

/** Environment variable naming an inherited descriptor that already holds the checkout lock. */
export const CHECKOUT_LOCK_FD_ENV = "GITOMIC_CHECKOUT_LOCK_FD"

/**
 * How long `holdCheckoutLock` waits for another writer by default, in ms. The
 * same bound Tent and the checkout-sync timer use: a gated write holds the lock
 * for about 0.6–0.8 s (measured), so 15 s outlasts a queue of roughly twenty
 * writers, and a holder still there after that is stuck rather than busy.
 */
export const DEFAULT_CHECKOUT_LOCK_TIMEOUT_MS = 15_000

const POLL_INTERVAL_MS = 50

export type CheckoutLock = FlockHandle

export type HoldCheckoutLockOutcome =
  | { readonly ok: true; readonly lock: CheckoutLock; readonly borrowed: boolean }
  | { readonly ok: false; readonly kind: "checkout-lock-busy"; readonly path: string; readonly error: string }

export interface HoldCheckoutLockOptions {
  /** Maximum wait for another holder, in ms. `0` tries once. Default {@link DEFAULT_CHECKOUT_LOCK_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /** Environment to read {@link CHECKOUT_LOCK_FD_ENV} from. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** `<git-common-dir>/km-state-write.lock` for the repository containing `repoRoot`. Throws when git cannot say. */
export function checkoutLockPath(repoRoot: string): string {
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  })
  const directory = result.stdout?.trim() ?? ""
  if (result.error !== undefined || result.status !== 0 || directory.length === 0) {
    const detail = result.error?.message || result.stderr?.trim() || "no common directory returned"
    throw new Error(
      `cannot resolve the checkout lock of ${JSON.stringify(repoRoot)}: git rev-parse --git-common-dir exited ${result.status ?? "without status"}: ${detail}`,
    )
  }
  return join(directory, CHECKOUT_LOCK_NAME)
}

/**
 * Hold the checkout lock of `repoRoot`: adopt the inherited descriptor when
 * {@link CHECKOUT_LOCK_FD_ENV} names one, otherwise take the lock, waiting at
 * most `timeoutMs` for another holder.
 *
 * A busy lock is an outcome, not an exception: nothing was written. A named
 * descriptor that is malformed, or that does not hold this repository's lock,
 * throws — the caller's environment is wrong, and waiting would not fix it.
 */
export function holdCheckoutLock(repoRoot: string, options: HoldCheckoutLockOptions = {}): HoldCheckoutLockOutcome {
  const path = checkoutLockPath(repoRoot)
  const env = options.env ?? process.env
  const inherited = env[CHECKOUT_LOCK_FD_ENV]
  if (inherited !== undefined) return { ok: true, lock: adoptCheckoutLock(path, inherited), borrowed: true }

  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECKOUT_LOCK_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const waitCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  while (true) {
    const lock = tryAcquireFlock(path)
    if (lock !== null) {
      // The body names the holder for a waiter's refusal. It is a label, never
      // authority: the flock alone decides who holds the lock.
      lock.replaceBody(`${JSON.stringify({ pid: process.pid, argv: process.argv })}\n`)
      return { ok: true, lock, borrowed: false }
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        kind: "checkout-lock-busy",
        path,
        error: `the checkout lock ${path} is held by ${recordedHolder(path)} after ${timeoutMs} ms; nothing was written`,
      }
    }
    Atomics.wait(waitCell, 0, 0, POLL_INTERVAL_MS)
  }
}

/**
 * The holder a busy lock's body records, when that process is still alive.
 * Writers that do not record themselves leave an older body behind, so a
 * recorded pid that no longer runs names nobody.
 */
function recordedHolder(path: string): string {
  let body: string
  try {
    body = readFileSync(path, "utf8")
  } catch (error) {
    return `another writer (the lock body could not be read: ${error instanceof Error ? error.message : String(error)})`
  }
  let recorded: { pid?: unknown; argv?: unknown }
  try {
    recorded = JSON.parse(body) as { pid?: unknown; argv?: unknown }
  } catch {
    return "another writer (the lock body records no holder)"
  }
  const pid = recorded.pid
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    return "another writer (the lock body records no holder)"
  }
  if (!isAlive(pid)) return `another writer (the recorded holder pid ${pid} is no longer running)`
  const argv = Array.isArray(recorded.argv) ? ` ${JSON.stringify(recorded.argv)}` : ""
  return `pid ${pid}${argv}`
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists under another user.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function adoptCheckoutLock(path: string, text: string): CheckoutLock {
  const fd = /^\d+$/u.test(text) ? Number(text) : Number.NaN
  if (!Number.isSafeInteger(fd) || fd < 3) {
    throw new Error(`${CHECKOUT_LOCK_FD_ENV} must name an inherited descriptor >= 3 holding ${path}, got ${JSON.stringify(text)}`)
  }
  const lock = adoptInheritedFlock(path, fd)
  if (lock === null) {
    throw new Error(`${CHECKOUT_LOCK_FD_ENV}=${fd} is open on ${path} but does not hold it: another descriptor does`)
  }
  return lock
}
