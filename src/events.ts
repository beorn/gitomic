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
import { randomUUID } from "node:crypto"

import { runCasLoop } from "./engine.ts"
import { Conflict } from "./errors.ts"
import {
  assertTrailers,
  cloneIdent,
  GENESIS_MESSAGE,
  GITOMIC_IDENT,
  isCurrentGeneratedCommit,
  validateOid,
  zeroOid,
} from "./git-object.ts"
import { shapeRefUpdates, type AlsoRef } from "./ref-updates.ts"
import {
  assertWriter,
  DEFAULT_WRITER_LABEL,
  normalizeClock,
  normalizePollInterval,
  normalizeRef,
  normalizeRetryBudget,
  rejectLegacyProvenance,
  untilAborted,
  waitForPoll,
} from "./options.ts"
import { createShellBackend } from "./shell.ts"
import type { Clock, CommitMeta, GitomicBackend, Ident, Oid, RefUpdate, Trailer } from "./types.js"
import { assertUtf8 } from "./utf8.ts"

/** One trailer as written: key, then value. Order and duplicates are kept. */
export type Prop = Trailer

/** What a caller asks to append. */
export type EventInput = {
  /** The caller's event type. gitomic stores it and never interprets it. */
  readonly type: string
  /** The commit subject after `writer: `. Defaults to the type. */
  readonly title?: string
  readonly content?: string
  readonly props?: readonly Prop[]
  /** Commits this event keeps: written as extra parents after the chain parent. */
  readonly keeps?: readonly Oid[]
  /** Git author for this event; when present, overrides the transaction's author. */
  readonly author?: Ident
  /** Commit trailers for this event, never event properties; when present, overrides transaction trailers. */
  readonly trailers?: readonly Trailer[]
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
  /** Git's author: who the event was written for. */
  readonly author: Ident
  /** Git's committer: who wrote it. */
  readonly committer: Ident
}

export type EventsOptions = {
  repo: string
  ref: string
  writer?: string
  /**
   * Git's committer for every event this handle writes. A call may name its own
   * author; one that names none has this committer as author. Defaults to
   * gitomic <gitomic@localhost>. The chain's genesis always keeps gitomic's.
   */
  committer?: Ident
  remote?: string
  backend?: GitomicBackend
  retryBudgetMs?: number
  /** Additional remote refs to fetch with this chain's tip; absent extras are omitted. */
  fetch?: readonly string[]
  /** The clock this chain's events are dated by (unix seconds); the wall clock by default (25486). */
  clock?: Clock
}

export type EventsRead = {
  /** Read only events newer than this event id (exclusive). */
  from?: Oid
  /**
   * Read the chain whose tip is this event instead of the ref's current tip: a tip another read already
   * fetched (a store's per-attempt `fetch` list), so the read costs no remote round trip and sees exactly
   * that state. Nothing is fetched; the commits must be in the repository.
   */
  at?: Oid
  limit?: number
  /** Chronological (oldest first) by default. */
  order?: "oldest-first" | "newest-first"
}

/** Decide what to append, given every event after `from` at this attempt's tip, or the whole chain without `from`. */
export type Decide = (events: readonly Event[]) => readonly EventInput[] | Promise<readonly EventInput[]>

export type Appended = {
  /** The new tip, or the unchanged tip when `decide` returned nothing. */
  readonly head: Oid | null
  readonly events: readonly Event[]
  readonly retries: number
}

/** Locally written event commits awaiting one leased, atomic publication. */
export type StagedEvents = {
  readonly ref: string
  readonly expect: Oid | null
  readonly head: Oid
  readonly events: readonly Event[]
  publish(options?: { also?: readonly AlsoRef[] }): Promise<Appended>
}

/**
 * The staged run an `Events.transact` `afterStage` hook sees: the commit that would be published, the tip it was
 * built on, and the events written for it. The hook runs after staging and before the single publish, once per CAS
 * attempt, and is a LOCAL-ONLY side effect in the caller's repository (a candidate marker, say). It must not publish
 * a ref of its own: refs that ride the atomic publish belong in `also`. A hook that throws aborts the attempt before
 * anything is published, so a failed side effect fails the whole transaction closed.
 */
export type StagedAttempt = {
  readonly next: Oid
  readonly base: Oid
  readonly events: readonly Event[]
}

