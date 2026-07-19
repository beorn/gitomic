import { open, RetriesExhausted } from "../../src/index.js"

const [repo, writer, countText] = process.argv.slice(2)
if (repo === undefined || writer === undefined || countText === undefined) {
  throw new TypeError("usage: stress-writer <repo> <writer> <count>")
}
const count = Number(countText)
if (!Number.isSafeInteger(count) || count < 1) throw new TypeError("count must be a positive integer")

const store = await open({ repo, ref: "main", writer })
const committed = []
let exhaustedCalls = 0
for (let index = 0; index < count; index += 1) {
  while (true) {
    try {
      committed.push(
        await store.transact(
          async (map) => {
            const value = Number((await map.get("count")) ?? "0")
            map.set("count", String(value + 1))
          },
          `${writer} operation ${index + 1}`,
        ),
      )
      break
    } catch (error) {
      if (!(error instanceof RetriesExhausted)) throw error
      exhaustedCalls += 1
    }
  }
}
process.stdout.write(`${JSON.stringify({ committed, exhaustedCalls })}\n`)
