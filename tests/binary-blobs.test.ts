// @failure One binary file anywhere in a tree makes every transaction on that tree impossible, because the whole-tree read decodes every blob as UTF-8 before the update function runs.
// @level l1
// @consumer any store whose tree mixes text with an image — e.g. a coordination repository of Markdown that also holds a screenshot

import { describe, expect, test } from "vitest"

import { apply, open, openReader } from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import { createBareRepo, git, gitWithInput } from "./helpers/git.js"

/** A byte sequence no UTF-8 decoder accepts, standing in for a real image. */
const BINARY = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80)

async function createMixedRepo(): Promise<{
  repo: string
  initial: string
  binaryOid: string
  cleanup(): Promise<void>
}> {
  const fixture = await createBareRepo()
  const binaryOid = await gitWithInput(fixture.repo, BINARY, "hash-object", "-w", "--stdin")
  const noteOid = await gitWithInput(fixture.repo, "# note\n", "hash-object", "-w", "--stdin")
  // `mktree` builds one level at a time, so nested paths are assembled bottom-up.
  const assets = await gitWithInput(fixture.repo, `100644 blob ${binaryOid}\tscreenshot.png\0`, "mktree", "-z")
  const notes = await gitWithInput(fixture.repo, `100644 blob ${noteOid}\tfirst.md\0`, "mktree", "-z")
  const tree = await gitWithInput(
    fixture.repo,
    `040000 tree ${assets}\tassets\0` + `040000 tree ${notes}\tnotes\0`,
    "mktree",
    "-z",
  )
  const commit = await git(fixture.repo, "commit-tree", tree, "-p", fixture.initial, "-m", "text beside an image")
  await git(fixture.repo, "update-ref", "refs/heads/main", commit, fixture.initial)
  return { repo: fixture.repo, initial: commit, binaryOid, cleanup: fixture.cleanup }
}

const backends = [
  { name: "shell", backend: undefined },
  { name: "iso", backend: createIsoBackend() },
] as const

