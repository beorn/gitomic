import { objectOid, validateOid } from "./git-object.js"
import { EditDoesNotApply } from "./errors.js"
import type { GitMap, Oid, Update } from "./types.js"

/**
 * The transaction map's internal hook that makes `to` keep the parent mode of `from` (an executable moved stays
 * executable). Symbol-keyed so it is not part of `GitMap`: only the move edit calls it, and a map without it moves
 * content only.
 */
export const KEEP_MODE_OF: unique symbol = Symbol("gitomic.keepModeOf")
export type ModeKeepingMap = GitMap & { readonly [KEEP_MODE_OF]?: (to: string, from: string) => void }

/**
 * The paths an update will read, declared ahead of it so one attempt fetches
 * their values in ONE backend read instead of one per `await map.get`. Symbol-
 * keyed so it is not part of `Update`: `apply` sets it from its edit list, and
 * an update without it reads lazily as it goes.
 */
export const PREFETCH_PATHS: unique symbol = Symbol("gitomic.prefetchPaths")
export type PrefetchingUpdate = Update & { readonly [PREFETCH_PATHS]?: readonly string[] }

/** Every path an edit list reads before it writes: the anchor of each edit, both ends of a move. */
export function editPaths(edits: readonly Edit[]): readonly string[] {
  const paths = new Set<string>()
  for (const edit of edits) {
    if (edit.kind === "mv") {
      paths.add(edit.from)
      paths.add(edit.to)
    } else {
      paths.add(edit.path)
    }
  }
  return [...paths]
}

/**
 * The four edits `apply` carries. Each names the anchor it was authored
 * against so it can re-check itself on a moved base (R44/R45).
 *
 * `expect` is the blob oid the author read at the base — the natural
 * `--base` per R46 ("the read's oid is the natural base"). `null` on a `put`
 * means the path must be ABSENT (a create). `append` carries no anchor: it is
 * the one edit with no precondition, so it always re-applies on the new tip.
 */
export type Edit =
  | { readonly kind: "put"; readonly path: string; readonly content: string; readonly expect: Oid | null }
  | { readonly kind: "append"; readonly path: string; readonly content: string }
  | { readonly kind: "rm"; readonly path: string; readonly expect: Oid }
  | { readonly kind: "mv"; readonly from: string; readonly to: string; readonly expect: Oid }

/** The git blob oid of some content, or `null` when the path is absent. */
function blobOid(content: string | undefined, algorithm: "sha1" | "sha256"): Oid | null {
  return content === undefined ? null : objectOid("blob", Buffer.from(content, "utf8"), algorithm)
}

/**
 * Apply one edit list against the tree the transaction actually attempted.
 *
 * `base` is the commit the edits were authored against; `head` is the tip this
 * attempt is checking on (they differ once a concurrent writer has moved the
 * ref). Each edit re-checks its own precondition against `map`; the FIRST
 * failure throws {@link EditDoesNotApply}, which aborts the whole
 * transaction — never a three-way merge, never a partial apply. A caller
 * running this inside `store.transact` gets R45's replay for free: on a CAS
 * conflict `transact` re-reads the new tip and re-runs this function against
 * it, so a disjoint-path writer's change leaves every precondition here
 * holding and both writers land.
 */
export async function applyEdits(map: GitMap, base: Oid, head: Oid, edits: readonly Edit[]): Promise<void> {
  const algorithm = validateOid(head).length === 64 ? "sha256" : "sha1"
  for (const [index, edit] of edits.entries()) {
    switch (edit.kind) {
      case "append": {
        const current = await map.get(edit.path)
        map.set(edit.path, (current ?? "") + edit.content)
        break
      }
      case "put": {
        const current = blobOid(await map.get(edit.path), algorithm)
        if (current !== edit.expect) {
          throw new EditDoesNotApply(
            index,
            "put",
            edit.expect === null ? "blob-absent" : "blob-identical",
            edit.path,
            edit.path,
            edit.expect,
            current,
            base,
            head,
          )
        }
        map.set(edit.path, edit.content)
        break
      }
      case "rm": {
        const current = blobOid(await map.get(edit.path), algorithm)
        if (current !== edit.expect) {
          throw new EditDoesNotApply(
            index,
            "rm",
            "source-identical",
            edit.path,
            edit.path,
            edit.expect,
            current,
            base,
            head,
          )
        }
        map.delete(edit.path)
        break
      }
      case "mv": {
        const source = await map.get(edit.from)
        const sourceOid = blobOid(source, algorithm)
        if (sourceOid !== edit.expect) {
          throw new EditDoesNotApply(
            index,
            "mv",
            "source-identical",
            edit.from,
            edit.from,
            edit.expect,
            sourceOid,
            base,
            head,
          )
        }
        const destinationOid = blobOid(await map.get(edit.to), algorithm)
        if (destinationOid !== null) {
          throw new EditDoesNotApply(
            index,
            "mv",
            "destination-absent",
            edit.to,
            edit.to,
            null,
            destinationOid,
            base,
            head,
          )
        }
        // source is defined here: its oid equalled a non-null expect.
        map.set(edit.to, source as string)
        map.delete(edit.from)
        ;(map as ModeKeepingMap)[KEEP_MODE_OF]?.(edit.to, edit.from)
        break
      }
    }
  }
}
