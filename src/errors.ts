export class Conflict extends Error {
  override readonly name = "Conflict"
}

export class RetriesExhausted extends Error {
  override readonly name = "RetriesExhausted"

  constructor(
    readonly retries: number,
    /** The time budget the transaction was given to land within, in milliseconds. */
    readonly budgetMs: number,
    options?: ErrorOptions,
  ) {
    super(
      `transaction did not land within its ${budgetMs}ms retry budget (${retries} CAS attempts); ` +
        `raise retryBudgetMs or reduce writer contention`,
      options,
    )
  }
}

/** The four edit kinds `apply` carries. */
export type EditKind = "put" | "append" | "rm" | "mv"

/**
 * Which precondition an edit failed. `put` and `rm` check the path's blob is
 * identical to the base's (`blob-identical`, or `blob-absent` for a create);
 * `mv` checks the source is identical (`source-identical`) AND the destination
 * is absent (`destination-absent`); `append` has no precondition and never
 * fails this way.
 */
export type PreconditionType = "blob-identical" | "blob-absent" | "source-identical" | "destination-absent"

/**
 * A single edit could not be applied against the tree the transaction actually
 * attempted: the base moved under the edit's own path between authoring and
 * landing. The whole `apply` refuses — never a three-way merge, never a partial
 * apply — and this error names, as machine-branchable fields, exactly which
 * edit failed which precondition and the two commits between which it moved.
 * Facts only: no owner, role, routing, or remediation prose.
 */
export class EditDoesNotApply extends Error {
  override readonly name = "EditDoesNotApply"
  /** Stable machine key; the same string across every backend and release. */
  readonly code = "edit-does-not-apply" as const

  constructor(
    /** Position of the failing edit in the `apply` list (0-based). */
    readonly editIndex: number,
    readonly kind: EditKind,
    readonly preconditionType: PreconditionType,
    /** The path whose precondition failed (the destination path for `destination-absent`). */
    readonly path: string,
    /**
     * What the precondition is anchored on. At the file level this equals
     * `path`; U2's node layer anchors on a node identity, extending this shape
     * without changing it.
     */
    readonly anchor: string,
    /** The content the precondition names — the expected git blob oid, or `null` for "absent". */
    readonly expected: string | null,
    /** What was actually there at the attempted tree — a git blob oid, or `null` for "absent". */
    readonly actual: string | null,
    /** The commit the edit was authored against. */
    readonly base: string,
    /** The commit the precondition was actually checked on (the attempted tree's tip). */
    readonly head: string,
    options?: ErrorOptions,
  ) {
    super(
      `edit-does-not-apply: ${kind} ${path} failed ${preconditionType}; ` +
        `expected ${expected ?? "absent"}, found ${actual ?? "absent"} at head ${head} (authored against ${base})`,
      options,
    )
  }
}
