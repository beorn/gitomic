/**
 * editsFromCheckout (25350 S1, @cto ruling 5e6ba33e): the library builder a
 * caller uses to turn the files it wrote in a checkout into gitomic edits, with
 * the same file read and auto-read precondition as the CLI's `put`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "vitest"

import { apply, editsFromCheckout, open } from "../src/index.js"
import { EditDoesNotApply } from "../src/errors.js"
import { createMemBackend } from "../src/mem.js"

const scratch = mkdtempSync(join(tmpdir(), "gitomic-checkout-edits-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let checkouts = 0

/** A checkout directory holding `files`, repository-relative. */
function checkout(files: Readonly<Record<string, string | Uint8Array>>): string {
  const root = join(scratch, `checkout-${String(checkouts++)}`)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  mkdirSync(root, { recursive: true })
  return root
}

/** A store whose tip holds `files`. */
async function storeWith(name: string, files: Readonly<Record<string, string>>) {
  const store = await open({ repo: name, ref: "main", writer: "checkout-edits-test", backend: createMemBackend() })
  const edits = Object.entries(files).map(([path, content]) => ({ kind: "put" as const, path, content, expect: null }))
  if (edits.length > 0) await apply(store, await store.head(), edits, "seed")
  return store
}

describe("editsFromCheckout — files a caller wrote become edits against the base it read", () => {
  test("a changed file is a put anchored on its base oid, a new one a create, a deleted one an rm; they land", async () => {
    const store = await storeWith("mixed", { "a.md": "old\n", "gone.md": "bye\n" })
    const base = await store.head()
    const snapshot = store.at(base)
    const root = checkout({ "a.md": "new\n", "dir/b.md": "fresh\n" })

    const edits = await editsFromCheckout(root, ["a.md", "dir/b.md", "gone.md"], snapshot)
    expect(edits).toEqual([
      { kind: "put", path: "a.md", content: "new\n", expect: await snapshot.oid("a.md") },
      { kind: "put", path: "dir/b.md", content: "fresh\n", expect: null },
      { kind: "rm", path: "gone.md", expect: await snapshot.oid("gone.md") },
    ])

    const landed = store.at((await apply(store, base, edits, "from the checkout")).oid)
    expect(await landed.get("a.md")).toBe("new\n")
    expect(await landed.get("dir/b.md")).toBe("fresh\n")
    expect(await landed.has("gone.md")).toBe(false)
  })

  test("the precondition is the base the caller read: a concurrent change to the path refuses the edit", async () => {
    const store = await storeWith("race", { "a.md": "old\n" })
    const base = await store.head()
    const edits = await editsFromCheckout(checkout({ "a.md": "mine\n" }), ["a.md"], store.at(base))
    await apply(
      store,
      base,
      [{ kind: "put", path: "a.md", content: "theirs\n", expect: (await store.at(base).oid("a.md")) ?? null }],
      "theirs",
    )
    await expect(apply(store, base, edits, "mine")).rejects.toBeInstanceOf(EditDoesNotApply)
  })

  test("a path absent from both, a path named twice, a non-UTF-8 file and an invalid path each refuse, naming it", async () => {
    const store = await storeWith("refusals", { "a.md": "x\n" })
    const snapshot = store.at(await store.head())
    const root = checkout({ "a.md": "y\n", "bin.dat": Uint8Array.from([0xff, 0xfe, 0x00]) })
    await expect(editsFromCheckout(root, ["missing.md"], snapshot)).rejects.toThrow(
      '"missing.md" is absent from the checkout',
    )
    await expect(editsFromCheckout(root, ["a.md", "a.md"], snapshot)).rejects.toThrow('"a.md" is named twice')
    await expect(editsFromCheckout(root, ["bin.dat"], snapshot)).rejects.toThrow("must be valid UTF-8")
    await expect(editsFromCheckout(root, ["../escape.md"], snapshot)).rejects.toThrow("invalid git tree path")
  })

  test("a path the checkout holds as a directory is an error, never read as a deletion", async () => {
    const store = await storeWith("dir", { "d/x.md": "x\n" })
    const root = checkout({ "d/x.md": "x\n" })
    await expect(editsFromCheckout(root, ["d"], store.at(await store.head()))).rejects.toThrow(/EISDIR|directory/)
  })
})
