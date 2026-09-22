const assert = require('node:assert/strict')
const test = require('node:test')

const {
  classifyProbe, summarize, redact, probeRunners, codexProbeConfigText, pinnedProviders,
  PROBED_PROVIDERS, KEY_VARIABLE,
} = require('./probe-cli-relay.cjs')

test('a request the endpoint rejects is the one verdict that condemns the version', () => {
  // The three regressions this list exists to catch all surfaced exactly like
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

test('a key that does not cover this tool group reads as a key problem, not a version problem', () => {
  // Every CLI draws its managed key from its own new-api group
  // (catalog.ts's managedCliKeyProfiles). One patrol key scoped to a single
  // group would otherwise condemn the other two tools' pinned versions.
  const groupRefusal = { code: 1, output: '当前分组下对于模型 gpt-6-astra 无可用渠道 (request id: abc)' }
  assert.equal(classifyProbe(groupRefusal).verdict, 'group')
  assert.match(classifyProbe(groupRefusal).detail, new RegExp(KEY_VARIABLE))
  assert.equal(classifyProbe({ code: 1, output: 'no available channel for this group' }).verdict, 'group')
  // The group refusal is usually delivered with a 4xx status, so it has to be
  // classified before the generic 400 branch claims it.
  assert.equal(classifyProbe({ code: 1, output: 'HTTP 400: 当前分组下无可用渠道' }).verdict, 'group')
})

test('a clean exit is the only pass', () => {
  assert.equal(classifyProbe({ code: 0, output: '好' }).verdict, 'ok')
  assert.equal(summarize([{ verdict: 'ok' }, { verdict: 'ok' }]).ok, true)
  assert.equal(summarize([{ verdict: 'ok' }, { verdict: 'rejected' }]).ok, false)
  // An inconclusive probe must not read as a pass: the whole point is that the
  // pin was actually exercised against the relay.
  assert.equal(summarize([{ verdict: 'ok' }, { verdict: 'quota' }]).ok, false)
  assert.equal(summarize([{ verdict: 'ok' }, { verdict: 'group' }]).ok, false)
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

test('every probed CLI has a runner, and each runs the CLI in a narrow environment of its own', () => {
  assert.deepEqual(PROBED_PROVIDERS, ['claude', 'codex', 'gemini'])
  for (const provider of PROBED_PROVIDERS) {
    const runner = probeRunners[provider]
    assert.ok(runner, `${provider} must have a probe runner`)
    const environment = runner.environment('https://example.invalid', 'sk-probe', '/tmp/home')
    // A per-site HOME keeps one site's session state from answering for the
    // next one, which would turn the second probe into a no-op.
    assert.equal(environment.HOME, '/tmp/home')
    assert.equal(environment.PATH, process.env.PATH)
    // Nothing inherited: no proxy, no npm settings, no second credential.
    assert.equal(environment.ANTHROPIC_API_KEY, undefined)
    assert.equal(environment.HTTPS_PROXY, undefined)
    assert.equal(environment.OPENAI_BASE_URL, undefined)
    // The prompt is the only thing the probe asks for, and the key is never
    // one of the arguments: argv is world-readable on a shared host.
    assert.equal(runner.argv('some-model').includes('sk-probe'), false)
  }
})

test('each CLI is pointed at its own relay base URL and told which model to use', () => {
  const site = { providerBaseUrls: { claude: 'https://relay.invalid', codex: 'https://relay.invalid/v1', gemini: 'https://relay.invalid', grok: 'https://relay.invalid/v1' } }
  assert.equal(probeRunners.claude.baseUrlFor(site), 'https://relay.invalid')
  // Codex and Grok carry the /v1 suffix in their base; Claude and Gemini do not.
  assert.equal(probeRunners.codex.baseUrlFor(site), 'https://relay.invalid/v1')
  assert.equal(probeRunners.gemini.baseUrlFor(site), 'https://relay.invalid')

  assert.deepEqual(probeRunners.claude.argv('claude-opus-5').slice(-2), ['--model', 'claude-opus-5'])
  assert.equal(probeRunners.gemini.argv('gemini-3.8-flash-high').includes('gemini-3.8-flash-high'), true)
  // Codex takes its model from config.toml, not argv -- that is the file a
  // customer actually gets, so the probe exercises the same request shape.
  assert.equal(probeRunners.codex.argv('gpt-6-astra').includes('gpt-6-astra'), false)
  assert.equal(probeRunners.codex.argv('gpt-6-astra')[0], 'exec')
  assert.equal(probeRunners.codex.argv('gpt-6-astra').includes('--skip-git-repo-check'), true)
})

test('the Codex config the probe writes is the one a customer gets', () => {
  const text = codexProbeConfigText('https://relay.invalid/v1', 'gpt-6-astra')
  // wire_api and the reasoning fields are what decide the request body, which
  // is the only thing this probe can tell us about. 0.155.0's regression lived
  // exactly there.
  assert.match(text, /wire_api = "responses"/)
  assert.match(text, /requires_openai_auth = true/)
  assert.match(text, /model_reasoning_effort = "xhigh"/)
  assert.match(text, /base_url = "https:\/\/relay\.invalid\/v1"/)
  assert.match(text, /^model = "gpt-6-astra"$/m)
})

test('only the tools the list actually pins are probed', () => {
  const list = {
    claude: { recommended: { version: '2.1.277' }, blocked: [] },
    codex: { recommended: { version: '0.155.1' }, blocked: [] },
    gemini: { recommended: null, blocked: [] },
    grok: { recommended: { version: '9.9.9' }, blocked: [] },
  }
  // grok has no runner, so a pin on it must not enter the probe list.
  assert.deepEqual(pinnedProviders(list), ['claude', 'codex'])
  assert.deepEqual(pinnedProviders({ claude: { recommended: null }, codex: { recommended: null }, gemini: { recommended: null }, grok: { recommended: null } }), [])
})
