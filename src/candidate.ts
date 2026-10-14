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
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { GitTimeout } from "./errors.ts"
import { runCommand, runGit } from "./shell.ts"
import type { Candidate, CandidateContext, CandidateVerdict, Oid } from "./types.js"
import { decodeUtf8 } from "./utf8.ts"

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
  /**
   * Measurement only (27155): called as each step of a run ends, with its wall time in milliseconds, so a caller can
   * say where a gated write's candidate time went. A step that throws reports nothing. It runs inline: keep it cheap,
   * and never let it throw, because a throwing onStep fails the write.
   */
  readonly onStep?: (step: CandidateStep, ms: number) => void
  /** Declared commands the caller runs in its own process instead of spawning them (27155 (iii)). */
  readonly inProcess?: InProcessOptions
}

/**
 * One timed step of {@link repositoryCandidate}: reading the base's declaration (its presence, then its keys),
 * checking its trust, resolving the git dir, materializing one candidate commit, and each declared command until its
 * process started (`deriveSpawn`, `checkSpawn`) and for its whole run (`derive`, `check`). A command run in process
 * is its `derive` or `check` step under "use", and its own `deriveInProcess` or `checkInProcess` step under "shadow".
 */
export type CandidateStep =
  | "declaration"
  | "trust"
  | "gitDir"
  | "materialize"
  | "deriveSpawn"
  | "derive"
  | "deriveInProcess"
  | "checkSpawn"
  | "check"
  | "checkInProcess"

/** What a declared command is given: the environment and stdin a spawned `sh -c` command gets, as values. */
export type DeclaredCommandInput = {
  /** GITOMIC_REPO. */
  readonly gitDir: string
  /** GITOMIC_BASE. */
  readonly base: Oid
  /** GITOMIC_CANDIDATE: the candidate, materialized as an unpublished commit. */
  readonly candidate: Oid
  /** The paths the write changed, as the spawned command reads them from stdin. */
  readonly changed: readonly string[]
}

/** A declared command's run: its exit code and output, or the declared limit that stopped it. */
export type CandidateRun =
  | { readonly code: number; readonly stdout: string; readonly stderr: string }
  | { readonly timedOut: true }

/** One declared command run in the caller's process: the inputs a spawned command gets, the result it would give. */
export type InProcessCommand = (
  input: DeclaredCommandInput,
) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>

/**
 * Declared commands a caller runs in its own process (27155 (iii), @cto 67b6d4c1). gitomic still reads and trusts the
 * declaration itself, then hands `resolve` each exact declared command: a returned implementation runs it, and
 * `undefined` runs the command as declared. Under "use" the in-process run decides, under the declared limit. Under
 * "shadow" both run, the declared command decides, and `compare` sees both runs; an in-process throw reaches
 * `compare` as `{ error }` and never changes the verdict. `compare` runs inline and must not throw.
 */
export type InProcessOptions = {
  readonly mode: "use" | "shadow"
  readonly resolve: (
    kind: "derive" | "check",
    command: string,
    context: CandidateContext,
  ) => InProcessCommand | undefined
  readonly compare?: (
    kind: "derive" | "check",
    command: string,
    runs: { readonly declared: CandidateRun; readonly inProcess: CandidateRun | { readonly error: string } },
  ) => void
}

/** Where a repository's trust is recorded: its own git config for a path, the caller's global config for a URL. */
export type TrustScope = { readonly repo: string; readonly url?: string }

/** The git config variable a path repository records its trusted declaration blob in. */
export const TRUST_CONFIG = "gitomic.trust"

function toUrl(urlOrPath: string): string {
  const drivePath = /^[A-Za-z]:[\\\\/]/.test(urlOrPath)
  const remote = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(urlOrPath) || (!drivePath && /^[^/\\\\:]+:/.test(urlOrPath))
  if (remote) return urlOrPath
  return pathToFileURL(resolve(urlOrPath)).href
}

function trustLocation(scope: TrustScope): { readonly git: string[]; readonly key: string; readonly file: string } {
  return scope.url === undefined
    ? { git: ["-C", scope.repo, "config", "--local"], key: TRUST_CONFIG, file: "local" }
    : { git: ["config", "--global"], key: `gitomic.${toUrl(scope.url)}.trust`, file: "global" }
}

