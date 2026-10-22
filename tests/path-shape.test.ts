// @failure A cut to the whole-tree shape check's per-path allocation changes which tree it refuses or what the refusal says: a path a backend returned slips through, a valid tree is refused, or a collision names another pair (29914 step 3a).
// @level l1
// @consumer every gitomic transaction on a large tree, through assertExposed and assertNextTree; km's STATE rail validates about 80k paths per create
// @testonly none: assertTreeShape and assertUtf8 are the production checks assertExposed and assertNextTree call.

import { describe, expect, test } from "vitest"

import { TreePathCollision } from "../src/errors.js"
import { assertTreeShape } from "../src/path.js"
import { assertUtf8 } from "../src/utf8.js"

/** The exact refusal a shape check throws for `paths`, by class and message. */
function refusal(paths: unknown[]): { readonly name: string; readonly message: string } {
  try {
    assertTreeShape(paths as string[])
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return { name: error.name, message: error.message }
  }
  throw new Error(`accepted ${JSON.stringify(paths)}`)
}

describe("the whole-tree shape check refuses with today's exact messages (29914 step 3a)", () => {
  test("a path that is not a string", () => {
    expect(refusal([42])).toEqual({
      name: "TypeError",
      message: "Git tree paths returned by a backend must be a UTF-8 string",
    })
  })

  test.each([
    ["a lone high surrogate", "a/b\uD800c"],
    ["a lone low surrogate", "a/b\uDC00c"],
    ["a reversed pair", "a/b\uDC00\uD800c"],
  ])("a path holding %s", (_case, path) => {
    expect(refusal([path])).toEqual({
      name: "TypeError",
      message:
        "Git tree paths returned by a backend must be valid UTF-8; unpaired Unicode surrogates are not supported",
    })
  })

  test("a path that is not NFC, checked before its components", () => {
    expect(refusal(["é/"])).toEqual({
      name: "Error",
      message:
        'Git tree path is not NFC-normalized: "é/"; rewrite the repository path in NFC before opening it with gitomic',
    })
  })

  test.each([
    ["", '""'],
    ["/a", '"/a"'],
    ["a/", '"a/"'],
    ["a\\b", '"a\\\\b"'],
    ["a\0b", '"a\\u0000b"'],
    ["a//b", '"a//b"'],
    [".", '"."'],
    ["..", '".."'],
    ["./a", '"./a"'],
    ["a/./b", '"a/./b"'],
    ["a/../b", '"a/../b"'],
    ["a/..", '"a/.."'],
  ])("the invalid path %j", (path, quoted) => {
    expect(refusal([path])).toEqual({ name: "Error", message: `backend returned an invalid Git tree path: ${quoted}` })
  })

  test("gitomic's own namespace", () => {
    expect(refusal([".gitomic"])).toEqual({
      name: "Error",
      message: '".gitomic" is reserved by gitomic; rename that repository path before opening it with gitomic',
    })
  })

  test("a file that is also a directory prefix", () => {
    const thrown = (() => {
      try {
        assertTreeShape(["a", "a/b"])
      } catch (error) {
        return error
      }
      throw new Error("accepted a collision")
    })()
    expect(thrown).toBeInstanceOf(TreePathCollision)
    expect(thrown).toMatchObject({
      file: "a",
      descendant: "a/b",
      message:
        'Git tree path collision: "a" is both a file and a directory prefix for "a/b"; delete one side in the same transaction',
    })
  })
})

describe("the shape check names the same collision whatever paths share a directory (29914 step 3a)", () => {
  test.each([
    // The first path in order with a stored ancestor, and its shortest stored ancestor.
    [["a/b/c", "a", "a/b"], "a", "a/b/c"],
    [["r/s/1", "r/s/2", "r/t", "r/s"], "r/s", "r/s/1"],
    // Siblings in one directory, then a directory of the same length that differs: never skipped as the same one.
    [["a/x/1", "a/x/2", "b/y/2", "b/y"], "b/y", "b/y/2"],
    [["a/b/c/1", "a/b/d/2", "a/b/d"], "a/b/d", "a/b/d/2"],
    // A top-level path, then a nested one whose ancestor is stored.
    [["top", "m/n/1", "m/n/2", "m"], "m", "m/n/1"],
  ])("%j refuses %j as a file over %j", (paths, file, descendant) => {
    expect(refusal(paths)).toEqual({
      name: "TreePathCollision",
      message: `Git tree path collision: ${JSON.stringify(file)} is both a file and a directory prefix for ${JSON.stringify(descendant)}; delete one side in the same transaction`,
    })
  })

  test("a tree of siblings, nested directories and dot-leading names is accepted", () => {
    expect(() =>
      assertTreeShape([
        "...",
        ".a",
        "a..",
        "..a",
        "a/.b/c",
        "a/...",
        "a/b-1.md",
        "a/b/1.md",
        "a/b/2.md",
        "a/b/c/1.md",
        "a/b.md",
        "a/c.md",
        "\u{1F600}/emoji.md",
      ]),
    ).not.toThrow()
  })
})

describe("assertUtf8 keeps its messages (29914 step 3a)", () => {
  test("a valid astral pair passes and a non-string is refused as before", () => {
    expect(() => assertUtf8("a\u{1F600}b", "label")).not.toThrow()
    expect(() => assertUtf8(7, "label")).toThrow(new TypeError("label must be a UTF-8 string"))
  })
})
