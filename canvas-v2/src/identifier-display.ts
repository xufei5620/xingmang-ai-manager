// Identifiers and prose truncate differently. `gemini-3-pro-image-preview`
// end-truncated to `gemini-3-pro-image…` throws away the half that tells it
// apart from `gemini-3-pro-image-fast`; a 43 character content-addressed asset
// id has the same problem. Prose is the opposite: the beginning carries the
// meaning, so CSS ellipsis is correct there and this helper is not used.

const ellipsis = '…'

/**
 * Keep both ends of an identifier, dropping the middle. Returns the input
 * unchanged when it already fits, so callers never need a length check.
 */
export function middleTruncate(value: string, maximum = 20): string {
  if (maximum < 5) throw new Error('中段截断的保留长度至少为 5')
  if (value.length <= maximum) return value
  const budget = maximum - ellipsis.length
  const head = Math.ceil(budget / 2)
  const tail = budget - head
  return `${value.slice(0, head)}${ellipsis}${value.slice(value.length - tail)}`
}
