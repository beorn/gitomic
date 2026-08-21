import {
  encodeCommit,
  encodeFiles,
  formatCommitMessage,
  INITIAL_TIMESTAMP,
  TRANSACTION_SEARCH_LIMIT,
  transactionLookupExceeded,
} from "./git-object.js"
import type { CommitInput, GitomicBackend, Oid } from "./types.js"
import { assertGitPrefixMatched, normalizePrefix } from "./path.js"

type MemCommit = {
  oid: Oid
  parent?: Oid
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
  const commit = encodeCommit({ tree: tree.oid, timestamp: INITIAL_TIMESTAMP, message: "initial\n" })
  return {
    oid: commit.oid,
    timestamp: INITIAL_TIMESTAMP,
    files,
  }
}

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
    const parent = repo.commits.get(input.parent)
    if (parent === undefined) throw new Error(`unknown parent commit: ${input.parent}`)
    const files = new Map(parent.files)
    for (const [path, content] of input.changes) {
      if (content === undefined) files.delete(path)
      else files.set(path, content)
    }
    const { tree } = encodeFiles(files)
    const timestamp = parent.timestamp + 1
    const commit = encodeCommit({
      tree: tree.oid,
      parent: parent.oid,
      timestamp,
      message: formatCommitMessage(input.writer, input.instance, input.message, input.seq),
    })
    repo.commits.set(commit.oid, {
      oid: commit.oid,
      parent: parent.oid,
      timestamp,
      instance: input.instance,
      seq: input.seq,
      files,
    })
    return commit.oid
  }

  const compareAndSwap = async (name: string, ref: string, next: Oid, expected: Oid): Promise<boolean> => {
    const repo = getRepo(name)
    if (repo.refs.get(ref) !== expected) return false
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
      oid = commit.parent
    }
    return undefined
  }

  const backend: GitomicBackend = {
    head,
    readFiles,
    writeCommit,
    compareAndSwap,
    findTransaction,
  }
  return backend
}
