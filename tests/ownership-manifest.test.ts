// @failure Ownership-manifest consumers can silently disagree about schema
// version, duplicate paths, path safety, or source-object coverage.
// @level l1
// @consumer generic Gitomic ownership-manifest callers

import { readFile } from "node:fs/promises"

import { describe, expect, test } from "vitest"

import { parseOwnershipManifest } from "../src/index.js"

const OID = "a".repeat(40)
const POLICY = {
  label: "fixture ownership manifest",
  acceptPath: (path: string) => path.startsWith("state/") && path.endsWith(".txt"),
}

function raw(value: unknown): string {
  return JSON.stringify(value)
}

describe("parseOwnershipManifest", () => {
  test("normalizes one exact version-1 path/source mapping into sorted order", () => {
    expect(
      parseOwnershipManifest(
        raw({
          version: 1,
          paths: ["state/z.txt", "state/a.txt"],
          sources: { "state/z.txt": OID, "state/a.txt": "b".repeat(64) },
        }),
        POLICY,
      ),
    ).toEqual({
      version: 1,
      paths: ["state/a.txt", "state/z.txt"],
      sources: { "state/a.txt": "b".repeat(64), "state/z.txt": OID },
    })
  })

  test.each([
    {
      name: "invalid JSON",
      value: "{",
      error: /invalid JSON/iu,
      winner: "all dialects rejected invalid JSON",
    },
    {
      name: "missing schema version",
      value: raw({ paths: ["state/a.txt"], sources: { "state/a.txt": OID } }),
      error: /version 1/iu,
      winner: "version 1 wins because three dialects enforced it and silent version upgrades are unsafe",
    },
    {
      name: "duplicate paths",
      value: raw({
        version: 1,
        paths: ["state/a.txt", "state/a.txt"],
        sources: { "state/a.txt": OID },
      }),
      error: /duplicate path/iu,
      winner: "rejection wins over three deduping dialects because authored ambiguity must fail loud",
    },
    {
      name: "unsafe traversal",
      value: raw({
        version: 1,
        paths: ["state/../a.txt"],
        sources: { "state/../a.txt": OID },
      }),
      error: /invalid.*path/iu,
      winner: "the reconcile dialect's path-safety check wins because manifests address Git tree objects",
    },
    {
      name: "caller-policy violation",
      value: raw({ version: 1, paths: ["code.ts"], sources: { "code.ts": OID } }),
      error: /caller policy/iu,
      winner: "the three partition-aware dialects win over the policy-free writer dialect",
    },
    {
      name: "extra source key",
      value: raw({
        version: 1,
        paths: ["state/a.txt"],
        sources: { "state/a.txt": OID, "state/b.txt": OID },
      }),
      error: /one source object id/iu,
      winner: "all dialects required an exact path/source bijection",
    },
    {
      name: "non-canonical source object id",
      value: raw({ version: 1, paths: ["state/a.txt"], sources: { "state/a.txt": "A".repeat(40) } }),
      error: /one source object id/iu,
      winner: "all dialects required lowercase 40- or 64-hex object ids",
    },
  ])("rejects $name — $winner", ({ value, error }) => {
    expect(() => parseOwnershipManifest(value, POLICY)).toThrow(error)
  })

  test("keeps workflow policy out of the generic implementation mechanically", async () => {
    const source = await readFile(new URL("../src/ownership-manifest.ts", import.meta.url), "utf8")
    expect(source).not.toMatch(/@tent|@km|state\/beads|gitomic-state/iu)
  })
})