async function trustedBlobs(scope: TrustScope): Promise<string[]> {
  const { git, key } = trustLocation(scope)
  const result = await runGit([...git, "--get-all", key])
  if (result.code === 0) {
    const list = lines(decodeUtf8(result.stdout, key)).map((line) => line.trim())
    if (list.length > 0) return list
  }
  // Exit 1 with no output: the variable is unset.
  if (result.code === 1 && result.stdout.length === 0) {
    if (scope.url !== undefined) {
      const rawKey = `gitomic.${scope.url}.trust`
      if (rawKey !== key) {
        const fallback = await runGit([...git, "--get-all", rawKey])
        if (fallback.code === 0) {
          const list = lines(decodeUtf8(fallback.stdout, rawKey)).map((line) => line.trim())
          if (list.length > 0) return list
          return []
        }
        if (fallback.code === 1 && fallback.stderr.toString("utf8").trim() === "") {
          return []
        }
        throw new Error(`cannot read ${rawKey}: ${fallback.stderr.toString("utf8").trim()}`)
      }
    }
    return []
  }
  if (result.code !== 0) throw new Error(`cannot read ${key}: ${result.stderr.toString("utf8").trim()}`)
  return []
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
  const target = options.url === undefined ? options.repo : toUrl(options.url)
  const address = `${target}#${options.ref ?? "main"}`
  return (
    `${CANDIDATE_CONFIG} ${declaration.blob} at ${base} is not trusted to run (${recorded}); ` +
    `read the commands it declares, then run: gitomic trust '${address}'`
  )
}

/**
 * Where a repository publishes: `[publish] remote = <name>` (and `branch`, default `main`) in the same declaration.
 * It is data that runs nothing: it only makes a write addressed to a checkout of the repository refuse, since such a
 * write lands on the checkout's local ref and pushes nothing.
 */
export type PublishDeclaration = { readonly remote: string; readonly branch: string }

/** The `[publish]` the declaration at `base` makes, or `undefined` when it has no declaration or no such section. */
export async function readPublishDeclaration(repo: string, base: string): Promise<PublishDeclaration | undefined> {
  const result = await runGit([
    "-C",
    repo,
    "config",
    "--blob",
    `${base}:${CANDIDATE_CONFIG}`,
    "--get-regexp",
    "^publish\\.",
  ])
  // Exit 1 with no output: no [publish] keys (the file may still declare [candidate]).
  if (result.code === 1 && result.stdout.length === 0) return undefined
  if (result.code !== 0) {
    throw new Error(
      `${CANDIDATE_CONFIG}: git config could not read it at ${base}: ${result.stderr.toString("utf8").trim()}`,
    )
  }
  let remote: string | undefined
  let branch = "main"
  for (const line of decodeUtf8(result.stdout, CANDIDATE_CONFIG).split("\n")) {
    if (line === "") continue
    const space = line.indexOf(" ")
    const key = space < 0 ? line : line.slice(0, space)
    const value = space < 0 ? "" : line.slice(space + 1).trim()
    if (key === "publish.remote") remote = value
    else if (key === "publish.branch") branch = value
    else throw new Error(`${CANDIDATE_CONFIG} at ${base}: unknown [publish] key '${key}' (allowed: remote, branch)`)
  }
  if (remote === undefined || remote === "" || branch === "") {
    throw new Error(`${CANDIDATE_CONFIG} at ${base}: [publish] needs a remote name and a non-empty branch`)
  }
  return { remote, branch }
}

/** A checkout-repair policy declared by the origin commit, never by its working copy. */
export type StateCheckoutDeclaration = {
  readonly quietSeconds: number
  readonly maxFileBytes: number
  readonly maxPaths: number
  readonly maxRemovals: number
  readonly newRoots: readonly string[]
}

