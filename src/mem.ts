import {
  commitParents,
  encodeCommit,
  encodeFiles,
  formatCommitMessage,
  GENESIS_MESSAGE,
  INITIAL_TIMESTAMP,
  isZeroOid,
  parseCommit,
  refUnderPrefix,
  TRANSACTION_SEARCH_LIMIT,
  transactionLookupExceeded,
  validateOid,
} from "./git-object.js"
import type { CommitInput, CommitMeta, GitomicBackend, Oid } from "./types.js"
import { assertGitPrefixMatched, normalizePrefix } from "./path.js"
import { normalizeRef, validateRefUpdates } from "./options.js"

type MemCommit = {
  oid: Oid
  content: Uint8Array
  /** Every parent in order; the first is the first-parent chain. Empty for a root. */
  parents: readonly Oid[]
  timestamp: number
  instance?: string
  seq?: number
  files: ReadonlyMap<string, string>
}

type MemRepo = {
  refs: Map<string, Oid>
  commits: Map<Oid, MemCommit>
}

function createInitialCommit(): MemCommit {
  const files = new Map<string, string>()
  const { tree } = encodeFiles(files)
  const commit = encodeCommit({ tree: tree.oid, timestamp: INITIAL_TIMESTAMP, message: GENESIS_MESSAGE })
  return {
    oid: commit.oid,
    content: commit.content,
    parents: [],
    timestamp: INITIAL_TIMESTAMP,
    files,
  }
}

const GENESIS_OID = createInitialCommit().oid

