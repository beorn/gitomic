// @failure The apply vocabulary could land a partial edit list, miss a moved-base precondition, or overwrite a concurrently-created move destination.
// @level l1
// @consumer any agent writing a repo by URL with no checkout — the file-level door

import { Buffer } from "node:buffer"

import { describe, expect, test } from "vitest"

import { apply } from "../src/index.js"
import { EditDoesNotApply } from "../src/errors.js"
import { objectOid } from "../src/git-object.js"
import { open } from "../src/index.js"
import { createMemBackend } from "../src/mem.js"

async function createStore(name: string) {
  return await open({ repo: name, ref: "main", writer: "edits-test", backend: createMemBackend() })
}

/** The blob oid of some content — what a caller reads and feeds back as `expect`. */
function oid(content: string): string {
  return objectOid("blob", Buffer.from(content, "utf8"))
}

describe("apply — the four-edit door", () => {
  test("put creates an absent path (expect null) and lands its content", async () => {
    const store = await createStore("put-create")
    const base = await store.head()

    const committed = await apply(
      store,
      base,
      [{ kind: "put", path: "a.md", content: "one\n", expect: null }],
      "create a",
    )

    expect(await store.at(committed.oid).get("a.md")).toBe("one\n")
  })

  test("put refuses when the path already exists but expect said absent", async () => {
    const store = await createStore("put-create-collision")
    const base = await store.head()
    const first = await apply(store, base, [{ kind: "put", path: "a.md", content: "one\n", expect: null }], "create a")

    // A second create against the same absent-anchor now sees a.md present.
    const error = await apply(
      store,
      first.oid,
      [{ kind: "put", path: "a.md", content: "two\n", expect: null }],
      "recreate a",
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(EditDoesNotApply)
    expect(error).toMatchObject({
      code: "edit-does-not-apply",
      kind: "put",
      preconditionType: "blob-absent",
      path: "a.md",
      expected: null,
      actual: oid("one\n"),
    })
    expect(await store.at(await store.head()).get("a.md")).toBe("one\n")
  })

  test("put replaces when the expect oid matches, refuses when the base moved that path", async () => {
    const store = await createStore("put-replace")
    const base = await store.head()
    const created = await apply(
      store,
      base,
      [{ kind: "put", path: "a.md", content: "one\n", expect: null }],
      "create a",
    )

    const replaced = await apply(
      store,
      created.oid,
      [{ kind: "put", path: "a.md", content: "two\n", expect: oid("one\n") }],
      "replace a",
    )
    expect(await store.at(replaced.oid).get("a.md")).toBe("two\n")

    // A writer authored against the "one" version, but the tree now holds "two".
    const stale = await apply(
      store,
      created.oid,
      [{ kind: "put", path: "a.md", content: "three\n", expect: oid("one\n") }],
      "stale replace",
    ).catch((e: unknown) => e)
    expect(stale).toBeInstanceOf(EditDoesNotApply)
    expect(stale).toMatchObject({
      kind: "put",
      preconditionType: "blob-identical",
      expected: oid("one\n"),
      actual: oid("two\n"),
    })
  })

  test("append carries no precondition and concatenates onto whatever is there", async () => {
    const store = await createStore("append")
    const base = await store.head()
    const created = await apply(
      store,
      base,
      [{ kind: "put", path: "log.md", content: "a\n", expect: null }],
      "start log",
    )

    const appended = await apply(store, created.oid, [{ kind: "append", path: "log.md", content: "b\n" }], "append b")
    expect(await store.at(appended.oid).get("log.md")).toBe("a\nb\n")

    // append onto an absent path starts it.
    const fresh = await apply(store, appended.oid, [{ kind: "append", path: "new.md", content: "x\n" }], "append fresh")
    expect(await store.at(fresh.oid).get("new.md")).toBe("x\n")
  })

  test("rm removes when the source oid matches, refuses on a moved source", async () => {
    const store = await createStore("rm")
    const base = await store.head()
    const created = await apply(
      store,
      base,
      [{ kind: "put", path: "a.md", content: "one\n", expect: null }],
      "create a",
    )

    const removed = await apply(store, created.oid, [{ kind: "rm", path: "a.md", expect: oid("one\n") }], "rm a")
    expect(await store.at(removed.oid).get("a.md")).toBeUndefined()

    const recreated = await apply(
      store,
      removed.oid,
      [{ kind: "put", path: "a.md", content: "two\n", expect: null }],
      "recreate",
    )
    const stale = await apply(
      store,
      created.oid,
      [{ kind: "rm", path: "a.md", expect: oid("one\n") }],
      "stale rm",
    ).catch((e: unknown) => e)
    expect(stale).toBeInstanceOf(EditDoesNotApply)
    expect(stale).toMatchObject({ kind: "rm", preconditionType: "source-identical", actual: oid("two\n") })
    expect(await store.at(recreated.oid).get("a.md")).toBe("two\n")
  })

  test("mv moves when source matches and destination is absent", async () => {
    const store = await createStore("mv")
    const base = await store.head()
    const created = await apply(
      store,
      base,
      [{ kind: "put", path: "from.md", content: "body\n", expect: null }],
      "create",
    )

    const moved = await apply(
      store,
      created.oid,
      [{ kind: "mv", from: "from.md", to: "to.md", expect: oid("body\n") }],
      "mv",
    )
    expect(await store.at(moved.oid).get("from.md")).toBeUndefined()
    expect(await store.at(moved.oid).get("to.md")).toBe("body\n")
  })

  test("mv refuses when the destination was concurrently created (no silent overwrite)", async () => {
    const store = await createStore("mv-dest")
    const base = await store.head()
    const setup = await apply(
      store,
      base,
      [
        { kind: "put", path: "from.md", content: "body\n", expect: null },
        { kind: "put", path: "to.md", content: "occupied\n", expect: null },
      ],
      "setup",
    )

    const error = await apply(
      store,
      setup.oid,
      [{ kind: "mv", from: "from.md", to: "to.md", expect: oid("body\n") }],
      "mv onto occupied",
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EditDoesNotApply)
    expect(error).toMatchObject({
      kind: "mv",
      preconditionType: "destination-absent",
      path: "to.md",
      actual: oid("occupied\n"),
    })
    // Nothing moved: both paths intact.
    expect(await store.at(setup.oid).get("from.md")).toBe("body\n")
    expect(await store.at(setup.oid).get("to.md")).toBe("occupied\n")
  })

  test("several edits are one all-or-nothing commit; a mid-list refusal lands nothing", async () => {
    const store = await createStore("atomic")
    const base = await store.head()
    const created = await apply(
      store,
      base,
      [{ kind: "put", path: "a.md", content: "one\n", expect: null }],
      "create a",
    )

    // The first edit would apply, the second refuses — the whole apply must land nothing.
    const error = await apply(
      store,
      created.oid,
      [
        { kind: "put", path: "b.md", content: "new\n", expect: null },
        { kind: "put", path: "a.md", content: "clobber\n", expect: null },
      ],
      "atomic batch",
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(EditDoesNotApply)
    // b.md never landed; a.md unchanged.
    const tip = await store.head()
    expect(await store.at(tip).get("b.md")).toBeUndefined()
    expect(await store.at(tip).get("a.md")).toBe("one\n")
  })
})
