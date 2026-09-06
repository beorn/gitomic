import { open } from "../../src/index.js"

const [repo, writer, countText] = process.argv.slice(2)
if (repo === undefined || writer === undefined || countText === undefined) {
  throw new TypeError("usage: stress-writer <repo> <writer> <count>")
}
const count = Number(countText)
if (!Number.isSafeInteger(count) || count < 1) throw new TypeError("count must be a positive integer")

const store = await open({ repo, ref: "main", writer })
const committed = []
for (let index = 0; index < count; index += 1) {
  // transact owns contention: it retries the CAS within its time budget, so the
  // worker never wraps it in an outer retry loop. A RetriesExhausted escaping
  // here would be a real finding (the budget is too short for this load), so it
  // is left to fail loudly rather than swallowed and retried.
  committed.push(
    await store.transact(
      async (map) => {
        const value = Number((await map.get("count")) ?? "0")
        map.set("count", String(value + 1))
      },
      `${writer} operation ${index + 1}`,
    ),
  )
}
process.stdout.write(`${JSON.stringify({ committed })}\n`)
