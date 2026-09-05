import { assertUtf8 } from "./utf8.js"

/**
 * Match one tree path against a glob pattern, using git's `:(glob)` pathspec
 * rules (the same wildcard grammar as gitignore(5)):
 *
 * - `*` matches any run of characters WITHIN one segment — it never crosses `/`.
 * - `?` matches exactly one character, never `/`.
 * - `[...]` is a character class; a leading `!` or `^` negates it, and `/` is
 *   never a member. An unterminated `[` is a literal bracket.
 * - `**` as a WHOLE segment crosses directories: a leading `**` matches in
 *   every directory (including none), a trailing `**` matches everything
 *   beneath (but not the directory itself), and a `**` between slashes matches
 *   zero or more segments. A `**` that is not a whole segment (e.g. `a` `**` `b`
 *   run together) is two `*`s, so it stays within its segment.
 * - Every other character, including regex metacharacters like `.` `+` `(`, is
 *   matched literally.
 *
 * Both the pattern and the path are normalized to Unicode NFC first — the same
 * form gitomic stores paths in — so a decomposed pattern still matches a
 * composed path. The whole path must match, anchored at both ends.
 */
export function matchGlob(pattern: string, path: string): boolean {
  assertUtf8(pattern, "glob pattern")
  return globToRegExp(pattern.normalize("NFC")).test(path.normalize("NFC"))
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g

/** Escape one character so a regex matches it literally. */
function escapeLiteral(text: string): string {
  return text.replace(REGEX_META, "\\$&")
}

function globToRegExp(pattern: string): RegExp {
  const segments = pattern.split("/")
  let source = ""
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1
    if (segment === "**") {
      if (last) {
        // A trailing `**` matches everything beneath the preceding slash; a
        // bare `**` (also first) matches anything at all, including nothing.
        source += index === 0 ? ".*" : ".+"
      } else {
        // A `**` with more to come swallows zero or more whole segments, each
        // ending in the slash, so the next segment can begin at any depth. The
        // slash is part of this token, so skip the between-segment slash below.
        source += "(?:[^/]+/)*"
        continue
      }
    } else {
      source += translateSegment(segment)
    }
    if (!last) source += "/"
  }
  return new RegExp(`^${source}$`)
}

/** Translate one path segment's wildcards; `*`/`?`/`[...]` stay within it. */
function translateSegment(segment: string): string {
  let out = ""
  for (let index = 0; index < segment.length; index++) {
    const char = segment.charAt(index)
    if (char === "*") {
      out += "[^/]*"
    } else if (char === "?") {
      out += "[^/]"
    } else if (char === "[") {
      const parsed = readClass(segment, index)
      if (parsed === undefined) {
        out += "\\["
      } else {
        out += parsed.regex
        index = parsed.end
      }
    } else {
      out += escapeLiteral(char)
    }
  }
  return out
}

/**
 * Read a `[...]` class starting at `open`. Returns the regex class and the
 * index of its closing `]`, or `undefined` when the bracket is never closed —
 * in which case the caller treats `[` as a literal.
 */
function readClass(segment: string, open: number): { regex: string; end: number } | undefined {
  let cursor = open + 1
  const negate = segment.charAt(cursor) === "!" || segment.charAt(cursor) === "^"
  if (negate) cursor++
  // A `]` as the first member is a literal `]`, not the terminator.
  if (segment.charAt(cursor) === "]") cursor++
  while (cursor < segment.length && segment.charAt(cursor) !== "]") cursor++
  if (cursor >= segment.length) return undefined
  const body = segment.slice(open + 1 + (negate ? 1 : 0), cursor)
  // A `/` can never appear in a segment, and a trailing backslash must not
  // escape past the class, so neutralize both before building the class.
  const safe = body.replace(/\\/g, "\\\\").replace(/\//g, "")
  return { regex: `[${negate ? "^" : ""}${safe}]`, end: cursor }
}
