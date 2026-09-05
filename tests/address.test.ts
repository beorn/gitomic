// @failure A repo-and-ref address is split on the wrong `#`, or an empty half is accepted, so the CLI opens the wrong ref or a nameless repository.
// @level l1
// @consumer the file-level-door CLI, which takes a repository and ref as one <repo>#<ref> argument

import { describe, expect, test } from "vitest"

import { parseAddress } from "../src/address.js"

describe("parseAddress — <repo>#<ref>", () => {
  test("splits a repo and ref on the first #", () => {
    expect(parseAddress("repo#ref")).toEqual({ repo: "repo", ref: "ref" })
    expect(parseAddress("/hh/pm#main")).toEqual({ repo: "/hh/pm", ref: "main" })
    expect(parseAddress(".#state")).toEqual({ repo: ".", ref: "state" })
  })

  test("keeps a URL's own punctuation in the repo half", () => {
    expect(parseAddress("git@github.com:beorn/gitomic.git#refs/heads/state")).toEqual({
      repo: "git@github.com:beorn/gitomic.git",
      ref: "refs/heads/state",
    })
    expect(parseAddress("https://example.com/x.git#main")).toEqual({
      repo: "https://example.com/x.git",
      ref: "main",
    })
  })

  test("splits on the first # only, so a ref may itself contain #", () => {
    // The repository half never contains '#'; the ref keeps everything after the first.
    expect(parseAddress("repo#feature#42")).toEqual({ repo: "repo", ref: "feature#42" })
  })

  test("defaults the ref to main when no # is present, honoring an override", () => {
    expect(parseAddress("/hh/pm")).toEqual({ repo: "/hh/pm", ref: "main" })
    expect(parseAddress("/hh/pm", "state")).toEqual({ repo: "/hh/pm", ref: "state" })
  })

  test("refuses an empty address, an empty repo half, or an empty ref half", () => {
    expect(() => parseAddress("")).toThrow(/empty/)
    expect(() => parseAddress("#main")).toThrow(/repository/)
    expect(() => parseAddress("repo#")).toThrow(/ref/)
  })
})
