// tsc copies a source file's shebang verbatim into its emitted output. `src/bin.ts` declares
// `#!/usr/bin/env bun` because the raw-TS bin only runs under Bun (it uses `using` and imports
// `.ts` specifiers directly), but the packed CLI (package.json `publishConfig.bin`) targets
// Node >=20 — which tsc's ES2022 lowering of `using` makes safe. This restores the Node shebang
// in the built file after `tsc` runs. Plain Node/ESM only: no Bun-only syntax, no `sed -i`.
import { readFile, writeFile } from "node:fs/promises"

const distBinPath = new URL("../dist/bin.js", import.meta.url)
const sourceShebang = "#!/usr/bin/env bun"
const publishedShebang = "#!/usr/bin/env node"

const content = await readFile(distBinPath, "utf8")
const newlineIndex = content.indexOf("\n")
if (newlineIndex === -1) {
  throw new Error(`dist/bin.js: expected a shebang line followed by file content, got a single line`)
}

const firstLine = content.slice(0, newlineIndex)
if (firstLine !== sourceShebang) {
  throw new Error(
    `dist/bin.js: expected first line ${JSON.stringify(sourceShebang)}, got ${JSON.stringify(firstLine)}; ` +
      "tsc's shebang emit or src/bin.ts's shebang changed — update this script rather than shipping the wrong one",
  )
}

await writeFile(distBinPath, publishedShebang + content.slice(newlineIndex))
