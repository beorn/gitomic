/**
 * The one compare-and-swap loop. Both doors use it: `Store.transact` (state =
 * the tree at the tip) and gitomic/events (state = the chain at the tip). A
 * door says how to read its state and build the next commit; the loop owns
 * contention, receipts and the retry budget, so there is exactly one of each.
 */
import { RetriesExhausted } from "./errors.js"
import type { Oid } from "./types.js"

/** What one attempt decided against the tip it saw. */
export type Attempt<R> =
  | { readonly kind: "noop"; readonly result: R }
  | {
      readonly kind: "write"
      /** The commit to publish. */
      readonly next: Oid
      /** The commit this attempt was built on: the receipt search stops there. */
      readonly base: Oid
      /** The receipt that identifies this transaction if its acknowledgement is lost. */
      readonly instance: string
      readonly seq: number
      landed(oid: Oid, retries: number): R
    }

export type CasLoop<H, R> = {
  /** Names the target in errors, e.g. `<repo> <ref>`. */
  readonly label: string
  readonly retryBudgetMs: number
  /** The current tip. */
  refresh(): Promise<H>
  publish(next: Oid, expected: H): Promise<boolean>
  /** Search `winner`'s first-parent chain, back to `base`, for this receipt. */
  findTransaction(winner: H, base: Oid, instance: string, seq: number): Promise<Oid | undefined>
  /** `retries` is how many contended publishes this transaction has lost so far. */
  attempt(tip: H, retries: number): Promise<Attempt<R>>
}

export async function runCasLoop<H, R>(loop: CasLoop<H, R>): Promise<R> {
  let retries = 0
  // Contention policy lives HERE, not in callers: the budget is TIME, not a
  // fixed attempt count. Under CAS one publish wins per round, so the unluckiest
  // of N writers needs about N attempts — a fixed counter abandons a healthy
  // burst by construction. The deadline resets whenever the ref advances (some
  // writer landed): a burst that keeps landing someone is never abandoned, while
  // a transaction that makes no progress for the whole budget fails loudly.
  let deadline = Date.now() + loop.retryBudgetMs
  while (true) {
    const tip = await loop.refresh()
    const attempt = await loop.attempt(tip, retries)
    if (attempt.kind === "noop") return attempt.result

    let publicationFailure: { cause: unknown; message: string } | undefined
    try {
      if (await loop.publish(attempt.next, tip)) return attempt.landed(attempt.next, retries)
    } catch (cause) {
      publicationFailure = {
        cause,
        message: `Transaction publication to ${loop.label} is unknown; do not blindly retry. ${cause instanceof Error ? cause.message : String(cause)}`,
      }
    }

    if (publicationFailure === undefined) retries += 1
    // A false publish is usually contention; false or throw can also mean an
    // acknowledgement was lost after landing. Look for this exact receipt before
    // replaying: replaying a landed transaction would apply it twice. The scan
    // stops at `base`, so it reads only the commits that arrived during this
    // attempt.
    let winner: H
    try {
      winner = await loop.refresh()
      const landed = await loop.findTransaction(winner, attempt.base, attempt.instance, attempt.seq)
      if (landed !== undefined) return attempt.landed(landed, retries)
    } catch (verificationError) {
      if (publicationFailure !== undefined) {
        throw new AggregateError([publicationFailure.cause, verificationError], publicationFailure.message)
      }
      throw verificationError
    }
    if (publicationFailure !== undefined) {
      throw new Error(publicationFailure.message, { cause: publicationFailure.cause })
    }
    // The ref advanced under us: a writer landed this round, so the race is
    // making progress — extend the budget rather than abandon a healthy burst.
    if (winner !== tip) deadline = Date.now() + loop.retryBudgetMs
    if (Date.now() >= deadline) throw new RetriesExhausted(retries, loop.retryBudgetMs)
    await delayForRetry(retries)
  }
}

function delayForRetry(retries: number): Promise<void> {
  const ceiling = Math.min(150, 4 * 2 ** Math.min(retries, 6))
  const milliseconds = Math.random() * ceiling
  return new Promise((resolveDelay) => {
    // raw-lifecycle-ok: this transaction-owned backoff is awaited and cannot outlive its caller.
    setTimeout(resolveDelay, milliseconds)
  })
}
