// @failure A snapshot omits the blob oid a writer needs to author a precondition, so every caller recomputes it by hand and drifts from what `apply` actually compares against.
// @level l1
// @consumer any agent reading a path to author a --base/--expect precondition for the next apply

import { Buffer } from "node:buffer"

import { describe, expect, test } from "vitest"

import { apply, open } from "../src/index.js"
import { objectOid } from "../src/git-object.js"
import { createMemBackend } from "../src/mem.js"

async function createStore(name: string) {
  return await open({ repo: name, ref: "main", writer: "snapshot-oid-test", backend: createMemBackend() })
}

/** The blob oid `apply`'s `expect` is compared against — what a caller must feed back. */
function oidOf(content: string): string {
  return objectOid("blob", Buffer.from(content, "utf8"))
}

describe("snapshot.oid — the read-side precondition anchor", () => {
  test("returns the git blob oid of a present path, matching what apply expects", async () => {
    const store = await createStore("oid-present")
    const base = await store.head()
    const created = await apply(
      store,
      base,
      [{ kind: "put", path: "a.md", content: "one\n", expect: null }],
      "create a",
    )

    const anchor = await store.at(created.oid).oid("a.md")
    expect(anchor).toBe(oidOf("one\n"))

    // The anchor read here feeds straight back as `expect`, and the replace lands —
    // proving the read-side oid is the same object the write-side precondition checks.
    const replaced = await apply(
      store,
      created.oid,
      [{ kind: "put", path: "a.md", content: "two\n", expect: anchor ?? null }],
      "replace a",
    )
    expect(await store.at(replaced.oid).get("a.md")).toBe("two\n")
  })

  test("returns undefined for an absent path — the create anchor is null, not an oid", async () => {
    const store = await createStore("oid-absent")
    const base = await store.head()
    expect(await store.at(base).oid("missing.md")).toBeUndefined()
  })

  test("tracks the tip: the oid changes with the content and is undefined once removed", async () => {
    const store = await createStore("oid-tracks")
    const base = await store.head()
    const created = await apply(store, base, [{ kind: "put", path: "a.md", content: "one\n", expect: null }], "create")

    const replaced = await apply(
      store,
      created.oid,
      [{ kind: "put", path: "a.md", content: "two\n", expect: oidOf("one\n") }],
      "replace",
    )
    expect(await store.at(replaced.oid).oid("a.md")).toBe(oidOf("two\n"))

    const removed = await apply(store, replaced.oid, [{ kind: "rm", path: "a.md", expect: oidOf("two\n") }], "rm")
    expect(await store.at(removed.oid).oid("a.md")).toBeUndefined()
  })
})
