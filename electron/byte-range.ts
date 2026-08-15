export interface ByteRange {
  start: number
  end: number
}

export function parseSingleByteRange(value: string, totalLength: number): ByteRange | null {
  if (!Number.isSafeInteger(totalLength) || totalLength <= 0) return null
  const match = value.match(/^bytes=(\d*)-(\d*)$/)
  if (!match || (!match[1] && !match[2])) return null
  if (!match[1]) {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null
    return { start: Math.max(0, totalLength - suffixLength), end: totalLength - 1 }
  }
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : totalLength - 1
  const end = Math.min(totalLength - 1, requestedEnd)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0 || start > end || start >= totalLength) return null
  return { start, end }
}
