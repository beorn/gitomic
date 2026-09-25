/**
 * The one validator for "other refs that land in the SAME atomic publish": the
 * events door's `also` and the store door's `beside` share it (25312 E2a,
 * @cto ruling rider 1b). A ref beside the chain may not be the chain itself or
 * repeat; a create is an all-zero expectation; a delete needs the real tip it
 * removes.
 */
import { validateOid, zeroOid } from "./git-object.js"
import { normalizeRef } from "./options.js"
import type { Oid, RefUpdate } from "./types.js"

/**
 * Another ref to move in the SAME atomic publish as the commit: from `expect`
 * (null: absent) to `oid`. A branch head beside the event that names it, say.
 * A null `oid` deletes the ref at `expect`, which must then be a real id.
 */
export type AlsoRef = {
  readonly ref: string
  readonly expect: Oid | null
  readonly oid: Oid | null
}

/** Validate and normalize refs published beside `chainRef`; `word` names the option in errors. */
export function shapeRefUpdates(
  chainRef: string,
  updates: readonly AlsoRef[] | undefined,
  word: "also" | "beside",
): RefUpdate[] {
  const seen = new Set<string>([chainRef])
  return (updates ?? []).map((update) => {
    const ref = normalizeRef(update.ref)
    if (ref === chainRef)
      throw new TypeError(`${word === "also" ? "an also" : "a beside"} ref cannot be the chain itself: ${chainRef}`)
    if (seen.has(ref)) throw new TypeError(`${word} names ${ref} more than once`)
    seen.add(ref)
    if (update.oid === null) {
      if (update.expect === null)
        throw new TypeError(`${word === "also" ? "an also" : "a beside"} delete of ${ref} needs the tip it removes`)
      return { ref, expect: validateOid(update.expect, `${word} expect for ${ref} must be a commit id`), oid: null }
    }
    const oid = validateOid(update.oid, `${word} oid for ${ref} must be a commit id or null`)
    const expect =
      update.expect === null
        ? zeroOid(oid)
        : validateOid(update.expect, `${word} expect for ${ref} must be a commit id or null`)
    return { ref, expect, oid }
  })
}
