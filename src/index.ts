import { Conflict, RetriesExhausted } from "./errors.js"
import { assertPath, assertPrefix, INTERNAL_PREFIX, isPublicPath } from "./path.js"
import { createShellBackend } from "./shell.js"
import type { Committed, GitMap, GitomicBackend, Oid, OpenOptions, Snapshot, Store, Update } from "./types.js"

export { Conflict, RetriesExhausted }
export { createShellBackend } from "./shell.js"
export type { Committed, GitMap, GitomicBackend, Oid, OpenOptions, Snapshot, Store, Update } from "./types.js"

export async function open(options: OpenOptions): Promise<Store> {
  const context = await prepareStore(options)
  const enqueue = createQueue()
  return {
    head: () => context.backend.head(context.repo, context.ref),
    at: (commit) => makeSnapshot(context, commit),
    transact: (update, message) => enqueue(async () => await transact(context, update, message)),
  }
}

type StoreContext = {
  repo: string
  ref: string
  writer: string
  backend: GitomicBackend
  refresh(): Promise<Oid>
  publish(next: Oid, expected: Oid): Promise<boolean>
}

const DEFAULT_MAX_ATTEMPTS = 10

async function prepareStore(options: OpenOptions): Promise<StoreContext> {
  assertWriter(options.writer)
  const repo = options.repo
  const ref = normalizeRef(options.ref)
  const writer = options.writer
  const backend = options.backend ?? createShellBackend()
  const remote = options.remote
  let refresh: () => Promise<Oid>
  let publish: (next: Oid, expected: Oid) => Promise<boolean>
  if (remote === undefined) {
    refresh = async () => await backend.head(repo, ref)
    publish = async (next, expected) => await backend.compareAndSwap(repo, ref, next, expected)
  } else {
    const fetchRemote = backend.fetchRemote
    const compareAndSwapRemote = backend.compareAndSwapRemote
    if (fetchRemote === undefined || compareAndSwapRemote === undefined) {
      throw new TypeError("this backend cannot arbitrate remotely; omit remote or use the shell/iso backend")
    }
    refresh = async () => await fetchRemote(repo, ref, remote)
    publish = async (next, expected) => await compareAndSwapRemote(repo, ref, next, expected, remote)
  }
  await refresh()
  return { repo, ref, writer, backend, refresh, publish }
}

async function transact(context: StoreContext, update: Update, message: string): Promise<Committed> {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new TypeError("message must say why this transaction exists")
  }
  let retries = 0
  let attempts = 0
  let seq: number | undefined
  while (true) {
    attempts += 1
    const parent = await context.refresh()
    const base = await context.backend.readFiles(context.repo, parent)
    seq ??= readSequence(base, context.writer) + 1
    const { map, changes } = makeOverlay(base)
    await update(map)
    const effective = removeNoopChanges(base, changes)
    if (effective.size === 0) return { oid: parent, retries }
    effective.set(metadataPath(context.writer), writeSequence(context.writer, seq))
    const next = await context.backend.writeCommit(context.repo, {
      parent,
      changes: effective,
      message: message.trim(),
      writer: context.writer,
      seq,
    })
    if (await context.publish(next, parent)) return { oid: next, retries }

    retries += 1
    const winner = await context.refresh()
    const winnerFiles = await context.backend.readFiles(context.repo, winner)
    if (readSequence(winnerFiles, context.writer) >= seq) {
      const landed = await context.backend.findTransaction(context.repo, winner, context.writer, seq)
      if (landed !== undefined) return { oid: landed, retries }
      throw new Error(
        `writer ${JSON.stringify(context.writer)} sequence ${seq} is marked landed but unreachable; use a unique writer per live process`,
      )
    }
    if (attempts >= DEFAULT_MAX_ATTEMPTS) throw new RetriesExhausted(retries)
    await delayForRetry(retries)
  }
}

