/**
 * gitomic/events — the transaction engine with the chain as its state.
 *
 * An event is an empty-tree commit on a ref. Its first parent is the previous
 * event (or the genesis commit, for the first one); any further parents are the
 * commits it KEEPS. Reading is one batched walk; writing is compare-and-swap on
 * the tip with gitomic's existing receipts, so a lost acknowledgement is never
 * replayed twice. Trailers are opaque: gitomic folds nothing and names no kinds.
 *
 * Design: ADR-0019 and work package 25035 § 3 (slice 3a, @i/10-yrd/25039).
 */
import type { GitomicBackend, Oid, Trailer } from "./types.js"

/** One trailer as written: key, then value. Order and duplicates are kept. */
export type Prop = Trailer

/** What a caller asks to append. */
export type EventInput = {
  /** The caller's event type. gitomic stores it and never interprets it. */
  readonly type: string
  readonly title?: string
  readonly content?: string
  readonly props?: readonly Prop[]
  /** Commits this event keeps: written as extra parents after the chain parent. */
  readonly keeps?: readonly Oid[]
}

/** One event as read back. */
export type Event = {
  /** The event's commit oid. */
  readonly id: Oid
  /** The previous event's id, or null for the chain's first event. */
  readonly parent: Oid | null
  /** The commits this event keeps, in the order written. */
  readonly links: readonly Oid[]
  readonly type: string
  readonly title: string
  readonly content: string
  readonly props: readonly Prop[]
  readonly writer: string | null
  readonly instance: string | null
  readonly seq: number | null
}

export type EventsOptions = {
  repo: string
  ref: string
  writer?: string
  remote?: string
  backend?: GitomicBackend
  retryBudgetMs?: number
}

export type EventsRead = {
  /** Read only events newer than this event id (exclusive). */
  from?: Oid
  limit?: number
  /** Chronological (oldest first) by default. */
  order?: "oldest-first" | "newest-first"
}

/** Decide what to append, given every event on the chain at this attempt's tip. */
export type Decide = (events: readonly Event[]) => readonly EventInput[] | Promise<readonly EventInput[]>

export type Appended = {
  /** The new tip, or the unchanged tip when `decide` returned nothing. */
  readonly head: Oid | null
  readonly events: readonly Event[]
  readonly retries: number
}

export type Events = {
  /** The chain tip, or null when the ref does not exist yet. */
  head(): Promise<Oid | null>
  events(options?: EventsRead): Promise<Event[]>
  transact(decide: Decide, message: string): Promise<Appended>
  /** Append at exactly `expect` (null = the chain must not exist); throws Conflict on a moved tip. */
  append(inputs: readonly EventInput[], options: { expect: Oid | null }): Promise<Appended>
  watch(options: { signal: AbortSignal; pollIntervalMs?: number }): AsyncIterable<Event[]>
}

export type ListRefsOptions = {
  repo: string
  remote?: string
  backend?: GitomicBackend
}

export type ChainsUnderOptions = ListRefsOptions & {
  /** Events read per chain; default 50, refused above 1024 like `Reader.log`. */
  limit?: number
}

function notImplemented(what: string): never {
  throw new Error(`gitomic/events: ${what} is not implemented yet (@i/10-yrd/25039)`)
}

export async function openEvents(_options: EventsOptions): Promise<Events> {
  return notImplemented("openEvents")
}

/** Every ref under `prefix` and its tip: `for-each-ref` locally, `ls-remote --refs` remotely. */
export async function listRefs(_prefix: string, _options: ListRefsOptions): Promise<ReadonlyMap<string, Oid>> {
  return notImplemented("listRefs")
}

/** Every chain under `prefix`, read in one walk. */
export async function chainsUnder(_prefix: string, _options: ChainsUnderOptions): Promise<ReadonlyMap<string, Event[]>> {
  return notImplemented("chainsUnder")
}
