import { createHash } from "node:crypto"

import type { CommitInput, CommitMeta, CommitProvenance, Ident, Oid, RefUpdate, Trailer } from "./types.js"
import { Conflict } from "./errors.js"
import { assertUtf8, decodeUtf8 } from "./utf8.js"

export const GITOMIC_NAME = "gitomic"
export const GITOMIC_EMAIL = "gitomic@localhost"
export const GITOMIC_IDENT: Ident = Object.freeze({ name: GITOMIC_NAME, email: GITOMIC_EMAIL })
export const INITIAL_TIMESTAMP = 946_684_800
export const TRANSACTION_SEARCH_LIMIT = 1_024

/**
 * The time a commit is written with: the store's clock reading for this attempt, never earlier than the
 * parent's time plus one, so dates track the clock and a chain never runs backwards (25486). A parent time git
 * could not read, or a clock that is not an integer of unix seconds, is a fault raised by name, never a default.
 */
export function commitTimestamp(parentTime: number, time: number): number {
  if (!Number.isFinite(parentTime))
    throw new TypeError(`gitomic: the parent commit's time is not a number (${String(parentTime)})`)
  if (!Number.isInteger(time))
    throw new TypeError(`gitomic: the clock returned ${String(time)}; an integer of unix seconds is required`)
  return Math.max(time, parentTime + 1)
}

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
  const author = headerIdent(oid, headers, "author")
  const committer = headerIdent(oid, headers, "committer")
  return commitMeta(oid, parents, timestamp, message, { author, committer })
}

/**
 * Read one author or committer line as it was stored. This is the read side, so
 * it is lenient about what a name holds (history written by other tools is
 * still history) and strict only about the line's shape.
 */
function headerIdent(oid: Oid, headers: readonly string[], role: "author" | "committer"): Ident {
  const lines = headers.filter((line) => line.startsWith(`${role} `))
  const match = lines.length === 1 ? /^\S+ (.*?) ?<([^<>]*)> -?\d+ [+-]\d{4}$/.exec(lines[0] ?? "") : null
  if (match === null) throw new Error(`invalid Git commit ${oid}: missing, duplicate or malformed ${role} line`)
  return { name: match[1] ?? "", email: match[2] ?? "" }
}

/**
 * Build `CommitMeta` from a commit's parts. `parseCommit` feeds it the fields of
 * one raw object; batched history reads feed it the fields of one walk record,
 * so both paths validate trailers and provenance identically.
 */
export function commitMeta(
  oid: Oid,
  parents: readonly Oid[],
  timestamp: number,
  message: string,
  idents: { readonly author: Ident; readonly committer: Ident },
): CommitMeta {
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
    parents,
    trailers: callerTrailers(message),
    message,
    writer: trailers.get("Gitomic-Writer") ?? null,
    instance: trailers.get("Gitomic-Instance") ?? null,
    seq,
    provenance,
    author: idents.author,
    committer: idents.committer,
    timestamp,
  }
}

/**
 * The caller trailers of a commit message: the final paragraph, when it is not
 * the subject paragraph and every one of its lines is `Key: value`. gitomic's
 * own `Gitomic-*` trailers are excluded; they surface as typed fields instead.
 * Mirrors git's rule closely enough that an ordinary `fix: x` subject is never
 * read as a trailer.
 */
function callerTrailers(message: string): Trailer[] {
  const paragraphs = message.trimEnd().split(/\n[ \t]*\n/)
  if (paragraphs.length < 2) return []
  const lines = (paragraphs.at(-1) ?? "").split("\n")
  const parsed: Trailer[] = []
  for (const line of lines) {
    const match = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]?(.*)$/.exec(line)
    if (match === null) return []
    const key = match[1] as string
    if (key.startsWith("Gitomic-")) continue
    parsed.push([key, match[2] ?? ""])
  }
  return parsed
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

/**
 * Git's "crud": what `commit-tree` silently strips from either end of a name or
 * email (ident.c). Stripping would give the shell backend a different commit
 * than mem and iso for the same input, so gitomic refuses these instead. The
 * "." stopped being crud in git 2.42 (1c04cb0744) and is stripped by 2.36 to
 * 2.41, so it is refused too: the commit never depends on the git version.
 * The rule can lift once the supported minimum reaches 2.42.
 */
function isCrud(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  return code <= 0x20 || ".,:;<>\"\\'".includes(character)
}