/** No section disables repair. A partial or unknown section refuses instead of supplying Gitomic-owned defaults. */
export async function readStateCheckoutDeclaration(
  repo: string,
  originTip: string,
): Promise<StateCheckoutDeclaration | undefined> {
  const declaration = await readRepositoryDeclaration(repo, originTip)
  if (declaration === undefined) return undefined
  const result = await runGit(["-C", repo, "config", "--blob", declaration.blob, "--get-regexp", "^state-checkout\\."])
  if (result.code === 1 && result.stdout.length === 0) {
    const text = await runGit(["-C", repo, "cat-file", "blob", declaration.blob])
    if (text.code !== 0) throw new Error(`${CANDIDATE_CONFIG}: cannot read declaration blob ${declaration.blob}`)
    if (/^\s*\[state-checkout\s*\]/imu.test(decodeUtf8(text.stdout, CANDIDATE_CONFIG))) {
      throw new Error(
        `${CANDIDATE_CONFIG} at ${originTip}: [state-checkout] lacks quiet-seconds, max-file-bytes, max-paths and max-removals`,
      )
    }
    return undefined
  }
  if (result.code !== 0) {
    throw new Error(
      `${CANDIDATE_CONFIG}: cannot read [state-checkout] at ${originTip}: ${result.stderr.toString("utf8").trim()}`,
    )
  }
  const numbers = new Map<string, number>()
  const newRoots: string[] = []
  const allowed = new Set(["quiet-seconds", "max-file-bytes", "max-paths", "max-removals", "new-root"])
  for (const line of decodeUtf8(result.stdout, CANDIDATE_CONFIG).split("\n")) {
    if (line === "") continue
    const space = line.indexOf(" ")
    const key = space < 0 ? line : line.slice(0, space)
    const value = space < 0 ? "" : line.slice(space + 1).trim()
    const name = key.slice("state-checkout.".length)
    if (!allowed.has(name)) {
      throw new Error(`${CANDIDATE_CONFIG} at ${originTip}: unknown [state-checkout] key '${key}'`)
    }
    if (name === "new-root") {
      if (value === "" || value.startsWith("/") || value.includes("..") || !value.endsWith("/")) {
        throw new Error(`${CANDIDATE_CONFIG} at ${originTip}: invalid new-root ${JSON.stringify(value)}`)
      }
      newRoots.push(value)
      continue
    }
    const number = Number(value)
    if (!Number.isSafeInteger(number) || number <= 0 || numbers.has(name)) {
      throw new Error(
        `${CANDIDATE_CONFIG} at ${originTip}: ${key} needs one positive integer, got ${JSON.stringify(value)}`,
      )
    }
    numbers.set(name, number)
  }
  const requiredNumber = (name: string): number => {
    const value = numbers.get(name)
    if (value === undefined) throw new Error(`${CANDIDATE_CONFIG} at ${originTip}: [state-checkout] lacks ${name}`)
    return value
  }
  return {
    quietSeconds: requiredNumber("quiet-seconds"),
    maxFileBytes: requiredNumber("max-file-bytes"),
    maxPaths: requiredNumber("max-paths"),
    maxRemovals: requiredNumber("max-removals"),
    newRoots,
  }
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
    const timed = stepTimer(options.onStep)
    if ((await timed("declaration", () => context.readBase(CANDIDATE_CONFIG))) === undefined) return { report: [] }
    const untrusted = await timed("trust", () => untrustedDeclaration(options, context.base))
    if (untrusted !== undefined) return { refuse: [untrusted] }
    const declared = await timed("declaration", () => readDeclaration(options.repo, context.base))
    if ("refuse" in declared) return declared
    const gitDir = await timed("gitDir", () => resolveGitDir(options.repo))
    const run: Runner = {
      gitDir,
      context,
      timeoutMs: declared.timeoutMs,
      timed,
      onStep: options.onStep,
      inProcess: options.inProcess,
    }
    let materialized: Oid | undefined
    if (declared.derive !== undefined) {
      materialized = await timed("materialize", () => context.materialize())
      const derived = await derive(run, declared.derive, materialized)
      if (derived === "edited") materialized = undefined
      else if (derived !== undefined) return derived
    }
    if (declared.check === undefined) return { report: [] }
    return check(run, declared.check, materialized)
  }
}

type StepTimer = <T>(step: CandidateStep, work: () => Promise<T>) => Promise<T>

/** Time each step for `onStep`; without one, run the work and measure nothing. */
function stepTimer(onStep: RepositoryCandidateOptions["onStep"]): StepTimer {
  return async (step, work) => {
    if (onStep === undefined) return work()
    const start = performance.now()
    const value = await work()
    onStep(step, performance.now() - start)
    return value
  }
}

/** What every declared command of one run shares. */
type Runner = {
  readonly gitDir: string
  readonly context: CandidateContext
  readonly timeoutMs: number
  readonly timed: StepTimer
  readonly onStep: RepositoryCandidateOptions["onStep"]
  readonly inProcess: RepositoryCandidateOptions["inProcess"]
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
    } else {
      return {
        refuse: [`${CANDIDATE_CONFIG}: unknown key ${key}; the [candidate] keys are derive, check and timeoutMs`],
      }
    }
  }
  return declaration
}

async function resolveGitDir(repo: string): Promise<string> {
  const result = await runGit(["-C", repo, "rev-parse", "--absolute-git-dir"])
  if (result.code !== 0) {
    throw new Error(`cannot resolve the git dir of ${repo}: ${result.stderr.toString("utf8").trim()}`)
  }
  return result.stdout.toString("utf8").trim()
}

