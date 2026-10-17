// @failure a chain read fetches from the remote on every read, even when the oid the remote just
// listed already sits at gitomic's private fetched ref — a fetch that cannot change anything the
// read returns, paid by every reader of every chain (a yrd merge round read its own ref twelve
// times, and eleven of those fetches carried nothing the first one had not already brought).
// @level l1
// @consumer every remote-backed chain read: they all reach the chain through this one `tip` closure.
// @testonly none — every method these rows use is production surface.
//
// The cure is a SKIP, never a cache: the ls-remote answer stays the authority on every read, and only
// the object fetch is skipped, and only when every oid the remote listed already sits at gitomic's
// private fetched ref.
//
// The six rows below are the acceptance: (1) a read whose listed tip is already held fetches
// nothing; (2) a moved remote tip is fetched again; (3) an oid the private ref does not hold is
// fetched, even when the namespace already holds another chain's ref; (4) a private ref that does
// not name a readable commit is never trusted as held; (5) a held read that names `fetch:` extras
// still fetches, because extras are never listed remotely; (6) a remote open names which half of the
// pair the backend is missing, and a local open asks neither.
//
// Each mutation names the rows it actually fails, measured and not assumed: reverting the cure to an
// unconditional fetch fails (1) and (5); a skip on "a private ref exists" instead of "this oid is
// held" fails (2); dropping the commit peel fails (4); ignoring the named extras fails (5); and
// stripping the missing half's name from the refusal fails (6). Row (3) has no RED of its own: it
// guards against a lookup keyed on the remote's namespace rather than on this ref's oid, which a later
// cure could introduce, and no mutation of this cure reaches it — the loose-skip mutation above passes
// it when run alone.

import { afterEach, describe, expect, test, vi } from "vitest"

import { openEvents } from "../src/events.js"
import { createShellBackend } from "../src/shell.js"
import { listRefs } from "../src/events.js"
import type { GitomicBackend, Oid } from "../src/types.js"
import { createBareRepo, git, gitWithInput } from "./helpers/git.js"

const CHAIN = "refs/yrd/q/changes/b"
const OTHER = "refs/yrd/q/changes/a"

afterEach(() => {
  vi.restoreAllMocks()
})

async function remotePair() {
  const origin = await createBareRepo()
  const local = await createBareRepo()
  await git(local.repo, "remote", "add", "origin", origin.repo)
  return {
    origin,
    local,
    cleanup: async () => {
      await origin.cleanup()
      await local.cleanup()
    },
  }
}

async function tipOf(repo: string, backend: GitomicBackend, ref: string, remote?: string): Promise<Oid | undefined> {
  const listed = await listRefs(ref, { repo, backend, ...(remote === undefined ? {} : { remote }) })
  return listed.get(ref)
}

/**
 * The backend under test with its fetch counted. `fetchRefs` is the one operation this change
 * removes calls to, so counting it is the measurement: a read that skips reports no call, and a
 * read that must fetch reports one.
 */
function counted(base: GitomicBackend): { backend: GitomicBackend; fetches: (string | readonly string[])[] } {
  const fetches: (string | readonly string[])[] = []
  const fetchRefs = base.fetchRefs as NonNullable<GitomicBackend["fetchRefs"]>
  return {
    fetches,
    backend: {
      ...base,
      fetchRefs: async (repo, refs, remote, options) => {
        fetches.push(typeof refs === "string" ? refs : [...refs])
        return await fetchRefs(repo, refs, remote, options)
      },
    },
  }
}

/** Put a chain on the origin and return the backend that wrote it. */
async function seedOrigin(origin: { repo: string }, branches: readonly string[]): Promise<GitomicBackend> {
  const writer = createShellBackend()
  for (const ref of branches) {
    const chain = await openEvents({ repo: origin.repo, ref, backend: writer })
    await chain.append([{ type: "submitted" }], { expect: null })
  }
  return writer
}

