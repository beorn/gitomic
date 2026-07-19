// @failure The fast backend could serialize different Git objects or weaken delete semantics.
// @level l1
// @consumer gitomic users opting into isomorphic-git

import * as nodeFs from "node:fs"
import { spawnSync } from "node:child_process"

import type { FsClient } from "isomorphic-git"
import { describe, expect, test } from "vitest"

import { open } from "../src/index.js"
import type { GitMap } from "../src/index.js"
import { createIsoBackend } from "../src/iso.js"
import { createMemBackend } from "../src/mem.js"
import { appendEmptyHistory, createBareRepo, git, gitWithInput } from "./helpers/git.js"

const TRANSACTION_SEARCH_LIMIT = 1_024
const gitInitHelp = spawnSync("git", ["init", "-h"], { encoding: "utf8" })
const supportsReftable = `${gitInitHelp.stdout}${gitInitHelp.stderr}`.includes("--ref-format")
const supportsObjectFormat = `${gitInitHelp.stdout}${gitInitHelp.stderr}`.includes("--object-format")

describe("iso backend", () => {
  test("keeps shell, iso, and mem object-id equivalent across writes and deletion", async () => {
    const shellFixture = await createBareRepo()
    const isoFixture = await createBareRepo()
    try {
      const shell = await open({ repo: shellFixture.repo, ref: "main", writer: "same-writer" })
      const iso = await open({
        repo: isoFixture.repo,
        ref: "main",
        writer: "same-writer",
        backend: createIsoBackend(),
      })
      const mem = await open({
        repo: "three-backend-equivalence",
        ref: "main",
        writer: "same-writer",
        backend: createMemBackend(),
      })
      const stores = [shell, iso, mem]
      expect(new Set(await Promise.all(stores.map(async (store) => await store.head())))).toHaveLength(1)
      const first = async (map: GitMap): Promise<void> => {
        map.set("nested/a.txt", "a\n")
        map.set("nested/deeper/b.txt", "b\n")
        map.set("root.txt", "root\n")
      }
      const firstCommits = await Promise.all(stores.map(async (store) => await store.transact(first, "first")))
      expect(new Set(firstCommits.map((commit) => commit.oid))).toHaveLength(1)

      const second = async (map: GitMap): Promise<void> => {
        map.delete("nested/a.txt")
        map.set("nested/deeper/b.txt", `${await map.get("nested/deeper/b.txt")}changed\n`)
      }
      const secondCommits = await Promise.all(stores.map(async (store) => await store.transact(second, "second")))

      expect(new Set(secondCommits.map((commit) => commit.oid))).toHaveLength(1)
      expect(await iso.at().keys()).toEqual(["nested/deeper/b.txt", "root.txt"])
      expect(await iso.at().get("nested/deeper/b.txt")).toBe("b\nchanged\n")
    } finally {
      await Promise.all([shellFixture.cleanup(), isoFixture.cleanup()])
    }
  })

  test("rejects file and directory prefix collisions identically in every backend", async () => {
    const shellFixture = await createBareRepo()
    const isoFixture = await createBareRepo()
    try {
      const stores = [
        await open({ repo: shellFixture.repo, ref: "main", writer: "shape-shell" }),
        await open({ repo: isoFixture.repo, ref: "main", writer: "shape-iso", backend: createIsoBackend() }),
        await open({ repo: "shape-mem", ref: "main", writer: "shape-mem", backend: createMemBackend() }),
      ]

      for (const store of stores) {
        await expect(
          store.transact(async (map) => {
            map.set("a", "file")
            map.set("a/b", "nested")
          }, "create impossible tree"),
        ).rejects.toThrow('Git tree path collision: "a" is both a file and a directory')
        expect(await store.at().keys()).toEqual([])
      }
    } finally {
      await Promise.all([shellFixture.cleanup(), isoFixture.cleanup()])
    }
  })

  test.runIf(supportsReftable)("uses native ref reads for a reftable repository", async () => {
    const fixture = await createBareRepo({ refFormat: "reftable" })
    try {
      const store = await open({
        repo: fixture.repo,
        ref: "main",
        writer: "reftable-iso",
        backend: createIsoBackend(),
      })

      const committed = await store.transact(async (map) => map.set("value", "reftable"), "write reftable state")

      expect(await store.head()).toBe(committed.oid)
      expect(await store.at().get("value")).toBe("reftable")
    } finally {
      await fixture.cleanup()
    }
  })

  test.runIf(supportsObjectFormat)("refuses SHA-256 repositories with an explicit backend remedy", async () => {
    const fixture = await createBareRepo({ objectFormat: "sha256" })
    try {
      await expect(
        open({ repo: fixture.repo, ref: "main", writer: "sha256-iso", backend: createIsoBackend() }),
      ).rejects.toThrow("iso backend supports SHA-1 repositories only; use the shell backend for SHA-256")
    } finally {
      await fixture.cleanup()
    }
  })

  test("canonicalizes a touched executable blob identically in shell and iso", async () => {
    const shellFixture = await createBareRepo()
    const isoFixture = await createBareRepo()
    try {
      for (const fixture of [shellFixture, isoFixture]) {
        const blob = await gitWithInput(fixture.repo, "before\n", "hash-object", "-w", "--stdin")
        const tree = await gitWithInput(fixture.repo, `100755 blob ${blob}\tscript\0`, "mktree", "-z")
        const commit = await git(fixture.repo, "commit-tree", tree, "-p", fixture.initial, "-m", "executable seed")
        await git(fixture.repo, "update-ref", "refs/heads/main", commit, fixture.initial)
      }
      const shell = await open({ repo: shellFixture.repo, ref: "main", writer: "same-writer" })
      const iso = await open({
        repo: isoFixture.repo,
        ref: "main",
        writer: "same-writer",
        backend: createIsoBackend(),
      })

      const commits = await Promise.all(
        [shell, iso].map(
          async (store) => await store.transact(async (map) => map.set("script", "after\n"), "edit script"),
        ),
      )

      expect(new Set(commits.map((commit) => commit.oid))).toHaveLength(1)
      expect(await git(shellFixture.repo, "ls-tree", "main", "script")).toMatch(/^100644 blob /)
      expect(await git(isoFixture.repo, "ls-tree", "main", "script")).toMatch(/^100644 blob /)
    } finally {
      await Promise.all([shellFixture.cleanup(), isoFixture.cleanup()])
    }
  })

  test.each([
    ["symlink", "120000", "blob"],
    ["gitlink", "160000", "commit"],
  ])("refuses a %s entry instead of projecting it as string state", async (_name, mode, type) => {
    const fixture = await createBareRepo()
    try {
      const oid =
        type === "blob" ? await gitWithInput(fixture.repo, "target\n", "hash-object", "-w", "--stdin") : fixture.initial
      const tree = await gitWithInput(fixture.repo, `${mode} ${type} ${oid}\tforeign\0`, "mktree", "-z")
      const commit = await git(fixture.repo, "commit-tree", tree, "-p", fixture.initial, "-m", "foreign tree mode")
      await git(fixture.repo, "update-ref", "refs/heads/main", commit, fixture.initial)

      const stores = [
        await open({ repo: fixture.repo, ref: "main", writer: "shell" }),
        await open({ repo: fixture.repo, ref: "main", writer: "iso", backend: createIsoBackend() }),
      ]
      for (const store of stores) {
        await expect(store.at().keys()).rejects.toThrow(`unsupported Git tree mode ${mode}`)
      }
    } finally {
      await fixture.cleanup()
    }
  })

  test("refuses a non-NFC repository path before it can alias canonical state", async () => {
    const fixture = await createBareRepo()
    try {
      const oid = await gitWithInput(fixture.repo, "foreign\n", "hash-object", "-w", "--stdin")
      const decomposed = "cafe\u0301.txt"
      const tree = await gitWithInput(fixture.repo, `100644 blob ${oid}\t${decomposed}\0`, "mktree", "-z")
      const commit = await git(fixture.repo, "commit-tree", tree, "-p", fixture.initial, "-m", "non-NFC path")
      await git(fixture.repo, "update-ref", "refs/heads/main", commit, fixture.initial)

      const stores = [
        await open({ repo: fixture.repo, ref: "main", writer: "shell" }),
        await open({ repo: fixture.repo, ref: "main", writer: "iso", backend: createIsoBackend() }),
      ]
      for (const store of stores) {
        await expect(store.at().keys()).rejects.toThrow("Git tree path is not NFC-normalized")
      }
    } finally {
      await fixture.cleanup()
    }
  })

  test("refuses a pre-existing file that occupies Gitomic's reserved metadata root", async () => {
    const fixture = await createBareRepo()
    try {
      const oid = await gitWithInput(fixture.repo, "foreign\n", "hash-object", "-w", "--stdin")
      const tree = await gitWithInput(fixture.repo, `100644 blob ${oid}\t.gitomic\0`, "mktree", "-z")
      const commit = await git(fixture.repo, "commit-tree", tree, "-p", fixture.initial, "-m", "reserved root")
      await git(fixture.repo, "update-ref", "refs/heads/main", commit, fixture.initial)

      const stores = [
        await open({ repo: fixture.repo, ref: "main", writer: "reserved-shell" }),
        await open({ repo: fixture.repo, ref: "main", writer: "reserved-iso", backend: createIsoBackend() }),
      ]
      for (const store of stores) {
        await expect(store.at().keys()).rejects.toThrow('".gitomic" is reserved')
      }
    } finally {
      await fixture.cleanup()
    }
  })

  test("refuses repository blob bytes that are not valid UTF-8", async () => {
    const fixture = await createBareRepo()
    try {
      const oid = await gitWithInput(fixture.repo, Uint8Array.of(0xff), "hash-object", "-w", "--stdin")
      const tree = await gitWithInput(fixture.repo, `100644 blob ${oid}\tinvalid.txt\0`, "mktree", "-z")
      const commit = await git(fixture.repo, "commit-tree", tree, "-p", fixture.initial, "-m", "invalid UTF-8 blob")
      await git(fixture.repo, "update-ref", "refs/heads/main", commit, fixture.initial)

      const stores = [
        await open({ repo: fixture.repo, ref: "main", writer: "utf8-shell" }),
        await open({ repo: fixture.repo, ref: "main", writer: "utf8-iso", backend: createIsoBackend() }),
      ]
      for (const store of stores) {
        await expect(store.at().get("invalid.txt")).rejects.toThrow("valid UTF-8")
      }
    } finally {
      await fixture.cleanup()
    }
  })

  test("refuses repository path bytes that are not valid UTF-8", async () => {
    const fixture = await createBareRepo()
    try {
      const oid = await gitWithInput(fixture.repo, "value\n", "hash-object", "-w", "--stdin")
      const treeInput = Buffer.concat([
        Buffer.from(`100644 blob ${oid}\t`, "utf8"),
        Buffer.from([0xff]),
        Buffer.from([0]),
      ])
      const tree = await gitWithInput(fixture.repo, treeInput, "mktree", "-z")
      const commit = await git(fixture.repo, "commit-tree", tree, "-p", fixture.initial, "-m", "invalid UTF-8 path")
      await git(fixture.repo, "update-ref", "refs/heads/main", commit, fixture.initial)

      const stores = [
        await open({ repo: fixture.repo, ref: "main", writer: "path-shell" }),
        await open({ repo: fixture.repo, ref: "main", writer: "path-iso", backend: createIsoBackend() }),
      ]
      for (const store of stores) {
        await expect(store.at().keys()).rejects.toThrow("valid UTF-8")
      }
    } finally {
      await fixture.cleanup()
    }
  })

  test("fails loudly instead of walking beyond the receipt lookup horizon", async () => {
    const fixture = await createBareRepo()
    try {
      await appendEmptyHistory(fixture.repo, fixture.initial, TRANSACTION_SEARCH_LIMIT + 1)
      const backend = createIsoBackend()
      const tip = await backend.head(fixture.repo, "refs/heads/main")

      await expect(backend.findTransaction(fixture.repo, tip, "missing-writer", 1)).rejects.toThrow(
        `exceeded ${TRANSACTION_SEARCH_LIMIT} first-parent commits`,
      )
    } finally {
      await fixture.cleanup()
    }
  }, 30_000)

  test("writes every loose object through temp, fsync, rename, and directory fsync", async () => {
    const fixture = await createBareRepo()
    const operations: string[] = []
    const promises = {
      ...nodeFs.promises,
      async open(path: nodeFs.PathLike, flags: string | number, mode?: nodeFs.Mode) {
        const handle = await nodeFs.promises.open(path, flags, mode)
        const label = String(path)
        operations.push(`open:${String(flags)}:${label}`)
        return {
          async writeFile(data: string | NodeJS.ArrayBufferView) {
            await handle.writeFile(
              typeof data === "string" ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength),
            )
          },
          async sync() {
            operations.push(`sync:${label}`)
            await handle.sync()
          },
          async close() {
            await handle.close()
          },
        }
      },
      async rename(from: nodeFs.PathLike, to: nodeFs.PathLike) {
        operations.push(`rename:${String(from)}:${String(to)}`)
        await nodeFs.promises.rename(from, to)
      },
    }
    try {
      const store = await open({
        repo: fixture.repo,
        ref: "main",
        writer: "durable-iso",
        backend: createIsoBackend({ fs: { promises } as unknown as FsClient }),
      })

      await store.transact(async (map) => map.set("value", "durable"), "durable iso write")

      const renames = operations.filter((operation) => operation.startsWith("rename:"))
      expect(renames.length).toBeGreaterThanOrEqual(4)
      expect(renames.every((operation) => operation.includes("/objects/"))).toBe(true)
      expect(operations.filter((operation) => operation.startsWith("sync:")).length).toBeGreaterThanOrEqual(
        renames.length * 2,
      )
    } finally {
      await fixture.cleanup()
    }
  })
})
