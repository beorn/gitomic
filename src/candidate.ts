/**
 * The candidate a repository declares for itself, in `.gitomic.conf` at the root of its tree (git-config syntax, the
 * `.gitmodules` precedent), read from the write's BASE commit and never from the write itself:
 *
 *     [candidate]
 *         derive = <command>     # optional: prints {"put": {path: content}, "rm": [path]} to add to the same commit
 *         check = <command>      # optional: exit 0 lands (stdout lines are the report), exit 1 refuses (stdout lines)
 *         timeoutMs = 30000      # optional: the limit for each command
 *
 * Each command runs through `sh -c` with GITOMIC_REPO (the git dir), GITOMIC_BASE (the base commit) and
 * GITOMIC_CANDIDATE (the candidate, materialized as an unpublished commit) in its environment, and the paths the
 * write changed on stdin, NUL-separated. gitomic holds no policy: it runs what the repository's trusted base declares,
 * and a gate edit must stand alone in its write so it is never smuggled inside a content change.
 *
 * Nothing runs until the caller has trusted that exact declaration, the way direnv allows an `.envrc` by its hash:
 * `gitomic trust <address>` prints the declared commands and records the declaration's blob in unversioned git config
 * (`gitomic.trust` in the repository's own config for a path, `gitomic.<url>.trust` in the caller's global config for a
 * URL, whose clone keeps none). A later edit of the file is a new blob and refuses until trusted again. Trust pins the
 * declaration's text, not the scripts it names: a command that runs a file the repository can change runs the changed
 * file. Name commands by absolute paths outside the repository to close that.
 */
import { GitTimeout } from "./errors.js"
import { runCommand, runGit } from "./shell.js"
import type { Candidate, CandidateContext, CandidateVerdict } from "./types.js"
import { decodeUtf8 } from "./utf8.js"

/** The path of a repository's candidate declaration. */
export const CANDIDATE_CONFIG = ".gitomic.conf"
/** The limit for each declared command when the declaration names none. */
export const DEFAULT_CANDIDATE_TIMEOUT_MS = 30_000

export type RepositoryCandidateOptions = {
  /** The repository the store writes: a git dir or a path `git -C` accepts. Commands read the candidate from it. */
  readonly repo: string
  /** The ref the store writes, named in the untrusted refusal's `gitomic trust` command. Default `main`. */
  readonly ref?: string
  /**
   * The URL `repo` is a throwaway clone of (a remote address). Trust is then read from the caller's global git config
   * under `[gitomic "<url>"]`, because the clone keeps no config; without it, from `repo`'s own config.
   */
  readonly url?: string
}

/** Where a repository's trust is recorded: its own git config for a path, the caller's global config for a URL. */
export type TrustScope = { readonly repo: string; readonly url?: string }

/** The git config variable a path repository records its trusted declaration blob in. */
export const TRUST_CONFIG = "gitomic.trust"

function trustLocation(scope: TrustScope): { readonly git: string[]; readonly key: string; readonly file: string } {
  return scope.url === undefined
    ? { git: ["-C", scope.repo, "config", "--local"], key: TRUST_CONFIG, file: "local" }
    : { git: ["config", "--global"], key: `gitomic.${scope.url}.trust`, file: "global" }
}

async function trustedBlobs(scope: TrustScope): Promise<string[]> {
  const { git, key } = trustLocation(scope)
  const result = await runGit([...git, "--get-all", key])
  // Exit 1 with no output: the variable is unset.
  if (result.code === 1 && result.stdout.length === 0) return []
  if (result.code !== 0) throw new Error(`cannot read ${key}: ${result.stderr.toString("utf8").trim()}`)
  return lines(decodeUtf8(result.stdout, key)).map((line) => line.trim())
}

/** A repository's declaration at one commit: its blob, and its `[candidate]` lines as `git config` prints them. */
export type RepositoryDeclaration = { readonly blob: string; readonly lines: readonly string[] }