describe.each(backends)("binary blobs ride through the $name backend", ({ name, backend }) => {
  test("a transaction that never touches the image commits, and the image survives byte-identical", async () => {
    const fixture = await createMixedRepo()
    try {
      const store = await open({
        repo: fixture.repo,
        ref: "main",
        writer: `binary-transact-${name}`,
        ...(backend === undefined ? {} : { backend }),
      })

      const committed = await store.transact(async (map) => {
        map.set("notes/second.md", "# second\n")
      }, "add a note to a tree that also holds an image")

      const listed = await git(fixture.repo, "ls-tree", "-r", committed.oid)
      expect(listed).toContain("notes/second.md")
      expect(listed).toContain("assets/screenshot.png")
      // Untouched means the SAME blob object, not merely a path that still exists.
      expect(listed).toContain(fixture.binaryOid)
      expect(await store.at(committed.oid).get("notes/first.md")).toBe("# note\n")
    } finally {
      await fixture.cleanup()
    }
  })

  test("keys and has report the image like any other entry, scoped and unscoped", async () => {
    const fixture = await createMixedRepo()
    try {
      const reader = await openReader({
        repo: fixture.repo,
        ref: "main",
        ...(backend === undefined ? {} : { backend }),
      })
      const snapshot = reader.at(fixture.initial)

      expect(await snapshot.keys()).toEqual(["assets/screenshot.png", "notes/first.md"])
      expect(await snapshot.keys("assets/")).toEqual(["assets/screenshot.png"])
      expect(await snapshot.has("assets/screenshot.png")).toBe(true)
      expect(await snapshot.has("assets/missing.png")).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })

  test("reading the image's VALUE is still refused, naming the path", async () => {
    const fixture = await createMixedRepo()
    try {
      const store = await open({
        repo: fixture.repo,
        ref: "main",
        writer: `binary-get-${name}`,
        ...(backend === undefined ? {} : { backend }),
      })

      // Snapshot reads and in-transaction reads refuse identically: gitomic v1
      // values are UTF-8 strings, and this blob is not one.
      await expect(store.at().get("assets/screenshot.png")).rejects.toThrow("valid UTF-8")
      await expect(store.at().get("assets/screenshot.png")).rejects.toThrow("assets/screenshot.png")
      await expect(
        store.transact(async (map) => {
          await map.get("assets/screenshot.png")
        }, "read the image inside a transaction"),
      ).rejects.toThrow("valid UTF-8")
    } finally {
      await fixture.cleanup()
    }
  })

  test("the image's oid is readable even though its value is not — the rm/mv anchor", async () => {
    const fixture = await createMixedRepo()
    try {
      const reader = await openReader({
        repo: fixture.repo,
        ref: "main",
        ...(backend === undefined ? {} : { backend }),
      })
      const snapshot = reader.at(fixture.initial)

      // `get` refuses the binary value, but `oid` returns the real git blob oid —
      // exactly the object `git hash-object` produced — so a caller can anchor an
      // rm/mv precondition on an image without ever decoding it.
      await expect(snapshot.get("assets/screenshot.png")).rejects.toThrow("valid UTF-8")
      expect(await snapshot.oid("assets/screenshot.png")).toBe(fixture.binaryOid)
      expect(await snapshot.oid("assets/missing.png")).toBeUndefined()
    } finally {
      await fixture.cleanup()
    }
  })

  test("native valid-UTF-8 BOM blobs retain every BOM byte through get, oid, and native-anchor apply", async () => {
    const fixture = await createBareRepo()
    try {
      // Native Git is the oracle: one and two leading BOMs are both valid UTF-8
      // content, and every stored U+FEFF must survive the read/write boundary.
      const singleBom = "\uFEFFone leading BOM\n"
      const doubleBom = "\uFEFF\uFEFFtwo leading BOMs\n"
      const singleBomOid = await gitWithInput(fixture.repo, singleBom, "hash-object", "-w", "--stdin")
      const doubleBomOid = await gitWithInput(fixture.repo, doubleBom, "hash-object", "-w", "--stdin")
      const tree = await gitWithInput(
        fixture.repo,
        `100644 blob ${singleBomOid}\tsingle-bom.txt\0` + `100644 blob ${doubleBomOid}\tdouble-bom.txt\0`,
        "mktree",
        "-z",
      )
      const base = await git(fixture.repo, "commit-tree", tree, "-p", fixture.initial, "-m", "native valid UTF-8 BOMs")
      await git(fixture.repo, "update-ref", "refs/heads/main", base, fixture.initial)
      const store = await open({
        repo: fixture.repo,
        ref: "main",
        writer: `bom-native-${name}`,
        ...(backend === undefined ? {} : { backend }),
      })
      const snapshot = store.at(base)

      expect.soft(await snapshot.get("single-bom.txt")).toBe(singleBom)
      expect.soft(await snapshot.get("double-bom.txt")).toBe(doubleBom)
      expect.soft(await snapshot.oid("single-bom.txt")).toBe(singleBomOid)
      expect.soft(await snapshot.oid("double-bom.txt")).toBe(doubleBomOid)

      const singleReplacement = "\uFEFFreplacement with one leading BOM\n"
      const doubleReplacement = "\uFEFF\uFEFFreplacement with two leading BOMs\n"
      const singleReplacementOid = await gitWithInput(fixture.repo, singleReplacement, "hash-object", "-w", "--stdin")
      const doubleReplacementOid = await gitWithInput(fixture.repo, doubleReplacement, "hash-object", "-w", "--stdin")
      const replaced = await apply(
        store,
        base,
        [
          { kind: "put", path: "single-bom.txt", content: singleReplacement, expect: singleBomOid },
          { kind: "put", path: "double-bom.txt", content: doubleReplacement, expect: doubleBomOid },
        ],
        "replace native valid UTF-8 BOM content",
      )

      expect(await store.at(replaced.oid).get("single-bom.txt")).toBe(singleReplacement)
      expect(await store.at(replaced.oid).get("double-bom.txt")).toBe(doubleReplacement)
      expect(await store.at(replaced.oid).oid("single-bom.txt")).toBe(singleReplacementOid)
      expect(await store.at(replaced.oid).oid("double-bom.txt")).toBe(doubleReplacementOid)
      expect(await git(fixture.repo, "rev-parse", `${replaced.oid}:single-bom.txt`)).toBe(singleReplacementOid)
      expect(await git(fixture.repo, "rev-parse", `${replaced.oid}:double-bom.txt`)).toBe(doubleReplacementOid)
    } finally {
      await fixture.cleanup()
    }
  })

  test("diff reports changed binary identities without decoding their values", async () => {
    const fixture = await createMixedRepo()
    try {
      const changedOid = await gitWithInput(
        fixture.repo,
        Uint8Array.of(0xff, 0x00, 0xfe),
        "hash-object",
        "-w",
        "--stdin",
      )
      const assets = await gitWithInput(fixture.repo, `100644 blob ${changedOid}\tscreenshot.png\0`, "mktree", "-z")
      const notes = await git(fixture.repo, "rev-parse", `${fixture.initial}:notes`)
      const tree = await gitWithInput(
        fixture.repo,
        `040000 tree ${assets}\tassets\0` + `040000 tree ${notes}\tnotes\0`,
        "mktree",
        "-z",
      )
      const next = await git(fixture.repo, "commit-tree", tree, "-p", fixture.initial, "-m", "change image")
      const reader = await openReader({ repo: fixture.repo, ...(backend === undefined ? {} : { backend }) })

      expect(await reader.diff(fixture.initial, next)).toEqual([
        { path: "assets/screenshot.png", from: fixture.binaryOid, to: changedOid },
      ])
      await expect(reader.at(next).get("assets/screenshot.png")).rejects.toThrow("valid UTF-8")
    } finally {
      await fixture.cleanup()
    }
  })

  test("the image can be deleted, and replacing it with text is a real change", async () => {
    const fixture = await createMixedRepo()
    try {
      const store = await open({
        repo: fixture.repo,
        ref: "main",
        writer: `binary-write-${name}`,
        ...(backend === undefined ? {} : { backend }),
      })

      const replaced = await store.transact(async (map) => {
        map.set("assets/screenshot.png", "now text\n")
      }, "replace the image with text")
      expect(await store.at(replaced.oid).get("assets/screenshot.png")).toBe("now text\n")

      const removed = await store.transact(async (map) => {
        map.delete("assets/screenshot.png")
      }, "delete the former image")
      expect(await store.at(removed.oid).has("assets/screenshot.png")).toBe(false)
    } finally {
      await fixture.cleanup()
    }
  })
})
