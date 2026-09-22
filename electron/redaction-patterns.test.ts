import { describe, expect, it } from 'vitest'
import { redactCommandText } from './command-runner'
import { redactCrashText } from './crash-report'
import { redactDiagnosticText } from './diagnostics'
import {
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

  it('does not treat short look-alikes as keys', () => {
    expect(redactSecretShapes('AIzaShort and xai-short and desk-toolbar')).toBe('AIzaShort and xai-short and desk-toolbar')
  })
})

describe('redactSecretFields', () => {
  it('redacts the x-api-key and x-goog-api-key request headers', () => {
    expect(redactSecretFields('x-api-key: plain-fake-value')).toBe('x-api-key: [REDACTED]')
    expect(redactSecretFields('X-Goog-Api-Key: plain-fake-value')).toBe('X-Goog-Api-Key: [REDACTED]')
    expect(redactSecretFields('{"x-api-key":"plain-fake-value"}')).toBe('{"x-api-key":"[REDACTED]"}')
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
  ].join('\n')
  const leaked = [fakeRelayKey, fakeGoogleKey, fakeGrokKey, 'plain-fake-header', 'plain-fake-query']

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
})
