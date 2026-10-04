/**
 * The ONE `readHistoryEdges` budget contract, shared by the shell and mem backends (@cto 9eeab5bd).
 *
 * The two backends must answer the same request the same way: a cap is validated identically BEFORE any event, and
 * both charge the SAME number for the same kept DAG — per completed commit, the canonical one-line edge record
 * (the OID, then each parent as ` <parent>`, then a terminating newline), which is exactly the record the ancestry
 * owner spools to its scratch. Without one contract the mem backend accepted a request the shell refused and
 * undercounted bytes, so the same cap was a different wall on each backend.
 */
import type { Oid } from "./types.js"
import { HistoryEdgesOverflow } from "./errors.ts"

/** A byte cap is a positive safe integer; anything else is a caller bug, refused by name before any event. */
export function normalizeHistoryEdgeByteCap(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("maxBytes must be a positive integer")
  return value
}

/** A record cap is a positive safe integer; anything else is a caller bug, refused by name before any event. */
export function normalizeHistoryEdgeRecordCap(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("maxRecords must be a positive integer")
  return value
}

/** The bytes a record costs as soon as its OID is read: the OID plus its terminating newline. */
export function historyEdgeRecordStartBytes(oid: Oid): number {
  return oid.length + 1
}

/** The bytes one parent adds: its leading space plus the OID. */
export function historyEdgeParentBytes(parent: Oid): number {
  return 1 + parent.length
}

export function historyEdgesByteOverflow(repo: string, maxBytes: number, bytes: number): HistoryEdgesOverflow {
  return new HistoryEdgesOverflow(`history edges in ${repo} exceeded maxBytes ${maxBytes} after ${bytes} bytes`)
}

export function historyEdgesRecordOverflow(repo: string, maxRecords: number): HistoryEdgesOverflow {
  return new HistoryEdgesOverflow(`history edges in ${repo} exceeded maxRecords ${maxRecords} commits`)
}