type EventWriteOptions = { readonly trailers?: readonly Trailer[] }

export type Events = {
  /** The chain tip, or null when the ref does not exist yet. */
  head(): Promise<Oid | null>
  events(options?: EventsRead): Promise<Event[]>
  /**
   * Read every event after `from` (or from genesis), decide, append, and replay
   * on a lost race. `message` names the transaction in errors. Long histories
   * are paged at one selected tip before `decide` runs; a missing boundary is
   * refused, never passed to `decide` as a partial chain.
   */
  transact(
    decide: Decide,
    message: string,
    options?: {
      also?: readonly AlsoRef[]
      author?: Ident
      from?: Oid
      afterStage?: (staged: StagedAttempt) => Promise<void>
    } & EventWriteOptions,
  ): Promise<Appended>
  /** Append at exactly `expect` (null = the chain must not exist); throws Conflict on a moved tip. */
  append(
    inputs: readonly EventInput[],
    options: { expect: Oid | null; also?: readonly AlsoRef[]; author?: Ident } & EventWriteOptions,
  ): Promise<Appended>
  /** Write commits locally without moving refs; publish the run once at the named tip. */
  stage(
    inputs: readonly EventInput[],
    options: { expect: Oid | null; author?: Ident } & EventWriteOptions,
  ): Promise<StagedEvents>
  watch(options: { signal: AbortSignal; pollIntervalMs?: number }): AsyncIterable<Event[]>
}

export type { AlsoRef } from "./ref-updates.js"

export type ListRefsOptions = {
  repo: string
  remote?: string
  backend?: GitomicBackend
}

export type ChainsUnderOptions = ListRefsOptions & {
  /** Events read per chain; default 50, refused above 1024 like `Reader.log`. */
  limit?: number
}

/** The one trailer key gitomic/events names: the envelope's `type`. Its value is opaque. */
export const EVENT_KEY = "Event"
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 1_024

type Capable = GitomicBackend & Required<Pick<GitomicBackend, "listRefs" | "readHistory" | "writeGenesis" | "publish">>

function requireEvents(backend: GitomicBackend): Capable {
  for (const method of ["listRefs", "readHistory", "writeGenesis", "publish"] as const) {
    if (typeof backend[method] !== "function") {
      throw new TypeError(
        `this backend cannot hold event chains: it has no ${method}; use the shell, iso or mem backend`,
      )
    }
  }
  return backend as Capable
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw new TypeError(`limit must be a positive safe integer no greater than ${MAX_LIMIT}`)
  }
  return limit
}

