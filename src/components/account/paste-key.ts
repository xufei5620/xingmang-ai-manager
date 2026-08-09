// Pure validation for PasteKeyDialog.tsx's manual-key entry field (W3b, the
// sub2api-style "粘贴 Key" flow -- see relay-sites.ts's accountBackend:
// 'manual-key'). Kept separate from validation.ts on purpose: that file
// validates new-api *account credentials* (username/password/email) against
// QuantumNous/new-api's own server-side rules; a pasted relay API key is a
// different kind of value with no account backend to defer to, so its rules
// are this app's own choice, not a mirror of an upstream schema.
//
// I13: this module only ever returns a Chinese error string or null -- it
// never logs, and the dialog above must not either. The one legitimate
// transformation of the raw value (trim) is exposed here too
// (normalizePastedApiKey) so the dialog and the eventual write call agree on
// exactly the same string, rather than each trimming independently.

const MIN_PASTED_KEY_LENGTH = 8
const MAX_PASTED_KEY_LENGTH = 512

// Matches any whitespace (space/tab/newline/etc.) or C0/C1 control character
// a clipboard paste occasionally carries in (a trailing newline from
// copying a whole line, a stray zero-width control byte) -- a relay API key
// is a single opaque bearer token with no legitimate embedded whitespace or
// control character.
const INVALID_KEY_CHARACTERS = /[\s\x00-\x1F\x7F]/

/** Trims the raw field value -- the only normalization this flow ever applies to a pasted key. */
export function normalizePastedApiKey(value: string): string {
  return value.trim()
}

/**
 * Validates a pasted relay API key: non-empty after trim, no whitespace or
 * control characters anywhere in it, and a length of 8~512 characters.
 * Returns a Chinese error message, or null when the value is acceptable.
 */
export function validatePastedApiKey(value: string): string | null {
  const trimmed = normalizePastedApiKey(value)
  if (!trimmed) return '请输入 Key'
  if (INVALID_KEY_CHARACTERS.test(trimmed)) return 'Key 不能包含空白或控制字符'
  if (trimmed.length < MIN_PASTED_KEY_LENGTH) return `Key 长度至少为 ${MIN_PASTED_KEY_LENGTH} 位`
  if (trimmed.length > MAX_PASTED_KEY_LENGTH) return `Key 长度不能超过 ${MAX_PASTED_KEY_LENGTH} 位`
  return null
}
