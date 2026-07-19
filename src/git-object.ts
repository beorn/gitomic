import { createHash } from "node:crypto"

import type { Oid } from "./types.js"

export const GITOMIC_NAME = "gitomic"
export const GITOMIC_EMAIL = "gitomic@localhost"
export const INITIAL_TIMESTAMP = 946_684_800

export type GitObject = {
  type: "blob" | "tree" | "commit"
  content: Buffer
  oid: Oid
}

export function objectOid(type: GitObject["type"], content: Buffer): Oid {
  const header = Buffer.from(`${type} ${content.length}\0`, "utf8")
  return createHash("sha1").update(header).update(content).digest("hex")
}

export function formatCommitMessage(writer: string, message: string, seq: number): string {
  return `${writer}: ${message}\n\nGitomic-Writer: ${writer}\nGitomic-Seq: ${seq}\n`
}

export function transactionMatches(message: string, writer: string, seq: number): boolean {
  return message.trimEnd().endsWith(`Gitomic-Writer: ${writer}\nGitomic-Seq: ${seq}`)
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

type EncodedEntry = {
  sortKey: Buffer
  content: Buffer
}

function encodeTree(node: TreeNode, objects: Map<Oid, GitObject>): GitObject {
  const entries: EncodedEntry[] = []
  for (const [name, value] of node.files) {
    const content = Buffer.from(value, "utf8")
    const blob: GitObject = { type: "blob", content, oid: objectOid("blob", content) }
    objects.set(blob.oid, blob)
    entries.push({
      sortKey: Buffer.from(name, "utf8"),
      content: Buffer.concat([Buffer.from(`100644 ${name}\0`, "utf8"), Buffer.from(blob.oid, "hex")]),
    })
  }
  for (const [name, child] of node.directories) {
    const tree = encodeTree(child, objects)
    entries.push({
      sortKey: Buffer.from(`${name}/`, "utf8"),
      content: Buffer.concat([Buffer.from(`40000 ${name}\0`, "utf8"), Buffer.from(tree.oid, "hex")]),
    })
  }
  entries.sort((left, right) => Buffer.compare(left.sortKey, right.sortKey))
  const content = Buffer.concat(entries.map((entry) => entry.content))
  const tree: GitObject = { type: "tree", content, oid: objectOid("tree", content) }
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
