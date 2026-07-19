import { createHash } from "node:crypto"

import type { Oid } from "./types.js"

export const GITOMIC_NAME = "gitomic"
export const GITOMIC_EMAIL = "gitomic@localhost"
export const INITIAL_TIMESTAMP = 946_684_800
export const TRANSACTION_SEARCH_LIMIT = 1_024

export type GitObject = {
  type: "blob" | "tree" | "commit"
  content: Buffer
  oid: Oid
}

export type GitTreeObjectEntry = {
  mode: "100644" | "100755" | "40000"
  path: string
  oid: Oid
}

export function objectOid(type: GitObject["type"], content: Buffer): Oid {
  const header = Buffer.from(`${type} ${content.length}\0`, "utf8")
  return createHash("sha1").update(header).update(content).digest("hex")
}

export function encodeBlob(content: Buffer): GitObject {
  return { type: "blob", content, oid: objectOid("blob", content) }
}

export function encodeTreeEntries(entries: readonly GitTreeObjectEntry[]): GitObject {
  const ordered = entries
    .map((entry) => ({
      ...entry,
      sortKey: Buffer.from(entry.mode === "40000" ? `${entry.path}/` : entry.path, "utf8"),
    }))
    .sort((left, right) => Buffer.compare(left.sortKey, right.sortKey))
  const content = Buffer.concat(
    ordered.map((entry) =>
      Buffer.concat([Buffer.from(`${entry.mode} ${entry.path}\0`, "utf8"), Buffer.from(entry.oid, "hex")]),
    ),
  )
  return { type: "tree", content, oid: objectOid("tree", content) }
}

export function validateOid(value: unknown, label = "invalid Git object id"): Oid {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new TypeError(`${label}: ${JSON.stringify(value)}; expected a full 40- or 64-character lowercase hex id`)
  }
  return value
}

export function formatCommitMessage(writer: string, message: string, seq: number): string {
  return `${writer}: ${message}\n\nGitomic-Writer: ${writer}\nGitomic-Seq: ${seq}\n`
}

export function transactionMatches(message: string, writer: string, seq: number): boolean {
  return message.trimEnd().endsWith(`Gitomic-Writer: ${writer}\nGitomic-Seq: ${seq}`)
}

export function transactionLookupExceeded(writer: string, seq: number): Error {
  return new Error(
    `transaction lookup for writer ${JSON.stringify(writer)} sequence ${seq} exceeded ${TRANSACTION_SEARCH_LIMIT} first-parent commits; the ambiguous acknowledgement is too old to resolve safely`,
  )
}

export function encodeCommit(input: { tree: Oid; parent?: Oid; timestamp: number; message: string }): GitObject {
  const parent = input.parent === undefined ? "" : `parent ${input.parent}\n`
  const identity = `${GITOMIC_NAME} <${GITOMIC_EMAIL}> ${input.timestamp} +0000`
  const content = Buffer.from(
    `tree ${input.tree}\n${parent}author ${identity}\ncommitter ${identity}\n\n${input.message}`,
    "utf8",
  )
  return { type: "commit", content, oid: objectOid("commit", content) }
}

type TreeNode = {
  files: Map<string, string>
  directories: Map<string, TreeNode>
}

function createTreeNode(): TreeNode {
  return { files: new Map(), directories: new Map() }
}

function addPath(root: TreeNode, path: string, content: string): void {
  const parts = path.split("/")
  const filename = parts.pop()
  if (filename === undefined) throw new TypeError(`invalid git tree path: ${JSON.stringify(path)}`)
  let node = root
  for (const part of parts) {
    let child = node.directories.get(part)
    if (child === undefined) {
      child = createTreeNode()
      node.directories.set(part, child)
    }
    node = child
  }
  node.files.set(filename, content)
}

function encodeTree(node: TreeNode, objects: Map<Oid, GitObject>): GitObject {
  const entries: GitTreeObjectEntry[] = []
  for (const [name, value] of node.files) {
    const blob = encodeBlob(Buffer.from(value, "utf8"))
    objects.set(blob.oid, blob)
    entries.push({
      mode: "100644",
      path: name,
      oid: blob.oid,
    })
  }
  for (const [name, child] of node.directories) {
    const tree = encodeTree(child, objects)
    entries.push({
      mode: "40000",
      path: name,
      oid: tree.oid,
    })
  }
  const tree = encodeTreeEntries(entries)
  objects.set(tree.oid, tree)
  return tree
}

export function encodeFiles(files: ReadonlyMap<string, string>): {
  tree: GitObject
  objects: ReadonlyMap<Oid, GitObject>
} {
  const root = createTreeNode()
  for (const [path, content] of files) addPath(root, path, content)
  const objects = new Map<Oid, GitObject>()
  return { tree: encodeTree(root, objects), objects }
}
