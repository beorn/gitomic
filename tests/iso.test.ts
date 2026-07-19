// @failure The fast backend could serialize different Git objects or weaken delete semantics.
// @level l1
// @consumer gitomic users opting into isomorphic-git

import { describe, expect, test } from "vitest"

import { open } from "../src/index.js"
import type { GitMap } from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import { createMemBackend } from "../src/mem.js"
import { createBareRepo } from "./helpers/git.js"

describe("iso backend", () => {
  test("keeps shell, iso, and mem object-id equivalent across writes and deletion", async () => {
    const shellFixture = await createBareRepo()
    const isoFixture = await createBareRepo()
    try {
      const shell = await open({ repo: shellFixture.repo, ref: "main", writer: "same-writer" })
      const iso = await open({
        repo: isoFixture.repo,
        ref: "main",
        writer: "same-writer",
        backend: createIsoBackend(),
      })
      const mem = await open({
        repo: "three-backend-equivalence",
        ref: "main",
        writer: "same-writer",
        backend: createMemBackend(),
      })
      const stores = [shell, iso, mem]
      expect(new Set(await Promise.all(stores.map(async (store) => await store.head())))).toHaveLength(1)
      const first = async (map: GitMap): Promise<void> => {
        map.set("nested/a.txt", "a\n")
        map.set("nested/deeper/b.txt", "b\n")
        map.set("root.txt", "root\n")
      }
      const firstCommits = await Promise.all(stores.map(async (store) => await store.transact(first, "first")))
      expect(new Set(firstCommits.map((commit) => commit.oid))).toHaveLength(1)

      const second = async (map: GitMap): Promise<void> => {
        map.delete("nested/a.txt")
        map.set("nested/deeper/b.txt", `${await map.get("nested/deeper/b.txt")}changed\n`)
      }
      const secondCommits = await Promise.all(stores.map(async (store) => await store.transact(second, "second")))

      expect(new Set(secondCommits.map((commit) => commit.oid))).toHaveLength(1)
      expect(await iso.at().keys()).toEqual(["nested/deeper/b.txt", "root.txt"])
      expect(await iso.at().get("nested/deeper/b.txt")).toBe("b\nchanged\n")
    } finally {
      await Promise.all([shellFixture.cleanup(), isoFixture.cleanup()])
    }
  })
})
