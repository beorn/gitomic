import { TreePathCollision } from "./errors.ts"
import { assertUtf8 } from "./utf8.ts"

/**
 * A tree path namespace gitomic reserves and does not itself write.
 *
 * Nothing gitomic stores lives here: transaction identity rides in the commit
 * message, not in the tree. The namespace stays closed to callers so a future
 * in-tree protocol file cannot collide with application state that was already
 * written there — and so `keys` never has to explain an entry the caller did
 * not create.
 */
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

/** Code points HFS+ ignores when it compares names, so `.g‌it` opens `.git` there (git's `next_hfs_char`). */
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/gu

/**
 * Whether one path component is git's own directory on some filesystem, by the two rules `git fsck` applies to every
 * tree entry (hasDotgit): HFS+ drops its ignorable code points and folds case (`is_hfs_dotgit`), and NTFS ends a name
 * at a `:` stream suffix, drops trailing dots and spaces, folds case and also answers to the short name `git~1`
 * (`is_ntfs_dotgit`). NTFS also splits a name at a backslash; {@link invalidTreePathReason} refuses every backslash
 * before this runs. Each spelling here, and each near-miss its tests accept, was checked against `git fsck --strict`.
 */
function namesGitDirectory(part: string): boolean {
  if (part.replace(HFS_IGNORABLE, "").toLowerCase() === ".git") return true
  const stem = (part.split(":", 1)[0] ?? "").replace(/[. ]+$/u, "").toLowerCase()
  return stem === ".git" || stem === "git~1"
}

/**
 * Why `path` cannot be a path in a tree gitomic writes, or `undefined` when it can. The one check every writer shares
 * (27155, @cto 6c9330ac and b9f44d25): {@link normalizePath} for a caller's path, and every backend's `writeCommit` for
 * a direct caller that never normalized, so shell, iso and mem refuse the same paths. A backslash is refused because
 * normalizePath always refused it, and git's index silently drops a `.git` path ("Ignoring path") while a tree that
 * holds one fails `git fsck --strict` (hasDotgit), so a remote that runs fsck rejects the push.
 */
export function invalidTreePathReason(path: string): string | undefined {
  if (path.includes("\\")) return "it holds a backslash"
  if (path.length === 0) return "it is empty"
  if (path.startsWith("/") || path.endsWith("/")) return "it starts or ends with a slash"
  if (path.includes("\0")) return "it holds a NUL byte"
  for (const part of path.split("/")) {
    if (part === "") return "it has an empty component"
    if (part === "." || part === "..") return `it has a ${JSON.stringify(part)} component`
    if (namesGitDirectory(part)) return `its component ${JSON.stringify(part)} names git's own directory`
  }
  return undefined
}

/** Refuse a path {@link invalidTreePathReason} names, by the path and the reason. */
export function assertTreePath(path: string): void {
  const reason = invalidTreePathReason(path)
  if (reason !== undefined) throw new TypeError(`invalid git tree path: ${JSON.stringify(path)}: ${reason}`)
}

export function normalizePath(path: string): string {
  assertUtf8(path, "git tree path")
  const normalized = path.normalize("NFC")
  const reason = invalidTreePathReason(normalized)
  if (reason !== undefined) {
    throw new TypeError(`invalid git tree path: ${JSON.stringify(path)}: ${reason}`)
  }
  if (normalized.startsWith(INTERNAL_PREFIX) || normalized === INTERNAL_PREFIX.slice(0, -1)) {
    throw new TypeError(`${INTERNAL_PREFIX} is a reserved gitomic path namespace`)
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
    throw new TypeError(`${INTERNAL_PREFIX} is a reserved gitomic path namespace`)
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
        throw new TreePathCollision(ancestor, path)
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
      `${JSON.stringify(path)} is reserved by gitomic; rename that repository path before opening it with gitomic`,
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
