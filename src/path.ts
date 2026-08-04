import { assertUtf8 } from "./utf8.js"

export const INTERNAL_PREFIX = ".gitomic/"

export type GitPrefixNotFoundError = Error & {
  readonly name: "GitPrefixNotFoundError"
  readonly code: "git_prefix_not_found"
  readonly repo: string
  readonly commit: string
  readonly prefix: string
}

export function isGitPrefixNotFoundError(error: unknown): error is GitPrefixNotFoundError {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "git_prefix_not_found" &&
    "prefix" in error &&
    typeof error.prefix === "string"
  )
}

export function assertGitPrefixMatched(count: number, repo: string, commit: string, prefix: string): void {
  if (prefix === "" || count > 0) return
  throw Object.assign(
    new Error(
      `Git tree prefix ${JSON.stringify(prefix)} matched no files in repository ${JSON.stringify(repo)} at commit ${commit}`,
    ),
    {
      name: "GitPrefixNotFoundError" as const,
      code: "git_prefix_not_found" as const,
      repo,
      commit,
      prefix,
    },
  )
}

export function normalizePath(path: string): string {
  assertUtf8(path, "git tree path")
  const normalized = path.normalize("NFC")
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new TypeError(`invalid git tree path: ${JSON.stringify(path)}`)
  }
  if (normalized.startsWith(INTERNAL_PREFIX) || normalized === INTERNAL_PREFIX.slice(0, -1)) {
    throw new TypeError(`${INTERNAL_PREFIX} is reserved for gitomic metadata`)
  }
  return normalized
}

export function normalizePrefix(prefix: string): string {
  assertUtf8(prefix, "git tree prefix")
  const normalized = prefix.normalize("NFC")
  if (
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part, index, parts) => {
      if (part === "." || part === "..") return true
      return part === "" && index !== parts.length - 1
    })
  ) {
    throw new TypeError(`invalid git tree prefix: ${JSON.stringify(prefix)}`)
  }
  if (normalized.startsWith(INTERNAL_PREFIX) || normalized === INTERNAL_PREFIX.slice(0, -1)) {
    throw new TypeError(`${INTERNAL_PREFIX} is reserved for gitomic metadata`)
  }
  return normalized
}

export function isPublicPath(path: string): boolean {
  return path !== INTERNAL_PREFIX.slice(0, -1) && !path.startsWith(INTERNAL_PREFIX)
}

export function assertTreeShape(paths: Iterable<string>): void {
  const stored = new Set(paths)
  for (const path of stored) assertStoredPath(path)
  for (const path of stored) {
    let separator = path.indexOf("/")
    while (separator >= 0) {
      const ancestor = path.slice(0, separator)
      if (stored.has(ancestor)) {
        throw new Error(
          `Git tree path collision: ${JSON.stringify(ancestor)} is both a file and a directory prefix for ${JSON.stringify(path)}; delete one side in the same transaction`,
        )
      }
      separator = path.indexOf("/", separator + 1)
    }
  }
}

function assertStoredPath(path: string): void {
  assertUtf8(path, "Git tree paths returned by a backend")
  if (path !== path.normalize("NFC")) {
    throw new Error(
      `Git tree path is not NFC-normalized: ${JSON.stringify(path)}; rewrite the repository path in NFC before opening it with gitomic`,
    )
  }
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`backend returned an invalid Git tree path: ${JSON.stringify(path)}`)
  }
  if (path === INTERNAL_PREFIX.slice(0, -1)) {
    throw new Error(
      `${JSON.stringify(path)} is reserved and collides with Gitomic metadata; rename that repository path before opening it with gitomic`,
    )
  }
}

export function assertRegularBlob(path: string, mode: string, type: string): void {
  if (path !== path.normalize("NFC")) {
    throw new Error(
      `Git tree path is not NFC-normalized: ${JSON.stringify(path)}; rewrite the repository path in NFC before opening it with gitomic`,
    )
  }
  if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
    throw new Error(
      `unsupported Git tree mode ${mode} at ${JSON.stringify(path)}; gitomic state accepts regular blobs only`,
    )
  }
}
