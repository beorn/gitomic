import { posix } from "node:path"

import type { GitMap, Snapshot, Store, Update } from "./types.js"
import { decodeUtf8 } from "./utf8.js"

type PathLike = string
type ReadEncoding = BufferEncoding | "buffer" | null

export type FsStat = {
  size: number
  isFile(): boolean
  isDirectory(): boolean
}

export type FsView = {
  readFile(path: PathLike, encoding: BufferEncoding): Promise<string>
  readFile(path: PathLike, options?: { encoding?: ReadEncoding } | null): Promise<string | Buffer>
  readdir(path: PathLike): Promise<string[]>
  stat(path: PathLike): Promise<FsStat>
  access(path: PathLike): Promise<void>
}

export type TransactionFs = FsView & {
  writeFile(path: PathLike, data: string | Uint8Array): Promise<void>
  unlink(path: PathLike): Promise<void>
  rm(path: PathLike, options?: { recursive?: boolean; force?: boolean }): Promise<void>
  rename(from: PathLike, to: PathLike): Promise<void>
  mkdir(path: PathLike, options?: { recursive?: boolean }): Promise<void>
}

export type ReadOnlyFs = TransactionFs

export class ReadOnlyError extends Error {
  override readonly name = "ReadOnlyError"
  readonly code = "EROFS"

  constructor() {
    super("gitomic asFs() is read-only; use store.transact(withFs(...)) to write")
  }
}

class FsError extends Error {
  constructor(
    readonly code: "ENOENT" | "EISDIR" | "ENOTDIR",
    operation: string,
    path: string,
  ) {
    super(`${code}: ${operation}, ${JSON.stringify(path)}`)
  }
}

function filePath(path: PathLike): string {
  if (typeof path !== "string") throw new TypeError("gitomic fs paths must be strings")
  if (path.startsWith("/")) throw new TypeError("gitomic fs paths must be relative")
  const normalized = posix.normalize(path)
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new TypeError(`invalid gitomic fs path: ${JSON.stringify(path)}`)
  }
  return normalized.replace(/^\.\//, "")
}

function directoryPath(path: PathLike): string {
  if (path === "" || path === ".") return ""
  return filePath(path).replace(/\/$/, "")
}

function encodingFrom(options: BufferEncoding | { encoding?: ReadEncoding } | null | undefined): ReadEncoding {
  if (typeof options === "string") return options
  return options?.encoding ?? null
}

function makeReadView(snapshot: () => Snapshot): FsView {
  const readFile = async (
    path: PathLike,
    options?: BufferEncoding | { encoding?: ReadEncoding } | null,
  ): Promise<string | Buffer> => {
    const normalized = filePath(path)
    const view = snapshot()
    const value = await view.get(normalized)
    if (value === undefined) {
      if ((await view.keys(`${normalized}/`)).length > 0) throw new FsError("EISDIR", "read", normalized)
      throw new FsError("ENOENT", "read", normalized)
    }
    const encoding = encodingFrom(options)
    const buffer = Buffer.from(value, "utf8")
    return encoding === null || encoding === "buffer" ? buffer : buffer.toString(encoding)
  }
  const stat = async (path: PathLike): Promise<FsStat> => {
    const normalized = directoryPath(path)
    const view = snapshot()
    const value = normalized === "" ? undefined : await view.get(normalized)
    if (value !== undefined) {
      return {
        size: Buffer.byteLength(value, "utf8"),
        isFile: () => true,
        isDirectory: () => false,
      }
    }
    const prefix = normalized === "" ? "" : `${normalized}/`
    if (normalized === "" || (await view.keys(prefix)).length > 0) {
      return { size: 0, isFile: () => false, isDirectory: () => true }
    }
    throw new FsError("ENOENT", "stat", normalized)
  }
  return {
    readFile: readFile as FsView["readFile"],
    async readdir(path) {
      const directory = directoryPath(path)
      const prefix = directory === "" ? "" : `${directory}/`
      const view = snapshot()
      if (directory !== "" && (await view.has(directory))) {
        throw new FsError("ENOTDIR", "scandir", directory)
      }
      const entries = new Set(
        (await view.keys(prefix)).map((key) => {
          const relative = key.slice(prefix.length)
          const separator = relative.indexOf("/")
          return separator < 0 ? relative : relative.slice(0, separator)
        }),
      )
      if (directory !== "" && entries.size === 0) throw new FsError("ENOENT", "scandir", directory)
      return [...entries].sort()
    },
    stat,
    async access(path) {
      await stat(path)
    },
  }
}

