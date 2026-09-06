import { objectOid } from "./git-object.js"
import { EditDoesNotApply } from "./errors.js"
import type { GitMap, Oid } from "./types.js"

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
function blobOid(content: string | undefined): Oid | null {
  return content === undefined ? null : objectOid("blob", Buffer.from(content, "utf8"))
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
  for (const [index, edit] of edits.entries()) {
    switch (edit.kind) {
      case "append": {
        const current = await map.get(edit.path)
        map.set(edit.path, (current ?? "") + edit.content)
        break
      }
      case "put": {
        const current = blobOid(await map.get(edit.path))
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
        const current = blobOid(await map.get(edit.path))
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
        const sourceOid = blobOid(source)
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
        const destinationOid = blobOid(await map.get(edit.to))
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
        break
      }
    }
  }
}
