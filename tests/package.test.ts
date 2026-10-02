// @failure Workspace imports can depend on ignored build output, while package installs can expose the wrong entrypoints or runtime dependencies.
// @level l1
// @consumer workspace and package consumers

import { execFile } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import { promisify } from "node:util"

import { describe, expect, test } from "vitest"
import { openReader } from "../src/index.js"
import { asFs } from "../src/adapters.js"
import {
  CandidateRefused,
  EditDoesNotApply,
  GitSignaled,
  GitTimeout,
  PublicationRejected,
  PublicationUnknown,
  RelativeOnlyEditRefused,
  RetriesExhausted,
  TreePathCollision,
} from "../src/errors.js"
import { open } from "../src/index.js"
import { createMemBackend } from "../src/mem.js"
import { batchCheck } from "../src/shell.js"

type PackageManifest = {
  version: string
  files?: string[]
  packageManager?: string
  dependencies?: Record<string, string>
  exports?: Record<string, PackageExport>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  publishConfig?: {
    exports?: Record<string, PackageExport>
  }
  types?: string
}

type PackageExport = string | { import?: string; types?: string }

async function manifest(): Promise<PackageManifest> {
  return JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as PackageManifest
}

function expectParameterProperties(error: unknown, values: Record<string, unknown>) {
  expect(error).toBeInstanceOf(Error)
  const descriptors = Object.getOwnPropertyDescriptors(error)
  for (const [field, value] of Object.entries(values)) {
    expect(descriptors[field], field).toEqual({ value, writable: true, enumerable: true, configurable: true })
  }
  expect(Object.keys(error as Error).slice(0, Object.keys(values).length)).toEqual(Object.keys(values))
}