async function runDeclared(
  run: Runner,
  kind: "derive" | "check",
  command: string,
  materialized?: Oid,
): Promise<CandidateRun> {
  const { context } = run
  const candidate = materialized ?? (await run.timed("materialize", () => context.materialize()))
  const input: DeclaredCommandInput = { gitDir: run.gitDir, base: context.base, candidate, changed: context.changed }
  const claimed = run.inProcess?.resolve(kind, command, context)
  if (claimed !== undefined && run.inProcess?.mode === "use") {
    return run.timed(kind, () => runInProcess(claimed, input, run.timeoutMs))
  }
  const declared = await spawnDeclared(run, kind, command, input)
  if (claimed !== undefined) {
    const inProcess = await run.timed(kind === "derive" ? "deriveInProcess" : "checkInProcess", () =>
      runInProcess(claimed, input, run.timeoutMs).catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      })),
    )
    run.inProcess?.compare?.(kind, command, { declared, inProcess })
  }
  return declared
}

/** The declared command as `sh -c`, with its inputs as environment and NUL-separated stdin. */
async function spawnDeclared(
  run: Runner,
  kind: "derive" | "check",
  command: string,
  input: DeclaredCommandInput,
): Promise<CandidateRun> {
  const { onStep } = run
  try {
    const started = onStep === undefined ? 0 : performance.now()
    const result = await run.timed(kind, () =>
      runCommand("sh", ["-c", command], {
        env: { GITOMIC_REPO: input.gitDir, GITOMIC_BASE: input.base, GITOMIC_CANDIDATE: input.candidate },
        input: input.changed.map((path) => `${path}\0`).join(""),
        timeoutMs: run.timeoutMs,
        ...(onStep === undefined
          ? {}
          : { onSpawn: () => onStep(kind === "derive" ? "deriveSpawn" : "checkSpawn", performance.now() - started) }),
      }),
    )
    return { code: result.code, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") }
  } catch (error) {
    if (error instanceof GitTimeout) return { timedOut: true }
    throw error
  }
}

/**
 * A claimed command under the declared limit, as a spawned one runs: past the limit it reads as timed out. Its work
 * cannot be killed, so a pure-JS hang still holds the caller's thread; the caller bounds what it claims (27155 (iii)).
 */
async function runInProcess(
  command: InProcessCommand,
  input: DeclaredCommandInput,
  timeoutMs: number,
): Promise<CandidateRun> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<CandidateRun>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
  })
  try {
    const result = await Promise.race([command(input), limit])
    return "timedOut" in result ? result : { code: result.code, stdout: result.stdout, stderr: result.stderr }
  } finally {
    clearTimeout(timer)
  }
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "")
}

function tail(text: string): string {
  return lines(text).slice(-8).join(" | ") || "no stderr"
}

/** Apply derive edits; every emitted put/rm operation invalidates the materialized candidate. */
async function derive(
  run: Runner,
  command: string,
  materialized: Oid,
): Promise<CandidateVerdict | "edited" | undefined> {
  const { context, timeoutMs } = run
  const ran = await runDeclared(run, "derive", command, materialized)
  if ("timedOut" in ran) return { refuse: [`derive \`${command}\` did not finish within its ${timeoutMs} ms limit`] }
  if (ran.code === 1) {
    const reasons = lines(ran.stdout)
    return {
      refuse: reasons.length > 0 ? reasons : [`derive \`${command}\` refused without a reason: ${tail(ran.stderr)}`],
    }
  }
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
  let edited = false
  if (edits.put !== undefined) {
    if (typeof edits.put !== "object" || edits.put === null || Array.isArray(edits.put)) {
      return { refuse: [`derive \`${command}\`: "put" must map paths to string content`] }
    }
    for (const [path, content] of Object.entries(edits.put)) {
      if (typeof content !== "string") {
        return { refuse: [`derive \`${command}\`: "put" content for ${path} is not a string`] }
      }
      context.map.set(path, content)
      edited = true
    }
  }
  if (edits.rm !== undefined) {
    if (!Array.isArray(edits.rm) || edits.rm.some((path) => typeof path !== "string")) {
      return { refuse: [`derive \`${command}\`: "rm" must be an array of paths`] }
    }
    for (const path of edits.rm as string[]) {
      context.map.delete(path)
      edited = true
    }
  }
  return edited ? "edited" : undefined
}

async function check(run: Runner, command: string, materialized?: Oid): Promise<CandidateVerdict> {
  const { timeoutMs } = run
  const ran = await runDeclared(run, "check", command, materialized)
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
