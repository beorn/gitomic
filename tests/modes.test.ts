// @failure A prose edit to an executable file (a hook, a render script) silently drops its x-bit, because every write
// recorded 100644; a mv of one lands a non-executable copy; an identical put on one lands a mode-only commit.
// @level l1
// @consumer 24168 slice A: STATE holds 11 executables (.agents/hooks/*.sh among them) edited through gitomic apply

import { describe, expect, test } from "vitest"

import { apply, createShellBackend, open, type GitomicBackend } from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import { createBareRepo, git, gitWithInput } from "./helpers/git.js"

const backends: readonly { name: string; backend: GitomicBackend }[] = [
  { name: "shell", backend: createShellBackend() },
  { name: "iso", backend: createIsoBackend() },
]

/** A repository whose tip holds `hooks/guard.sh` at 100755 and `notes.md` at 100644, built with plain git. */
async function createExecutableRepo(): Promise<{ repo: string; cleanup(): Promise<void> }> {
  const fixture = await createBareRepo()
  const script = await gitWithInput(fixture.repo, "#!/bin/sh\nexit 0\n", "hash-object", "-w", "--stdin")
  const note = await gitWithInput(fixture.repo, "# notes\n", "hash-object", "-w", "--stdin")
  const hooks = await gitWithInput(fixture.repo, `100755 blob ${script}\tguard.sh\0`, "mktree", "-z")
  const tree = await gitWithInput(
    fixture.repo,
    `040000 tree ${hooks}\thooks\0` + `100644 blob ${note}\tnotes.md\0`,
    "mktree",
    "-z",
  )
  const commit = await git(fixture.repo, "commit-tree", tree, "-p", fixture.initial, "-m", "seed an executable")
  await git(fixture.repo, "update-ref", "refs/heads/main", commit, fixture.initial)
  return fixture
}

async function modeAt(repo: string, commit: string, path: string): Promise<string> {
  return (await git(repo, "ls-tree", commit, "--", path)).split(" ")[0] ?? ""
}

describe.each(backends)("modes through the $name backend", ({ name, backend }) => {
  async function withStore(run: (store: Awaited<ReturnType<typeof open>>, repo: string) => Promise<void>) {
    const fixture = await createExecutableRepo()
    try {
      await run(await open({ repo: fixture.repo, ref: "main", writer: `modes-${name}`, backend }), fixture.repo)
    } finally {
      await fixture.cleanup()
    }
  }

  test("a put on an executable keeps 100755; a new path is 100644", async () => {
    await withStore(async (store, repo) => {
      const committed = await store.transact(async (map) => {
        map.set("hooks/guard.sh", "#!/bin/sh\nexit 1\n")
        map.set("hooks/new.sh", "#!/bin/sh\n")
      }, "edit a hook")
      expect(await modeAt(repo, committed.oid, "hooks/guard.sh")).toBe("100755")
      expect(await modeAt(repo, committed.oid, "hooks/new.sh")).toBe("100644")
      expect(await modeAt(repo, committed.oid, "notes.md")).toBe("100644")
    })
  })

  test("an append to an executable keeps 100755", async () => {
    await withStore(async (store, repo) => {
      const base = await store.head()
      const committed = await apply(store, base, [{ kind: "append", path: "hooks/guard.sh", content: "# tail\n" }], "a")
      expect(await modeAt(repo, committed.oid, "hooks/guard.sh")).toBe("100755")
    })
  })

  test("an mv of an executable lands 100755 at the destination, through one hop and two", async () => {
    await withStore(async (store, repo) => {
      const base = await store.head()
      const snapshot = store.at(base)
      const expect0 = await snapshot.oid("hooks/guard.sh")
      if (expect0 === undefined) throw new Error("fixture lost hooks/guard.sh")
      const committed = await apply(
        store,
        base,
        [
          { kind: "mv", from: "hooks/guard.sh", to: "hooks/moved.sh", expect: expect0 },
          { kind: "mv", from: "hooks/moved.sh", to: "bin/guard.sh", expect: expect0 },
        ],
        "move a hook twice",
      )
      expect(await modeAt(repo, committed.oid, "bin/guard.sh")).toBe("100755")
      expect(await git(repo, "ls-tree", "-r", "--name-only", committed.oid)).not.toContain("hooks/")
    })
  })

  test("an identical put on an executable changes nothing and lands no commit", async () => {
    await withStore(async (store) => {
      const before = await store.head()
      const committed = await store.transact(async (map) => {
        map.set("hooks/guard.sh", "#!/bin/sh\nexit 0\n")
      }, "rewrite a hook unchanged")
      expect(committed.oid).toBe(before)
    })
  })
})
