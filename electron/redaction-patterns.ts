// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

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
 * - `ghp_…` / `github_pat_…` / `glpat-…` GitHub and GitLab access tokens
 * - URL userinfo: private Git sources are pasted as
 *   `https://user:token@host/repo` (#537). Any userinfo on http(s) is a
 *   credential; other schemes only lose it when a password is present, so
 *   `ssh://git@host` stays readable.
 */
export function redactSecretShapes(value: string): string {
  return value
    .replace(/\b(https?:\/\/)[^\s/?#@]+@/gi, `$1${REDACTED}@`)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@:]*:[^\s/?#@]*@/gi, `$1${REDACTED}@`)
    .replace(new RegExp(`\\bgh[pousr]_[A-Za-z0-9]{20,}${KEY_TAIL}`, 'g'), REDACTED)
    .replace(new RegExp(`\\bgithub_pat_[A-Za-z0-9_]{20,}${KEY_TAIL}`, 'g'), REDACTED)
    .replace(new RegExp(`\\bglpat-[A-Za-z0-9_-]{20,}${KEY_TAIL}`, 'g'), REDACTED)
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, `$1${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/gi, REDACTED)
    .replace(new RegExp(`\\bAIza[A-Za-z0-9_-]{35,}${KEY_TAIL}`, 'g'), REDACTED)
    .replace(new RegExp(`\\bxai-[A-Za-z0-9_-]{20,}${KEY_TAIL}`, 'gi'), REDACTED)
}

// A command-line flag that carries a credential: the name ends in one of these
// words (`--token`, `--api-key`, `--github-token`, `-key`, `--client-secret`,
// `--auth`). Anchoring on the end keeps `--password-store` and
// `--bearer-token-env-var`, whose values are not secrets, readable. Each
// segment of the name ends at its own separator, so a long flag name cannot
// make the match backtrack badly.
const CREDENTIAL_FLAG = '--?(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|key|token|secret|password|passwd|auth)'
const CREDENTIAL_FLAG_ARGUMENT = new RegExp(`^${CREDENTIAL_FLAG}$`, 'i')
const CREDENTIAL_FLAG_ASSIGNMENT = new RegExp(`^${CREDENTIAL_FLAG}=([\\s\\S]+)$`, 'i')
const CREDENTIAL_FLAG_IN_TEXT = new RegExp(
  `((?:^|[\\s"'])${CREDENTIAL_FLAG}(?:=|\\s+(?!-)))(?:"[^"]*"|'[^']*'|[^\\s"']+)`,
  'gi',
)

/**
 * Values recognised by the name in front of them. `api[_-]?key` also covers the
 * `x-api-key` and `x-goog-api-key` request headers, since the rule is not
 * anchored at the start of the name. `cookie` and `credential` are the two
 * names the crash reporter already hid while the runtime log and the feedback
 * export kept them (#1073): a session cookie is a login, whatever text it is
 * printed in.
 */
export function redactSecretFields(value: string): string {
  return value
    // MCP servers are commonly launched as `npx some-server --token <value>`.
    // The `name=value` rules below never see the space-separated spelling, and
    // a bare `--key=` is not one of their names, so a failed `mcp add` printed
    // the user's token straight into the runtime log and the feedback export.
    .replace(CREDENTIAL_FLAG_IN_TEXT, `$1${REDACTED}`)
    // An Authorization value is `<scheme> <credentials>`. The unquoted rule
    // below stops at the space and would hide only the scheme word, leaving a
    // `Basic` credential (base64 of user:password) readable. A `Bearer` value
    // the shape rules already turned into `[REDACTED]` cannot match again.
    .replace(/(authorization\s*[:=]\s*)[A-Za-z][A-Za-z0-9-]*\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1${REDACTED}`)
    // A Cookie header joins its pairs with `; `, where the unquoted rule below
    // stops, so `Cookie: session=…; refresh=…` would lose only its first pair.
    // Only `name=value` segments are taken, which leaves `Set-Cookie` flags such
    // as `HttpOnly` and the rest of a sentence readable.
    .replace(/(cookies?\s*[:=]\s*)[^\s,;"']+(?:;\s*[^\s,;"'=]+=[^\s,;"']*)+/gi, `$1${REDACTED}`)
    // The quoted spellings need their own rules: in `{"access_token":"…"}` the
    // unquoted rule can never match, because `\s*` does not cross the quote
    // that closes the key name, so any CLI writing JSON to stderr leaked its
    // secrets verbatim into the runtime log and the feedback export. Redacting
    // between the existing quotes also keeps a JSON body parseable.
    .replace(/((?:api[_-]?key|authorization|token|secret|password|cookies?|credentials?)"\s*[:=]\s*)"[^"]*"/gi, `$1"${REDACTED}"`)
    .replace(/((?:api[_-]?key|authorization|token|secret|password|cookies?|credentials?)'\s*[:=]\s*)'[^']*'/gi, `$1'${REDACTED}'`)
    .replace(/((?:api[_-]?key|authorization|token|secret|password|cookies?|credentials?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, `$1${REDACTED}`)
}

/**
 * Credentials carried in a query string. Bare `key=` is included because the
 * Gemini REST API authenticates with `?key=AIza…`.
 */
export function redactSecretQueryParameters(value: string): string {
  return value.replace(/([?&](?:api[_-]?key|key|token)=)[^&\s]+/gi, `$1${REDACTED}`)
}

/**
 * The values an argv hands to credential flags, in both the `--token=value`
 * and the `--token value` spelling. Text rules cannot pair a flag with the
 * value in the next argv element, because every element is redacted on its
 * own; command runners add these to their explicit sensitive values instead,
 * which also hides them wherever the child echoes them back on stdout/stderr.
 */
export function credentialArgumentValues(argv: readonly string[]): string[] {
  const values: string[] = []
  argv.forEach((argument, index) => {
    const assigned = CREDENTIAL_FLAG_ASSIGNMENT.exec(argument)
    if (assigned) values.push(assigned[1])
    const next = argv[index + 1]
    // A following flag means this one took no value (`--auth --verbose`).
    if (next !== undefined && !next.startsWith('-') && CREDENTIAL_FLAG_ARGUMENT.test(argument)) values.push(next)
  })
  return values
}

export function redactSecretPatterns(value: string): string {
  return redactSecretQueryParameters(redactSecretFields(redactSecretShapes(value)))
}