function identFieldProblem(value: unknown, field: "name" | "email"): string | undefined {
  if (typeof value !== "string") return `${field} must be a string`
  try {
    assertUtf8(value, field)
  } catch {
    return `${field} must be valid UTF-8`
  }
  if (value.length === 0) return `${field} must not be empty`
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return `${field} must not contain a control character, newline or NUL`
    if (character === "<" || character === ">") return `${field} must not contain < or >`
  }
  if (isCrud(value[0] as string) || isCrud(value.at(-1) as string)) {
    return `${field} must not begin or end with a space or any of . , : ; < > " \\ ' (git would strip it)`
  }
  return undefined
}

/**
 * Why git would not record `ident` byte for byte, or `undefined` when it would.
 * This is the one predicate every refusal uses, exported so a caller can check
 * an ident it did not choose (a user's git config) and fall back instead of
 * failing the write.
 */
export function identProblem(ident: unknown): string | undefined {
  if (ident === null || typeof ident !== "object" || Array.isArray(ident)) {
    return "must be an object with name and email"
  }
  for (const key of Object.keys(ident)) {
    if (key !== "name" && key !== "email") return `contains an unknown field: ${JSON.stringify(key)}`
  }
  const source = ident as Record<string, unknown>
  return identFieldProblem(source.name, "name") ?? identFieldProblem(source.email, "email")
}

/** Validate and copy an ident before it can cross a replay boundary; `role` names it in the refusal. */
export function cloneIdent(value: Ident | undefined, role: "author" | "committer"): Ident | undefined {
  if (value === undefined) return undefined
  const problem = identProblem(value)
  if (problem !== undefined) throw new TypeError(`${role} ${problem}`)
  return Object.freeze({ name: value.name, email: value.email })
}

/**
 * The author and committer one commit records: validated, with the committer
 * defaulting to gitomic's identity and the author to the committer. Every
 * backend resolves them here, so a direct backend caller is held to the same
 * rule as a store.
 */
export function commitIdents(input: Pick<CommitInput, "author" | "committer">): {
  readonly author: Ident
  readonly committer: Ident
} {
  const committer = cloneIdent(input.committer, "committer") ?? GITOMIC_IDENT
  return { author: cloneIdent(input.author, "author") ?? committer, committer }
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
  trailers: readonly Trailer[] = [],
): string {
  const captured = cloneCommitProvenance(provenance)
  const provenanceTrailers =
    captured === undefined
      ? ""
      : `Gitomic-Actor: ${captured.actor}\nGitomic-Actor-Session: ${captured.session}\nGitomic-Actor-Generation: ${captured.generation}\n${captured.run === undefined ? "" : `Gitomic-Actor-Run: ${captured.run}\n`}`
  // Caller trailers go INSIDE the final block, ahead of gitomic's own: git and
  // parseCommit read trailers from the last paragraph only, and
  // `transactionMatches` needs Instance/Seq to end the message.
  const callerBlock = assertTrailers(trailers)
    .map(([key, value]) => `${key}: ${value}\n`)
    .join("")
  return `${writer}: ${message}\n\n${callerBlock}Gitomic-Writer: ${writer}\n${provenanceTrailers}Gitomic-Instance: ${instance}\nGitomic-Seq: ${seq}\n`
}

/**
 * Validate caller trailers before they are serialized. A key is `Token` of
 * letters, digits and hyphens; a value is one line. `Gitomic-*` keys are
 * reserved and refused loudly: a caller must never be able to forge a receipt
 * or an attribution by writing one.
 */
export function assertTrailers(trailers: readonly Trailer[]): readonly Trailer[] {
  for (const entry of trailers) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError("a trailer must be a [key, value] pair")
    }
    const [key, value] = entry
    if (typeof key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(key)) {
      throw new TypeError(`trailer key must be letters, digits and hyphens: ${JSON.stringify(key)}`)
    }
    if (key.toLowerCase().startsWith("gitomic-")) {
      throw new TypeError(`trailer key ${JSON.stringify(key)} is reserved for gitomic's own trailers`)
    }
    if (typeof value !== "string") throw new TypeError(`trailer ${key} value must be a string`)
    assertUtf8(value, `trailer ${key}`)
    const hasControlCharacter = [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
    if (hasControlCharacter || value !== value.trim()) {
      throw new TypeError(`trailer ${key} value must be one line without surrounding whitespace`)
    }
  }
  return trailers
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

/**
 * The complete parent list of a commit input: `parents` when given, otherwise
 * `parent` alone. The first entry must be `parent` — that is the chain the
 * first-parent walk follows — and a parent may not repeat.
 */
