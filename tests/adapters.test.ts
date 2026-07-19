// @failure Familiar interface adapters could bypass replay, expose writable tip views, or fail real consumers.
// @level l1
// @consumer node:fs, KV, and unstorage callers

import { createStorage } from "unstorage"
import { describe, expect, test } from "vitest"

import { asFs, asKv, asUnstorage, ReadOnlyError, withFs } from "../src/adapters.js"
import { open } from "../src/index.js"
import { createMemBackend } from "../src/mem.js"

async function createStore(name: string) {
  return await open({ repo: name, ref: "main", writer: "adapter-test", backend: createMemBackend() })
}

describe("adapter contracts", () => {
  test("withFs keeps fs-shaped writes and reads inside one transaction", async () => {
    const store = await createStore("with-fs")

    const committed = await store.transact(
      withFs(async (fs) => {
        await fs.writeFile("notes/today.md", "first")
        expect(await fs.readFile("notes/today.md", "utf8")).toBe("first")
        await fs.rename("notes/today.md", "archive/today.md")
        await fs.writeFile("index.md", Buffer.from("archive/today.md\n"))
        expect(await fs.readdir("archive")).toEqual(["today.md"])
      }),
      "archive note",
    )

    expect(await store.at(committed.oid).keys()).toEqual(["archive/today.md", "index.md"])
    expect(await store.at(committed.oid).get("notes/today.md")).toBeUndefined()
  })

  test("asFs tracks the tip for reads and rejects every mutating face", async () => {
    const store = await createStore("as-fs")
    const files = asFs(store)
    await store.transact(async (map) => map.set("one.txt", "one"), "seed")

    expect(await files.readFile("one.txt", "utf8")).toBe("one")
    expect(await files.readFile("one.txt", "base64")).toBe(Buffer.from("one").toString("base64"))
    const access = files.access
    await expect(access("one.txt")).resolves.toBeUndefined()
    await expect(files.writeFile("two.txt", "two")).rejects.toBeInstanceOf(ReadOnlyError)
    await expect(files.rm("one.txt")).rejects.toMatchObject({ code: "EROFS" })
    expect(await store.at().keys()).toEqual(["one.txt"])
  })

  test("asKv makes each write one named transaction", async () => {
    const store = await createStore("as-kv")
    const kv = asKv(store)

    await kv.set("settings/theme", "dark", "choose theme")
    expect(await kv.get("settings/theme")).toBe("dark")
    expect(await kv.has("settings/theme")).toBe(true)
    expect(await kv.keys("settings/")).toEqual(["settings/theme"])
    await kv.delete("settings/theme", "remove theme")
    expect(await kv.get("settings/theme")).toBeUndefined()
  })

  test("asUnstorage is accepted by createStorage and round-trips values", async () => {
    const store = await createStore("unstorage")
    const storage = createStorage({ driver: asUnstorage(store) })

    await storage.setItem("profile", { name: "Ada", active: true })
    expect(await storage.getItem("profile")).toEqual({ name: "Ada", active: true })
    expect(await storage.getKeys()).toEqual(["profile"])
    await storage.removeItem("profile")
    expect(await storage.hasItem("profile")).toBe(false)
  })
})
