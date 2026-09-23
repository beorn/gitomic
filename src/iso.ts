import * as nodeFs from "node:fs"

import { readBlob, readCommit, readObject, readTree, resolveRef } from "isomorphic-git"
import type { FsClient } from "isomorphic-git"

import {
  commitParents,
  encodeBlob,
  encodeCommit,
  encodeTreeEntries,
  commitIdents,
  formatCommitMessage,
  GENESIS_MESSAGE,
  INITIAL_TIMESTAMP,
  parseCommit,
  TRANSACTION_SEARCH_LIMIT,
  transactionLookupExceeded,
  transactionMatches,
  validateOid,
} from "./git-object.js"
import type { GitObject, GitTreeObjectEntry } from "./git-object.js"
import { createDurableObjectWriter } from "./iso-durable.js"
import { assertGitPrefixMatched, assertRegularBlob, normalizePrefix } from "./path.js"
import { createShellRuntime } from "./shell.js"
import type { BlobValue, CommitInput, GitomicBackend, Oid } from "./types.js"
import { decodeBlob } from "./utf8.js"

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

  const loadTree = async (gitdir: string, oid: Oid, prefix = "", readPrefix = ""): Promise<TreeNode> => {
    const result = await readTree({ fs, gitdir, oid, cache })
    if (readPrefix === "") {
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
    }
    const entries = new Map<string, TreeNode | BlobEntry>()
    await Promise.all(
      result.tree.map(async (entry) => {
        const path = prefix === "" ? entry.path : `${prefix}/${entry.path}`
        const intersects =
          readPrefix === "" ||
          path.startsWith(readPrefix) ||
          (entry.type === "tree" && readPrefix.startsWith(`${path}/`))
        if (!intersects) return
        if (entry.type === "tree") {
          entries.set(entry.path, await loadTree(gitdir, entry.oid, path, readPrefix))
        } else {
          assertRegularBlob(path, entry.mode, entry.type)
          entries.set(entry.path, { kind: entry.type, mode: entry.mode, oid: entry.oid })
        }
      }),
    )
    return { kind: "tree", entries }
  }

  const readFiles = async (repo: string, oid: Oid, prefix?: string): Promise<ReadonlyMap<string, BlobValue>> => {
    const normalizedPrefix = prefix === undefined ? "" : normalizePrefix(prefix)
    const gitdir = await resolveGitDir(repo)
    const { commit } = await readCommit({ fs, gitdir, oid, cache })
    const root = await loadTree(gitdir, commit.tree, "", normalizedPrefix)
    const files = new Map<string, BlobValue>()
    const visit = async (node: TreeNode, prefix: string): Promise<void> => {
      await Promise.all(
        [...node.entries].map(async ([name, entry]) => {
          const path = prefix === "" ? name : `${prefix}/${name}`
          if (entry.kind === "tree") {
            await visit(entry, path)
          } else if (entry.kind === "blob" && path.startsWith(normalizedPrefix)) {
            const result = await readBlob({ fs, gitdir, oid: entry.oid, cache })
            files.set(path, decodeBlob(result.blob))
          }
        }),
      )
    }
    await visit(root, "")
    assertGitPrefixMatched(files.size, repo, oid, normalizedPrefix)
    return files
  }

  /** The mode of `path`'s blob entry in the parent tree, or `undefined` when there is none. */
  const parentMode = (root: TreeNode, path: string): string | undefined => {
    let node: TreeNode | undefined = root
    const parts = path.split("/")
    const filename = parts.pop()
    for (const part of parts) {
      const next: TreeNode | BlobEntry | undefined = node.entries.get(part)
      node = next?.kind === "tree" ? next : undefined
      if (node === undefined) return undefined
    }
    const entry = filename === undefined ? undefined : node.entries.get(filename)
    return entry?.kind === "blob" ? entry.mode : undefined
  }

  const applyChange = (
    root: TreeNode,
    path: string,
    content: string | undefined,
    oid?: Oid,
    mode: "100644" | "100755" = "100644",
  ): void => {
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
      mode,
      oid,
    })
  }

  const writeCommit = async (repo: string, input: CommitInput): Promise<Oid> => {
    const gitdir = await resolveGitDir(repo)
    const parents = commitParents(input)
    const parentResult = await readCommit({ fs, gitdir, oid: input.parent, cache })
    // shell's commit-tree refuses a missing parent; an object writer would not,
    // so check the kept commits exist before writing anything that names them.
    for (const kept of parents.slice(1)) await readCommit({ fs, gitdir, oid: kept, cache })
    const root = await loadTree(gitdir, parentResult.commit.tree)
    const objects = new Map<Oid, GitObject>()
    const blobs = new Map<string, Oid>()
    for (const [path, content] of input.changes) {
      if (content === undefined) continue
      const blob = encodeBlob(Buffer.from(content, "utf8"))
      objects.set(blob.oid, blob)
      blobs.set(path, blob.oid)
    }
    // Each changed path keeps its parent entry's mode (a move keeps its source's), read before any change applies.
    const modes = new Map<string, "100644" | "100755">()
    for (const [path, content] of input.changes) {
      if (content === undefined) continue
      modes.set(path, parentMode(root, input.modeSources?.get(path) ?? path) === "100755" ? "100755" : "100644")
    }
    for (const [path, content] of input.changes) applyChange(root, path, content, blobs.get(path), modes.get(path))
    const tree = encodeTreeNode(root, objects)
    const timestamp = parentResult.commit.committer.timestamp + 1
    const commit = encodeCommit({
      tree,
      parents,
      timestamp,
      ...commitIdents(input),
      message: formatCommitMessage(
        input.writer,
        input.instance,
        input.message,
        input.seq,
        input.provenance,
        input.trailers,
      ),
    })
    objects.set(commit.oid, commit)
    // Durably written but unreferenced until the publish adopts it. No pin ref
    // guards that window; see the residual-risk note on the shell backend's
    // `writeCommit` and the README's durability section.
    await objectWriter.writeObjects(gitdir, objects.values())
    return commit.oid
  }

  const findTransaction = async (
    repo: string,
    tip: Oid,
    base: Oid,
    instance: string,
    seq: number,
  ): Promise<Oid | undefined> => {
    const gitdir = await resolveGitDir(repo)
    let oid: Oid | undefined = tip
    let inspected = 0
    // Stop at `base`: the sought commit is its child, so nothing older can be it.
    while (oid !== undefined && oid !== base) {
      if (inspected >= TRANSACTION_SEARCH_LIMIT) throw transactionLookupExceeded(instance, seq)
      const { commit } = await readCommit({ fs, gitdir, oid, cache })
      inspected += 1
      if (transactionMatches(commit.message, instance, seq)) return oid
      oid = commit.parent[0]
    }
    return undefined
  }

  return {
    ...shell,
    head: async (repo, ref) => {
      const gitdir = await resolveGitDir(repo)
      return (await refStorage(repo)) === "files" ? resolveRef({ fs, gitdir, ref }) : shell.head(repo, ref)
    },
    readFiles,
    readCommit: async (repo, oid) => {
      validateOid(oid)
      const gitdir = await resolveGitDir(repo)
      // Require original bytes. Verified at isomorphic-git 1.38.10, index.cjs:
      // :4292 decodes UTF-8 non-fatally, :4409 normalizes payload, :5934 peels
      // tags, :5961 returns parsed metadata/signing payload, not original bytes.
      // tests/shell.test.ts's "reads ordinary/root metadata and walks the first
      // parent of a real merge" parity journey fails with typed readCommit.
      // oxlint-disable-next-line typescript/no-deprecated -- the typed reader cannot preserve this contract
      const result = await readObject({ fs, gitdir, oid, format: "content", cache })
      if (result.type !== "commit" || !(result.object instanceof Uint8Array)) {
        throw new Error(`cannot read commit ${oid} in ${JSON.stringify(repo)}: object is not a commit`)
      }
      return parseCommit(oid, result.object)
    },
    writeCommit,
    findTransaction,
    writeGenesis: async (repo) => {
      const gitdir = await resolveGitDir(repo)
      const objects = new Map<Oid, GitObject>()
      const emptyTree = encodeTreeEntries([])
      objects.set(emptyTree.oid, emptyTree)
      const genesis = encodeCommit({ tree: emptyTree.oid, timestamp: INITIAL_TIMESTAMP, message: GENESIS_MESSAGE })
      objects.set(genesis.oid, genesis)
      await objectWriter.writeObjects(gitdir, objects.values())
      return genesis.oid
    },
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
