/**
 * maintainStore beside live writers (hh 28530, @cto 24f0006f pin 4): the owner's upkeep runs OUTSIDE the write path
 * and may overlap it, so it must lose or refuse no write on either store shape.
 *
 * @failure pack-refs rewrites packed-refs under its own lock while ref updates take the same file's lock to delete or
 *   rewrite a packed entry; commit-graph rewrites the chain under readers. If either refused or lost a CAS publish on
 *   the kept copy, or a push into the state authority, the cure for a slow write would drop writes instead.
 * @level l1
 * @consumer the km daemon's publisher (kept copy, CAS ref publishes) and state-authority-pack (pushes), hh 28530
 * @testonly none
 */
import { execFile } from "node:child_process"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, test } from "vitest"
import { maintainStore, type StoreMaintenance } from "../src/index.js"
import { appendEmptyHistory, createBareRepo, git } from "./helpers/git.js"

const execFileAsync = promisify(execFile)
/** Full upkeep runs that must complete while the writers are still writing. */
const OVERLAP = 3
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** Run maintainStore back to back until `stop()`, keeping every outcome. */
function maintainLoop(repo: string) {
  const outcomes: StoreMaintenance[] = []
  let running = true
  const done = (async () => {
    while (running) outcomes.push(await maintainStore(repo, { timeoutMs: 30_000 }))
  })()
  return {
    outcomes,
    stop: async () => {
      running = false
      await done
    },
  }
}

async function attempt(cwd: string, args: string[]): Promise<{ ok: true } | { ok: false; stderr: string }> {
  try {
    await execFileAsync("git", args, { cwd })
    return { ok: true }
  } catch (error) {
    return { ok: false, stderr: String((error as { stderr?: unknown }).stderr ?? error) }
  }
}

describe("maintainStore overlapping writers loses and refuses no write", () => {
  test("kept-copy shape: CAS ref publishes all land while maintenance loops", async () => {
    const store = await createBareRepo()
    cleanups.push(store.cleanup)
    await appendEmptyHistory(store.repo, store.initial, 60)
    const commits = (await git(store.repo, "rev-list", "--reverse", "refs/heads/main")).split("\n").filter(Boolean)
    for (let index = 0; index < 200; index++) {
      await git(store.repo, "update-ref", `refs/km/items/i${index}`, commits[0] as string)
    }
    const loop = maintainLoop(store.repo)
    const refused: string[] = []
    const expected = new Map<string, string>()
    // Twenty refs advance by compare-and-swap, the way the publisher moves a ref (new value, old value): at least
    // twelve steps each, and on until upkeep has completed OVERLAP runs, so the overlap is structural, never timing.
    await Promise.all(
      Array.from({ length: 20 }, async (_, lane) => {
        const ref = `refs/km/items/i${lane}`
        let current = commits[0] as string
        for (let step = 1; step <= 12 || loop.outcomes.length < OVERLAP; step++) {
          const next = commits[(lane + step) % commits.length] as string
          const result = await attempt(store.repo, ["update-ref", ref, next, current])
          if (!result.ok) {
            refused.push(`${ref} ${current}->${next}: ${result.stderr.trim()}`)
            return
          }
          current = next
        }
        expected.set(ref, current)
      }),
    )
    await loop.stop()

    expect(refused).toEqual([])
    for (const [ref, oid] of expected) expect((await git(store.repo, "rev-parse", ref)).trim()).toBe(oid)
    // The writes really overlapped upkeep: several full maintenance runs happened while they ran.
    expect(loop.outcomes.length, "maintenance runs during the writes").toBeGreaterThanOrEqual(3)
    expect(loop.outcomes.filter((outcome) => outcome.outcome !== "maintained")).toEqual([])
  }, 120_000)

  test("state-authority shape: every push lands while maintenance loops on the receiving store", async () => {
    const origin = await createBareRepo()
    cleanups.push(origin.cleanup)
    await appendEmptyHistory(origin.repo, origin.initial, 20)
    for (let index = 0; index < 200; index++) {
      await git(origin.repo, "update-ref", `refs/km/items/i${index}`, origin.initial)
    }
    // Beside the origin, so the helper's own cleanup removes it.
    const pusher = join(dirname(origin.repo), "pusher.git")
    await execFileAsync("git", ["clone", "--quiet", "--bare", origin.repo, pusher])
    const loop = maintainLoop(origin.repo)
    const refused: string[] = []
    let tip = (await git(pusher, "rev-parse", "refs/heads/main")).trim()
    const tree = (await git(pusher, "rev-parse", "refs/heads/main^{tree}")).trim()
    let pushes = 0
    // At least thirty pushes, and on until upkeep has completed OVERLAP runs on the receiving store.
    for (let step = 0; step < 30 || loop.outcomes.length < OVERLAP; step++) {
      pushes = step + 1
      tip = (await git(pusher, "commit-tree", tree, "-p", tip, "-m", `push ${step}`)).trim()
      const result = await attempt(pusher, [
        "push",
        "--quiet",
        "--atomic",
        origin.repo,
        `${tip}:refs/heads/main`,
        `${tip}:refs/km/items/pushed${step}`,
      ])
      if (!result.ok) refused.push(`push ${step}: ${result.stderr.trim()}`)
    }
    await loop.stop()

    expect(refused).toEqual([])
    expect((await git(origin.repo, "rev-parse", "refs/heads/main")).trim()).toBe(tip)
    expect(
      (await git(origin.repo, "for-each-ref", "--format=%(refname)", "refs/km/items/pushed*"))
        .split("\n")
        .filter(Boolean),
    ).toHaveLength(pushes)
    // The writes really overlapped upkeep: several full maintenance runs happened while they ran.
    expect(loop.outcomes.length, "maintenance runs during the writes").toBeGreaterThanOrEqual(3)
    expect(loop.outcomes.filter((outcome) => outcome.outcome !== "maintained")).toEqual([])
  }, 120_000)
})
