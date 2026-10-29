// @renderer-importable: bundled into the renderer, so no Node or Electron here or in what it value-imports (I6).

// The one table of secret shapes that every log, diagnostics, crash and
// feedback redactor applies. It must stay free of imports: startup-log and
// crash-report redact while recording a failure of some other module, so the
// table cannot drag in anything that could itself be what failed.

const REDACTED = '[REDACTED]'

// Word characters plus `-`, the alphabet every relay/vendor key below uses. A
// trailing `\b` would stop short of a key ending in `-` and leak its tail.
const KEY_TAIL = '(?![A-Za-z0-9_-])'

// URL userinfo that carries a password, on any scheme. The scheme always runs
// to the end of its run of scheme characters (none of them is the `:` of
// `://`), so a match starts where that run starts and reads it once. A `\b` in
// front let every letter after a `-`, `.` or `+` start a match and read the
// rest of the run again, which is quadratic in a long base64url or kebab-case
// run. The lookahead keeps what that rule reached: a run counts only if a
// letter opens it at a word boundary or follows a `-`, `.` or `+` in it, where
// `\b[a-z]` could start; the part in front of that letter is kept in `$1`.
const URL_USERINFO_WITH_PASSWORD = /(?<![a-z0-9+.-])(?=\b[a-z]|[a-z0-9+.-]*?[+.-][a-z])([a-z0-9+.-]+:\/\/)[^\s/?#@:]*:[^\s/?#@]*@/gi

// A JWT is three base64url segments. The first is a JSON header, and `{"`
// followed by a letter always encodes to `eyJ`; the header has to name its
// `alg`, so even `{"alg":"none"}` runs past the floor of ten after `eyJ`.
// The lookbehind lets a match start only where a token can start: a long
// base64url run with `-eyJ` all through it (a blob in a log detail) is then
// scanned once, not once per occurrence.
const JSON_WEB_TOKEN = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g

// Cloud access key IDs: AWS long-term `AKIA` and temporary `ASIA` (always 20
// characters), Alibaba Cloud `LTAI`, Tencent Cloud `AKID` (36 characters). The
// secret that goes with each is printed under a name (`aws_secret_access_key`,
// `AccessKeySecret`) and is the field rules' job; the ID is what Codex reads out
// of `~/.aws/credentials` or a `.env` as `aws_access_key_id = AKIA…`, a name
// those rules rightly leave alone.
const CLOUD_ACCESS_KEY_ID = /\b(?:(?:AKIA|ASIA)[A-Z0-9]{16}|LTAI[A-Za-z0-9]{12,20}|AKID[A-Za-z0-9]{32})\b/g

// `RSA`, `EC`, `OPENSSH`, `ENCRYPTED`, and PGP's `PRIVATE KEY BLOCK`.
const PRIVATE_KEY_BEGIN = /-----BEGIN ((?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?)-----/g

/**
 * Hides the body of every PEM private key block. The END line has to carry the
 * same label as the BEGIN line, so two blocks in one text are hidden one by one
 * rather than everything between the first and the last. A BEGIN line with no
 * END line of its own label after it means the text was cut off inside the key,
 * so everything from there on is key material, including any other block's END
 * line further down. One forward scan: a regex that searched for the END line
 * from every BEGIN line again would reread the rest of the text once per BEGIN
 * line, and a log that quotes a key file a few hundred times is not rare.
 */
function redactPrivateKeyBlocks(value: string): string {
  let output = ''
  let cursor = 0
  for (const begin of value.matchAll(PRIVATE_KEY_BEGIN)) {
    // A BEGIN line inside a body that is already hidden.
    if (begin.index < cursor) continue
    const bodyStart = begin.index + begin[0].length
    output += `${value.slice(cursor, bodyStart)}\n${REDACTED}`
    const end = `-----END ${begin[1]}-----`
    const endIndex = value.indexOf(end, bodyStart)
    if (endIndex === -1) return output
    output += `\n${end}`
    cursor = endIndex + end.length
  }
  return cursor === 0 ? value : output + value.slice(cursor)
}

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
 * - PEM private key blocks (`-----BEGIN … PRIVATE KEY-----` through the
 *   matching END line, or to the end of the text when the END line was cut
 *   off): Codex reads `~/.ssh` or a `.pem` on request and its answer goes to
 *   the phone (YK-4). The BEGIN/END lines stay so the reader knows what it was.
 * - JWTs (`eyJ…` header, payload, signature): a website login token, read out
 *   of a browser profile or a CLI's cache on request, is a login wherever it is
 *   printed (#1407 P2-4).
 * - Cloud access key IDs (`AKIA…`, `ASIA…`, `LTAI…`, `AKID…`), for the same
 *   reason.
 */
export function redactSecretShapes(value: string): string {
  return redactPrivateKeyBlocks(value)
    .replace(/\b(https?:\/\/)[^\s/?#@]+@/gi, `$1${REDACTED}@`)
    .replace(URL_USERINFO_WITH_PASSWORD, `$1${REDACTED}@`)
    .replace(new RegExp(`\\bgh[pousr]_[A-Za-z0-9]{20,}${KEY_TAIL}`, 'g'), REDACTED)
    .replace(new RegExp(`\\bgithub_pat_[A-Za-z0-9_]{20,}${KEY_TAIL}`, 'g'), REDACTED)
    .replace(new RegExp(`\\bglpat-[A-Za-z0-9_-]{20,}${KEY_TAIL}`, 'g'), REDACTED)
    .replace(JSON_WEB_TOKEN, REDACTED)
    .replace(CLOUD_ACCESS_KEY_ID, REDACTED)
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

// The names a value is recognised by (the crash reporter builds its own rule
// from this list, with a wider value alphabet). None is anchored at the start of the
// name, so `flow_token`, `MY_APP_SECRET` and `x-api-key` all match. A name that
// ends in `key` needs at least one segment in front of it
// (`AWS_SECRET_ACCESS_KEY`, `PRIVATE_KEY`, `ssh-key`, as `.env` files spell
// them): a bare `key=` names an installation queue entry in the runtime log and
// has to stay readable, and `keyboard`, `max_tokens`, `password_hash_rounds`
// never end on the word. The lookbehind lets that alternative start only where
// a name starts: without it a long run of letters (a base64 blob, an 8 KB
// filler value in a log detail) is rescanned from every position in it, which
// is quadratic and timed out the runtime log's oversized-detail test.
export const SECRET_FIELD_NAME = '(?:api[_-]?key|(?<![a-z0-9_-])(?:[a-z0-9]+[_-])+key|authorization|token|secret|password|passwd|cookies?|credentials?)'
const DOUBLE_QUOTED_SECRET_FIELD = new RegExp(`(${SECRET_FIELD_NAME}"\\s*[:=]\\s*)"[^"]*"`, 'gi')
const SINGLE_QUOTED_SECRET_FIELD = new RegExp(`(${SECRET_FIELD_NAME}'\\s*[:=]\\s*)'[^']*'`, 'gi')
const SECRET_FIELD = new RegExp(`(${SECRET_FIELD_NAME}\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;]+)`, 'gi')

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
    .replace(DOUBLE_QUOTED_SECRET_FIELD, `$1"${REDACTED}"`)
    .replace(SINGLE_QUOTED_SECRET_FIELD, `$1'${REDACTED}'`)
    .replace(SECRET_FIELD, `$1${REDACTED}`)
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

// The address shape the crash reporter hides. The lookbehind lets a match start
// only where a local part can start, so a long run of address characters with
// no `@` in it (a base64 blob in a log line) is scanned once rather than once
// per position. The domain has to end on a letters-only label, which keeps npm
// pins such as `@openai/codex@0.130.0-alpha.12` readable.
const EMAIL_ADDRESS = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})(?![A-Za-z0-9_-])/g

/**
 * Half-hides email addresses: `alice@qq.com` becomes `a***@qq.com`. Support can
 * still match a feedback report to the customer by asking for the address,
 * while the report itself no longer carries it whole. Only the runtime log and
 * the feedback exports apply this; the crash reporter hides the whole address,
 * and nothing on screen is masked.
 */
export function maskEmailAddresses(value: string): string {
  return value.replace(EMAIL_ADDRESS, '$1***@$2')
}
