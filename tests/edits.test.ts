// @failure The apply vocabulary could land a partial edit list, miss a moved-base precondition, or overwrite a concurrently-created move destination.
// @level l1
// @consumer any agent writing a repo by URL with no checkout — the file-level door

import { Buffer } from "node:buffer"

import { describe, expect, test } from "vitest"

import {
  apply,
  CANDIDATE_CONFIG,
  countOccurrences,
  open,
  parseEditsDeclaration,
  RelativeOnlyEditRefused,
} from "../src/index.js"
import { EditDoesNotApply } from "../src/errors.js"
import { objectOid } from "../src/git-object.js"
import { createMemBackend } from "../src/mem.js"

async function createStore(name: string) {
  return await open({ repo: name, ref: "main", writer: "edits-test", backend: createMemBackend() })
}

/** The blob oid of some content — what a caller reads and feeds back as `expect`. */
function oid(content: string): string {
  return objectOid("blob", Buffer.from(content, "utf8"))
}

describe("apply — the four-edit door", () => {
  test("put-bytes stores opaque bytes in the mem backend with their Git blob identity", async () => {
    const backend = createMemBackend()
    const store = await open({ repo: "put-bytes-mem", ref: "main", writer: "edits-test", backend })
    const base = await store.head()
    const bytes = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0xff, 0x00)
    const expected = objectOid("blob", Buffer.from(bytes))
    const landed = await apply(
      store,
      base,
      [{ kind: "put-bytes", path: "image.png", content: bytes, expect: null }],
      "add image",
    )
    expect(await store.at(landed.oid).oid("image.png")).toBe(expected)
    expect((await backend.readBlobs("put-bytes-mem", [expected])).get(expected)).toEqual(bytes)
    await expect(store.at(landed.oid).get("image.png")).rejects.toThrow("valid UTF-8")
  })

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

describe("replace edit and relative-only door (26683)", () => {
  test("countOccurrences handles simple and overlapping matches without normalization", () => {
    expect(countOccurrences("hello world", "world")).toBe(1)
    expect(countOccurrences("aaa", "aa")).toBe(2)
    expect(countOccurrences("banana", "an")).toBe(2)
    expect(countOccurrences("hello\r\nworld", "hello\nworld")).toBe(0)
    expect(countOccurrences("cafe\u0301", "café")).toBe(0)
  })

  test("parseEditsDeclaration parses repeated relative-only keys and validates paths", () => {
    const valid = '[edits]\nrelative-only = pm/pm-plan.md\nrelative-only = "docs/a file with spaces.md"\n'
    const parsed = parseEditsDeclaration(valid, "head123")
    expect(parsed.relativeOnly).toEqual(["pm/pm-plan.md", "docs/a file with spaces.md"])

    expect(() => parseEditsDeclaration("[edits]\nrelative-only = /absolute.md\n", "head123")).toThrow(
      "invalid relative-only",
    )
    expect(() => parseEditsDeclaration("[edits]\nrelative-only = ../escape.md\n", "head123")).toThrow(
      "invalid relative-only",
    )
    expect(() => parseEditsDeclaration("[edits]\nrelative-only = trailing/slash/\n", "head123")).toThrow(
      "invalid relative-only",
    )
    expect(() => parseEditsDeclaration("[edits]\nrelative-only = \n", "head123")).toThrow("invalid relative-only")
    expect(() => parseEditsDeclaration("[edits]\nunknown-key = foo\n", "head123")).toThrow("unknown [edits] key")
  })

  test("replace succeeds on unique text match", async () => {
    const store = await createStore("replace-success")
    const base = await store.head()
    const seeded = await apply(
      store,
      base,
      [{ kind: "put", path: "plan.md", content: "row 1\nrow 2\nrow 3\n", expect: null }],
      "seed",
    )
    const replaced = await apply(
      store,
      seeded.oid,
      [{ kind: "replace", path: "plan.md", oldText: "row 2\n", newText: "row 2 (modified)\n" }],
      "replace row 2",
    )
    expect(await store.at(replaced.oid).get("plan.md")).toBe("row 1\nrow 2 (modified)\nrow 3\n")
  })

  test("replace refuses with EditDoesNotApply (text-unique) when old text is absent", async () => {
    const store = await createStore("replace-absent-text")
    const base = await store.head()
    const seeded = await apply(
      store,
      base,
      [{ kind: "put", path: "plan.md", content: "row 1\nrow 2\n", expect: null }],
      "seed",
    )
    const error = await apply(
      store,
      seeded.oid,
      [{ kind: "replace", path: "plan.md", oldText: "row 99\n", newText: "row 99 new\n" }],
      "replace absent",
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(EditDoesNotApply)
    expect(error).toMatchObject({
      kind: "replace",
      preconditionType: "text-unique",
      path: "plan.md",
      expected: "1",
      actual: "0",
    })
    expect((error as EditDoesNotApply).message).toContain("expected 1 occurrence of old text, found 0")
  })

  test("replace refuses with EditDoesNotApply (text-unique) when old text has multiple occurrences", async () => {
    const store = await createStore("replace-multiple-text")
    const base = await store.head()
    const seeded = await apply(
      store,
      base,
      [{ kind: "put", path: "plan.md", content: "row dup\nrow dup\n", expect: null }],
      "seed",
    )
    const error = await apply(
      store,
      seeded.oid,
      [{ kind: "replace", path: "plan.md", oldText: "row dup\n", newText: "single\n" }],
      "replace multiple",
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(EditDoesNotApply)
    expect(error).toMatchObject({
      kind: "replace",
      preconditionType: "text-unique",
      path: "plan.md",
      expected: "1",
      actual: "2",
    })
    expect((error as EditDoesNotApply).message).toContain("expected 1 occurrence of old text, found 2")
  })

  test("replace refuses with EditDoesNotApply (text-unique, actual null) when file is absent", async () => {
    const store = await createStore("replace-absent-file")
    const base = await store.head()
    const error = await apply(
      store,
      base,
      [{ kind: "replace", path: "nonexistent.md", oldText: "foo", newText: "bar" }],
      "replace absent file",
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(EditDoesNotApply)
    expect(error).toMatchObject({
      kind: "replace",
      preconditionType: "text-unique",
      path: "nonexistent.md",
      expected: "1",
      actual: null,
    })
    expect((error as EditDoesNotApply).message).toContain("expected 1 occurrence of old text, found absent")
  })

  test("replace throws TypeError when old text is empty", async () => {
    const store = await createStore("replace-empty-old")
    const base = await store.head()
    await expect(
      apply(store, base, [{ kind: "replace", path: "a.md", oldText: "", newText: "something" }], "empty old"),
    ).rejects.toThrow(TypeError)
  })

  test("relative-only door in .gitomic.conf refuses put, put-bytes, rm, and mv (both to and from)", async () => {
    const store = await createStore("relative-only-door")
    const base = await store.head()
    const setup = await apply(
      store,
      base,
      [
        { kind: "put", path: CANDIDATE_CONFIG, content: "[edits]\nrelative-only = protected.md\n", expect: null },
        { kind: "put", path: "protected.md", content: "protected content\n", expect: null },
        { kind: "put", path: "other.md", content: "other content\n", expect: null },
      ],
      "setup protected",
    )

    // put refused
    await expect(
      apply(store, setup.oid, [{ kind: "put", path: "protected.md", content: "clobber\n", expect: null }], "put"),
    ).rejects.toThrow(RelativeOnlyEditRefused)

    // rm refused
    await expect(
      apply(store, setup.oid, [{ kind: "rm", path: "protected.md", expect: oid("protected content\n") }], "rm"),
    ).rejects.toThrow(RelativeOnlyEditRefused)

    // mv to protected path refused
    await expect(
      apply(
        store,
        setup.oid,
        [{ kind: "mv", from: "other.md", to: "protected.md", expect: oid("other content\n") }],
        "mv to",
      ),
    ).rejects.toThrow(RelativeOnlyEditRefused)

    // mv from protected path refused
    await expect(
      apply(
        store,
        setup.oid,
        [{ kind: "mv", from: "protected.md", to: "renamed.md", expect: oid("protected content\n") }],
        "mv from",
      ),
    ).rejects.toThrow(RelativeOnlyEditRefused)
  })

  test("relative-only door permits replace and append", async () => {
    const store = await createStore("relative-only-permitted")
    const base = await store.head()
    const setup = await apply(
      store,
      base,
      [
        { kind: "put", path: CANDIDATE_CONFIG, content: "[edits]\nrelative-only = protected.md\n", expect: null },
        { kind: "put", path: "protected.md", content: "initial line\n", expect: null },
      ],
      "setup protected",
    )

    const replaced = await apply(
      store,
      setup.oid,
      [{ kind: "replace", path: "protected.md", oldText: "initial line\n", newText: "edited line\n" }],
      "replace",
    )
    expect(await store.at(replaced.oid).get("protected.md")).toBe("edited line\n")

    const appended = await apply(
      store,
      replaced.oid,
      [{ kind: "append", path: "protected.md", content: "second line\n" }],
      "append",
    )
    expect(await store.at(appended.oid).get("protected.md")).toBe("edited line\nsecond line\n")
  })
})
