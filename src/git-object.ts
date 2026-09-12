import { createHash } from "node:crypto"

import type { CommitMeta, CommitProvenance, Oid } from "./types.js"
import { assertUtf8, decodeUtf8 } from "./utf8.js"

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

export function objectOid(type: GitObject["type"], content: Buffer, algorithm: "sha1" | "sha256" = "sha1"): Oid {
  const header = Buffer.from(`${type} ${content.length}\0`, "utf8")
  return createHash(algorithm).update(header).update(content).digest("hex")
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

/** Decode the same stored commit bytes in every backend; metadata is not inferred from its subject. */
export function parseCommit(oid: Oid, content: Uint8Array): CommitMeta {
  validateOid(oid)
  const raw = decodeUtf8(content, `Git commit ${oid}`)
  const separator = raw.indexOf("\n\n")
  if (separator < 0) throw new Error(`invalid Git commit ${oid}: missing message separator`)
  const headers = raw.slice(0, separator).split("\n")
  const parents = headers.filter((line) => line.startsWith("parent ")).map((line) => validateOid(line.slice(7)))
  const committers = headers.filter((line) => line.startsWith("committer "))
  const time = committers.length === 1 ? / (-?\d+) [+-]\d{4}$/.exec(committers[0] ?? "") : null
  const timestamp = time === null ? NaN : Number(time[1])
  if (!Number.isSafeInteger(timestamp)) throw new Error(`invalid Git commit ${oid}: invalid committer timestamp`)
  const message = raw.slice(separator + 2)
  const trailers = new Map<string, string>()
  const finalParagraph =
    message
      .trimEnd()
      .split(/\n[ \t]*\n/)
      .at(-1) ?? ""
  for (const line of finalParagraph.split("\n")) {
    const match = /^(Gitomic-(?:Writer|Instance|Seq|Actor|Actor-Session|Actor-Generation|Actor-Run)):(.*)$/.exec(line)
    if (match === null) continue
    const key = match[1] as string
    const value = (match[2] ?? "").trim()
    const hasControlCharacter = [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
    if (trailers.has(key) || value.length === 0 || hasControlCharacter) {
      throw new Error(`invalid Git commit ${oid}: malformed or duplicate ${key} trailer`)
    }
    trailers.set(key, value)
  }
  const rawSeq = trailers.get("Gitomic-Seq")
  const seq = rawSeq === undefined ? null : Number(rawSeq)
  if (rawSeq !== undefined && (!/^\d+$/.test(rawSeq) || !Number.isSafeInteger(seq))) {
    throw new Error(`invalid Git commit ${oid}: malformed Gitomic-Seq trailer`)
  }
  const provenance = parseCommitProvenance(oid, trailers)
  return {
    oid,
    parent: parents[0] ?? null,
    message,
    writer: trailers.get("Gitomic-Writer") ?? null,
    instance: trailers.get("Gitomic-Instance") ?? null,
    seq,
    provenance,
    timestamp,
  }
}

function parseCommitProvenance(oid: Oid, trailers: ReadonlyMap<string, string>): CommitProvenance | null {
  const keys = ["Gitomic-Actor", "Gitomic-Actor-Session", "Gitomic-Actor-Generation", "Gitomic-Actor-Run"] as const
  if (!keys.some((key) => trailers.has(key))) return null

  const actor = trailers.get("Gitomic-Actor")
  const session = trailers.get("Gitomic-Actor-Session")
  const rawGeneration = trailers.get("Gitomic-Actor-Generation")
  if (actor === undefined || session === undefined || rawGeneration === undefined) {
    throw new Error(`invalid Git commit ${oid}: incomplete Gitomic-Actor provenance trailers`)
  }
  const generation = Number(rawGeneration)
  if (!/^\d+$/.test(rawGeneration) || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error(`invalid Git commit ${oid}: malformed Gitomic-Actor-Generation trailer`)
  }
  const run = trailers.get("Gitomic-Actor-Run")
  return run === undefined ? { actor, session, generation } : { actor, session, generation, run }
}

/** Clone and validate untrusted per-call metadata before it can cross a replay boundary. */
export function cloneCommitProvenance(value: CommitProvenance | undefined): CommitProvenance | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("provenance must be an object with actor, session, generation, and optional run")
  }
  const source = value as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (!["actor", "session", "generation", "run"].includes(key)) {
      throw new TypeError(`provenance contains an unknown field: ${JSON.stringify(key)}`)
    }
  }
  const actor = assertProvenanceString(source.actor, "actor")
  const session = assertProvenanceString(source.session, "session")
  const generation = source.generation
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
    throw new TypeError("provenance.generation must be a non-negative safe integer")
  }
  const run = source.run === undefined ? undefined : assertProvenanceString(source.run, "run")
  return run === undefined ? { actor, session, generation } : { actor, session, generation, run }
}

function assertProvenanceString(value: unknown, field: "actor" | "session" | "run"): string {
  if (typeof value !== "string") throw new TypeError(`provenance.${field} must be a string`)
  assertUtf8(value, `provenance.${field}`)
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
  if (value.length === 0 || value !== value.trim() || hasControlCharacter) {
    throw new TypeError(`provenance.${field} must be a non-empty, single-line identifier`)
  }
  return value
}

/**
 * Build the commit message for one transaction.
 *
 * `writer` is the caller's human-readable label: it leads the subject so
 * `git log --oneline` reads as an audit trail, and it repeats as a trailer so
 * `git log --format=%(trailers:key=Gitomic-Writer,valueonly)` can group by it.
 * `instance` is the library-minted id of the one live store that produced this
 * commit. The label is a name and may repeat across processes; the instance is
 * an identity and cannot, which is why `transactionMatches` keys on it.
 */
export function formatCommitMessage(
  writer: string,
  instance: string,
  message: string,
  seq: number,
  provenance?: CommitProvenance,
): string {
  const captured = cloneCommitProvenance(provenance)
  const provenanceTrailers =
    captured === undefined
      ? ""
      : `Gitomic-Actor: ${captured.actor}\nGitomic-Actor-Session: ${captured.session}\nGitomic-Actor-Generation: ${captured.generation}\n${captured.run === undefined ? "" : `Gitomic-Actor-Run: ${captured.run}\n`}`
  return `${writer}: ${message}\n\nGitomic-Writer: ${writer}\n${provenanceTrailers}Gitomic-Instance: ${instance}\nGitomic-Seq: ${seq}\n`
}

/**
 * Recognize a commit as one specific store instance's transaction.
 *
 * Deliberately blind to the writer label: two live processes may share a label,
 * so a label-keyed match could claim another process's commit as this one's and
 * drop this one's writes. `(instance, seq)` is unique by construction.
 */
export function transactionMatches(message: string, instance: string, seq: number): boolean {
  return message.trimEnd().endsWith(`Gitomic-Instance: ${instance}\nGitomic-Seq: ${seq}`)
}

export function transactionLookupExceeded(instance: string, seq: number): Error {
  return new Error(
    `transaction lookup for store instance ${JSON.stringify(instance)} sequence ${seq} exceeded ${TRANSACTION_SEARCH_LIMIT} first-parent commits without reaching the commit it was built on; the ambiguous acknowledgement cannot be resolved safely`,
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
