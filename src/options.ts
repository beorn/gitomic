/**
 * Option validation shared by gitomic's doors (`open`, `openReader`,
 * `openEvents`). Internal: not exported from the package.
 */
import { assertUtf8 } from "./utf8.js"

export const DEFAULT_RETRY_BUDGET_MS = 30_000
export const DEFAULT_READER_POLL_INTERVAL_MS = 1_000
export const DEFAULT_WRITER_LABEL = "gitomic"

export function normalizeRetryBudget(value: number | undefined): number {
  const budget = value ?? DEFAULT_RETRY_BUDGET_MS
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new TypeError("retryBudgetMs must be a positive number of milliseconds")
  }
  return budget
}

export function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined)
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener("abort", onAbort)
    const onAbort = (): void => {
      cleanup()
      resolve(undefined)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    pending.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

export function normalizePollInterval(value: number | undefined): number {
  const interval = value ?? DEFAULT_READER_POLL_INTERVAL_MS
  if (!Number.isSafeInteger(interval) || interval <= 0) {
    throw new TypeError("pollIntervalMs must be a positive integer")
  }
  return interval
}

export function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolveWait) => {
    let settled = false
    const settle = (elapsed: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolveWait(elapsed)
    }
    const onAbort = (): void => settle(false)
    // raw-lifecycle-ok: the awaited reader poll owns and clears this timer and abort listener.
    const timer = setTimeout(() => settle(true), milliseconds)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/** The label leads the subject and is echoed as a trailer, so it stays single-line. */
export function assertWriter(writer: string): void {
  assertUtf8(writer, "writer")
  const hasControlCharacter = [...writer].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
  if (writer.trim().length === 0 || hasControlCharacter) {
    throw new TypeError("writer must be a non-empty, single-line identifier")
  }
}

export function normalizeRef(ref: string): string {
  assertUtf8(ref, "ref")
  if (ref.length === 0) throw new TypeError("ref is required")
  const normalized = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`
  if (normalized === "refs/gitomic" || normalized.startsWith("refs/gitomic/")) {
    throw new TypeError("refs/gitomic/ is reserved for Gitomic's internal reachability refs")
  }
  const components = normalized.split("/")
  if (
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.endsWith(".") ||
    normalized.includes("..") ||
    normalized.includes("@{") ||
    [...normalized].some(isInvalidRefCharacter) ||
    components.some((component) => component.length === 0 || component.startsWith(".") || component.endsWith(".lock"))
  ) {
    throw new TypeError(`invalid Git ref: ${JSON.stringify(ref)}`)
  }
  return normalized
}

function isInvalidRefCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0
  return codePoint <= 0x20 || codePoint === 0x7f || "~^:?*[\\".includes(character)
}