function assertLine(value: string, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`)
  assertUtf8(value, field)
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
  if (value.trim().length === 0 || hasControlCharacter || value !== value.trim()) {
    throw new TypeError(`${field} must be a non-empty, single line`)
  }
  return value
}

/** Validate one input and shape its commit: body text, trailers and parents. */
function shapeInput(input: EventInput) {
  rejectLegacyProvenance(input)
  const type = assertLine(input.type, "event type")
  // A reader of `git log --oneline` sees `writer: <type>`, never a generic word.
  const title = assertLine(input.title ?? type, "event title")
  const content = input.content ?? ""
  if (typeof content !== "string") throw new TypeError("event content must be a string")
  assertUtf8(content, "event content")
  if (content.includes("\0")) throw new TypeError("event content cannot contain NUL")
  const props = assertTrailers(input.props ?? [])
  for (const [key] of props) {
    if (key.toLowerCase() === EVENT_KEY.toLowerCase()) {
      throw new TypeError(`trailer key ${JSON.stringify(key)} is reserved: gitomic/events writes the event type there`)
    }
  }
  const keeps = (input.keeps ?? []).map((oid) => validateOid(oid, "invalid kept commit id"))
  const body = content.trim() === "" ? title : `${title}\n\n${content.trim()}`
  return { type, title, content: content.trim(), props, keeps, body }
}

/** Validate and snapshot per-call commit trailers before an event path awaits. */
function captureEventTrailers(trailers: readonly Trailer[] | undefined): readonly Trailer[] {
  if (trailers === undefined) return []
  return assertTrailers(trailers).map(([key, value]) => {
    if (key.toLowerCase() === EVENT_KEY.toLowerCase()) {
      throw new TypeError(`trailer key ${JSON.stringify(key)} is reserved: gitomic/events writes the event type there`)
    }
    return [key, value] as const
  })
}

type EventAttribution = { readonly author: Ident; readonly trailers: readonly Trailer[] }
type ShapedEventInput = ReturnType<typeof shapeInput> & EventAttribution

function eventAttribution(
  input: EventInput,
  defaultAuthor: Ident,
  fallbackAuthor: Ident,
  defaultTrailers: readonly Trailer[],
): EventAttribution {
  const author = Object.hasOwn(input, "author") ? (cloneIdent(input.author, "author") ?? fallbackAuthor) : defaultAuthor
  const trailers = Object.hasOwn(input, "trailers") ? captureEventTrailers(input.trailers) : defaultTrailers
  return { author, trailers }
}

function shapeEventInputs(
  inputs: readonly EventInput[],
  defaultAuthor: Ident,
  fallbackAuthor: Ident,
  defaultTrailers: readonly Trailer[],
  captured: (EventAttribution | undefined)[] = [],
): ShapedEventInput[] {
  return inputs.map((input, index) => {
    const attribution = captured[index] ?? eventAttribution(input, defaultAuthor, fallbackAuthor, defaultTrailers)
    captured[index] = attribution
    return { ...shapeInput(input), ...attribution }
  })
}

/**
 * Turn one walk into events. The walk is newest-first; the chain's root is the
 * genesis, which is not an event and is dropped. A root that is not the genesis
 * means the ref is not an event chain, and that is refused rather than guessed.
 */
function toEvents(history: readonly CommitMeta[], ref: string): { events: Event[]; genesis: Oid | undefined } {
  let genesis: Oid | undefined
  const events: Event[] = []
  for (const meta of history) {
    if (meta.parents.length === 0) {
      if (meta.message !== GENESIS_MESSAGE) {
        throw new Error(`${ref} is not an event chain: its root ${meta.oid} is not gitomic's genesis commit`)
      }
      genesis = meta.oid
      continue
    }
    events.push(toEvent(meta, ref))
  }
  return {
    genesis,
    // The first event's parent is the genesis: expose it as no parent at all.
    events: events.map((event) => (event.parent === genesis ? { ...event, parent: null } : event)),
  }
}

function toEvent(meta: CommitMeta, ref: string): Event {
  const typed = meta.trailers.filter(([key]) => key === EVENT_KEY)
  if (typed.length !== 1) {
    throw new Error(`commit ${meta.oid} on ${ref} has ${typed.length} ${EVENT_KEY}: trailers; an event has exactly one`)
  }
  const paragraphs = meta.message.trimEnd().split(/\n[ \t]*\n/)
  // The last paragraph is the trailer block; the first line is the subject.
  const text = paragraphs.slice(0, -1).join("\n\n")
  const newline = text.indexOf("\n")
  const subject = newline < 0 ? text : text.slice(0, newline)
  const generatedSeparator = subject.indexOf(": ")
  const currentGeneratedMessage = isCurrentGeneratedCommit(meta.message, meta.instance, meta.seq)
  const prefix =
    meta.writer !== null
      ? `${meta.writer}: `
      : meta.instance !== null && meta.seq !== null && generatedSeparator >= 0
        ? subject.slice(0, generatedSeparator + 2)
        : ""
  const title = subject.startsWith(prefix) ? subject.slice(prefix.length) : subject
  const content = newline < 0 ? "" : text.slice(newline + 1).replace(/^\n+/, "")
  const eventTrailerIndex = meta.trailers.findIndex(([key]) => key === EVENT_KEY)
  return {
    id: meta.oid,
    parent: meta.parents[0] ?? null,
    links: meta.parents.slice(1),
    type: (typed[0] as Trailer)[1],
    title,
    content,
    props: currentGeneratedMessage
      ? meta.trailers.slice(0, eventTrailerIndex)
      : meta.trailers.filter(([key]) => key !== EVENT_KEY),
    writer: meta.writer,
    instance: meta.instance,
    seq: meta.seq,
    author: meta.author,
    committer: meta.committer,
  }
}

