// @failure Read-only branch consumers could acquire writer leases, observe moving snapshots, or leak ref-watch timers.
// @level l1
// @consumer lease-free Git snapshot consumers

import { describe, expect, test, vi } from "vitest"

import { open, openReader } from "../src/index.js"
import type { GitomicBackend } from "../src/index.js"
import { createMemBackend } from "../src/mem.js"

describe("lease-free reader", () => {
  test("opens without acquiring a writer and reads an exact pinned snapshot", async () => {
    const backend = createMemBackend()
    const writer = await open({ repo: "reader-snapshot", ref: "main", writer: "writer", backend })
    const first = await writer.transact(async (map) => map.set("notes/one.md", "one\n"), "write one")
    let acquireCalls = 0
    const readerBackend: GitomicBackend = {
      ...backend,
      acquireWriter: async () => {
        acquireCalls += 1
        throw new Error("reader must not acquire a writer")
      },
    }

    const reader = await openReader({ repo: "reader-snapshot", ref: "main", backend: readerBackend })
    const snapshot = reader.at(first.oid)
    await writer.transact(async (map) => map.set("notes/two.md", "two\n"), "write two")

    expect(acquireCalls).toBe(0)
    expect(await snapshot.keys()).toEqual(["notes/one.md"])
    expect(await snapshot.get("notes/one.md")).toBe("one\n")
    expect(await snapshot.get("notes/two.md")).toBeUndefined()
    expect(await reader.at().keys()).toEqual(["notes/one.md", "notes/two.md"])
  })

  test("defaults to main and validates refs before invoking the backend", async () => {
    const mem = createMemBackend()
    const observedRefs: string[] = []
    const backend: GitomicBackend = {
      ...mem,
      head: async (repo, ref) => {
        observedRefs.push(ref)
        return await mem.head(repo, ref)
      },
    }

    await openReader({ repo: "reader-default-ref", backend })

    expect(observedRefs).toEqual(["refs/heads/main"])
    await expect(openReader({ repo: "reader-invalid-ref", ref: "main\nprepare\ncommit", backend })).rejects.toThrow(
      "invalid Git ref",
    )
    expect(observedRefs).toEqual(["refs/heads/main"])
  })

  test("refreshes a configured remote instead of trusting a local ref", async () => {
    const mem = createMemBackend()
    const expected = await mem.head("reader-remote", "refs/heads/main")
    const fetchRemote = vi.fn(async () => expected)
    const backend: GitomicBackend = { ...mem, fetchRemote }

    const reader = await openReader({ repo: "reader-remote", ref: "main", remote: "origin", backend })

    expect(await reader.head()).toBe(expected)
    expect(fetchRemote).toHaveBeenCalledTimes(2)
    expect(fetchRemote).toHaveBeenNthCalledWith(1, "reader-remote", "refs/heads/main", "origin")
  })

  test("fails loudly when the selected backend cannot refresh a remote", async () => {
    await expect(
      openReader({ repo: "reader-unsupported-remote", remote: "origin", backend: createMemBackend() }),
    ).rejects.toThrow("this backend cannot refresh a remote")
  })

  test("streams ref-tip changes and releases promptly when aborted", async () => {
    const backend = createMemBackend()
    const writer = await open({ repo: "reader-watch", ref: "main", writer: "writer", backend })
    const reader = await openReader({ repo: "reader-watch", backend })
    const initial = await reader.head()
    const controller = new AbortController()
    const changes = reader
      .watch({ after: initial, signal: controller.signal, pollIntervalMs: 1 })
      [Symbol.asyncIterator]()
    const pending = changes.next()

    const committed = await writer.transact(async (map) => map.set("changed.md", "yes\n"), "advance tip")

    await expect(pending).resolves.toEqual({
      done: false,
      value: { from: initial, to: committed.oid },
    })
    controller.abort()
    await expect(changes.next()).resolves.toEqual({ done: true, value: undefined })
  })

  test("does not inspect the ref when watch starts already aborted", async () => {
    const mem = createMemBackend()
    let headCalls = 0
    const backend: GitomicBackend = {
      ...mem,
      head: async (repo, ref) => {
        headCalls += 1
        return await mem.head(repo, ref)
      },
    }
    const reader = await openReader({ repo: "reader-aborted", backend })
    const after = await reader.head()
    const callsBeforeWatch = headCalls
    const controller = new AbortController()
    controller.abort()

    const result = await reader
      .watch({ after, signal: controller.signal, pollIntervalMs: 1 })
      [Symbol.asyncIterator]()
      .next()

    expect(result).toEqual({ done: true, value: undefined })
    expect(headCalls).toBe(callsBeforeWatch)
  })

  test("settles a watch aborted during an in-flight ref refresh", async () => {
    const mem = createMemBackend()
    const initial = await mem.head("reader-in-flight-abort", "refs/heads/main")
    let headCalls = 0
    const backend: GitomicBackend = {
      ...mem,
      head: async () => {
        headCalls += 1
        if (headCalls === 1) return initial
        return await new Promise<string>(() => undefined)
      },
    }
    const reader = await openReader({ repo: "reader-in-flight-abort", backend })
    const controller = new AbortController()
    const changes = reader
      .watch({ after: initial, signal: controller.signal, pollIntervalMs: 1 })
      [Symbol.asyncIterator]()
    const pending = changes.next()
    await vi.waitFor(() => expect(headCalls).toBe(2))

    controller.abort()
    const timedOut = new Promise<"timed out">((resolve) => {
      AbortSignal.timeout(50).addEventListener("abort", () => resolve("timed out"), { once: true })
    })

    expect(await Promise.race([pending, timedOut])).toEqual({ done: true, value: undefined })
  })
})
