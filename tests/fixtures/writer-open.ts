import { open } from "../../src/index.js"

const repo = process.argv[2]
const writer = process.argv[3]
const mode = process.argv[4]
if (repo === undefined || writer === undefined) throw new TypeError("repo and writer arguments are required")

const store = await open({ repo, ref: "main", writer })
process.stdout.write("opened\n")
if (mode === "write") {
  await store.transact(async (map) => map.set(`${writer}/${process.pid}`, "landed"), "concurrent write")
}
if (mode === "hold") await new Promise<never>(() => undefined)