// oxlint-disable-next-line typescript/require-await -- Promise-typed open rejects validation errors, never throws synchronously.
export async function openEvents(options: EventsOptions): Promise<Events> {
  if (options.writer !== undefined) assertWriter(options.writer)
  const committer = cloneIdent(options.committer, "committer") ?? GITOMIC_IDENT
  const clock = normalizeClock(options.clock)
  const repo = options.repo
  const ref = normalizeRef(options.ref)
  const writer = options.writer ?? DEFAULT_WRITER_LABEL
  const backend = requireEvents(options.backend ?? createShellBackend())
  const retryBudgetMs = normalizeRetryBudget(options.retryBudgetMs)
  const remote = options.remote
  if (options.fetch !== undefined && !Array.isArray(options.fetch)) {
    throw new TypeError("events fetch needs an array of full refs/ names")
  }
  const extra: readonly string[] = options.fetch ?? []
  if (extra.some((name) => typeof name !== "string" || !name.startsWith("refs/"))) {
    throw new TypeError("events fetch needs an array of full refs/ names")
  }
  if (new Set([ref, ...extra]).size !== extra.length + 1) {
    throw new TypeError(`${ref}: events fetch repeats the chain ref or another ref`)
  }
  if (extra.length > 0 && remote === undefined) throw new TypeError(`${ref}: events fetch needs a remote`)
  // One id per open, exactly like `open`: `(instance, seq)` names a transaction
  // without a lock or a stored high-water mark.
  const instance = randomUUID()
  let seq = 0

  let tip: () => Promise<Oid | null>
  if (remote === undefined) {
    tip = async () => (await backend.listRefs(repo, ref)).get(ref) ?? null
  } else {
    const fetchRefs = backend.fetchRefs
    if (fetchRefs === undefined) {
      throw new TypeError("this backend cannot read remotely; omit remote or use the shell/iso backend")
    }
    tip = async () => {
      const listed = (await backend.listRefs(repo, ref, remote)).get(ref) ?? null
      // Bring the objects over into gitomic's private namespace: no application
      // ref moves, and no local ref is treated as a cache of the remote.
      if (listed !== null) {
        const fetched = await fetchRefs(
          repo,
          [ref, ...extra],
          remote,
          extra.length === 0 ? undefined : { absent: "omit" },
        )
        if (fetched.get(ref) === undefined) throw new Error(`${remote} lost ${ref} while fetching its event chain`)
      }
      return listed
    }
  }

  /**
   * One atomic publish of the event ref plus every `also` ref. A conflict that
   * names the chain alone returns false, so the loop re-reads and re-decides:
   * every `also` lease is untouched, and the next atomic publish re-checks each
   * of them. A conflict naming any `also` ref is final and reaches the caller
   * as the typed Conflict naming that ref, even alongside the chain (@cto
   * a8b9146d, 25708). The backend names every rejected ref with its expected
   * and observed values. Other failures remain the backend's Error.
   */
  const publishWith =
    (also: readonly RefUpdate[]) =>
    async (next: Oid, expected: Oid | null): Promise<boolean> => {
      try {
        await backend.publish(repo, [{ ref, expect: expected ?? zeroOid(next), oid: next }, ...also], remote)
        return true
      } catch (error) {
        // The tool named each lost lease. A lost `also` ref is final: a retry
        // would find it just as stale. The chain alone is the usual race.
        if (error instanceof Conflict && error.refs.length > 0 && error.refs.every((lost) => lost === ref)) return false
        throw error
      }
    }
  const shapeAlso = (also: readonly AlsoRef[] | undefined): RefUpdate[] => shapeRefUpdates(ref, also, "also")

  const readChain = async (at: Oid, options: { from?: Oid; limit: number }) => {
    const history = await backend.readHistory(repo, [at], {
      ...(options.from === undefined ? {} : { exclude: [options.from] }),
      // One more than asked for, so the genesis fits when the chain is short.
      limit: options.limit + 1,
    })
    const read = toEvents(history, ref)
    return { ...read, events: read.events.slice(0, options.limit) }
  }

  /** Watch keeps its bounded jump refusal; a partial batch is never yielded. */
  const readWhole = async (at: Oid, from?: Oid) => {
    const history = await backend.readHistory(repo, [at], {
      ...(from === undefined ? {} : { exclude: [from] }),
      // The genesis is one commit beyond the bound's worth of events.
      limit: MAX_LIMIT + 1,
    })
    const oldest = history.at(-1)
    const reached =
      from === undefined
        ? oldest !== undefined && oldest.parents.length === 0
        : oldest === undefined || (oldest.parents[0] === from && history.length <= MAX_LIMIT)
    if (!reached) {
      const boundary = from === undefined ? "its genesis" : `event ${from}`
      throw new Error(
        `${ref} at ${at} does not reach ${boundary} within ${MAX_LIMIT} events; refusing a partial read. ` +
          `Page through it with events({ from, limit }) instead.`,
      )
    }
    return toEvents(history, ref)
  }

  /** Assemble one attempt's complete history before a transaction decides. */
  const readComplete = async (at: Oid, from?: Oid): Promise<Event[]> => {
    const pages: Event[][] = []
    const seen = new Set<Oid>()
    let cursor = at
    for (;;) {
      if (seen.has(cursor)) throw new Error(`${ref} at ${at}: event paging did not advance at ${cursor}`)
      seen.add(cursor)
      const { events } = await readChain(cursor, { ...(from === undefined ? {} : { from }), limit: MAX_LIMIT })
      if (events.length === 0) {
        if (cursor === from) return pages.flat().reverse()
        throw new Error(`${ref} at ${at} does not reach event ${from ?? "its genesis"}; refusing a partial read`)
      }
      if (events[0]?.id !== cursor) {
        throw new Error(`${ref} at ${at}: event paging expected ${cursor}, read ${events[0]?.id ?? "nothing"}`)
      }
      for (let index = 0; index + 1 < events.length; index++) {
        if (events[index]?.parent !== events[index + 1]?.id) {
          throw new Error(`${ref} at ${at}: event paging lost the first-parent chain at ${events[index]?.id}`)
        }
      }
      pages.push(events)
      const parent = events.at(-1)?.parent
      if (from === undefined ? parent === null : parent === from) return pages.flat().reverse()
      if (parent === null || parent === undefined) {
        throw new Error(`${ref} at ${at} does not reach event ${from}; refusing a partial read`)
      }
      cursor = parent
    }
  }

  /**
   * Write `inputs` as a run of empty-tree commits on `base`. `reserved` keeps
   * each position's seq across replays, so a replayed transaction reuses its
   * receipts instead of minting new ones.
   */
  const writeRun = async (
    base: Oid,
    /** True when `base` is the genesis: the chain did not exist, so event 1 has no parent. */
    newChain: boolean,
    inputs: readonly ShapedEventInput[],
    reserved: number[],
  ): Promise<{ next: Oid; written: Event[]; lastSeq: number }> => {
    let previous = base
    const written: Event[] = []
    for (const [position, input] of inputs.entries()) {
      reserved[position] ??= seq++
      const eventSeq = reserved[position] as number
      const oid = await backend.writeCommit(repo, {
        parent: previous,
        time: clock(),
        parents: [previous, ...input.keeps],
        changes: new Map(),
        allowEmpty: true,
        trailers: [...input.props, [EVENT_KEY, input.type], ...input.trailers],
        message: input.body,
        writer,
        instance,
        seq: eventSeq,
        author: input.author,
        committer,
      })
      written.push({
        id: oid,
        parent: position === 0 && newChain ? null : previous,
        links: input.keeps,
        type: input.type,
        title: input.title,
        content: input.content,
        props: input.props,
        writer,
        instance,
        seq: eventSeq,
        author: input.author,
        committer,
      })
      previous = oid
    }
    return { next: previous, written, lastSeq: reserved[inputs.length - 1] as number }
  }

  let genesis: Oid | undefined
  const genesisOf = async (): Promise<Oid> => (genesis ??= await backend.writeGenesis(repo))

  const findTransaction = async (winner: Oid | null, base: Oid, receiptInstance: string, receiptSeq: number) =>
    winner === null ? undefined : backend.findTransaction(repo, winner, base, receiptInstance, receiptSeq)

  const label = `${repo} ${ref}`

  return {
    head: tip,
    async events(read = {}) {
      const limit = normalizeLimit(read.limit)
      const from = read.from === undefined ? undefined : validateOid(read.from, "events from must be an event id")
      const at = read.at === undefined ? await tip() : validateOid(read.at, "events at must be an event id")
      if (at === null) return []
      const { events } = await readChain(at, { ...(from === undefined ? {} : { from }), limit })
      // The walk is newest-first.
      return read.order === "newest-first" ? events : events.reverse()
    },
    async transact(decide, message, transactOptions = {}) {
      rejectLegacyProvenance(transactOptions)
      const why = assertLine(typeof message === "string" ? message.trim() : message, "message")
      const callerTrailers = captureEventTrailers(transactOptions.trailers)
      const author = cloneIdent(transactOptions.author, "author") ?? committer
      const publish = publishWith(shapeAlso(transactOptions.also))
      const afterStage = transactOptions.afterStage
      const from =
        transactOptions.from === undefined
          ? undefined
          : validateOid(transactOptions.from, "transact from must be an event id")
      const reserved: number[] = []
      const capturedAttributions: (EventAttribution | undefined)[] = []
      return runCasLoop<Oid | null, Appended>({
        // `message` names the transaction in the loop's errors; each event's own
        // subject comes from its type or title.
        label: `${label} (${why})`,
        retryBudgetMs,
        refresh: tip,
        publish,
        findTransaction,
        attempt: async (at, retries) => {
          if (at === null && from !== undefined) {
            throw new Error(`${ref} has no chain tip to reach event ${from}; refusing a partial read.`)
          }
          const current = at === null ? [] : await readComplete(at, from)
          const inputs = await decide(current)
          if (inputs.length === 0) return { kind: "noop", result: { head: at, events: [], retries } }
          const shaped = shapeEventInputs(inputs, author, committer, callerTrailers, capturedAttributions)
          const base = at ?? (await genesisOf())
          const { next, written, lastSeq } = await writeRun(base, at === null, shaped, reserved)
          // The caller's local-only side effect rides the attempt, not the publish: it runs after staging and before
          // the single publish, once per CAS attempt, and a throw here fails the attempt before anything lands.
          if (afterStage !== undefined) await afterStage({ next, base, events: written })
          return {
            kind: "write",
            next,
            base,
            instance,
            seq: lastSeq,
            landed: (oid, landedRetries) => ({ head: oid, events: written, retries: landedRetries }),
          }
        },
      })
    },
    async append(inputs, appendOptions) {
      rejectLegacyProvenance(appendOptions)
      const { expect, also, author: named, trailers: namedTrailers } = appendOptions
      if (inputs.length === 0) throw new TypeError("append needs at least one event")
      const callerTrailers = captureEventTrailers(namedTrailers)
      const author = cloneIdent(named, "author") ?? committer
      const shaped = shapeEventInputs(inputs, author, committer, callerTrailers)
      const expected = expect === null ? null : validateOid(expect, "append expect must be an event id or null")
      const publish = publishWith(shapeAlso(also))
      const reserved: number[] = []
      // The caller names the tip and the compare-and-swap enforces it, so the
      // first attempt trusts `expect` instead of spending a process to re-read
      // it. After a lost publish the loop re-reads for real: then a moved tip is
      // seen, and throws Conflict below.
      let trusted = true
      const refresh = async (): Promise<Oid | null> => {
        if (trusted) {
          trusted = false
          return expected
        }
        return tip()
      }
      return runCasLoop<Oid | null, Appended>({
        label,
        retryBudgetMs,
        refresh,
        publish,
        findTransaction,
        attempt: async (at) => {
          // XADD with an explicit id: a moved tip is a Conflict, never a replay.
          if (at !== expected) {
            throw new Conflict(`${label} is at ${at ?? "nothing"}, not the expected ${expected ?? "nothing"}`)
          }
          const base = at ?? (await genesisOf())
          const { next, written, lastSeq } = await writeRun(base, at === null, shaped, reserved)
          return {
            kind: "write",
            next,
            base,
            instance,
            seq: lastSeq,
            landed: (oid, retries) => ({ head: oid, events: written, retries }),
          }
        },
      })
    },
    async stage(inputs, stageOptions) {
      rejectLegacyProvenance(stageOptions)
      const { expect, author: named, trailers: namedTrailers } = stageOptions
      if (inputs.length === 0) throw new TypeError("stage needs at least one event")
      const callerTrailers = captureEventTrailers(namedTrailers)
      const author = cloneIdent(named, "author") ?? committer
      const shaped = shapeEventInputs(inputs, author, committer, callerTrailers)
      const expected = expect === null ? null : validateOid(expect, "stage expect must be an event id or null")
      const base = expected ?? (await genesisOf())
      const { next, written } = await writeRun(base, expected === null, shaped, [])
      let attempted = false
      return {
        ref,
        expect: expected,
        head: next,
        events: written,
        async publish(options = {}) {
          if (attempted) throw new Error(`${label}: staged events already attempted publication`)
          attempted = true
          const published = await publishWith(shapeAlso(options.also))(next, expected)
          if (!published) throw new Conflict(`${label}: staged events lost their expected tip`, { refs: [ref] })
          return { head: next, events: written, retries: 0 }
        },
      }
    },
    async *watch(watchOptions) {
      const pollIntervalMs = normalizePollInterval(watchOptions.pollIntervalMs)
      let previous = await untilAborted(tip(), watchOptions.signal)
      if (previous === undefined) return
      while (!watchOptions.signal.aborted) {
        const next = await untilAborted(tip(), watchOptions.signal)
        if (next === undefined) return
        if (next !== null && next !== previous) {
          const { events } = await readWhole(next, previous ?? undefined)
          previous = next
          yield events.reverse()
          continue
        }
        if (!(await waitForPoll(pollIntervalMs, watchOptions.signal))) return
      }
    },
  }
}

