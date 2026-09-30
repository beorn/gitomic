import type { Trailer } from "./types.js"

/**
 * Where an actor token lives and which of its claims name the acting session and generation.
 *
 * The declaration is the caller's data. gitomic knows no issuer, variable or claim name: the program that mints the
 * token owns those names, and each caller declares them beside its own configuration.
 */
export type ActorTokenDeclaration = {
  /** The environment variable that carries the token. */
  readonly variable: string
  /** The payload claim whose string value becomes the `Actor-Session` trailer. */
  readonly sessionClaim: string
  /** The payload claim whose nonnegative safe-integer value becomes the `Actor-Generation` trailer. */
  readonly generationClaim: string
}

/** Both actor trailers, or why the token could not be read. A reason never quotes the token or a claim value. */
export type ActorTrailersResult =
  | { readonly trailers: readonly [session: Trailer, generation: Trailer] }
  | { readonly reason: string }

/** A token longer than this is refused before it is decoded. */
export const ACTOR_TOKEN_MAX_BYTES = 8192

const DECLARATION_KEYS = ["variable", "sessionClaim", "generationClaim"] as const

/**
 * Read an actor-token declaration. `undefined` means none is declared; any other shape that lacks one of the three
 * nonempty strings throws a TypeError whose text names `label`, the caller's own key for the declaration.
 */
export function parseActorTokenDeclaration(
  value: unknown,
  label = "actor token declaration",
): ActorTokenDeclaration | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must declare variable, sessionClaim and generationClaim`)
  }
  const record = value as Record<string, unknown>
  for (const key of DECLARATION_KEYS) {
    const field = record[key]
    if (typeof field !== "string" || field.trim() === "") {
      throw new TypeError(`${label}.${key} must be a nonempty string`)
    }
  }
  return Object.freeze({
    variable: record.variable as string,
    sessionClaim: record.sessionClaim as string,
    generationClaim: record.generationClaim as string,
  })
}

/** The character classes a session value may not hold, by name: each would split or forge a trailer line. */
const SESSION_REFUSALS: readonly (readonly [RegExp, string])[] = [
  [/\r/u, "a carriage return"],
  [/\n/u, "a line feed"],
  [/\0/u, "a NUL"],
  [/:/u, "a colon"],
  // eslint-disable-next-line no-control-regex -- the refusal is exactly the remaining C0 controls and DEL.
  [/[\u0001-\u001f\u007f]/u, "a control character"],
]

/**
 * Decode an actor token into the `Actor-Session` and `Actor-Generation` trailers.
 *
 * Decode only: the signature is not verified, and nothing here grants permission or changes a write. The token is a
 * compact JWS (three base64url segments); only the payload is read. A caller that gets a `reason` records the write
 * without either trailer and says why.
 */
export function actorTrailersFromToken(raw: string, declaration: ActorTokenDeclaration): ActorTrailersResult {
  const bytes = Buffer.byteLength(raw, "utf8")
  if (bytes > ACTOR_TOKEN_MAX_BYTES) {
    return { reason: `token is ${bytes} bytes, over the ${ACTOR_TOKEN_MAX_BYTES}-byte limit` }
  }
  const segments = raw.split(".")
  if (segments.length !== 3 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/u.test(segment))) {
    return { reason: "token is not three nonempty base64url segments separated by dots" }
  }
  const payload = segments[1] as string
  const decoded = Buffer.from(payload, "base64url")
  if (decoded.toString("base64url") !== payload) return { reason: "token payload is not canonical base64url" }
  let claims: unknown
  try {
    claims = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded))
  } catch {
    // silent-fallback-allow: the refusal is returned as data with its reason; every caller reports it.
    return { reason: "token payload is not UTF-8 JSON" }
  }
  if (claims === null || typeof claims !== "object" || Array.isArray(claims)) {
    return { reason: "token payload is not a JSON object" }
  }
  const record = claims as Record<string, unknown>
  const { sessionClaim, generationClaim } = declaration
  if (!Object.hasOwn(record, sessionClaim)) return { reason: `claim ${sessionClaim} is missing` }
  const session = record[sessionClaim]
  if (typeof session !== "string") return { reason: `claim ${sessionClaim} is not a string` }
  if (session.trim() === "") return { reason: `claim ${sessionClaim} is empty` }
  for (const [pattern, name] of SESSION_REFUSALS) {
    if (pattern.test(session)) return { reason: `claim ${sessionClaim} contains ${name}` }
  }
  if (session !== session.trim()) return { reason: `claim ${sessionClaim} has surrounding whitespace` }
  if (!Object.hasOwn(record, generationClaim)) return { reason: `claim ${generationClaim} is missing` }
  const generation = record[generationClaim]
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
    return { reason: `claim ${generationClaim} is not a nonnegative safe integer` }
  }
  return {
    trailers: [
      ["Actor-Session", session],
      ["Actor-Generation", String(generation)],
    ],
  }
}