/** The `.gitomic.conf` at `commit`, or `undefined` when that commit declares none. */
export async function readRepositoryDeclaration(
  repo: string,
  commit: string,
): Promise<RepositoryDeclaration | undefined> {
  const object = await runGit(["-C", repo, "rev-parse", "--verify", "--quiet", `${commit}:${CANDIDATE_CONFIG}`])
  if (object.code === 1 && object.stdout.length === 0) return undefined
  if (object.code !== 0) {
    throw new Error(`cannot resolve ${CANDIDATE_CONFIG} at ${commit}: ${object.stderr.toString("utf8").trim()}`)
  }
  const blob = decodeUtf8(object.stdout, CANDIDATE_CONFIG).trim()
  const listed = await runGit(["-C", repo, "config", "--blob", blob, "--list"])
  if (listed.code !== 0) {
    throw new Error(`${CANDIDATE_CONFIG} ${blob} is not readable git config: ${listed.stderr.toString("utf8").trim()}`)
  }
  return { blob, lines: lines(decodeUtf8(listed.stdout, CANDIDATE_CONFIG)) }
}

/**
 * Record `blob` as the one declaration allowed to run in `scope`, replacing any earlier entry. The caller shows the
 * declared commands first (`gitomic trust` prints them); this only writes the entry.
 */
export async function trustDeclaration(scope: TrustScope, blob: string): Promise<{ key: string; file: string }> {
  const { git, key, file } = trustLocation(scope)
  const result = await runGit([...git, "--replace-all", key, blob])
  if (result.code !== 0) throw new Error(`cannot record ${key}: ${result.stderr.toString("utf8").trim()}`)
  return { key, file }
}

/** Why the declaration at `base` may not run here, or `undefined` when it is the trusted blob. */
async function untrustedDeclaration(options: RepositoryCandidateOptions, base: string): Promise<string | undefined> {
  const declaration = await readRepositoryDeclaration(options.repo, base)
  if (declaration === undefined) return undefined
  const trusted = await trustedBlobs(options)
  if (trusted.includes(declaration.blob)) return undefined
  const { key } = trustLocation(options)
  const recorded = trusted.length === 0 ? `${key} is unset` : `${key} is ${trusted.join(", ")}`
  const address = `${options.url ?? options.repo}#${options.ref ?? "main"}`
  return (
    `${CANDIDATE_CONFIG} ${declaration.blob} at ${base} is not trusted to run (${recorded}); ` +
    `read the commands it declares, then run: gitomic trust '${address}'`
  )
}

type Declaration = { derive?: string; check?: string; timeoutMs: number }

/** The candidate that runs the repository's own declared derive and check commands. Shell-backed repositories only. */
export function repositoryCandidate(options: RepositoryCandidateOptions): Candidate {
  return async (context) => {
    if (context.changed.includes(CANDIDATE_CONFIG) && context.changed.length > 1) {
      return {
        refuse: [
          `${CANDIDATE_CONFIG}: a write that changes the gate must change nothing else; this one changes ${context.changed.length} paths`,
        ],
      }
    }
    if ((await context.readBase(CANDIDATE_CONFIG)) === undefined) return { report: [] }
    const untrusted = await untrustedDeclaration(options, context.base)
    if (untrusted !== undefined) return { refuse: [untrusted] }
    const declared = await readDeclaration(options.repo, context.base)
    if ("refuse" in declared) return declared
    const gitDir = await resolveGitDir(options.repo)
    if (declared.derive !== undefined) {
      const derived = await derive(gitDir, context, declared.derive, declared.timeoutMs)
      if (derived !== undefined) return derived
    }
    if (declared.check === undefined) return { report: [] }
    return check(gitDir, context, declared.check, declared.timeoutMs)
  }
}

async function readDeclaration(
  repo: string,
  base: string,
): Promise<Declaration | (CandidateVerdict & { refuse: string[] })> {
  const result = await runGit([
    "-C",
    repo,
    "config",
    "--blob",
    `${base}:${CANDIDATE_CONFIG}`,
    "--get-regexp",
    "^candidate\\.",
  ])
  // Exit 1 with no output: the file exists but declares nothing under [candidate].
  if (result.code === 1 && result.stdout.length === 0) return { timeoutMs: DEFAULT_CANDIDATE_TIMEOUT_MS }
  if (result.code !== 0) {
    return {
      refuse: [
        `${CANDIDATE_CONFIG}: git config could not read it at ${base}: ${result.stderr.toString("utf8").trim()}`,
      ],
    }
  }
  const declaration: Declaration = { timeoutMs: DEFAULT_CANDIDATE_TIMEOUT_MS }
  for (const line of decodeUtf8(result.stdout, CANDIDATE_CONFIG).split("\n")) {
    if (line === "") continue
    const space = line.indexOf(" ")
    const key = space < 0 ? line : line.slice(0, space)
    const value = space < 0 ? "" : line.slice(space + 1)
    if (key === "candidate.derive") declaration.derive = value
    else if (key === "candidate.check") declaration.check = value
    else if (key === "candidate.timeoutms") {
      const timeoutMs = Number(value)
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        return {
          refuse: [`${CANDIDATE_CONFIG}: candidate.timeoutMs must be a positive integer, got ${JSON.stringify(value)}`],
        }
      }
      declaration.timeoutMs = timeoutMs
    } else
      return {
        refuse: [`${CANDIDATE_CONFIG}: unknown key ${key}; the [candidate] keys are derive, check and timeoutMs`],
      }
  }
  return declaration
}

