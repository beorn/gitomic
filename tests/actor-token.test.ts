// @failure Two callers decode the same actor token differently, a token with a line break or colon in its session forges
// a trailer, an oversized token is decoded at all, or a refusal leaks the token into a warning.
// @level l1
// @consumer km's caller attribution and hh's CODE commit-msg hook, which both stamp these trailers (who-acted WA-R12, WA-R14)
// @testonly none
import { describe, expect, test } from "vitest"

import {
  ACTOR_TOKEN_MAX_BYTES,
  actorTrailersFromToken,
  parseActorTokenDeclaration,
  type ActorTokenDeclaration,
} from "../src/index.js"

const DECLARATION: ActorTokenDeclaration = { variable: "TEST_TOKEN", sessionClaim: "sid", generationClaim: "gen" }
const b64 = (text: string) => Buffer.from(text).toString("base64url")
const token = (claims: unknown) => ["e30", b64(JSON.stringify(claims)), "c2ln"].join(".")

describe("actorTrailersFromToken", () => {
  test("decodes the declared claims into both trailers and ignores every other claim", () => {
    expect(actorTrailersFromToken(token({ sid: "launch-a", gen: 7, act: { sub: "@dev/1" } }), DECLARATION)).toEqual({
      trailers: [
        ["Actor-Session", "launch-a"],
        ["Actor-Generation", "7"],
      ],
    })
    expect(
      actorTrailersFromToken(token({ session: "s", generation: 0 }), {
        variable: "OTHER",
        sessionClaim: "session",
        generationClaim: "generation",
      }),
    ).toEqual({
      trailers: [
        ["Actor-Session", "s"],
        ["Actor-Generation", "0"],
      ],
    })
  })

  test.each([
    ["an oversized token", "a".repeat(ACTOR_TOKEN_MAX_BYTES + 1), /over the 8192-byte limit/u],
    ["two segments", "e30.c2ln", /three nonempty base64url segments/u],
    ["an empty segment", "e30..c2ln", /three nonempty base64url segments/u],
    ["a non-base64url segment", "e30.a+b/.c2ln", /three nonempty base64url segments/u],
    ["a non-canonical payload", "e30.e31.c2ln", /not canonical base64url/u],
    ["a payload that is not JSON", ["e30", b64("{not json"), "c2ln"].join("."), /not UTF-8 JSON/u],
    [
      "a payload that is not UTF-8",
      ["e30", Buffer.from([0xff, 0xfe]).toString("base64url"), "c2ln"].join("."),
      /not UTF-8 JSON/u,
    ],
    ["a JSON array payload", token([1, 2]), /not a JSON object/u],
    ["a missing session claim", token({ gen: 1 }), /claim sid is missing/u],
    ["a numeric session claim", token({ sid: 5, gen: 1 }), /claim sid is not a string/u],
    ["an empty session claim", token({ sid: " ", gen: 1 }), /claim sid is empty/u],
    ["a CR in the session", token({ sid: "a\rb", gen: 1 }), /claim sid contains a carriage return/u],
    ["an LF in the session", token({ sid: "a\nActor-Session: forged", gen: 1 }), /claim sid contains a line feed/u],
    ["a NUL in the session", token({ sid: "a\0b", gen: 1 }), /claim sid contains a NUL/u],
    ["a colon in the session", token({ sid: "Actor-Session:forged", gen: 1 }), /claim sid contains a colon/u],
    ["a tab in the session", token({ sid: "a\tb", gen: 1 }), /claim sid contains a control character/u],
    ["surrounding whitespace in the session", token({ sid: " a", gen: 1 }), /claim sid has surrounding whitespace/u],
    ["a missing generation claim", token({ sid: "a" }), /claim gen is missing/u],
    ["a string generation", token({ sid: "a", gen: "1" }), /claim gen is not a nonnegative safe integer/u],
    ["a negative generation", token({ sid: "a", gen: -1 }), /claim gen is not a nonnegative safe integer/u],
    ["a fractional generation", token({ sid: "a", gen: 1.5 }), /claim gen is not a nonnegative safe integer/u],
    ["an unsafe generation", token({ sid: "a", gen: 2 ** 53 }), /claim gen is not a nonnegative safe integer/u],
  ])("refuses %s with a reason and no trailers", (_shape, raw, reason) => {
    const result = actorTrailersFromToken(raw, DECLARATION)
    expect(result).not.toHaveProperty("trailers")
    expect("reason" in result ? result.reason : "").toMatch(reason)
    // A reason names the cause, never the token: a warning must not leak a credential into a log.
    expect("reason" in result ? result.reason : "").not.toContain(raw)
  })

  test("a token of exactly the byte limit is decoded; one byte more is refused", () => {
    const head = `e30.${b64(JSON.stringify({ sid: "a", gen: 1 }))}.`
    const atLimit = head + "A".repeat(ACTOR_TOKEN_MAX_BYTES - head.length)
    expect(Buffer.byteLength(atLimit)).toBe(ACTOR_TOKEN_MAX_BYTES)
    expect(actorTrailersFromToken(atLimit, DECLARATION)).toHaveProperty("trailers")
    expect(actorTrailersFromToken(`${atLimit}A`, DECLARATION)).toHaveProperty("reason")
  })
})

describe("parseActorTokenDeclaration", () => {
  test("no declaration is undefined; a declaration keeps exactly its three names", () => {
    expect(parseActorTokenDeclaration(undefined)).toBeUndefined()
    expect(parseActorTokenDeclaration({ ...DECLARATION, extra: true })).toEqual(DECLARATION)
  })

  test.each([null, "TEST_TOKEN", ["TEST_TOKEN"]])(
    "refuses a non-object declaration %j by the caller's label",
    (value) => {
      expect(() => parseActorTokenDeclaration(value, "attribution.token")).toThrow(
        "attribution.token must declare variable, sessionClaim and generationClaim",
      )
    },
  )

  test.each(["variable", "sessionClaim", "generationClaim"])("refuses a missing or blank %s", (key) => {
    expect(() => parseActorTokenDeclaration({ ...DECLARATION, [key]: " " }, "attribution.token")).toThrow(
      `attribution.token.${key} must be a nonempty string`,
    )
    expect(() => parseActorTokenDeclaration({ ...DECLARATION, [key]: undefined })).toThrow(
      `actor token declaration.${key} must be a nonempty string`,
    )
  })
})
