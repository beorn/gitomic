import { randomUUID } from "node:crypto"
import { basename, dirname, join } from "node:path"
import { promisify } from "node:util"
import { deflate } from "node:zlib"

import type { FsClient } from "isomorphic-git"

import type { GitObject } from "./git-object.js"

type AtomicFileHandle = {
  writeFile(data: string | NodeJS.ArrayBufferView): Promise<unknown>
  sync(): Promise<void>
  close(): Promise<void>
}

type AtomicFsPromises = {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  open(path: string, flags: string, mode?: number): Promise<AtomicFileHandle>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

export type DurableObjectWriter = {
  writeObjects(gitdir: string, objects: Iterable<GitObject>): Promise<void>
}

const deflateAsync = promisify(deflate)

export function createDurableObjectWriter(fs: FsClient): DurableObjectWriter {
  const candidate: unknown = (fs as { promises?: unknown }).promises
  if (typeof candidate !== "object" || candidate === null) {
    throw new TypeError("the iso backend requires a Node-compatible promise fs with mkdir, open, rename, and unlink")
  }
  const methods = candidate as Record<string, unknown>
  if (
    typeof methods.mkdir !== "function" ||
    typeof methods.open !== "function" ||
    typeof methods.rename !== "function" ||
    typeof methods.unlink !== "function"
  ) {
    throw new TypeError("the iso backend requires a Node-compatible promise fs with mkdir, open, rename, and unlink")
  }
  const atomic: AtomicFsPromises = {
    mkdir: methods.mkdir.bind(candidate) as AtomicFsPromises["mkdir"],
    open: methods.open.bind(candidate) as AtomicFsPromises["open"],
    rename: methods.rename.bind(candidate) as AtomicFsPromises["rename"],
    unlink: methods.unlink.bind(candidate) as AtomicFsPromises["unlink"],
  }
  return {
    async writeObjects(gitdir, objects) {
      const directories = new Set<string>()
      const parents = new Set<string>()
      await Promise.all(
        [...objects].map(async (object) => {
          const directory = join(gitdir, "objects", object.oid.slice(0, 2))
          await atomic.mkdir(directory, { recursive: true })
          const wrapped = Buffer.concat([
            Buffer.from(`${object.type} ${object.content.length}\0`, "utf8"),
            object.content,
          ])
          const compressed = await deflateAsync(wrapped)
          await writeDurableFile(atomic, directories, parents, join(directory, object.oid.slice(2)), compressed)
        }),
      )
      await Promise.all([...directories].map(async (directory) => await syncDirectory(atomic, directory)))
      await Promise.all([...parents].map(async (directory) => await syncDirectory(atomic, directory)))
    },
  }
}

async function writeDurableFile(
  fs: AtomicFsPromises,
  directories: Set<string>,
  parents: Set<string>,
  path: string,
  data: string | NodeJS.ArrayBufferView,
): Promise<void> {
  const directory = dirname(path)
  const temporary = join(directory, `.${basename(path)}.gitomic-${process.pid}-${randomUUID()}.tmp`)
  let file: AtomicFileHandle | undefined
  try {
    file = await fs.open(temporary, "wx", 0o444)
    await file.writeFile(data)
    await file.sync()
    await file.close()
    file = undefined
    await fs.rename(temporary, path)
    directories.add(directory)
    parents.add(dirname(directory))
  } catch (error) {
    await file?.close().catch(() => undefined)
    await fs.unlink(temporary).catch((unlinkError: unknown) => {
      if (!isNodeError(unlinkError) || unlinkError.code !== "ENOENT") throw unlinkError
    })
    throw error
  }
}

async function syncDirectory(fs: AtomicFsPromises, directory: string): Promise<void> {
  const handle = await fs.open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}
