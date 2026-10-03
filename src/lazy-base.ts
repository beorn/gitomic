import { objectOid } from "./git-object.ts"
import { assertRegularBlob, assertTreeShape, isPublicPath, normalizePath } from "./path.ts"
import type { BlobValue, GitomicBackend, Oid, TreeEntry, TreeListing } from "./types.js"
import { assertUtf8, decodeUtf8 } from "./utf8.ts"

/**
 * The base tree of one transaction attempt: whole-tree strict on SHAPE, lazy on
 * VALUES.
 *
 * The listing (every path, mode and oid) is read and shape-validated once per
 * attempt, so a colliding, symlinked or gitlinked entry refuses the write as it
 * always did. A VALUE is fetched only when a read asks for it — the update's
 * `get`, the candidate's `readBase`, or `apply`'s prefetch of its edit paths —
 * and it is UTF-8-validated at that read, never for the blobs the write does
 * not touch. Reads issued in one microtask coalesce into one `readBlobs`; a
 * value is memoised by oid for the rest of the attempt.
 *
 * A transaction's LazyBase is created inside one attempt and never outlives
 * it: a CAS replay builds a new one on the new parent, so no memoised value
 * crosses parents. A Snapshot keeps ONE LazyBase for its whole life, pinned at
 * its one commit, over the one map `createSnapshotBase` grows — a whole listing
 * for `keys(prefix)`, or a memoised exact entry per path asked (27226 part 2).
 * A value the Snapshot memoises can never go stale; a read that failed is not
 * memoised, so a later read of the same path asks the backend again.
 */
export type LazyBase = {
  readonly listing: TreeListing
  readonly algorithm: "sha1" | "sha256"
  has(path: string): boolean
  /** The blob oid at `path` from the listing — no value read, so it answers for a binary blob too. */
  oid(path: string): Oid | undefined
  /** The public paths of the listing, unsorted. */
  publicPaths(): string[]
  /** The stored value at `path`, decoded and validated at this read; `undefined` when absent. */
  get(path: string): Promise<string | undefined>
  /** Internal raw value for an OID-anchored move; no public GitMap byte read. */
  raw(path: string): Promise<BlobValue | undefined>
  /** Fetch the values of every listed path among `paths` in one read, so later `get`s answer from memory. */
  prefetch(paths: Iterable<string>): Promise<void>
  /** Whether writing `content` at `path` (or deleting it, `undefined`) changes the tree. Decided from the listing. */
  isChange(path: string, content: BlobValue | undefined): boolean
}

type Waiter = { readonly path: string; resolve(value: BlobValue): void; reject(error: unknown): void }

/**
 * Read `commit`'s listing and build the lazy base on it. `prefix` is passed to the backend's `readTree`, which
 * lists the WHOLE tree and filters in JS; a Snapshot passes none so its one listing answers every prefix, and the
 * scoped form is kept for callers that want the filter pushed to the edges of the listing.
 */
export async function readLazyBase(
  backend: GitomicBackend,
  repo: string,
  commit: Oid,
  prefix?: string,
): Promise<LazyBase> {
  return createLazyBase(backend, repo, commit, await backend.readTree(repo, commit, prefix))
}

/**
 * THE policy site for a listing exposed WHOLE: every entry must be a regular blob and the paths must be a tree,
 * refused by name before any value can be read. A transaction takes this exposure, so a base tree holding a
 * symlink or a gitlink refuses the write whatever paths it names. A reader that validates only what each verb
 * EXPOSES passes "caller" and calls this itself with the paths that verb exposes (see createSnapshotBase).
 *
 * One predicate decides a supported mode: assertRegularBlob in path.ts, called from here and from that verb site,
 * never a second mode test (27226, @cto acb610e6).
 */
export function assertExposed(listing: TreeListing, paths: readonly string[]): void {
  assertTreeShape(paths)
  for (const path of paths) {
    const entry = listing.get(path)
    if (entry !== undefined) assertRegularBlob(path, entry.mode, "blob")
  }
}

