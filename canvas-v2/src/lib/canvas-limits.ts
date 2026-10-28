// Leave room below D1's per-value bound for UTF-8 content and metadata.
export const maximumProjectFileBytes = 2 * 1024 * 1024
export const maximumProjectContentBytes = 1_900_000
export const maximumProjectNodes = 2_000
export const maximumProjectEdges = 4_000

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
