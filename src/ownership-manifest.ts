import { normalizePath } from "./path.js"

export interface OwnershipManifest {
  readonly version: 1
  readonly paths: readonly string[]
  readonly sources: Readonly<Record<string, string>>
}

export interface OwnershipManifestPolicy {
  readonly label?: string
  readonly acceptPath: (path: string) => boolean
}

function invalid(label: string, detail: string): never {
  throw new TypeError(`invalid ${label}: ${detail}`)
}

/**
 * Parse one versioned path-to-source ownership declaration. Gitomic owns the
 * schema and Git-tree safety checks; callers retain partition policy.
 */
export function parseOwnershipManifest(raw: string, policy: OwnershipManifestPolicy): OwnershipManifest {
  const label = policy.label ?? "ownership manifest"
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    invalid(label, `invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("paths" in parsed) ||
    !Array.isArray(parsed.paths) ||
    !parsed.paths.every((path) => typeof path === "string") ||
    !("sources" in parsed) ||
    typeof parsed.sources !== "object" ||
    parsed.sources === null ||
    Array.isArray(parsed.sources)
  ) {
    invalid(label, "expected version 1 paths and sources")
  }

  const paths: string[] = []
  const seen = new Set<string>()
  for (const path of parsed.paths) {
    let normalized: string
    try {
      normalized = normalizePath(path)
    } catch (cause) {
      invalid(label, cause instanceof Error ? cause.message : String(cause))
    }
    if (normalized !== path) invalid(label, `path is not NFC-normalized: ${JSON.stringify(path)}`)
    if (seen.has(path)) invalid(label, `duplicate path: ${JSON.stringify(path)}`)
    if (!policy.acceptPath(path)) invalid(label, `path rejected by caller policy: ${JSON.stringify(path)}`)
    seen.add(path)
    paths.push(path)
  }
  paths.sort()

  const rawSources = Object.entries(parsed.sources)
  if (
    rawSources.length !== paths.length ||
    rawSources.some(
      ([path, source]) =>
        !seen.has(path) || typeof source !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(source),
    )
  ) {
    invalid(label, "every path must map to exactly one source object id")
  }
  const inputSources = Object.fromEntries(rawSources) as Record<string, string>
  const sources: Record<string, string> = {}
  for (const path of paths) {
    const source = inputSources[path]
    if (source === undefined) invalid(label, `missing source object id for ${JSON.stringify(path)}`)
    sources[path] = source
  }
  return { version: 1, paths, sources }
}