function makeTransactionFs(map: GitMap): TransactionFs {
  const read = makeReadView(() => map)
  return {
    ...read,
    async writeFile(path, data) {
      map.set(filePath(path), typeof data === "string" ? data : decodeUtf8(data, "fs.writeFile data"))
    },
    async unlink(path) {
      const normalized = filePath(path)
      if (!(await map.has(normalized))) throw new FsError("ENOENT", "unlink", normalized)
      map.delete(normalized)
    },
    async rm(path, options = {}) {
      const normalized = filePath(path)
      if (await map.has(normalized)) {
        map.delete(normalized)
        return
      }
      const descendants = await map.keys(`${normalized}/`)
      if (descendants.length > 0 && !options.recursive) throw new FsError("EISDIR", "rm", normalized)
      for (const descendant of descendants) map.delete(descendant)
      if (descendants.length === 0 && !options.force) throw new FsError("ENOENT", "rm", normalized)
    },
    async rename(from, to) {
      const source = filePath(from)
      const destination = filePath(to)
      const value = await map.get(source)
      if (value !== undefined) {
        map.set(destination, value)
        map.delete(source)
        return
      }
      const descendants = await map.keys(`${source}/`)
      if (descendants.length === 0) throw new FsError("ENOENT", "rename", source)
      for (const descendant of descendants) {
        const content = await map.get(descendant)
        if (content !== undefined) map.set(`${destination}/${descendant.slice(source.length + 1)}`, content)
        map.delete(descendant)
      }
    },
    async mkdir(path) {
      directoryPath(path)
      // Git has no empty directories. The first write beneath this path materializes it.
    },
  }
}

export function withFs(update: (fs: TransactionFs) => Promise<void>): Update {
  return async (map) => await update(makeTransactionFs(map))
}

function rejectWrite(): Promise<never> {
  return Promise.reject(new ReadOnlyError())
}

export function asFs(store: Store): ReadOnlyFs {
  const read = makeReadView(() => store.at())
  return {
    ...read,
    writeFile: rejectWrite,
    unlink: rejectWrite,
    rm: rejectWrite,
    rename: rejectWrite,
    mkdir: rejectWrite,
  }
}

export type KvStore = {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string, message: string): Promise<void>
  delete(key: string, message: string): Promise<void>
  has(key: string): Promise<boolean>
  keys(prefix?: string): Promise<string[]>
}

export function asKv(store: Store): KvStore {
  return {
    get: async (key) => await store.at().get(key),
    async set(key, value, message) {
      await store.transact(async (map) => map.set(key, value), message)
    },
    async delete(key, message) {
      await store.transact(async (map) => map.delete(key), message)
    },
    has: async (key) => await store.at().has(key),
    keys: async (prefix) => await store.at().keys(prefix),
  }
}

export type UnstorageDriver = {
  name: string
  hasItem(key: string): Promise<boolean>
  getItem(key: string): Promise<string | undefined>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
  getKeys(base?: string): Promise<string[]>
  clear(base?: string): Promise<void>
}

export function asUnstorage(store: Store): UnstorageDriver {
  const kv = asKv(store)
  return {
    name: "gitomic",
    hasItem: kv.has,
    getItem: kv.get,
    setItem: async (key, value) => await kv.set(key, value, `unstorage set ${key}`),
    removeItem: async (key) => await kv.delete(key, `unstorage remove ${key}`),
    getKeys: kv.keys,
    async clear(base = "") {
      await store.transact(
        async (map) => {
          for (const key of await map.keys(base)) map.delete(key)
        },
        base === "" ? "unstorage clear" : `unstorage clear ${base}`,
      )
    },
  }
}
