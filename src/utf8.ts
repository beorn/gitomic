import { TextDecoder } from "node:util"

const decoder = new TextDecoder("utf-8", { fatal: true })

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
