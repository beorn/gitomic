/** A repository and the ref within it, parsed from one `<repo>#<ref>` string. */
export type Address = {
  repo: string
  ref: string
}

/**
 * Parse a `<repo>#<ref>` address — the file-level door's single argument for
 * "which repository, which ref".
 *
 * The repository half is a path or URL and never contains `#`, so the split is
 * on the FIRST `#`: everything before it is the repository, everything after is
 * the ref (which may itself contain `#`, a legal ref character). With no `#` the
 * whole string is the repository and the ref falls back to `defaultRef`.
 * Neither half may be empty. The ref is not validated here — `open`/`openReader`
 * do that when the store is actually opened.
 */
export function parseAddress(address: string, defaultRef = "main"): Address {
  const separator = address.indexOf("#")
  if (separator < 0) {
    if (address.length === 0) throw new TypeError("address is empty; expected <repo> or <repo>#<ref>")
    return { repo: address, ref: defaultRef }
  }
  const repo = address.slice(0, separator)
  const ref = address.slice(separator + 1)
  if (repo.length === 0) throw new TypeError(`address has no repository before '#': ${JSON.stringify(address)}`)
  if (ref.length === 0) throw new TypeError(`address has no ref after '#': ${JSON.stringify(address)}`)
  return { repo, ref }
}