async function resolveGitDir(repo: string): Promise<string> {
  const result = await runGit(["-C", repo, "rev-parse", "--absolute-git-dir"])
  if (result.code !== 0)
    throw new Error(`cannot resolve the git dir of ${repo}: ${result.stderr.toString("utf8").trim()}`)
  return result.stdout.toString("utf8").trim()
}

type Ran = { code: number; stdout: string; stderr: string } | { timedOut: true }

async function runDeclared(
  gitDir: string,
  context: CandidateContext,
  command: string,
  timeoutMs: number,
): Promise<Ran> {
  const candidate = await context.materialize()
  try {
    const result = await runCommand("sh", ["-c", command], {
      env: { GITOMIC_REPO: gitDir, GITOMIC_BASE: context.base, GITOMIC_CANDIDATE: candidate },
      input: context.changed.map((path) => `${path}\0`).join(""),
      timeoutMs,
    })
    return { code: result.code, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") }
  } catch (error) {
    if (error instanceof GitTimeout) return { timedOut: true }
    throw error
  }
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "")
}

function tail(text: string): string {
  return lines(text).slice(-8).join(" | ") || "no stderr"
}

/** Apply the derive step's edits to the candidate map; a verdict only when it refuses. */
async function derive(
  gitDir: string,
  context: CandidateContext,
  command: string,
  timeoutMs: number,
): Promise<CandidateVerdict | undefined> {
  const ran = await runDeclared(gitDir, context, command, timeoutMs)
  if ("timedOut" in ran) return { refuse: [`derive \`${command}\` did not finish within its ${timeoutMs} ms limit`] }
  if (ran.code !== 0) return { refuse: [`derive \`${command}\` could not run (exit ${ran.code}): ${tail(ran.stderr)}`] }
  let parsed: unknown
  try {
    parsed = ran.stdout.trim() === "" ? {} : JSON.parse(ran.stdout)
  } catch (error) {
    return {
      refuse: [`derive \`${command}\` printed invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
    }
  }
  const edits = parsed as { put?: unknown; rm?: unknown }
  if (typeof edits !== "object" || edits === null || Array.isArray(edits)) {
    return { refuse: [`derive \`${command}\` must print a JSON object {"put": {...}, "rm": [...]}`] }
  }
  if (edits.put !== undefined) {
    if (typeof edits.put !== "object" || edits.put === null || Array.isArray(edits.put)) {
      return { refuse: [`derive \`${command}\`: "put" must map paths to string content`] }
    }
    for (const [path, content] of Object.entries(edits.put)) {
      if (typeof content !== "string")
        return { refuse: [`derive \`${command}\`: "put" content for ${path} is not a string`] }
      context.map.set(path, content)
    }
  }
  if (edits.rm !== undefined) {
    if (!Array.isArray(edits.rm) || edits.rm.some((path) => typeof path !== "string")) {
      return { refuse: [`derive \`${command}\`: "rm" must be an array of paths`] }
    }
    for (const path of edits.rm as string[]) context.map.delete(path)
  }
  return undefined
}

async function check(
  gitDir: string,
  context: CandidateContext,
  command: string,
  timeoutMs: number,
): Promise<CandidateVerdict> {
  const ran = await runDeclared(gitDir, context, command, timeoutMs)
  if ("timedOut" in ran) return { refuse: [`check \`${command}\` did not finish within its ${timeoutMs} ms limit`] }
  if (ran.code === 0) return { report: lines(ran.stdout) }
  if (ran.code === 1) {
    const reasons = lines(ran.stdout)
    return {
      refuse: reasons.length > 0 ? reasons : [`check \`${command}\` refused without a reason: ${tail(ran.stderr)}`],
    }
  }
  return { refuse: [`check \`${command}\` could not run (exit ${ran.code}): ${tail(ran.stderr)}`] }
}