/**
 * The tree access of one Snapshot: ONE listing map that answers BOTH of a reader's questions, at the same commit
 * (27226 part 2, @cto 0f5c2039).
 *
 * `keys(prefix)` is the whole-listing question. It loads `readTree` once and keeps it, so the one listing answers
 * every later `keys` and every later exact path, and its `startsWith` contract is exactly what it always was.
 *
 * `get`/`oid`/`has` are the exact-path question. Each distinct path costs ONE scoped lookup (`readTreeExact`, one
 * small `ls-tree` child on the shell backend) memoised into that same map, so a repeat costs nothing; a path the
 * tree does not hold is remembered as absent too. The exact lookup NEVER answers `keys`, and `keys` never assembles
 * from partial lookups — the map holds a subset of one whole listing, never a different tree.
 *
 * The base that reads VALUES is the ordinary LazyBase over that same live map, so the blob memo, the batching and
 * the read-error wrapping are the one implementation, not a second. Exposure is "caller": each verb validates the
 * paths it exposes with `assertExposed`, so a whole-tree refusal is not charged to a one-path read (27226), and the
 * one `assertRegularBlob` predicate still decides acceptability at both entry points.
 */
export type SnapshotBase = LazyBase & {
  /** Resolve the exact path through the one map; the first ask costs one scoped lookup, a repeat nothing. */
  resolveExact(path: string): Promise<void>
  /** Load and keep the whole listing, so every later `keys` and every later exact path answers with no read. */
  wholeListing(): Promise<void>
}

export function createSnapshotBase(backend: GitomicBackend, repo: string, commit: Oid): SnapshotBase {
  const entries = new Map<string, TreeEntry>()
  const base = createLazyBase(backend, repo, commit, entries, "caller")
  const resolved = new Set<string>()
  let whole: Promise<void> | undefined
  const loadWhole = (): Promise<void> => {
    whole ??= (async () => {
      for (const [path, entry] of await backend.readTree(repo, commit)) entries.set(path, entry)
    })()
    return whole
  }
  return {
    ...base,
    async wholeListing() {
      await loadWhole()
    },
    async resolveExact(path) {
      if (whole !== undefined) {
        await whole
        return
      }
      const normalized = normalizePath(path)
      if (resolved.has(normalized)) return
      const entry = await backend.readTreeExact(repo, commit, normalized)
      if (entry !== undefined) entries.set(normalized, entry)
      resolved.add(normalized)
    },
  }
}

