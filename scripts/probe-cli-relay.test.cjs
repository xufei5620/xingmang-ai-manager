const assert = require('node:assert/strict')
const test = require('node:test')

const { classifyProbe, summarize, redact, probeEnvironment, KEY_VARIABLE } = require('./probe-cli-relay.cjs')

test('a request the endpoint rejects is the one verdict that condemns the version', () => {
  // The two regressions this list exists to catch both surfaced exactly like
  // this: the CLI's own request body came back 400 from a third-party base URL.
  assert.equal(classifyProbe({ code: 1, output: 'API Error: 400 {"type":"invalid_request_error"}' }).verdict, 'rejected')
  assert.equal(classifyProbe({ code: 1, output: "Input tag 'advisor_20260301' found using 'type'" }).verdict, 'rejected')
  assert.equal(classifyProbe({ code: 1, output: 'text content blocks must be non-empty' }).verdict, 'rejected')
})

test('a broken probe is reported as a broken probe, not as a broken version', () => {
  assert.equal(classifyProbe({ code: 1, output: 'API Error: 401 authentication_error' }).verdict, 'credential')
  assert.match(classifyProbe({ code: 1, output: '403 permission_error' }).detail, new RegExp(KEY_VARIABLE))
  assert.equal(classifyProbe({ code: 1, output: 'API Error: 429 rate_limit_error' }).verdict, 'quota')
  assert.equal(classifyProbe({ code: 1, output: '余额不足' }).verdict, 'quota')
  assert.equal(classifyProbe({ code: 1, output: 'connect ETIMEDOUT' }).verdict, 'unreachable')
  assert.equal(classifyProbe({ code: 1, output: 'API Error: 503' }).verdict, 'unreachable')
  assert.equal(classifyProbe({ code: 7, output: 'something else entirely' }).verdict, 'unknown')
})

test('a clean exit is the only pass', () => {
  assert.equal(classifyProbe({ code: 0, output: '好' }).verdict, 'ok')
  assert.equal(summarize([{ verdict: 'ok' }, { verdict: 'ok' }]).ok, true)
  assert.equal(summarize([{ verdict: 'ok' }, { verdict: 'rejected' }]).ok, false)
  // An inconclusive probe must not read as a pass: the whole point is that the
  // pin was actually exercised against the relay.
  assert.equal(summarize([{ verdict: 'ok' }, { verdict: 'quota' }]).ok, false)
  assert.equal(summarize([{ verdict: 'unknown' }]).ok, false)
  assert.match(summarize([{ verdict: 'rejected' }]).headline, /不要合入/)
})

test('the key never survives into anything the job prints', () => {
  const secret = 'sk-probe-abcdef'
  assert.equal(redact(`Authorization: Bearer ${secret}`, secret).includes(secret), false)
  assert.match(redact(`x ${secret} y ${secret}`, secret), /^x \*\*\* y \*\*\*$/)
  assert.equal(redact('plain text', ''), 'plain text')
  // Output is bounded before it is redacted, so a runaway CLI cannot flood the
  // job summary with megabytes of (possibly credential-bearing) text.
  assert.ok(redact('a'.repeat(1024 * 1024), secret).length <= 16 * 1024)
})

test('the probe runs the CLI in a narrow environment of its own', () => {
  const environment = probeEnvironment('https://example.invalid', 'sk-probe', '/tmp/home')
  assert.deepEqual(Object.keys(environment).sort(), [
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CI', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'HOME', 'PATH',
  ])
  // A per-site HOME keeps one site's session state from answering for the next
  // one, which would turn the second probe into a no-op.
  assert.equal(environment.HOME, '/tmp/home')
  assert.equal(environment.ANTHROPIC_BASE_URL, 'https://example.invalid')
  assert.equal(environment.ANTHROPIC_API_KEY, undefined)
  assert.equal(environment.HTTPS_PROXY, undefined)
})
