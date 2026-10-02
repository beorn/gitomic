import type { Oid, RefUpdate } from "./types.js"

/** The proposed Git tree contains a file and one of that file's descendants. */
export class TreePathCollision extends Error {
  readonly file: string
  readonly descendant: string
  override readonly name = "TreePathCollision"
  readonly code = "tree-path-collision" as const

  constructor(file: string, descendant: string, options?: ErrorOptions) {
    super(
      `Git tree path collision: ${JSON.stringify(file)} is both a file and a directory prefix for ${JSON.stringify(descendant)}; delete one side in the same transaction`,
      options,
    )
    this.file = file
    this.descendant = descendant
  }
}

export class Conflict extends Error {
  override readonly name = "Conflict"
  /** The refs whose lease a MULTI publish lost, as the tool named them; empty otherwise. */
  readonly refs: readonly string[]

  constructor(message?: string, options?: ErrorOptions & { refs?: readonly string[] }) {
    super(message, options)
    this.refs = options?.refs ?? []
  }
}

export class RetriesExhausted extends Error {
  readonly retries: number
  /** The time budget the transaction was given to land within, in milliseconds. */
  readonly budgetMs: number
  override readonly name = "RetriesExhausted"

  constructor(
    retries: number,
    /** The time budget the transaction was given to land within, in milliseconds. */
    budgetMs: number,
    options?: ErrorOptions,
  ) {
    super(
      `transaction did not land within its ${budgetMs}ms retry budget (${retries} CAS attempts); ` +
        `raise retryBudgetMs or reduce writer contention`,
      options,
    )
    this.retries = retries
    this.budgetMs = budgetMs
  }
}

/** A publish threw and its transaction receipt could not prove that it landed. */
export class PublicationUnknown extends AggregateError {
  readonly label: string
  readonly verified: "no-receipt" | "unverified"
  readonly attempt?:
    | {
        readonly candidate: Oid
        readonly base: Oid
        readonly expected: Oid | null
        readonly observed?: Oid | null
      }
    | undefined
  override readonly name = "PublicationUnknown"

