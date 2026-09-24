import { objectOid } from "./git-object.js"
import { assertTreeShape, isPublicPath, normalizePath } from "./path.js"
import type { BlobValue, GitomicBackend, Oid, TreeListing } from "./types.js"
import { assertUtf8, decodeUtf8 } from "./utf8.js"

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
 * A LazyBase is created inside one attempt and never outlives it: a CAS replay
 * builds a new one on the new parent, so no memoised value crosses parents.
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
  /** Fetch the values of every listed path among `paths` in one read, so later `get`s answer from memory. */
  prefetch(paths: Iterable<string>): Promise<void>
  /** Whether writing `content` at `path` (or deleting it, `undefined`) changes the tree. Decided from the listing. */
  isChange(path: string, content: string | undefined): boolean
}

type Waiter = { readonly path: string; resolve(value: BlobValue): void; reject(error: unknown): void }

/** Read `commit`'s listing (whole, or one prefix's) and build the lazy base on it. */
export async function readLazyBase(
  backend: GitomicBackend,
  repo: string,
  commit: Oid,
  prefix?: string,
): Promise<LazyBase> {
  return createLazyBase(backend, repo, commit, await backend.readTree(repo, commit, prefix))
}

/** A lazy base over a listing already read: shape-validated here, values fetched by oid on demand. */
export function createLazyBase(backend: GitomicBackend, repo: string, parent: Oid, listing: TreeListing): LazyBase {
  assertTreeShape(listing.keys())
  const algorithm = parent.length === 64 ? "sha256" : "sha1"
  const memo = new Map<Oid, Promise<BlobValue>>()
  let pending: Map<Oid, Waiter[]> | undefined

  const flush = async (batch: Map<Oid, Waiter[]>): Promise<void> => {
    let read: ReadonlyMap<Oid, BlobValue>
    try {
      read = await backend.readBlobs(repo, [...batch.keys()])
    } catch (error) {
      for (const waiters of batch.values()) for (const waiter of waiters) waiter.reject(error)
      return
    }
    for (const [oid, waiters] of batch) {
      const value = read.get(oid)
      for (const waiter of waiters) {
        if (value === undefined) {
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
      const value = await stored(path)
      if (value === undefined) return undefined
      // The one UTF-8 check a write performs: on the value it reads, at the read.
      if (typeof value === "string") {
        assertUtf8(value, `Git blob at ${JSON.stringify(path)}`)
        return value
      }
      return decodeUtf8(value, `Git blob at ${JSON.stringify(path)}`)
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
      // Same bytes, same oid: a string that hashes to a stored binary blob's oid would have been valid UTF-8.
      return entry === undefined || entry.oid !== objectOid("blob", Buffer.from(content, "utf8"), algorithm)
    },
  }
}
