// @failure An object-side write could land without the repository's own checks ever seeing it (git hooks never fire for
// commit-tree + update-ref), derived files could land in a second commit that readers catch half-done, a check could
// judge a tree other than the one that actually lands after a CAS replay, or a refused write could still move the ref.
// @level l1
// @consumer 24168 slice A: STATE prose/config writes through gitomic, and km's writes through the same transact()

import { describe, expect, test } from "vitest"

import { CandidateRefused } from "../src/errors.js"
import { apply, open, type CandidateContext } from "../src/index.js"
import { createMemBackend } from "../src/mem.js"

async function createStores(name: string) {
  const backend = createMemBackend()
  const a = await open({ repo: name, ref: "main", writer: "candidate-test-a", backend })
  const b = await open({ repo: name, ref: "main", writer: "candidate-test-b", backend })
  return { a, b }
}

describe("transact candidate — the repository's checks run inside the write, before the CAS", () => {
  test("the candidate sees the attempt's base and the changed paths, and what it derives lands in the same commit", async () => {
    const { a } = await createStores("derive")
    const seen: { base: string; changed: readonly string[] }[] = []
    const committed = await a.transact(
      async (map) => {
        map.set(".claude/x.md", "master\n")
      },
      "write a master",
      {
        candidate: async (context: CandidateContext) => {
          seen.push({ base: context.base, changed: context.changed })
          const master = await context.map.get(".claude/x.md")
          context.map.set(".agents/x.md", `mirror of ${master ?? ""}`)
          return { report: [] }
        },
      },
    )

    expect(seen).toEqual([{ base: expect.any(String), changed: [".claude/x.md"] }])
    const landed = a.at(committed.oid)
    expect(await landed.get(".claude/x.md")).toBe("master\n")
    expect(await landed.get(".agents/x.md")).toBe("mirror of master\n")
  })

  test("a refusal throws CandidateRefused with every reason, and the ref does not move", async () => {
    const { a } = await createStores("refuse")
    const before = await a.head()
    const refused = a.transact(
      async (map) => {
        map.set("pm/plan.md", "broken\n")
      },
      "a write its checks refuse",
      { candidate: async () => ({ refuse: ["pm/plan.md: outline row has no bead", "pm/plan.md: second reason"] }) },
    )

    await expect(refused).rejects.toBeInstanceOf(CandidateRefused)
    await expect(refused).rejects.toMatchObject({
      code: "candidate-refused",
      reasons: ["pm/plan.md: outline row has no bead", "pm/plan.md: second reason"],
    })
    expect(await a.head()).toBe(before)
  })

  test("a report never refuses: the write lands and the report comes back with the commit", async () => {
    const { a } = await createStores("report")
    const committed = await a.transact(
      async (map) => {
        map.set("docs/a.md", "a\n")
      },
      "a write with a whole-plan finding elsewhere",
      { candidate: async () => ({ report: ["pm-plan.md: bead 25228 is closed but its plan row still reads open"] }) },
    )

    expect(committed.report).toEqual(["pm-plan.md: bead 25228 is closed but its plan row still reads open"])
    expect(await a.at(committed.oid).get("docs/a.md")).toBe("a\n")
  })

  test("a CAS replay re-runs the candidate against the tree actually attempted", async () => {
    const { a, b } = await createStores("replay")
    const bases: string[] = []
    let raced = false
    const committed = await a.transact(
      async (map) => {
        map.set("docs/a.md", "a\n")
      },
      "a write that loses one race",
      {
        candidate: async (context) => {
          bases.push(context.base)
          if (!raced) {
            raced = true
            await b.transact(async (map) => map.set("docs/b.md", "b\n"), "the concurrent writer")
          }
          const seesB = await context.map.get("docs/b.md")
          return { report: [`b present: ${String(seesB !== undefined)}`] }
        },
      },
    )

    expect(bases).toHaveLength(2)
    expect(bases[0]).not.toBe(bases[1])
    expect(committed.report).toEqual(["b present: true"])
  })

  test("materialize writes the candidate as an unpublished commit whose tree is what would land", async () => {
    const { a } = await createStores("materialize")
    const before = await a.head()
    let materialized: string | undefined
    const committed = await a.transact(
      async (map) => {
        map.set("docs/a.md", "a\n")
      },
      "a write whose check reads a materialized candidate",
      {
        candidate: async (context) => {
          materialized = await context.materialize()
          return {}
        },
      },
    )

    expect(materialized).toBeDefined()
    expect(materialized).not.toBe(before)
    expect(await a.at(materialized).get("docs/a.md")).toBe("a\n")
    expect(await a.at(committed.oid).get("docs/a.md")).toBe("a\n")
  })

  test("readBase answers from the attempt's base, not from the candidate", async () => {
    const { a } = await createStores("read-base")
    await a.transact(async (map) => map.set(".gitomic.conf", "[candidate]\n\tcheck = old\n"), "declare the gate")
    let fromBase: string | undefined
    await a.transact(
      async (map) => {
        map.set(".gitomic.conf", "[candidate]\n\tcheck = new\n")
      },
      "a write that changes the gate",
      {
        candidate: async (context) => {
          fromBase = await context.readBase(".gitomic.conf")
          return {}
        },
      },
    )

    expect(fromBase).toBe("[candidate]\n\tcheck = old\n")
  })

  test("apply passes the candidate through, so the four-edit door is gated the same way", async () => {
    const { a } = await createStores("apply")
    const base = await a.head()
    const refused = apply(a, base, [{ kind: "put", path: "docs/a.md", content: "a\n", expect: null }], "gated apply", {
      candidate: async () => ({ refuse: ["docs/a.md: refused"] }),
    })

    await expect(refused).rejects.toBeInstanceOf(CandidateRefused)
    expect(await a.head()).toBe(base)
  })
})
