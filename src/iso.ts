import * as nodeFs from "node:fs"

import {
  readBlob,
  readCommit,
  readTree,
  resolveRef,
  writeBlob,
  writeCommit as writeIsoCommit,
  writeTree,
} from "isomorphic-git"
import type { CommitObject, FsClient, TreeEntry } from "isomorphic-git"

import { formatCommitMessage, GITOMIC_EMAIL, GITOMIC_NAME, transactionMatches } from "./git-object.js"
import { createGitDirResolver, createShellBackend } from "./shell.js"
import type { CommitInput, GitomicBackend, Oid } from "./types.js"

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
  const cache = {}
  const shell = createShellBackend()
  const fetchRemote = shell.fetchRemote
  const compareAndSwapRemote = shell.compareAndSwapRemote
  if (fetchRemote === undefined || compareAndSwapRemote === undefined) {
    throw new Error("shell backend remote methods are unavailable")
  }
  const resolveGitDir = createGitDirResolver()

  const loadTree = async (gitdir: string, oid: Oid): Promise<TreeNode> => {
    const result = await readTree({ fs, gitdir, oid, cache })
    const entries = new Map<string, TreeNode | BlobEntry>()
    await Promise.all(
      result.tree.map(async (entry) => {
        if (entry.type === "tree") {
          entries.set(entry.path, await loadTree(gitdir, entry.oid))
        } else {
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
            files.set(path, Buffer.from(result.blob).toString("utf8"))
          }
        }),
      )
    }
    await visit(root, "")
    return files
  }

  const applyChange = async (
    gitdir: string,
    root: TreeNode,
    path: string,
    content: string | undefined,
  ): Promise<void> => {
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
    const oid = await writeBlob({ fs, gitdir, blob: Buffer.from(content, "utf8") })
    node.entries.set(filename, {
      kind: "blob",
      mode: existing?.mode ?? "100644",
      oid,
    })
  }

  const writeNode = async (gitdir: string, node: TreeNode): Promise<Oid> => {
    const tree: TreeEntry[] = []
    for (const [path, entry] of node.entries) {
      if (entry.kind === "tree") {
        if (entry.entries.size === 0) continue
        tree.push({ mode: "040000", path, oid: await writeNode(gitdir, entry), type: "tree" })
      } else {
        tree.push({ mode: entry.mode, path, oid: entry.oid, type: entry.kind })
      }
    }
    return await writeTree({ fs, gitdir, tree })
  }

  const writeCommit = async (repo: string, input: CommitInput): Promise<Oid> => {
    const gitdir = await resolveGitDir(repo)
    const parentResult = await readCommit({ fs, gitdir, oid: input.parent, cache })
    const root = await loadTree(gitdir, parentResult.commit.tree)
    for (const [path, content] of input.changes) await applyChange(gitdir, root, path, content)
    const tree = await writeNode(gitdir, root)
    const timestamp = parentResult.commit.committer.timestamp + 1
    const signature = {
      name: GITOMIC_NAME,
      email: GITOMIC_EMAIL,
      timestamp,
      timezoneOffset: 0,
    }
    const commit: CommitObject = {
      tree,
      parent: [input.parent],
      author: signature,
      committer: signature,
      message: formatCommitMessage(input.writer, input.message, input.seq),
    }
    return await writeIsoCommit({ fs, gitdir, commit })
  }

  const findTransaction = async (repo: string, tip: Oid, writer: string, seq: number): Promise<Oid | undefined> => {
    const gitdir = await resolveGitDir(repo)
    let oid: Oid | undefined = tip
    while (oid !== undefined) {
      const { commit } = await readCommit({ fs, gitdir, oid, cache })
      if (transactionMatches(commit.message, writer, seq)) return oid
      oid = commit.parent[0]
    }
    return undefined
  }

  return {
    head: async (repo, ref) => await resolveRef({ fs, gitdir: await resolveGitDir(repo), ref }),
    readFiles,
    writeCommit,
    compareAndSwap: shell.compareAndSwap,
    findTransaction,
    fetchRemote,
    compareAndSwapRemote,
  }
}