function makeSnapshot(context: StoreContext, commit?: Oid): Snapshot {
  const pinned = commit === undefined ? context.backend.head(context.repo, context.ref) : Promise.resolve(commit)
  let files: Promise<ReadonlyMap<string, string>> | undefined
  const load = (): Promise<ReadonlyMap<string, string>> => {
    files ??= pinned.then((oid) => context.backend.readFiles(context.repo, oid))
    return files
  }
  return {
    async get(path) {
      assertPath(path)
      return (await load()).get(path)
    },
    async has(path) {
      assertPath(path)
      return (await load()).has(path)
    },
    async keys(prefix = "") {
      assertPrefix(prefix)
      return [...(await load()).keys()].filter((path) => isPublicPath(path) && path.startsWith(prefix)).sort()
    },
  }
}

function makeOverlay(base: ReadonlyMap<string, string>): {
  map: GitMap
  changes: Map<string, string | undefined>
} {
  const changes = new Map<string, string | undefined>()
  const get = (path: string): string | undefined => (changes.has(path) ? changes.get(path) : base.get(path))
  const map: GitMap = {
    async get(path) {
      assertPath(path)
      return get(path)
    },
    set(path, content) {
      assertPath(path)
      if (typeof content !== "string") throw new TypeError("gitomic v1 values must be UTF-8 strings")
      changes.set(path, content)
    },
    delete(path) {
      assertPath(path)
      changes.set(path, undefined)
    },
    async has(path) {
      assertPath(path)
      return get(path) !== undefined
    },
    async keys(prefix = "") {
      assertPrefix(prefix)
      const keys = new Set([...base.keys()].filter(isPublicPath))
      for (const [path, value] of changes) {
        if (value === undefined) keys.delete(path)
        else keys.add(path)
      }
      return [...keys].filter((path) => path.startsWith(prefix)).sort()
    },
  }
  return { map, changes }
}

function createQueue(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return await result
  }
}

function assertWriter(writer: string): void {
  const hasControlCharacter =
    typeof writer === "string" &&
    [...writer].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  if (typeof writer !== "string" || writer.trim().length === 0 || hasControlCharacter) {
    throw new TypeError("writer must be a non-empty, single-line identifier")
  }
}

function normalizeRef(ref: string): string {
  if (typeof ref !== "string" || ref.length === 0) throw new TypeError("ref is required")
  return ref.startsWith("refs/") ? ref : `refs/heads/${ref}`
}

function metadataPath(writer: string): string {
  return `${INTERNAL_PREFIX}writers/${Buffer.from(writer, "utf8").toString("base64url")}.json`
}

function readSequence(files: ReadonlyMap<string, string>, writer: string): number {
  const raw = files.get(metadataPath(writer))
  if (raw === undefined) return 0
  try {
    const value: unknown = JSON.parse(raw)
    if (
      typeof value === "object" &&
      value !== null &&
      "writer" in value &&
      value.writer === writer &&
      "seq" in value &&
      typeof value.seq === "number" &&
      Number.isSafeInteger(value.seq) &&
      value.seq >= 0
    ) {
      return value.seq
    }
  } catch {
    // Report corrupt internal state with one stable public error below.
  }
  throw new Error(`invalid gitomic high-water mark for writer ${JSON.stringify(writer)}`)
}

function writeSequence(writer: string, seq: number): string {
  return `${JSON.stringify({ writer, seq })}\n`
}

function removeNoopChanges(
  base: ReadonlyMap<string, string>,
  changes: ReadonlyMap<string, string | undefined>,
): Map<string, string | undefined> {
  return new Map([...changes].filter(([path, value]) => base.get(path) !== value))
}

function delayForRetry(retries: number): Promise<void> {
  const ceiling = Math.min(150, 4 * 2 ** Math.min(retries, 6))
  const milliseconds = Math.random() * ceiling
  return new Promise((resolveDelay) => {
    // raw-lifecycle-ok: this transaction-owned backoff is awaited and cannot outlive its caller.
    setTimeout(resolveDelay, milliseconds)
  })
}