export function createMemBackend(): GitomicBackend {
  const repos = new Map<string, MemRepo>()

  const getRepo = (name: string): MemRepo => {
    let repo = repos.get(name)
    if (repo === undefined) {
      const initial = createInitialCommit()
      repo = { refs: new Map(), commits: new Map([[initial.oid, initial]]) }
      repos.set(name, repo)
    }
    return repo
  }

  const head = async (name: string, ref: string): Promise<Oid> => {
    const repo = getRepo(name)
    let oid = repo.refs.get(ref)
    if (oid === undefined) {
      oid = repo.commits.keys().next().value as Oid
      repo.refs.set(ref, oid)
    }
    return oid
  }

  const readFiles = async (name: string, commit: Oid, prefix?: string): Promise<ReadonlyMap<string, string>> => {
    const found = getRepo(name).commits.get(commit)
    if (found === undefined) throw new Error(`unknown commit: ${commit}`)
    const normalizedPrefix = prefix === undefined ? "" : normalizePrefix(prefix)
    const files = new Map([...found.files].filter(([path]) => path.startsWith(normalizedPrefix)))
    assertGitPrefixMatched(files.size, name, commit, normalizedPrefix)
    return files
  }

  const writeCommit = async (name: string, input: CommitInput): Promise<Oid> => {
    const repo = getRepo(name)
    const parents = commitParents(input)
    const parent = repo.commits.get(input.parent)
    if (parent === undefined) throw new Error(`unknown parent commit: ${input.parent}`)
    for (const kept of parents.slice(1)) {
      if (!repo.commits.has(kept)) throw new Error(`unknown parent commit: ${kept}`)
    }
    const files = new Map(parent.files)
    for (const [path, content] of input.changes) {
      if (content === undefined) files.delete(path)
      else files.set(path, content)
    }
    const { tree } = encodeFiles(files)
    const timestamp = parent.timestamp + 1
    const commit = encodeCommit({
      tree: tree.oid,
      parents,
      timestamp,
      message: formatCommitMessage(
        input.writer,
        input.instance,
        input.message,
        input.seq,
        input.provenance,
        input.trailers,
      ),
    })
    repo.commits.set(commit.oid, {
      oid: commit.oid,
      content: commit.content,
      parents,
      timestamp,
      instance: input.instance,
      seq: input.seq,
      files,
    })
    return commit.oid
  }

  const compareAndSwap = async (name: string, ref: string, next: Oid, expected: Oid): Promise<boolean> => {
    const repo = getRepo(name)
    const current = repo.refs.get(ref)
    // An all-zero expected means the ref must be absent: create-if-absent.
    if (isZeroOid(expected) ? current !== undefined : current !== expected) return false
    if (!repo.commits.has(next)) throw new Error(`unknown next commit: ${next}`)
    repo.refs.set(ref, next)
    return true
  }

  const findTransaction = async (
    name: string,
    tip: Oid,
    base: Oid,
    instance: string,
    seq: number,
  ): Promise<Oid | undefined> => {
    const commits = getRepo(name).commits
    let oid: Oid | undefined = tip
    let inspected = 0
    // Stop at `base`: the sought commit is its child, so nothing older can be it.
    while (oid !== undefined && oid !== base) {
      if (inspected >= TRANSACTION_SEARCH_LIMIT) throw transactionLookupExceeded(instance, seq)
      const commit = commits.get(oid)
      if (commit === undefined) throw new Error(`unknown commit: ${oid}`)
      inspected += 1
      if (commit.instance === instance && commit.seq === seq) return oid
      oid = commit.parents[0]
    }
    return undefined
  }

  const listRefs = async (name: string, prefix: string, remote?: string): Promise<ReadonlyMap<string, Oid>> => {
    if (remote !== undefined) throw new TypeError("the mem backend has no remotes; omit remote")
    const listed = [...getRepo(name).refs].filter(([ref]) => refUnderPrefix(ref, prefix))
    return new Map(listed.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  }

  const readHistory = async (
    name: string,
    tips: readonly Oid[],
    options: { readonly exclude?: readonly Oid[]; readonly limit?: number } = {},
  ): Promise<CommitMeta[]> => {
    const commits = getRepo(name).commits
    const exclude = new Set(options.exclude ?? [])
    const limit = options.limit ?? Number.POSITIVE_INFINITY
    const seen = new Set<Oid>()
    const read: CommitMeta[] = []
    for (const tip of tips) {
      let oid: Oid | undefined = tip
      while (oid !== undefined && !exclude.has(oid) && !seen.has(oid) && read.length < limit) {
        const commit = commits.get(oid)
        if (commit === undefined) throw new Error(`unknown commit: ${oid}`)
        seen.add(oid)
        read.push(parseCommit(oid, commit.content))
        oid = commit.parents[0]
      }
    }
    return read
  }

  const backend: GitomicBackend = {
    head,
    readCommit: (name, oid) =>
      Promise.resolve().then(() => {
        validateOid(oid)
        const found = getRepo(name).commits.get(oid)
        if (found === undefined) throw new Error(`cannot read commit ${oid} in ${JSON.stringify(name)}: unknown commit`)
        return parseCommit(oid, found.content)
      }),
    readFiles,
    writeCommit,
    compareAndSwap,
    publish: async (name, updates, options = {}) => {
      if (options.remote !== undefined) throw new TypeError("the mem backend has no remotes; omit remote")
      validateRefUpdates(updates)
      const repo = getRepo(name)
      for (const { ref, expect, oid } of updates) {
        const current = repo.refs.get(ref)
        if (isZeroOid(expect) ? current !== undefined : current !== expect) return false
        if (!repo.commits.has(oid)) throw new Error(`unknown next commit: ${oid}`)
      }
      for (const { ref, oid } of updates) repo.refs.set(ref, oid)
      return true
    },
    fetchRefs: async (name, refs, options = {}) => {
      if (options.remote !== undefined) throw new TypeError("the mem backend has no remotes; omit remote")
      const repo = getRepo(name)
      const names = typeof refs === "string"
        ? [...repo.refs.keys()].filter((ref) => refUnderPrefix(ref, refs))
        : refs
      for (const ref of names) {
        if (normalizeRef(ref) !== ref) throw new TypeError(`fetchRefs needs a full ref: ${ref}`)
        if (!repo.refs.has(ref)) throw new Error(`cannot fetch missing local ref ${ref}`)
      }
    },
    findTransaction,
    listRefs,
    readHistory,
    // The initial commit every mem repo already holds IS the genesis.
    writeGenesis: async (name) => {
      getRepo(name)
      return GENESIS_OID
    },
  }
  return backend
}