export function commitParents(input: CommitInput): readonly Oid[] {
  const parents = input.parents ?? [input.parent]
  if (parents.length === 0 || parents[0] !== input.parent) {
    throw new TypeError("parents must start with parent: the first parent is the chain a first-parent walk follows")
  }
  for (const oid of parents) validateOid(oid, "invalid parent commit id")
  if (new Set(parents).size !== parents.length) throw new TypeError("a commit may not name the same parent twice")
  return parents
}

/**
 * Whether `ref` falls under `prefix` the way `git for-each-ref <prefix>`
 * matches: the prefix itself, or anything below it at a `/` boundary. So
 * `refs/events/demo` never matches `refs/events/demos`.
 */
export function refUnderPrefix(ref: string, prefix: string): boolean {
  if (prefix.endsWith("/")) return ref.startsWith(prefix)
  return ref === prefix || ref.startsWith(`${prefix}/`)
}

/** The all-zero id: as a compare-and-swap `expected`, it means the ref must be absent. */
export function zeroOid(like: Oid): Oid {
  return "0".repeat(like.length)
}

export function isZeroOid(oid: Oid): boolean {
  return /^0+$/.test(oid)
}

/**
 * Validate a MULTI publish before any backend writes: at least one update, full
 * `refs/` names, each ref once, real object ids, and never an all-zero target
 * (a MULTI publish moves or creates refs; it does not delete them).
 */
export function assertRefUpdates(updates: readonly RefUpdate[]): readonly RefUpdate[] {
  if (!Array.isArray(updates) || updates.length === 0) throw new TypeError("publish needs at least one ref update")
  const seen = new Set<string>()
  return updates.map((update) => {
    const ref = update.ref
    if (typeof ref !== "string" || !ref.startsWith("refs/") || /[\s~^:?*[\\]|\.\.|@\{/.test(ref)) {
      throw new TypeError(`publish ref must be a full refs/ name: ${JSON.stringify(ref)}`)
    }
    if (seen.has(ref)) throw new TypeError(`publish names ${ref} more than once`)
    seen.add(ref)
    const expect = validateOid(update.expect, `publish expect for ${ref} is not a Git object id`)
    if (update.oid === null) {
      // A delete is leased by the tip it removes; there is no absent to lease from.
      if (isZeroOid(expect)) throw new TypeError(`publish cannot delete ${ref} at an all-zero expect`)
      return { ref, expect, oid: null }
    }
    const oid = validateOid(update.oid, `publish oid for ${ref} is not a Git object id`)
    if (isZeroOid(oid)) throw new TypeError(`publish cannot write zeros to ${ref}; a null oid deletes it`)
    return { ref, expect, oid }
  })
}

/** One ref whose lease was lost: what the caller expected and what the tool saw there. */
export type LostLease = { readonly ref: string; readonly expect: Oid; readonly observed: string }

/** The Conflict for lost leases, naming each ref, its expected value and its observed tip. */
export function leaseConflict(lost: readonly LostLease[], options?: ErrorOptions): Conflict {
  const describe = ({ ref, expect, observed }: LostLease) =>
    `${ref} is at ${observed}, not ${isZeroOid(expect) ? "absent" : expect}`
  return new Conflict(`lease lost, nothing published: ${lost.map(describe).join("; ")}`, {
    ...options,
    refs: lost.map(({ ref }) => ref),
  })
}

/** The canonical empty root every chain starts from: mem's initial commit, byte for byte. */
export const GENESIS_MESSAGE = "initial\n"

export function encodeCommit(input: {
  tree: Oid
  parent?: Oid
  /** Every parent in order; overrides `parent` when given. */
  parents?: readonly Oid[]
  timestamp: number
  message: string
  /** Omitted, the committer. */
  author?: Ident
  /** Omitted, gitomic's own identity. */
  committer?: Ident
}): GitObject {
  const parents = input.parents ?? (input.parent === undefined ? [] : [input.parent])
  const parent = parents.map((oid) => `parent ${oid}\n`).join("")
  const committer = input.committer ?? GITOMIC_IDENT
  const author = input.author ?? committer
  const line = ({ name, email }: Ident) => `${name} <${email}> ${input.timestamp} +0000`
  const content = Buffer.from(
    `tree ${input.tree}\n${parent}author ${line(author)}\ncommitter ${line(committer)}\n\n${input.message}`,
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
