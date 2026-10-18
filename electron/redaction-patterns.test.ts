import { describe, expect, it } from 'vitest'
import { redactCommandText } from './command-runner'
import { redactCrashText } from './crash-report'
import { redactDiagnosticText } from './diagnostics'
import {
  credentialArgumentValues,
  maskEmailAddresses,
  redactSecretFields,
  redactSecretPatterns,
  redactSecretQueryParameters,
  redactSecretShapes,
} from './redaction-patterns'
import { redactStartupSecrets } from './startup-log'

// Every value below is invented for the test: the prefixes match the vendor
// formats, the bodies are filler that no vendor ever issued.
const fakeGoogleKey = `AIza${'Fake0Test1Value2Filler3Xy'.padEnd(35, 'z')}`
const fakeGrokKey = `xai-${'FakeGrokTestValueFillerOnly0123456789'}`
const fakeRelayKey = 'sk-fake-relay-test-value'

describe('redactSecretShapes', () => {
  it('redacts a Google API key wherever it appears', () => {
    expect(fakeGoogleKey).toHaveLength(39)
    expect(redactSecretShapes(`gemini failed with ${fakeGoogleKey}.`)).toBe('gemini failed with [REDACTED].')
    expect(redactSecretShapes(`key:${fakeGoogleKey}-`)).toBe('key:[REDACTED]')
  })

  it('redacts a Grok key but leaves the npm package name readable', () => {
    expect(redactSecretShapes(`grok rejected ${fakeGrokKey}`)).toBe('grok rejected [REDACTED]')
    expect(redactSecretShapes('npm install -g @xai-official/grok')).toBe('npm install -g @xai-official/grok')
  })

  it('keeps the existing Bearer and sk- rules, now case-insensitive for sk- everywhere', () => {
    expect(redactSecretShapes(`Authorization: Bearer ${fakeRelayKey}`)).toBe('Authorization: Bearer [REDACTED]')
    expect(redactSecretShapes(`SK-FAKE-UPPER-VALUE`)).toBe('[REDACTED]')
  })

  it('redacts credentials pasted into a Git source URL but keeps the host readable', () => {
    expect(redactSecretShapes('git clone https://fake-user:fake-pass-value@git.example.invalid/acme/demo.git failed'))
      .toBe('git clone https://[REDACTED]@git.example.invalid/acme/demo.git failed')
    expect(redactSecretShapes('git+https://fake-token-only@git.example.invalid/acme/demo'))
      .toBe('git+https://[REDACTED]@git.example.invalid/acme/demo')
    expect(redactSecretShapes('ssh://oauth2:fake-pass-value@git.example.invalid/acme'))
      .toBe('ssh://[REDACTED]@git.example.invalid/acme')
    expect(redactSecretShapes('ssh://git@github.com/acme/demo.git')).toBe('ssh://git@github.com/acme/demo.git')
    expect(redactSecretShapes('https://registry.npmjs.org/@xai-official/grok')).toBe('https://registry.npmjs.org/@xai-official/grok')
  })

  it('redacts GitHub and GitLab access tokens wherever they appear', () => {
    const classic = `ghp_${'FakeClassicTokenFiller0123'}`
    const fineGrained = `github_pat_${'Fake_Fine_Grained_Filler_0123'}`
    const gitlab = `glpat-${'Fake-GitLab-Filler-012345'}`
    expect(redactSecretShapes(`remote rejected ${classic} ${fineGrained} ${gitlab}`))
      .toBe('remote rejected [REDACTED] [REDACTED] [REDACTED]')
    expect(redactSecretShapes('ghp_short github_pat_short')).toBe('ghp_short github_pat_short')
  })

  it('does not treat short look-alikes as keys', () => {
    expect(redactSecretShapes('AIzaShort and xai-short and desk-toolbar')).toBe('AIzaShort and xai-short and desk-toolbar')
  })
})

