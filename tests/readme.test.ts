// @failure The documented default could require a bare gitdir or mutate the user's checkout.
// @level l1
// @consumer README example users

import { access, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { describe, expect, test } from "vitest"

import { Conflict, open } from "../src/index.js"
import type { Store } from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import { createMemBackend } from "../src/mem.js"
import { createWorktreeRepo, gitFrom } from "./helpers/git.js"

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>

async function readmeExample(containing: string): Promise<string> {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8")
  const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)\n```/g)].map((match) => match[1] ?? "")
  const block = blocks.find((candidate) => candidate.includes(containing))
  if (block === undefined)
    throw new Error(`README TypeScript example containing ${JSON.stringify(containing)} not found`)
  return block.replace(/^import[^\n]+\n\n/, "")
}

async function runReadmeExample(containing: string, store: Store): Promise<void> {
  const execute = new AsyncFunction("store", "Conflict", await readmeExample(containing))
  await execute(store, Conflict)
}

describe("README example", () => {
  test("states the durability, topology, path, and trust boundaries", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8")

    for (const contract of [
      "Git 2.36",
      "core.fsync",
      "NFC",
      "symlink",
      "gitlink",
      "refs/gitomic/inflight",
      "local ref is then a cache",
      "path partition",
      "never rebases",
      "trusted perimeter",
      "not a security boundary",
    ]) {
      expect(readme).toContain(contract)
    }
  })

  test("accepts any directory inside a checkout and writes only to Git objects", async () => {
    const fixture = await createWorktreeRepo()
    try {
      const store = await open({ repo: fixture.nested, ref: "main", writer: "worker-3" })
      const before = store.at()

      await store.transact(async (map) => {
        map.set("notes/milk.md", "buy milk")
        map.set("index.md", ((await map.get("index.md")) ?? "") + "milk\n")
      }, "add note")

      expect(await before.keys()).toEqual([])
      expect(await store.at().get("notes/milk.md")).toBe("buy milk")
      expect(await gitFrom(fixture.repo, "show", "main:notes/milk.md")).toBe("buy milk")
      await expect(access(join(fixture.repo, "notes", "milk.md"))).rejects.toMatchObject({ code: "ENOENT" })
      expect(await gitFrom(fixture.repo, "status", "--short")).toContain("notes/milk.md")
    } finally {
      await fixture.cleanup()
    }
  })

  test("uses the common object and ref store from a linked worktree", async () => {
    const fixture = await createWorktreeRepo()
    const linked = join(dirname(fixture.repo), "linked")
    const nested = join(linked, "deep", "inside")
    try {
      await gitFrom(fixture.repo, "worktree", "add", "--quiet", "-b", "state", linked, "main")
      await mkdir(nested, { recursive: true })
      const shell = await open({ repo: nested, ref: "state", writer: "linked-shell" })
      const first = await shell.transact(async (map) => map.set("linked/shell", "one"), "write from linked shell")
      const iso = await open({ repo: nested, ref: "state", writer: "linked-iso", backend: createIsoBackend() })
      const second = await iso.transact(async (map) => map.set("linked/iso", "two"), "write from linked iso")

      expect(await gitFrom(fixture.repo, "rev-parse", "state")).toBe(second.oid)
      expect(await gitFrom(fixture.repo, "merge-base", "--is-ancestor", first.oid, second.oid)).toBe("")
      expect(await gitFrom(fixture.repo, "show", "state:linked/shell")).toBe("one")
      expect(await gitFrom(fixture.repo, "show", "state:linked/iso")).toBe("two")
    } finally {
      await fixture.cleanup()
    }
  })

  test("defers an invalid commit failure until a pinned snapshot is read", async () => {
    const fixture = await createWorktreeRepo()
    try {
      const store = await open({ repo: fixture.repo, ref: "main", writer: "worker-3" })
      const invalid = store.at("0000000000000000000000000000000000000000")
      await expect(invalid.keys()).rejects.toThrow()
    } finally {
      await fixture.cleanup()
    }
  })

  test("runs the archive loop as one atomic move", async () => {
    const store = await open({
      repo: "readme-archive",
      ref: "main",
      writer: "worker-3",
      backend: createMemBackend(),
    })
    await store.transact(async (map) => {
      map.set("inbox/one.md", "one")
      map.set("inbox/two.md", "two")
      map.set("archive/two.md", "already archived")
    }, "seed inbox")

    await runReadmeExample("archive inbox", store)

    expect(await store.at().get("archive/one.md")).toBe("one")
    expect(await store.at().get("archive/two.md")).toBe("already archived")
    expect(await store.at().get("inbox/one.md")).toBeUndefined()
    expect(await store.at().get("inbox/two.md")).toBe("two")
  })

  test("runs the deploy-lock Conflict demo verbatim on free and occupied locks", async () => {
    const backend = createMemBackend()
    const free = await open({ repo: "readme-lock-free", ref: "main", writer: "worker-3", backend })
    await runReadmeExample("take deploy lock", free)
    expect(await free.at().get("locks/deploy")).toBe("worker-3")

    const occupied = await open({ repo: "readme-lock-occupied", ref: "main", writer: "worker-4", backend })
    await occupied.transact(async (map) => map.set("locks/deploy", "worker-4"), "seed occupied lock")
    await expect(runReadmeExample("take deploy lock", occupied)).rejects.toBeInstanceOf(Conflict)
    expect(await occupied.at().get("locks/deploy")).toBe("worker-4")
  })
})