/** A lazy base over a listing already read: values fetched by oid on demand. */
export function createLazyBase(
  backend: GitomicBackend,
  repo: string,
  parent: Oid,
  listing: TreeListing,
  exposure: "whole" | "caller" = "whole",
): LazyBase {
  if (exposure === "whole") assertExposed(listing, [...listing.keys()])
  const algorithm = parent.length === 64 ? "sha256" : "sha1"
  const memo = new Map<Oid, Promise<BlobValue>>()
  let pending: Map<Oid, Waiter[]> | undefined

  const unreadable = (oid: Oid, path: string, error: unknown): Error =>
    new Error(
      `cannot read Git blob at ${JSON.stringify(path)} (${oid}) in ${JSON.stringify(repo)} at commit ${parent}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  const settle = (oid: Oid, waiters: readonly Waiter[], read: ReadonlyMap<Oid, BlobValue>): void => {
    const value = read.get(oid)
    for (const waiter of waiters) {
      if (value === undefined) {
        memo.delete(oid)
        waiter.reject(
          new Error(
            `backend returned no blob ${oid} for Git blob at ${JSON.stringify(waiter.path)} in ${JSON.stringify(repo)} at commit ${parent}`,
          ),
        )
      } else {
        waiter.resolve(value)
      }
    }
  }
  const flush = async (batch: Map<Oid, Waiter[]>): Promise<void> => {
    let read: ReadonlyMap<Oid, BlobValue>
    try {
      read = await backend.readBlobs(repo, [...batch.keys()])
    } catch (error) {
      // The backend names the oid it could not read; the reader wants the PATH that asked. A batch of several oids
      // is re-read one oid at a time, so a present blob resolves and only the lost one rejects, naming its own
      // path, repo and commit with the backend's error as the cause. A rejected value leaves the memo, so a later
      // read of that path asks again instead of inheriting this failure.
      for (const [oid, waiters] of batch) {
        let alone: ReadonlyMap<Oid, BlobValue> | undefined
        try {
          alone = batch.size === 1 ? undefined : await backend.readBlobs(repo, [oid])
        } catch (own) {
          memo.delete(oid)
          for (const waiter of waiters) waiter.reject(unreadable(oid, waiter.path, own))
          continue
        }
        if (alone === undefined) {
          memo.delete(oid)
          for (const waiter of waiters) waiter.reject(unreadable(oid, waiter.path, error))
          continue
        }
        settle(oid, waiters, alone)
      }
      return
    }
    for (const [oid, waiters] of batch) settle(oid, waiters, read)
  }

  const request = (oid: Oid, path: string): Promise<BlobValue> =>
    new Promise<BlobValue>((resolve, reject) => {
      if (pending === undefined) {
        const batch = new Map<Oid, Waiter[]>()
        pending = batch
        // Every read issued before this microtask runs joins the same `readBlobs`.
        queueMicrotask(() => {
          pending = undefined
          void flush(batch)
        })
      }
      const waiters = pending.get(oid)
      const waiter: Waiter = { path, resolve, reject }
      if (waiters === undefined) pending.set(oid, [waiter])
      else waiters.push(waiter)
    })

  const stored = (path: string): Promise<BlobValue> | undefined => {
    const entry = listing.get(path)
    if (entry === undefined) return undefined
    let value = memo.get(entry.oid)
    if (value === undefined) {
      value = request(entry.oid, path)
      memo.set(entry.oid, value)
    }
    return value
  }

  return {
    listing,
    algorithm,
    has: (path) => listing.has(path),
    oid: (path) => listing.get(path)?.oid,
    publicPaths: () => [...listing.keys()].filter(isPublicPath),
    async get(path) {
      let value: BlobValue | undefined
      try {
        value = await stored(path)
      } catch (error) {
        // The memo is keyed by oid, so a shared promise was named after the first path that asked; this read names
        // its own path, with the backend's error (not the other path's wrapper) as the cause.
        const cause = error instanceof Error && error.cause !== undefined ? error.cause : error
        throw unreadable(listing.get(path)?.oid ?? "?", path, cause)
      }
      if (value === undefined) return undefined
      // The one UTF-8 check a write performs: on the value it reads, at the read.
      if (typeof value === "string") {
        assertUtf8(value, `Git blob at ${JSON.stringify(path)}`)
        return value
      }
      return decodeUtf8(value, `Git blob at ${JSON.stringify(path)}`)
    },
    async raw(path) {
      try {
        return await stored(path)
      } catch (error) {
        const cause = error instanceof Error && error.cause !== undefined ? error.cause : error
        throw unreadable(listing.get(path)?.oid ?? "?", path, cause)
      }
    },
    async prefetch(paths) {
      const reads: Promise<BlobValue>[] = []
      for (const path of paths) {
        const value = stored(normalizePath(path))
        if (value !== undefined) reads.push(value)
      }
      // A prefetch only warms the memo; a value that fails to decode is refused by the read that asks for it.
      await Promise.allSettled(reads)
    },
    isChange(path, content) {
      const entry = listing.get(path)
      if (content === undefined) return entry !== undefined
      const bytes = Buffer.from(content)
      return entry === undefined || entry.oid !== objectOid("blob", bytes, algorithm)
    },
  }
}