/**
 * Fetch every ref under `refs` (a prefix) or exactly the named refs from
 * `remote`, with their objects, in ONE git process; return each ref's tip under
 * its original name. Only gitomic's private namespace is written.
 */
export async function fetchRefs(
  refs: string | readonly string[],
  options: ListRefsOptions & { remote: string },
): Promise<ReadonlyMap<string, Oid>> {
  const backend = options.backend ?? createShellBackend()
  if (backend.fetchRefs === undefined) throw new TypeError("this backend cannot fetch; use the shell or iso backend")
  return backend.fetchRefs(options.repo, refs, options.remote)
}

/** Every ref under `prefix` and its tip: `for-each-ref` locally, `ls-remote --refs` remotely. */
export async function listRefs(prefix: string, options: ListRefsOptions): Promise<ReadonlyMap<string, Oid>> {
  const backend = requireEvents(options.backend ?? createShellBackend())
  return backend.listRefs(options.repo, prefix, options.remote)
}

/**
 * Every chain under `prefix`, read in one walk: the tips from `listRefs`, then
 * ONE `readHistory` over all of them, with each chain rebuilt from its commits'
 * first parents. A chain the shared read budget did not reach its root on, and
 * did not fill to `limit`, is refused loudly rather than returned short.
 */
export async function chainsUnder(prefix: string, options: ChainsUnderOptions): Promise<ReadonlyMap<string, Event[]>> {
  const limit = normalizeLimit(options.limit)
  const backend = requireEvents(options.backend ?? createShellBackend())
  let refs: ReadonlyMap<string, Oid>
  if (options.remote === undefined) {
    refs = await backend.listRefs(options.repo, prefix)
  } else {
    // ONE fetch brings every tip under the prefix and its objects, into
    // gitomic's private namespace; the walk below then reads them locally.
    if (backend.fetchRefs === undefined) {
      throw new TypeError("this backend cannot read remote chains; omit remote or use the shell/iso backend")
    }
    refs = await backend.fetchRefs(options.repo, prefix, options.remote)
  }
  const tips = [...new Set(refs.values())]
  if (tips.length === 0) return new Map()
  const history = await backend.readHistory(options.repo, tips, { limit: (limit + 1) * tips.length })
  const byId = new Map(history.map((meta) => [meta.oid, meta]))
  const chains = new Map<string, Event[]>()
  for (const [ref, tip] of refs) {
    const walk: CommitMeta[] = []
    let oid: Oid | undefined = tip
    let reachedRoot = false
    while (oid !== undefined && walk.length < limit + 1) {
      const meta = byId.get(oid)
      if (meta === undefined) break
      walk.push(meta)
      if (meta.parents.length === 0) {
        reachedRoot = true
        break
      }
      oid = meta.parents[0]
    }
    const eventsRead = walk.filter((meta) => meta.parents.length > 0).length
    if (!reachedRoot && eventsRead < limit) {
      throw new Error(`chainsUnder read budget ran out before ${ref} reached its root; read it with openEvents instead`)
    }
    chains.set(ref, toEvents(walk, ref).events.slice(0, limit).reverse())
  }
  return chains
}
