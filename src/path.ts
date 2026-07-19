export const INTERNAL_PREFIX = ".gitomic/"

export function assertPath(path: string): void {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new TypeError(`invalid git tree path: ${JSON.stringify(path)}`)
  }
  if (path.startsWith(INTERNAL_PREFIX) || path === INTERNAL_PREFIX.slice(0, -1)) {
    throw new TypeError(`${INTERNAL_PREFIX} is reserved for gitomic metadata`)
  }
}

export function assertPrefix(prefix: string): void {
  if (
    prefix.startsWith("/") ||
    prefix.includes("\\") ||
    prefix.includes("\0") ||
    prefix.split("/").some((part, index, parts) => {
      if (part === "." || part === "..") return true
      return part === "" && index !== parts.length - 1
    })
  ) {
    throw new TypeError(`invalid git tree prefix: ${JSON.stringify(prefix)}`)
  }
  if (prefix.startsWith(INTERNAL_PREFIX) || prefix === INTERNAL_PREFIX.slice(0, -1)) {
    throw new TypeError(`${INTERNAL_PREFIX} is reserved for gitomic metadata`)
  }
}

export function isPublicPath(path: string): boolean {
  return !path.startsWith(INTERNAL_PREFIX)
}
