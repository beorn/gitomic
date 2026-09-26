import { appendFile, mkdir } from "node:fs/promises"
import { basename, join } from "node:path"

/**
 * The journal of remote lease rejections (hh 25626, @cto 96930a63). The engine classifies a rejection exactly at its
 * two remote write sites, so the record of those refusals is the engine's too: one JSON line per confirmed rejection,
 * written before the Conflict (or the lost-lease answer) goes back to the caller, whether or not the caller retries.
 *
 * The line schema is the contract; its reader is hh's tools/cas-rejections.ts, which counts them per hour.
 * Files are per UTC day under `<git common dir>/gitomic/`, so the journal is bounded by construction.
 */
export const LEASE_REJECTIONS_SCHEMA = "lease-rejections/1"

export type LeaseRejectionSite = "compareAndSwapRemote" | "publishRemote"

/** One ref whose lease the remote refused; `observed` only where the engine already read the remote's tip. */
export type LeaseRejectionRef = { readonly ref: string; readonly expect: string; readonly observed?: string }

/** The day file a rejection at `at` belongs to. */
export function leaseRejectionsPath(gitDir: string, at: Date): string {
  return join(gitDir, "gitomic", `lease-rejections.${at.toISOString().slice(0, 10)}.jsonl`)
}

/**
 * Appends one rejection line. A journal that cannot be written must not replace the rejection it records (a
 * retryable lease loss would become terminal for a permissions problem), so a failure is said on stderr with the path
 * and returned for the caller to attach to its Conflict; it is never swallowed.
 */
export async function journalLeaseRejection(
  gitDir: string,
  site: LeaseRejectionSite,
  remote: string,
  refs: readonly LeaseRejectionRef[],
): Promise<Error | undefined> {
  const at = new Date()
  const path = leaseRejectionsPath(gitDir, at)
  const line = {
    schema: LEASE_REJECTIONS_SCHEMA,
    at: at.toISOString(),
    pid: process.pid,
    by: basename(process.argv[1] ?? process.argv[0] ?? ""),
    remote,
    site,
    refs,
  }
  try {
    await mkdir(join(gitDir, "gitomic"), { recursive: true })
    await appendFile(path, `${JSON.stringify(line)}\n`, "utf8")
    return undefined
  } catch (cause) {
    const failure = new Error(`lease rejection not journaled at ${path}: ${(cause as Error).message}`, { cause })
    process.stderr.write(`gitomic: ${failure.message}\n`)
    return failure
  }
}