describe("package dependency boundary", () => {
  test.each([
    [new TreePathCollision("file", "file/child"), { file: "file", descendant: "file/child" }],
    [new RetriesExhausted(2, 100), { retries: 2, budgetMs: 100 }],
    [
      new PublicationUnknown("origin", new Error("unreachable"), "no-receipt"),
      { label: "origin", verified: "no-receipt", attempt: undefined },
    ],
    [new PublicationRejected([], [], "denied"), { updates: [], reasons: [], detail: "denied" }],
    [
      new EditDoesNotApply(0, "put", "blob-identical", "file", "file", null, null, "base", "head"),
      {
        editIndex: 0,
        kind: "put",
        preconditionType: "blob-identical",
        path: "file",
        anchor: "file",
        expected: null,
        actual: null,
        base: "base",
        head: "head",
      },
    ],
    [new RelativeOnlyEditRefused("file", "put", "head"), { path: "file", kind: "put", head: "head" }],
    [new GitTimeout("git fetch", 100), { command: "git fetch", timeoutMs: 100 }],
    [
      new GitSignaled("git fetch", "SIGTERM", "stopped"),
      { command: "git fetch", signal: "SIGTERM", stderr: "stopped" },
    ],
    [new CandidateRefused([], "base"), { reasons: [], base: "base" }],
  ] as const)("preserves parameter-property descriptors for %s", (error, values) => {
    expectParameterProperties(error, values)
  })

  test("preserves private batch-check error properties through its public operation", async () => {
    const error = await batchCheck("descriptor-test", ["HEAD"], {
      run: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    }).catch((reason: unknown) => reason)
    expectParameterProperties(error, { answered: 0, requested: 1 })
  })

  test("preserves private filesystem error properties through the public adapter", async () => {
    const store = await open({ repo: "descriptor-test", ref: "main", backend: createMemBackend() })
    const error = await asFs(store)
      .readFile("missing")
      .catch((reason: unknown) => reason)
    expectParameterProperties(error, { code: "ENOENT" })
  })

  test("imports tracked workspace source and executes the public runner under ordinary Node", async () => {
    const entry = new URL("../src/index.ts", import.meta.url).href
    const { stdout, stderr } = await promisify(execFile)(
      "node",
      [
        "--input-type=module",
        "-e",
        `const { runCommand } = await import(${JSON.stringify(entry)});
       const result = await runCommand(process.execPath, ["-e", "process.stdout.write('source-runner'); process.stderr.write('diagnostic'); process.exitCode = 7"]);
       console.log(JSON.stringify({code: result.code, stdout: result.stdout.toString(), stderr: result.stderr.toString()}));`,
      ],
      { timeout: 10_000 },
    )
    expect(stderr).toBe("")
    expect(JSON.parse(stdout)).toEqual({ code: 7, stdout: "source-runner", stderr: "diagnostic" })
  })

  test("depends only on the checkout lock's flock and makes isomorphic-git an optional peer", async () => {
    const packageManifest = await manifest()

    // @bearly/flock is the estate's one fd-held flock; @bearly/pacing is the shared retry jitter (25676);
    // @bearly/cli-process is the shared CLI entry that lets stdout drain (hh 27071). None imports gitomic.
    expect(packageManifest.dependencies).toEqual({
      "@bearly/cli-process": "^0.1.0",
      "@bearly/flock": "^0.2.2",
      "@bearly/pacing": "^0.1.0",
    })
    expect(packageManifest.optionalDependencies).toBeUndefined()
    expect(packageManifest.peerDependencies).toEqual({ "isomorphic-git": "^1.38.7" })
    expect(packageManifest.peerDependenciesMeta).toEqual({ "isomorphic-git": { optional: true } })
    expect(
      packageManifest.packageManager,
      "a Bun pin blocks the canonical pnpm pack/publish release path",
    ).toBeUndefined()
  })

  test("resolves workspaces from tracked source while publishing built entrypoints", async () => {
    const packageManifest = await manifest()
    const sourceExports = {
      ".": "./src/index.ts",
      "./adapters": "./src/adapters.ts",
      "./checkout-lock": "./src/checkout-lock.ts",
      "./events": "./src/events.ts",
      "./iso": "./src/iso.ts",
      "./mem": "./src/mem.ts",
    }

    expect(packageManifest.types).toBeUndefined()
    expect(packageManifest.exports).toEqual(sourceExports)
    for (const target of Object.values(sourceExports)) {
      const source = await stat(new URL(`..${target.slice(1)}`, import.meta.url))
      expect(source.isFile()).toBe(true)
    }
    expect(packageManifest.publishConfig?.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./adapters": { types: "./dist/adapters.d.ts", import: "./dist/adapters.js" },
      "./checkout-lock": { types: "./dist/checkout-lock.d.ts", import: "./dist/checkout-lock.js" },
      "./events": { types: "./dist/events.d.ts", import: "./dist/events.js" },
      "./iso": { types: "./dist/iso.d.ts", import: "./dist/iso.js" },
      "./mem": { types: "./dist/mem.d.ts", import: "./dist/mem.js" },
    })
  })

  test("keeps public release metadata aligned with the packed artifact", async () => {
    const packageManifest = await manifest()
    const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8")
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8")

    expect(packageManifest.files).toContain("CHANGELOG.md")
    expect(changelog).toContain(`## ${packageManifest.version}`)
    expect(openReader).toBeTypeOf("function")
    expect(readme).toContain('import { openReader } from "gitomic"')
    expect(readme).not.toContain("Not on npm yet")
  })

  test("keeps the root entry free of the checkout lock", async () => {
    // The optional checkout lock selects the runtime's native binding. Only its subpath and the CLI's dynamic import may reach it, so the root
    // entry imports under Node; scripts/node-smoke.mjs proves the same against the built package.
    const seen = new Set<string>()
    const pending = ["index.ts"]
    while (pending.length > 0) {
      const file = pending.pop()
      if (file === undefined || seen.has(file)) continue
      seen.add(file)
      const source = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8")
      for (const match of source.matchAll(/^(?:import|export)\s(?!type\s)[^"']*from\s+["']([^"']+)["']/gmu)) {
        const specifier = match[1] ?? ""
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(/^(?:bun:|@bearly\/flock$)/u)
        if (specifier.startsWith("./")) pending.push(specifier.slice(2).replace(/\.js$/u, ".ts"))
      }
    }
    expect(seen.has("index.ts")).toBe(true)
    expect(seen.has("checkout-lock.ts")).toBe(false)
  })
})
