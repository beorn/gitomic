/**
 * Edits from a checkout's working tree: the one way a caller turns files it
 * wrote into gitomic edits, and the file read and precondition the CLI's
 * `put <path> <file>` uses too, so there is one implementation of each.
 * Node-clean: it holds no lock. A caller projecting the result back into the
 * checkout holds the checkout lock around both (`gitomic/checkout-lock`).
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { Edit } from "./edits.js"
import { normalizePath } from "./path.js"
import type { Oid, Snapshot } from "./types.js"
import { decodeUtf8 } from "./utf8.js"

/** A file's content as UTF-8 text; a file that is not UTF-8 refuses, naming it. */
export async function readTextFile(file: string): Promise<string> {
  return decodeUtf8(await readFile(file), `file ${JSON.stringify(file)}`)
}

/**
 * `put`'s precondition for one path, shared by `write`, `apply`'s `put` clause
 * and {@link editsFromCheckout}: an explicit `--expect` oid wins; a strict
 * create anchors on absence (`null`, which fails the edit if the path turns out
 * to be present); else auto-read the path's own current oid at the base the
 * caller read — present means "replace exactly that", absent means a create.
 * Race-safe: `apply`'s CAS replay re-checks this same precondition against
 * whatever tree the commit actually attempts.
 */
export async function putPrecondition(
  path: string,
  explicitExpect: Oid | undefined,
  strictCreate: boolean,
  snapshot: Pick<Snapshot, "oid">,
): Promise<Oid | null> {
  if (explicitExpect !== undefined) return explicitExpect
  if (strictCreate) return null
  return (await snapshot.oid(path)) ?? null
}

/**
 * One edit per path, read from `root`'s working tree against `base`, the
 * snapshot the caller read: a file present in the checkout is a `put` of its
 * UTF-8 content under `put`'s auto-read precondition; a file missing from the
 * checkout is an `rm` anchored on the path's oid at `base`. A path absent from
 * both, or named twice, is refused, naming it: the caller asked to write
 * something that is not there. Paths are repository-relative, normalized as
 * every gitomic path is.
 */
export async function editsFromCheckout(
  root: string,
  paths: readonly string[],
  base: Pick<Snapshot, "oid">,
): Promise<Edit[]> {
  const seen = new Set<string>()
  const edits: Edit[] = []
  for (const raw of paths) {
    const path = normalizePath(raw)
    if (seen.has(path)) throw new TypeError(`editsFromCheckout: ${JSON.stringify(path)} is named twice`)
    seen.add(path)
    let content: string | undefined
    try {
      content = await readTextFile(join(root, path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    if (content !== undefined) {
      edits.push({ kind: "put", path, content, expect: await putPrecondition(path, undefined, false, base) })
      continue
    }
    const expect = await base.oid(path)
    if (expect === undefined) {
      throw new TypeError(
        `editsFromCheckout: ${JSON.stringify(path)} is absent from the checkout at ${root} and from the base, so there is nothing to write`,
      )
    }
    edits.push({ kind: "rm", path, expect })
  }
  return edits
}
