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

import { runCasLoop } from "./engine.js"
import { Conflict } from "./errors.js"
import { assertTrailers, GENESIS_MESSAGE, validateOid, zeroOid } from "./git-object.js"
import {
  assertWriter,
  DEFAULT_WRITER_LABEL,
  normalizePollInterval,
  normalizeRef,
  normalizeRetryBudget,
  untilAborted,
  waitForPoll,
} from "./options.js"
import { createShellBackend } from "./shell.js"
import type { CommitMeta, GitomicBackend, Oid, RefUpdate, Trailer } from "./types.js"
import { assertUtf8 } from "./utf8.js"

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
  /**
   * Read every event, decide, append, and replay on a lost race. `message` names
   * the transaction in errors. A chain over 1024 events is refused, not truncated.
   */
  transact(decide: Decide, message: string, options?: { also?: readonly AlsoRef[] }): Promise<Appended>
  /** Append at exactly `expect` (null = the chain must not exist); throws Conflict on a moved tip. */
  append(inputs: readonly EventInput[], options: { expect: Oid | null; also?: readonly AlsoRef[] }): Promise<Appended>
  watch(options: { signal: AbortSignal; pollIntervalMs?: number }): AsyncIterable<Event[]>
}

/**
 * Another ref to move in the SAME atomic publish as the event: from `expect`
 * (null: absent) to `oid`. A branch head beside the event that names it, say.
 * If it lost its expectation, nothing lands and the append or transact throws
 * Conflict naming it; it is never retried.
 */
export type AlsoRef = {
  readonly ref: string
  readonly expect: Oid | null
  readonly oid: Oid
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
  const prefix = meta.writer === null ? "" : `${meta.writer}: `
  const title = subject.startsWith(prefix) ? subject.slice(prefix.length) : subject
  const content = newline < 0 ? "" : text.slice(newline + 1).replace(/^\n+/, "")
  return {
    id: meta.oid,
    parent: meta.parents[0] ?? null,
    links: meta.parents.slice(1),
    type: (typed[0] as Trailer)[1],
    title,
    content,
    props: meta.trailers.filter(([key]) => key !== EVENT_KEY),
    writer: meta.writer,
    instance: meta.instance,
    seq: meta.seq,
  }
}

export async function openEvents(options: EventsOptions): Promise<Events> {
  if (options.writer !== undefined) assertWriter(options.writer)
  const repo = options.repo
  const ref = normalizeRef(options.ref)
  const writer = options.writer ?? DEFAULT_WRITER_LABEL
  const backend = requireEvents(options.backend ?? createShellBackend())
  const retryBudgetMs = normalizeRetryBudget(options.retryBudgetMs)
  const remote = options.remote
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
      if (listed !== null) await fetchRefs(repo, [ref], remote)
      return listed
    }
  }

  /**
   * One atomic publish of the event ref plus every `also` ref. A lost `also`
   * lease is a Conflict now; the event ref alone is contention, returned as false
   * for the loop to handle. Any other failure is the backend's Error.
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
  const shapeAlso = (also: readonly AlsoRef[] | undefined): RefUpdate[] => {
    const seen = new Set<string>([ref])
    return (also ?? []).map((update) => {
      const alsoRef = normalizeRef(update.ref)
      if (alsoRef === ref) throw new TypeError(`an also ref cannot be the chain itself: ${ref}`)
      if (seen.has(alsoRef)) throw new TypeError(`also names ${alsoRef} more than once`)
      seen.add(alsoRef)
      const oid = validateOid(update.oid, `also oid for ${alsoRef} must be a commit id`)
      const expect =
        update.expect === null
          ? zeroOid(oid)
          : validateOid(update.expect, `also expect for ${alsoRef} must be a commit id or null`)
      return { ref: alsoRef, expect, oid }
    })
  }

  const readChain = async (at: Oid, options: { from?: Oid; limit: number }) => {
    const history = await backend.readHistory(repo, [at], {
      ...(options.from === undefined ? {} : { exclude: [options.from] }),
      // One more than asked for, so the genesis fits when the chain is short.
      limit: options.limit + 1,
    })
    const read = toEvents(history, ref)
    return { ...read, events: read.events.slice(0, options.limit) }
  }

  /**
   * Read EVERY event from `at` back to a boundary: `from` when given, else the
   * genesis. transact's decide and watch's batches must see the whole span, so a
   * span longer than the bound is refused rather than handed over truncated as if
   * it were whole. Paging through a long chain is `events({ from, limit })`.
   */
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

  /**
   * Write `inputs` as a run of empty-tree commits on `base`. `reserved` keeps
   * each position's seq across replays, so a replayed transaction reuses its
   * receipts instead of minting new ones.
   */
  const writeRun = async (
    base: Oid,
    /** True when `base` is the genesis: the chain did not exist, so event 1 has no parent. */
    newChain: boolean,
    inputs: readonly EventInput[],
    reserved: number[],
  ): Promise<{ next: Oid; written: Event[]; lastSeq: number }> => {
    const shaped = inputs.map(shapeInput)
    let previous = base
    const written: Event[] = []
    for (const [position, input] of shaped.entries()) {
      reserved[position] ??= seq++
      const eventSeq = reserved[position] as number
      const oid = await backend.writeCommit(repo, {
        parent: previous,
        parents: [previous, ...input.keeps],
        changes: new Map(),
        allowEmpty: true,
        trailers: [...input.props, [EVENT_KEY, input.type]],
        message: input.body,
        writer,
        instance,
        seq: eventSeq,
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
      })
      previous = oid
    }
    return { next: previous, written, lastSeq: reserved[shaped.length - 1] as number }
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
      const at = await tip()
      if (at === null) return []
      const { events } = await readChain(at, { ...(from === undefined ? {} : { from }), limit })
      // The walk is newest-first.
      return read.order === "newest-first" ? events : events.reverse()
    },
    async transact(decide, message, transactOptions = {}) {
      const why = assertLine(typeof message === "string" ? message.trim() : message, "message")
      const publish = publishWith(shapeAlso(transactOptions.also))
      const reserved: number[] = []
      return runCasLoop<Oid | null, Appended>({
        // `message` names the transaction in the loop's errors; each event's own
        // subject comes from its type or title.
        label: `${label} (${why})`,
        retryBudgetMs,
        refresh: tip,
        publish,
        findTransaction,
        attempt: async (at, retries) => {
          const current = at === null ? [] : (await readWhole(at)).events.reverse()
          const inputs = await decide(current)
          if (inputs.length === 0) return { kind: "noop", result: { head: at, events: [], retries } }
          const base = at ?? (await genesisOf())
          const { next, written, lastSeq } = await writeRun(base, at === null, inputs, reserved)
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
    async append(inputs, { expect, also }) {
      if (inputs.length === 0) throw new TypeError("append needs at least one event")
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
          const { next, written, lastSeq } = await writeRun(base, at === null, inputs, reserved)
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