describe('redactSecretFields', () => {
  it('redacts a two-step login flow token in JSON and key=value form', () => {
    const text = redactSecretFields('{"flow_token":"test-flow-abc"} flow_token=test-flow-abc flowToken: test-flow-abc')
    expect(text).not.toContain('test-flow-abc')
  })
  it('redacts the x-api-key and x-goog-api-key request headers', () => {
    expect(redactSecretFields('x-api-key: plain-fake-value')).toBe('x-api-key: [REDACTED]')
    expect(redactSecretFields('X-Goog-Api-Key: plain-fake-value')).toBe('X-Goog-Api-Key: [REDACTED]')
    expect(redactSecretFields('{"x-api-key":"plain-fake-value"}')).toBe('{"x-api-key":"[REDACTED]"}')
  })

  it('redacts credential flags on a command line in both the spaced and the = spelling', () => {
    expect(redactSecretFields('npx -y some-server --token plain-fake-a --api-key plain-fake-b --key=plain-fake-c'))
      .toBe('npx -y some-server --token [REDACTED] --api-key [REDACTED] --key=[REDACTED]')
    expect(redactSecretFields('server -key plain-fake-a --GitHub-Token "plain fake b" --client_secret=\'plain fake c\''))
      .toBe('server -key [REDACTED] --GitHub-Token [REDACTED] --client_secret=[REDACTED]')
    // `claude mcp list` prints each server as `<name>: <command> <args> - <state>`.
    expect(redactSecretFields('demo: npx some-server --auth plain-fake-a - ✗ Failed to connect'))
      .toBe('demo: npx some-server --auth [REDACTED] - ✗ Failed to connect')
  })

  it('leaves flags that only mention a credential word, and flags followed by another flag, readable', () => {
    for (const text of [
      'codex mcp add demo --url https://mcp.example.invalid --bearer-token-env-var DEMO_TOKEN',
      'electron --password-store=basic',
      'server --auth --verbose',
      "error: unexpected argument '--token' found",
      'npm install --keyboard-layout us',
    ]) {
      expect(redactSecretFields(text)).toBe(text)
    }
  })

  it('redacts the credential of a non-Bearer Authorization header, not just its scheme', () => {
    expect(redactSecretFields('--header Authorization: Basic cGxhaW4tZmFrZTp2YWx1ZQ==')).toBe('--header Authorization: [REDACTED]')
    expect(redactSecretFields('authorization=Token plain-fake-value')).toBe('authorization=[REDACTED]')
    expect(redactSecretPatterns(`Authorization: Bearer ${fakeRelayKey}`)).not.toContain(fakeRelayKey)
  })

  it('redacts cookie and credential values in every spelling the crash reporter already hid', () => {
    expect(redactSecretFields('cookie=plain-fake-a credential: plain-fake-b'))
      .toBe('cookie=[REDACTED] credential: [REDACTED]')
    expect(redactSecretFields('{"refresh_cookie":"plain-fake-a","credentials":"plain-fake-b"}'))
      .toBe('{"refresh_cookie":"[REDACTED]","credentials":"[REDACTED]"}')
    expect(redactSecretFields("{'cookies': 'plain-fake-a', 'credential': 'plain-fake-b'}"))
      .toBe("{'cookies': '[REDACTED]', 'credential': '[REDACTED]'}")
  })

  it('redacts every pair of a Cookie header but leaves Set-Cookie flags and the sentence readable', () => {
    expect(redactSecretFields('Cookie: session=plain-fake-a; refresh=plain-fake-b'))
      .toBe('Cookie: [REDACTED]')
    expect(redactSecretFields('Set-Cookie: sid=plain-fake-a; Path=/; HttpOnly; Secure'))
      .toBe('Set-Cookie: [REDACTED]; HttpOnly; Secure')
    expect(redactSecretFields('cookie=plain-fake-a; then the request failed'))
      .toBe('cookie=[REDACTED]; then the request failed')
  })

  it('leaves names that only contain a cookie or credential word readable', () => {
    for (const text of [
      'git config credential.helper=manager',
      'credentialStore missing, cookie jar empty',
    ]) {
      expect(redactSecretFields(text)).toBe(text)
    }
  })
})

describe('credentialArgumentValues', () => {
  it('pairs each credential flag with the value in the next argv element', () => {
    expect(credentialArgumentValues([
      'mcp', 'add', 'demo', '--env', 'DEMO_MODE=1', '--', 'npx', '-y', 'some-server',
      '--token', 'plain-fake-a', '--key=plain-fake-b', '-api_key', 'plain-fake-c', '--auth', '--verbose',
    ])).toEqual(['plain-fake-a', 'plain-fake-b', 'plain-fake-c'])
  })

  it('ignores a trailing credential flag and flags whose name only contains a credential word', () => {
    expect(credentialArgumentValues(['--bearer-token-env-var', 'DEMO_TOKEN', '--password-store=basic', '--token']))
      .toEqual([])
  })
})

