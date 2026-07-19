import * as nodeFs from "node:fs"

import { readBlob, readCommit, readTree, resolveRef } from "isomorphic-git"
import type { FsClient } from "isomorphic-git"

import {
  encodeBlob,
  encodeCommit,
  encodeTreeEntries,
  formatCommitMessage,
  TRANSACTION_SEARCH_LIMIT,
  transactionLookupExceeded,
  transactionMatches,
} from "./git-object.js"
import type { GitObject, GitTreeObjectEntry } from "./git-object.js"
import { createDurableObjectWriter } from "./iso-durable.js"
import { assertRegularBlob } from "./path.js"
import { createShellRuntime } from "./shell.js"
import type { CommitInput, GitomicBackend, Oid } from "./types.js"
import { decodeUtf8 } from "./utf8.js"

type BlobEntry = {
  kind: "blob" | "commit"
  mode: string
  oid: Oid
}

type TreeNode = {
  kind: "tree"
  entries: Map<string, TreeNode | BlobEntry>
}

export function createIsoBackend(options: { fs?: FsClient } = {}): GitomicBackend {
  const fs = options.fs ?? nodeFs
  const objectWriter = createDurableObjectWriter(fs)
  const cache = {}
  const shellRuntime = createShellRuntime()
  const shell = shellRuntime.backend
  const resolveCommonGitDir = shellRuntime.resolveGitDir
  const refStorage = shellRuntime.refStorage
  const resolveGitDir = async (repo: string): Promise<string> => {
    const gitdir = await resolveCommonGitDir(repo)
    if ((await shellRuntime.objectFormat(repo)) !== "sha1") {
      throw new Error("iso backend supports SHA-1 repositories only; use the shell backend for SHA-256")
    }
    return gitdir
  }

  const loadTree = async (gitdir: string, oid: Oid, prefix = ""): Promise<TreeNode> => {
    const result = await readTree({ fs, gitdir, oid, cache })
    const canonicalEntries = result.tree.map((entry): GitTreeObjectEntry => {
      const path = prefix === "" ? entry.path : `${prefix}/${entry.path}`
      if (entry.type === "tree") return { mode: "40000", path: entry.path, oid: entry.oid }
      assertRegularBlob(path, entry.mode, entry.type)
      const mode = entry.mode === "100755" ? "100755" : "100644"
      return { mode, path: entry.path, oid: entry.oid }
    })
    if (encodeTreeEntries(canonicalEntries).oid !== oid) {
      throw new Error(`Git tree ${oid} contains path bytes that are not valid UTF-8 or canonical Git tree order`)
    }
    const entries = new Map<string, TreeNode | BlobEntry>()
    await Promise.all(
      result.tree.map(async (entry) => {
        const path = prefix === "" ? entry.path : `${prefix}/${entry.path}`
        if (entry.type === "tree") {
          entries.set(entry.path, await loadTree(gitdir, entry.oid, path))
        } else {
          assertRegularBlob(path, entry.mode, entry.type)
          entries.set(entry.path, { kind: entry.type, mode: entry.mode, oid: entry.oid })
        }
      }),
    )
    return { kind: "tree", entries }
  }

  const readFiles = async (repo: string, oid: Oid): Promise<ReadonlyMap<string, string>> => {
    const gitdir = await resolveGitDir(repo)
    const { commit } = await readCommit({ fs, gitdir, oid, cache })
    const root = await loadTree(gitdir, commit.tree)
    const files = new Map<string, string>()
    const visit = async (node: TreeNode, prefix: string): Promise<void> => {
      await Promise.all(
        [...node.entries].map(async ([name, entry]) => {
          const path = prefix === "" ? name : `${prefix}/${name}`
          if (entry.kind === "tree") {
            await visit(entry, path)
          } else if (entry.kind === "blob") {
            const result = await readBlob({ fs, gitdir, oid: entry.oid, cache })
            files.set(path, decodeUtf8(result.blob, `Git blob at ${JSON.stringify(path)}`))
          }
        }),
      )
    }
    await visit(root, "")
    return files
  }

  const applyChange = (root: TreeNode, path: string, content: string | undefined, oid?: Oid): void => {
    const parts = path.split("/")
    const filename = parts.pop()
    if (filename === undefined) throw new TypeError(`invalid git tree path: ${JSON.stringify(path)}`)
    let node = root
    for (const part of parts) {
      const existing = node.entries.get(part)
      if (existing === undefined) {
        const child: TreeNode = { kind: "tree", entries: new Map() }
        node.entries.set(part, child)
        node = child
      } else if (existing.kind === "tree") {
        node = existing
      } else {
        throw new TypeError(`path component is not a tree: ${part}`)
      }
    }
    if (content === undefined) {
      node.entries.delete(filename)
      return
    }
    const existing = node.entries.get(filename)
    if (existing?.kind === "tree") throw new TypeError(`path is a tree: ${path}`)
    if (oid === undefined) throw new Error(`missing prepared blob for ${JSON.stringify(path)}`)
    node.entries.set(filename, {
      kind: "blob",
      mode: "100644",
      oid,
    })
  }

  const writeCommit = async (repo: string, input: CommitInput): Promise<Oid> => {
    const gitdir = await resolveGitDir(repo)
    const parentResult = await readCommit({ fs, gitdir, oid: input.parent, cache })
    const root = await loadTree(gitdir, parentResult.commit.tree)
    const objects = new Map<Oid, GitObject>()
    const blobs = new Map<string, Oid>()
    for (const [path, content] of input.changes) {
      if (content === undefined) continue
      const blob = encodeBlob(Buffer.from(content, "utf8"))
      objects.set(blob.oid, blob)
      blobs.set(path, blob.oid)
    }
    for (const [path, content] of input.changes) applyChange(root, path, content, blobs.get(path))
    const tree = encodeTreeNode(root, objects)
    const timestamp = parentResult.commit.committer.timestamp + 1
    const commit = encodeCommit({
      tree,
      parent: input.parent,
      timestamp,
      message: formatCommitMessage(input.writer, input.message, input.seq),
    })
    objects.set(commit.oid, commit)
    await objectWriter.writeObjects(gitdir, objects.values())
    await shellRuntime.pinCommit(repo, input.writer, commit.oid)
    return commit.oid
  }

  const findTransaction = async (repo: string, tip: Oid, writer: string, seq: number): Promise<Oid | undefined> => {
    const gitdir = await resolveGitDir(repo)
    let oid: Oid | undefined = tip
    let inspected = 0
    while (oid !== undefined) {
      if (inspected >= TRANSACTION_SEARCH_LIMIT) throw transactionLookupExceeded(writer, seq)
      const { commit } = await readCommit({ fs, gitdir, oid, cache })
      inspected += 1
      if (transactionMatches(commit.message, writer, seq)) return oid
      oid = commit.parent[0]
    }
    return undefined
  }

  return {
    ...shell,
    head: async (repo, ref) => {
      const gitdir = await resolveGitDir(repo)
      return (await refStorage(repo)) === "files" ? await resolveRef({ fs, gitdir, ref }) : await shell.head(repo, ref)
    },
    readFiles,
    writeCommit,
    findTransaction,
  }
}

function encodeTreeNode(node: TreeNode, objects: Map<Oid, GitObject>): Oid {
  const entries: GitTreeObjectEntry[] = []
  for (const [path, entry] of node.entries) {
    if (entry.kind === "tree") {
      if (entry.entries.size === 0) continue
      entries.push({ mode: "40000", path, oid: encodeTreeNode(entry, objects) })
      continue
    }
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      throw new Error(`unsupported Git tree mode ${entry.mode} at ${JSON.stringify(path)}`)
    }
    entries.push({ mode: entry.mode, path, oid: entry.oid })
  }
  const tree = encodeTreeEntries(entries)
  objects.set(tree.oid, tree)
  return tree.oid
}
