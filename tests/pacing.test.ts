/**
 * @failure A gitomic retry wait exceeds its cap, or two callers retry in step.
 * @level l0 — pure wait arithmetic over an injected random source.
 * @consumer 25676: engine and shell adopt @bearly/pacing full jitter.
 */
import { describe, expect, test } from "vitest"
import { delayForRetryMs } from "../src/engine.js"
import { waitOutHeldFetchLockMs } from "../src/shell.js"

const draws = [0, 0.001, 0.5, 0.999, 1 - 2 ** -53]

describe("delayForRetryMs", () => {
  test("never exceeds the 150ms cap", () => {
    for (const retries of [0, 1, 3, 6, 12, 100]) {
      for (const draw of draws) {
        expect(delayForRetryMs(retries, () => draw)).toBeLessThanOrEqual(150)
        expect(delayForRetryMs(retries, () => draw)).toBeGreaterThanOrEqual(0)
      }
    }
  })

  test("spreads attempt 0 over [0, 4]", () => {
    expect(delayForRetryMs(0, () => 0)).toBe(0)
    expect(delayForRetryMs(0, () => 0.5)).toBe(2)
    expect(delayForRetryMs(0, () => 1 - 2 ** -53)).toBeCloseTo(4, 10)
  })
})

describe("waitOutHeldFetchLockMs", () => {
  test("never exceeds 100ms and stays at or above 25ms", () => {
    for (const draw of draws) {
      const wait = waitOutHeldFetchLockMs(() => draw)
      expect(wait).toBeGreaterThanOrEqual(25)
      expect(wait).toBeLessThanOrEqual(100)
    }
  })

  test("spreads over the held-lock window", () => {
    expect(waitOutHeldFetchLockMs(() => 0)).toBe(25)
    expect(waitOutHeldFetchLockMs(() => 0.5)).toBe(62)
  })
})
