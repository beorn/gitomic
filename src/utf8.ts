import { TextDecoder } from "node:util"

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })

export function decodeUtf8(data: Uint8Array, label: string): string {
  try {
    return decoder.decode(data)
  } catch (cause) {
    throw new TypeError(`${label} must be valid UTF-8; binary values are not supported`, { cause })
  }
}

export function assertUtf8(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a UTF-8 string`)
  if (decodeUtf8(Buffer.from(value, "utf8"), label) !== value) {
    throw new TypeError(`${label} must be valid UTF-8; unpaired Unicode surrogates are not supported`)
  }
}

/**
 * Decode a blob, or keep its raw bytes when it is not valid UTF-8.
 *
 * The refusal is not dropped, only deferred to whoever reads this value. A
 * whole-tree read must not fail because one unrelated file in the tree is an
 * image: that would make every transaction on such a tree impossible, which is
 * a far larger failure than refusing the one value gitomic v1 cannot carry.
 */
export function decodeBlob(bytes: Uint8Array): string | Uint8Array {
  try {
    return decoder.decode(bytes)
  } catch {
    return bytes
  }
}
