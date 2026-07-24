// @failure Installing the default shell entrypoint could pull an unused runtime dependency.
// @level l1
// @consumer package installers

import { access, readFile } from "node:fs/promises"

import { describe, expect, test } from "vitest"

type PackageManifest = {
  dependencies?: Record<string, string>
  exports?: Record<string, PackageExport>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  publishConfig?: {
    access?: string
    exports?: Record<string, PackageExport>
  }
  types?: string
}

type PackageExport = string | { import?: string; types?: string }

async function manifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest
}

describe("package dependency boundary", () => {
  test("keeps the default install runtime-free and makes isomorphic-git an optional peer", async () => {
    const packageManifest = await manifest()

    expect(packageManifest.dependencies).toBeUndefined()
    expect(packageManifest.optionalDependencies).toBeUndefined()
    expect(packageManifest.peerDependencies).toEqual({ "isomorphic-git": "^1.38.7" })
    expect(packageManifest.peerDependenciesMeta).toEqual({ "isomorphic-git": { optional: true } })
  })

  test("resolves workspaces from tracked source while publishing built entrypoints", async () => {
    const packageManifest = await manifest()
    const sourceExports = {
      ".": "./src/index.ts",
      "./adapters": "./src/adapters.ts",
      "./iso": "./src/iso.ts",
      "./mem": "./src/mem.ts",
    }

    expect(packageManifest.types).toBeUndefined()
    expect(packageManifest.exports).toEqual(sourceExports)
    for (const target of Object.values(sourceExports)) {
      await expect(access(new URL(`..${target.slice(1)}`, import.meta.url))).resolves.toBeUndefined()
    }
    expect(packageManifest.publishConfig).toEqual({
      access: "public",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
        "./adapters": { types: "./dist/adapters.d.ts", import: "./dist/adapters.js" },
        "./iso": { types: "./dist/iso.d.ts", import: "./dist/iso.js" },
        "./mem": { types: "./dist/mem.d.ts", import: "./dist/mem.js" },
      },
    })
  })
})