  constructor(
    label: string,
    cause: unknown,
    verified: "no-receipt" | "unverified",
    verificationError?: unknown,
    attempt?:
      | {
          readonly candidate: Oid
          readonly base: Oid
          readonly expected: Oid | null
          readonly observed?: Oid | null
        }
      | undefined,
  ) {
    super(
      verified === "unverified" ? [cause, verificationError] : [cause],
      `Transaction publication to ${label} is unknown; do not blindly retry. ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.label = label
    this.verified = verified
    this.attempt = attempt
  }
}

/** The remote explicitly refused every requested update in this push. Nothing was retried. */
export class PublicationRejected extends Error {
  readonly updates: readonly RefUpdate[]
  /** The remote's per-ref reasons, in the same order as updates. */
  readonly reasons: readonly string[]
  readonly detail: string
  override readonly name = "PublicationRejected"

  constructor(
    updates: readonly RefUpdate[],
    /** The remote's per-ref reasons, in the same order as updates. */
    reasons: readonly string[],
    detail: string,
  ) {
    super(
      `Publication to ${updates.map(({ ref, expect, oid }) => `${ref} (candidate ${oid ?? "delete"}, expected ${expect ?? "absent"})`).join(", ")} was rejected: the attempt did not land; nothing was retried. ` +
        `A fresh transaction can be submitted after resolving the rejection. ${detail}`,
    )
    this.updates = updates
    this.reasons = reasons
    this.detail = detail
  }
}

/** The edit kinds `apply` carries. */
export type EditKind = "put" | "put-bytes" | "append" | "rm" | "mv" | "replace"

/**
 * Which precondition an edit failed. `put` and `rm` check the path's blob is
 * identical to the base's (`blob-identical`, or `blob-absent` for a create);
 * `mv` checks the source is identical (`source-identical`) AND the destination
 * is absent (`destination-absent`); `replace` checks the old text occurs exactly
 * once (`text-unique`); `append` has no precondition and never fails this way.
 */
export type PreconditionType =
  | "blob-identical"
  | "blob-absent"
  | "source-identical"
  | "destination-absent"
  | "text-unique"

/**
 * A single edit could not be applied against the tree the transaction actually
 * attempted: the base moved under the edit's own path between authoring and
 * landing. The whole `apply` refuses — never a three-way merge, never a partial
 * apply — and this error names, as machine-branchable fields, exactly which
 * edit failed which precondition and the two commits between which it moved.
 * Facts only: no owner, role, routing, or remediation prose.
 *
 * For `text-unique`, `expected` holds `"1"` and `actual` holds the occurrence
 * count as decimal text, or `null` when the path is absent.
 */
export class EditDoesNotApply extends Error {
  /** Position of the failing edit in the `apply` list (0-based). */
  readonly editIndex: number
  readonly kind: EditKind
  readonly preconditionType: PreconditionType
  /** The path whose precondition failed (the destination path for `destination-absent`). */
  readonly path: string
  /**
   * What the precondition is anchored on. At the file level this equals
   * `path`; U2's node layer anchors on a node identity, extending this shape
   * without changing it.
   */
  readonly anchor: string
  /** The content the precondition names — the expected git blob oid, "1" for text-unique, or `null` for "absent". */
  readonly expected: string | null
  /** What was actually there at the attempted tree — a git blob oid, decimal count for text-unique, or `null` for "absent". */
  readonly actual: string | null
  /** The commit the edit was authored against. */
  readonly base: string
  /** The commit the precondition was actually checked on (the attempted tree's tip). */
  readonly head: string
  override readonly name = "EditDoesNotApply"
  /** Stable machine key; the same string across every backend and release. */
  readonly code = "edit-does-not-apply" as const

  constructor(
    /** Position of the failing edit in the `apply` list (0-based). */
    editIndex: number,
    kind: EditKind,
    preconditionType: PreconditionType,
    /** The path whose precondition failed (the destination path for `destination-absent`). */
    path: string,
    /**
     * What the precondition is anchored on. At the file level this equals
     * `path`; U2's node layer anchors on a node identity, extending this shape
     * without changing it.
     */
    anchor: string,
    /** The content the precondition names — the expected git blob oid, "1" for text-unique, or `null` for "absent". */
    expected: string | null,
    /** What was actually there at the attempted tree — a git blob oid, decimal count for text-unique, or `null` for "absent". */
    actual: string | null,
    /** The commit the edit was authored against. */
    base: string,
    /** The commit the precondition was actually checked on (the attempted tree's tip). */
    head: string,
    options?: ErrorOptions,
  ) {
    const expectedDesc = preconditionType === "text-unique" ? "1 occurrence of old text" : (expected ?? "absent")
    const actualDesc = actual ?? "absent"
    super(
      `edit-does-not-apply: ${kind} ${path} failed ${preconditionType}; ` +
        `expected ${expectedDesc}, found ${actualDesc} at head ${head} (authored against ${base})`,
      options,
    )
    this.editIndex = editIndex
    this.kind = kind
    this.preconditionType = preconditionType
    this.path = path
    this.anchor = anchor
    this.expected = expected
    this.actual = actual
    this.base = base
    this.head = head
  }
}

/**
 * An edit attempted a non-relative mutation (`put`, `put-bytes`, `rm`, `mv`)
 * on a path declared `relative-only` in `.gitomic.conf` [edits].
 */
export class RelativeOnlyEditRefused extends Error {
  readonly path: string
  readonly kind: EditKind
  readonly head: string
  override readonly name = "RelativeOnlyEditRefused"
  readonly code = "relative-only-edit-refused" as const

  constructor(path: string, kind: EditKind, head: string, options?: ErrorOptions) {
    super(
      `gitomic: ${path} is declared relative-only in .gitomic.conf ([edits] relative-only at head ${head}); ` +
        `put, put-bytes, rm, and mv are refused; use 'replace' or 'append'`,
      options,
    )
    this.path = path
    this.kind = kind
    this.head = head
  }
}

/**
 * A native Git command outlived its time limit. The command led its own process
 * group, and the whole group was stopped, so helpers Git started (ssh,
 * index-pack) do not outlive it. Facts only: the command and the limit.
 */
export class GitTimeout extends Error {
  /** The Git command that was stopped, as `git <subcommand>` plus its target. */
  readonly command: string
  /** The limit it exceeded, in milliseconds. */
  readonly timeoutMs: number
  override readonly name = "GitTimeout"

  constructor(
    /** The Git command that was stopped, as `git <subcommand>` plus its target. */
    command: string,
    /** The limit it exceeded, in milliseconds. */
    timeoutMs: number,
    options?: ErrorOptions,
  ) {
    super(`${command} did not finish within its ${timeoutMs} ms limit; its process group was stopped`, options)
    this.command = command
    this.timeoutMs = timeoutMs
  }
}

/** A native Git process terminated by an observed signal. The caller owns cancellation policy. */
export class GitSignaled extends Error {
  readonly command: string
  readonly signal: NodeJS.Signals
  readonly stderr: string
  override readonly name = "GitSignaled"

  constructor(command: string, signal: NodeJS.Signals, stderr: string, options?: ErrorOptions) {
    super(`${command} was interrupted by ${signal}${stderr.trim() ? `: ${stderr.trim()}` : ""}`, options)
    this.command = command
    this.signal = signal
    this.stderr = stderr
  }
}

/**
 * The repository's candidate check refused the tree this write would land. Nothing landed and the ref did not move.
 * `reasons` are the check's own lines, verbatim. `base` is the tip the candidate was built on. Facts only: gitomic
 * runs whatever check the caller or the repository's trusted base declares; it holds no policy of its own.
 */
/**
 * A transaction named a commit to keep that its base already contains: the merge is already made. Thrown on
 * every attempt, so a retry on a tip that gained the commit refuses instead of writing a second merge.
 */
export class AlreadyKept extends Error {
  /** The commit the transaction asked to keep. */
  readonly keep: string
  /** The base that already contains it. */
  readonly base: string
  override readonly name = "AlreadyKept"
  /** Stable machine key; the same string across every backend and release. */
  readonly code = "already-kept" as const

  constructor(keep: string, base: string) {
    super(`already kept: ${keep} is reachable from the base ${base}; nothing was written`)
    this.keep = keep
    this.base = base
  }
}

export class CandidateRefused extends Error {
  readonly reasons: readonly string[]
  /** The commit the refused candidate was built on. */
  readonly base: string
  override readonly name = "CandidateRefused"
  /** Stable machine key; the same string across every backend and release. */
  readonly code = "candidate-refused" as const

  constructor(
    reasons: readonly string[],
    /** The commit the refused candidate was built on. */
    base: string,
    options?: ErrorOptions,
  ) {
    super(`candidate-refused: ${reasons.length} reason(s) at base ${base}: ${reasons.join("; ")}`, options)
    this.reasons = reasons
    this.base = base
  }
}
