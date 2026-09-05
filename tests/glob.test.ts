// @failure The read verbs' path filter treats `*` as crossing directories, or lets a regex metacharacter in a pattern match more than the literal path, so a glob silently selects the wrong files.
// @level l1
// @consumer any read verb (ls/grep) that filters tree paths by a caller-supplied pattern

import { describe, expect, test } from "vitest"

import { matchGlob } from "../src/glob.js"

describe("matchGlob — git :(glob) / gitignore wildcard semantics", () => {
  test("* matches within one segment and never crosses a slash", () => {
    expect(matchGlob("*.md", "a.md")).toBe(true)
    expect(matchGlob("*.md", "notes.md")).toBe(true)
    expect(matchGlob("*.md", "notes/a.md")).toBe(false)
    expect(matchGlob("notes/*.md", "notes/a.md")).toBe(true)
    expect(matchGlob("notes/*.md", "notes/deep/a.md")).toBe(false)
    expect(matchGlob("*", "top")).toBe(true)
    expect(matchGlob("*", "a/b")).toBe(false)
  })

  test("? matches exactly one character, never a slash", () => {
    expect(matchGlob("a?.md", "ab.md")).toBe(true)
    expect(matchGlob("a?.md", "a.md")).toBe(false)
    expect(matchGlob("a?.md", "abc.md")).toBe(false)
    expect(matchGlob("a?b", "a/b")).toBe(false)
  })

  test("** crosses directories — leading, middle, trailing, and bare", () => {
    // leading **/ matches in every directory, including zero
    expect(matchGlob("**/a.md", "a.md")).toBe(true)
    expect(matchGlob("**/a.md", "x/a.md")).toBe(true)
    expect(matchGlob("**/a.md", "x/y/a.md")).toBe(true)
    expect(matchGlob("**/a.md", "x/a.txt")).toBe(false)

    // middle /**/ matches zero or more segments
    expect(matchGlob("pm/**/x.md", "pm/x.md")).toBe(true)
    expect(matchGlob("pm/**/x.md", "pm/a/x.md")).toBe(true)
    expect(matchGlob("pm/**/x.md", "pm/a/b/x.md")).toBe(true)
    expect(matchGlob("pm/**/x.md", "other/x.md")).toBe(false)

    // trailing /** matches everything beneath, but not the directory itself
    expect(matchGlob("pm/**", "pm/x.md")).toBe(true)
    expect(matchGlob("pm/**", "pm/a/b.md")).toBe(true)
    expect(matchGlob("pm/**", "pm")).toBe(false)
    expect(matchGlob("pm/**", "other/x")).toBe(false)

    // bare ** matches anything at any depth
    expect(matchGlob("**", "top.md")).toBe(true)
    expect(matchGlob("**", "a/b/c.md")).toBe(true)
  })

  test("** that is not a whole segment degrades to a single * (stays in-segment)", () => {
    expect(matchGlob("a**b", "axxb")).toBe(true)
    expect(matchGlob("a**b", "ab")).toBe(true)
    expect(matchGlob("a**b", "a/b")).toBe(false)
  })

  test("a literal pattern is an exact match", () => {
    expect(matchGlob("pm/@i/14-substrate.md", "pm/@i/14-substrate.md")).toBe(true)
    expect(matchGlob("pm/@i/14-substrate.md", "pm/@i/15-other.md")).toBe(false)
    expect(matchGlob("pm/@i/*.md", "pm/@i/14-substrate.md")).toBe(true)
    expect(matchGlob("pm/@i/*.md", "pm/@i/nested/x.md")).toBe(false)
  })

  test("character classes select and negate, and never match a slash", () => {
    expect(matchGlob("[abc].md", "a.md")).toBe(true)
    expect(matchGlob("[abc].md", "d.md")).toBe(false)
    expect(matchGlob("[!abc].md", "d.md")).toBe(true)
    expect(matchGlob("[!abc].md", "a.md")).toBe(false)
    expect(matchGlob("x[0-9].md", "x7.md")).toBe(true)
    expect(matchGlob("x[0-9].md", "xa.md")).toBe(false)
    // an unterminated [ is a literal bracket
    expect(matchGlob("a[b.md", "a[b.md")).toBe(true)
  })

  test("regex metacharacters in a pattern are literal, not regex", () => {
    expect(matchGlob("a.b+c(d).md", "a.b+c(d).md")).toBe(true)
    expect(matchGlob("a.b+c(d).md", "aXbYcZdW.md")).toBe(false)
    expect(matchGlob("v1.2.3", "v1.2.3")).toBe(true)
    expect(matchGlob("v1.2.3", "v1x2y3")).toBe(false)
  })

  test("pattern and path are compared in NFC, so composition never hides a match", () => {
    const composed = "café.md" // é as one code point (NFC)
    const decomposed = "café.md" // e + combining acute (NFD)
    expect(matchGlob(composed, decomposed)).toBe(true)
    expect(matchGlob(decomposed, composed)).toBe(true)
    expect(matchGlob("caf*.md", decomposed)).toBe(true)
  })
})
