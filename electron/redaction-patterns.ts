// The one table of secret shapes that every log, diagnostics, crash and
// feedback redactor applies. It must stay free of imports: startup-log and
// crash-report redact while recording a failure of some other module, so the
// table cannot drag in anything that could itself be what failed.

const REDACTED = '[REDACTED]'

// Word characters plus `-`, the alphabet every relay/vendor key below uses. A
// trailing `\b` would stop short of a key ending in `-` and leak its tail.
const KEY_TAIL = '(?![A-Za-z0-9_-])'

/**
 * Values recognised by their own shape, wherever they appear:
 * - `Bearer …` authorization values
 * - `sk-…` relay / OpenAI / Anthropic keys
 * - `AIza…` Google (Gemini) API keys, always 39 characters
 * - `xai-…` Grok keys; the 20-character floor keeps the npm package name
 *   `@xai-official/grok` in install logs readable
 */
export function redactSecretShapes(value: string): string {
  return value
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, `$1${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/gi, REDACTED)
    .replace(new RegExp(`\\bAIza[A-Za-z0-9_-]{35,}${KEY_TAIL}`, 'g'), REDACTED)
    .replace(new RegExp(`\\bxai-[A-Za-z0-9_-]{20,}${KEY_TAIL}`, 'gi'), REDACTED)
}

/**
 * Values recognised by the name in front of them. `api[_-]?key` also covers the
 * `x-api-key` and `x-goog-api-key` request headers, since the rule is not
 * anchored at the start of the name.
 */
export function redactSecretFields(value: string): string {
  return value
    // The quoted spellings need their own rules: in `{"access_token":"…"}` the
    // unquoted rule can never match, because `\s*` does not cross the quote
    // that closes the key name, so any CLI writing JSON to stderr leaked its
    // secrets verbatim into the runtime log and the feedback export. Redacting
    // between the existing quotes also keeps a JSON body parseable.
    .replace(/((?:api[_-]?key|authorization|token|secret|password)"\s*[:=]\s*)"[^"]*"/gi, `$1"${REDACTED}"`)
    .replace(/((?:api[_-]?key|authorization|token|secret|password)'\s*[:=]\s*)'[^']*'/gi, `$1'${REDACTED}'`)
    .replace(/((?:api[_-]?key|authorization|token|secret|password)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, `$1${REDACTED}`)
}

/**
 * Credentials carried in a query string. Bare `key=` is included because the
 * Gemini REST API authenticates with `?key=AIza…`.
 */
export function redactSecretQueryParameters(value: string): string {
  return value.replace(/([?&](?:api[_-]?key|key|token)=)[^&\s]+/gi, `$1${REDACTED}`)
}

export function redactSecretPatterns(value: string): string {
  return redactSecretQueryParameters(redactSecretFields(redactSecretShapes(value)))
}