describe('redactSecretQueryParameters', () => {
  it('redacts a bare key= query parameter as Gemini REST sends it', () => {
    expect(redactSecretQueryParameters('GET /v1beta/models?key=plain-fake-value&alt=sse'))
      .toBe('GET /v1beta/models?key=[REDACTED]&alt=sse')
    expect(redactSecretQueryParameters('?a=1&KEY=plain-fake-value')).toBe('?a=1&KEY=[REDACTED]')
  })

  it('leaves parameters that merely end in key alone', () => {
    expect(redactSecretQueryParameters('?cachekey=abc&monkey=1')).toBe('?cachekey=abc&monkey=1')
  })
})

describe('maskEmailAddresses', () => {
  it('keeps the first character and the domain of every address', () => {
    expect(maskEmailAddresses('登录 alice@qq.com 失败，换 Bob.Smith+tag@mail.example.co.uk 试试'))
      .toBe('登录 a***@qq.com 失败，换 B***@mail.example.co.uk 试试')
    expect(maskEmailAddresses('{"email":"x@example.com"}')).toBe('{"email":"x***@example.com"}')
    expect(maskEmailAddresses('联系 a@b.com.')).toBe('联系 a***@b.com.')
  })

  it('leaves npm pins, hosts without a dot and already masked text alone', () => {
    for (const text of [
      'npm install -g @openai/codex@0.130.0-alpha.12 @xai-official/grok@latest @anthropic-ai/claude-code@2.1.302',
      'user@localhost',
      'a***@qq.com',
      '[REDACTED]@git.example.invalid',
    ]) {
      expect(maskEmailAddresses(text)).toBe(text)
    }
  })

  it('scans a long run of address characters without an @ in one pass', () => {
    const blob = 'A'.repeat(200_000)
    const started = performance.now()
    expect(maskEmailAddresses(blob)).toBe(blob)
    // Without the lookbehind this takes most of a minute.
    expect(performance.now() - started).toBeLessThan(1_000)
  })
})

describe('shared redaction table', () => {
  const sample = [
    `Bearer ${fakeRelayKey}`,
    `gemini ${fakeGoogleKey}`,
    `grok ${fakeGrokKey}`,
    'x-goog-api-key: plain-fake-header',
    'https://example.invalid/v1?key=plain-fake-query',
    'https://fake-user:plain-fake-userinfo@git.example.invalid/acme/demo.git',
  ].join('\n')
  const leaked = [fakeRelayKey, fakeGoogleKey, fakeGrokKey, 'plain-fake-header', 'plain-fake-query', 'plain-fake-userinfo']

  it.each([
    ['redactSecretPatterns', (value: string) => redactSecretPatterns(value)],
    ['redactCommandText', (value: string) => redactCommandText(value)],
    ['redactStartupSecrets', (value: string) => redactStartupSecrets(value)],
    ['redactDiagnosticText', (value: string) => redactDiagnosticText(value)],
    ['redactCrashText', (value: string) => redactCrashText(value, '/home/fake-user')],
  ])('%s hides every known key shape', (_name, redact) => {
    const result = redact(sample)
    for (const secret of leaked) expect(result).not.toContain(secret)
  })

  // A pasted MCP launch line reaches the runtime log, the feedback export and
  // the diagnostics export through these four; crash reports carry stack
  // traces, not command lines.
  it.each([
    ['redactSecretPatterns', (value: string) => redactSecretPatterns(value)],
    ['redactCommandText', (value: string) => redactCommandText(value)],
    ['redactStartupSecrets', (value: string) => redactStartupSecrets(value)],
    ['redactDiagnosticText', (value: string) => redactDiagnosticText(value)],
  ])('%s hides credentials named only by their command-line flag', (_name, redact) => {
    const result = redact('npx some-server --token plain-fake-flag --key=plain-fake-assigned\nAuthorization: Basic plain-fake-basic')
    for (const secret of ['plain-fake-flag', 'plain-fake-assigned', 'plain-fake-basic']) expect(result).not.toContain(secret)
  })

  // The crash reporter hid these two names long before the other four did.
  it.each([
    ['redactSecretPatterns', (value: string) => redactSecretPatterns(value)],
    ['redactCommandText', (value: string) => redactCommandText(value)],
    ['redactStartupSecrets', (value: string) => redactStartupSecrets(value)],
    ['redactDiagnosticText', (value: string) => redactDiagnosticText(value)],
    ['redactCrashText', (value: string) => redactCrashText(value, '/home/fake-user')],
  ])('%s hides cookie and credential values', (_name, redact) => {
    const result = redact('cookie=plain-fake-cookie {"credential":"plain-fake-credential"}')
    for (const secret of ['plain-fake-cookie', 'plain-fake-credential']) expect(result).not.toContain(secret)
  })
})