describe("a chain read fetches only what it does not already hold", () => {
  test("(1) a read whose listed tip is already held fetches nothing", async () => {
    const pair = await remotePair()
    try {
      const writer = await seedOrigin(pair.origin, [CHAIN])
      const listed = await tipOf(pair.origin.repo, writer, CHAIN)
      const { backend, fetches } = counted(createShellBackend())
      const read = async () =>
        await (await openEvents({ repo: pair.local.repo, remote: "origin", ref: CHAIN, backend })).head()

      // The first read has nothing locally and must fetch.
      expect(await read()).toBe(listed)
      expect(fetches).toEqual([[CHAIN]])

      // The second has the very oid the remote still lists: nothing to bring over.
      fetches.length = 0
      expect(await read()).toBe(listed)
      expect(fetches).toEqual([])
    } finally {
      await pair.cleanup()
    }
  })

  test("(2) a moved remote tip is fetched again", async () => {
    const pair = await remotePair()
    try {
      const writer = await seedOrigin(pair.origin, [CHAIN])
      const { backend, fetches } = counted(createShellBackend())
      const read = async () =>
        await (await openEvents({ repo: pair.local.repo, remote: "origin", ref: CHAIN, backend })).head()
      expect(await read()).toBe(await tipOf(pair.origin.repo, writer, CHAIN))
      expect(fetches).toEqual([[CHAIN]])

      const chain = await openEvents({ repo: pair.origin.repo, ref: CHAIN, backend: writer })
      const moved = (await chain.append([{ type: "verifying" }], { expect: await chain.head() })).head
      expect(moved).not.toBe(undefined)

      fetches.length = 0
      expect(await read()).toBe(moved)
      expect(fetches).toEqual([[CHAIN]])
    } finally {
      await pair.cleanup()
    }
  })

  test("(3) an oid the private ref does not hold is fetched, even when the namespace holds another chain", async () => {
    const pair = await remotePair()
    try {
      const writer = await seedOrigin(pair.origin, [OTHER, CHAIN])
      const { backend, fetches } = counted(createShellBackend())
      const read = async (ref: string) =>
        await (await openEvents({ repo: pair.local.repo, remote: "origin", ref, backend })).head()

      // Warm the namespace for the OTHER chain only: the private ref for CHAIN stays absent.
      expect(await read(OTHER)).toBe(await tipOf(pair.origin.repo, writer, OTHER))
      expect(fetches).toEqual([[OTHER]])

      fetches.length = 0
      expect(await read(CHAIN)).toBe(await tipOf(pair.origin.repo, writer, CHAIN))
      expect(fetches).toEqual([[CHAIN]])
    } finally {
      await pair.cleanup()
    }
  })

  test("(4) a private ref that does not name a readable commit is never trusted as held", async () => {
    const pair = await remotePair()
    try {
      await seedOrigin(pair.origin, [CHAIN])
      // Both stores hold a blob at the chain ref and at the private ref, so the two oids are equal
      // and the objects are present — but neither is a commit. An equality test on the bare ref name
      // would call this "held" and skip the fetch; `rev-parse --verify --quiet <ref>^{commit}` does
      // not, which is what makes the skip safe for a ref whose object is gone.
      const blob = await gitWithInput(pair.local.repo, "not a commit\n", "hash-object", "-w", "--stdin")
      const originBlob = await gitWithInput(pair.origin.repo, "not a commit\n", "hash-object", "-w", "--stdin")
      expect(blob).toBe(originBlob)
      const privateRef = "refs/gitomic/fetched/origin/yrd/q/changes/b"
      await git(pair.origin.repo, "update-ref", CHAIN, blob)
      await git(pair.local.repo, "update-ref", privateRef, blob)
      // The private ref resolves by name to exactly what the remote lists, and does not peel to a
      // commit. That asymmetry is the whole point: "the name resolves" is not "the objects are here".
      expect(await git(pair.local.repo, "rev-parse", "--verify", "--quiet", privateRef)).toBe(blob)
      await expect(git(pair.local.repo, "rev-parse", "--verify", "--quiet", `${privateRef}^{commit}`)).rejects.toThrow()

      const { backend, fetches } = counted(createShellBackend())
      const head = await (await openEvents({ repo: pair.local.repo, remote: "origin", ref: CHAIN, backend })).head()
      expect(head).toBe(blob)
      expect(fetches).toEqual([[CHAIN]])
    } finally {
      await pair.cleanup()
    }
  })

  test("(5) a held read that names fetch extras still fetches", async () => {
    const pair = await remotePair()
    try {
      const writer = await seedOrigin(pair.origin, [CHAIN, OTHER])
      const { backend, fetches } = counted(createShellBackend())
      const read = async (fetch?: readonly string[]) =>
        await (
          await openEvents({
            repo: pair.local.repo,
            remote: "origin",
            ref: CHAIN,
            backend,
            ...(fetch === undefined ? {} : { fetch }),
          })
        ).head()

      // Warm the private ref for CHAIN so the oid the remote lists is already held: a plain read of
      // the same ref now skips its fetch.
      expect(await read()).toBe(await tipOf(pair.origin.repo, writer, CHAIN))
      expect(fetches).toEqual([[CHAIN]])
      fetches.length = 0
      expect(await read()).toBe(await tipOf(pair.origin.repo, writer, CHAIN))
      expect(fetches).toEqual([])

      // Naming an EXTRA ref keeps the fetch. Extras are never listed remotely, so nothing in this
      // read says whether they moved: a skip keyed on the listed ref alone would take the extras with
      // it and their objects would never arrive.
      fetches.length = 0
      expect(await read([OTHER])).toBe(await tipOf(pair.origin.repo, writer, CHAIN))
      expect(fetches).toEqual([[CHAIN, OTHER]])
    } finally {
      await pair.cleanup()
    }
  })

  test("(6) a remote open names which of the pair is missing, and a local open asks neither", async () => {
    const pair = await remotePair()
    try {
      await seedOrigin(pair.origin, [CHAIN])
      const shell = createShellBackend()

      const noTip = { ...shell, fetchedTip: undefined } as unknown as GitomicBackend
      await expect(openEvents({ repo: pair.local.repo, remote: "origin", ref: CHAIN, backend: noTip })).rejects.toThrow(
        /^this backend cannot read remotely: fetchedTip missing;/,
      )

      const noFetch = { ...shell, fetchRefs: undefined } as unknown as GitomicBackend
      await expect(
        openEvents({ repo: pair.local.repo, remote: "origin", ref: CHAIN, backend: noFetch }),
      ).rejects.toThrow(/^this backend cannot read remotely: fetchRefs missing;/)

      // The pair is asserted where a REMOTE read starts, never in the chain machinery: a local open
      // asks neither method, so a backend missing one half can still hold chains.
      const local = await openEvents({ repo: pair.local.repo, ref: CHAIN, backend: noFetch })
      expect(await local.head()).toBeNull()
    } finally {
      await pair.cleanup()
    }
  })
})
