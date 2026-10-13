import { describe, expect, it } from 'vitest'
import { redactCommandText } from './command-runner'
import { redactCrashText } from './crash-report'
import { redactDiagnosticText } from './diagnostics'
import {
  credentialArgumentValues,
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
})
