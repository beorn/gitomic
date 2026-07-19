// @failure Installing the default shell entrypoint could pull an unused runtime dependency.
// @level l1
// @consumer package installers

import { readFile } from "node:fs/promises"

import { describe, expect, test } from "vitest"

type PackageManifest = {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

describe("package dependency boundary", () => {
  test("keeps the default install runtime-free and makes isomorphic-git an optional peer", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest

    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.optionalDependencies).toBeUndefined()
    expect(manifest.peerDependencies).toEqual({ "isomorphic-git": "^1.38.7" })
    expect(manifest.peerDependenciesMeta).toEqual({ "isomorphic-git": { optional: true } })
  })
})
