// @failure A ref the store cannot resolve is refused with Git's bare "Needed a single revision", naming neither the repository, nor one ref the store holds, nor the form that works, so a caller guesses at HEAD or a commit sha.
// @level l1
// @consumer any seat addressing <repo>#<ref>, which reads a shorthand as refs/heads/<name> and nothing else as a revision

import { describe, expect, test } from "vitest"

import { createShellBackend } from "../src/shell.js"
import { createBareRepo } from "./helpers/git.js"

describe("a refused ref names the repository, a ref it holds, and the form that works (38554)", () => {
  test("a full name the store does not hold is refused with the refs it does hold", async () => {
    const fixture = await createBareRepo()
    try {
      const shell = createShellBackend()
      const message = await shell.head(fixture.repo, "refs/heads/absent-branch").then(
        () => {
          throw new Error("expected the lookup to be refused")
        },
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      expect(message).toContain('ref "refs/heads/absent-branch" does not resolve in')
      expect(message).toContain(fixture.repo)
      expect(message).toContain("refs/heads/main")
      expect(message).toMatch(/<repo>#<ref>/)
      expect(message).toContain("HEAD and a bare commit sha are revisions, not refs")
      expect(message).toContain("Needed a single revision")
    } finally {
      await fixture.cleanup()
    }
  })

  test("a resolvable ref still resolves, unchanged", async () => {
    const fixture = await createBareRepo()
    try {
      const shell = createShellBackend()
      expect(await shell.head(fixture.repo, "refs/heads/main")).toBe(fixture.initial)
    } finally {
      await fixture.cleanup()
    }
  })
})
