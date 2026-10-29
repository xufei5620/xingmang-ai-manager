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
// Built at run time so no whole token sits in the source for a scanner to flag.
const fakeJwt = [
  Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
  Buffer.from('{"sub":"fake-test-user","exp":1}').toString('base64url'),
  'fake-signature_filler-0123',
].join('.')
const fakeAwsKeyId = `AKIA${'FAKE0TEST1FILLER'}`
const fakeAwsTemporaryKeyId = `ASIA${'FAKE0TEST1FILLER'}`
const fakeAliyunKeyId = `LTAI${'Fake0Test1Filler2345'}`
const fakeTencentKeyId = `AKID${'Fake0Test1Filler2Only3Value4567'.padEnd(32, 'z')}`

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

  // Why this is safe to widen: the rule only ever adds redaction, and the BEGIN
  // and END lines are kept so a reader still sees that a key was there.
  it('redacts a PEM private key block, each block on its own, and one cut off before its END line', () => {
    const block = (label: string, body: string) => `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`
    const text = `cat ~/.ssh/id_ed25519\n${block('OPENSSH PRIVATE KEY', 'b3BlbnNzaC1rZXktdjEAAAAA\nfake-openssh-body')}\nand ${block('RSA PRIVATE KEY', 'MIIEfake-rsa-body')}\n${block('PUBLIC KEY', 'MFkwfake-public')}`
    expect(redactSecretShapes(text))
      .toBe(`cat ~/.ssh/id_ed25519\n${block('OPENSSH PRIVATE KEY', '[REDACTED]')}\nand ${block('RSA PRIVATE KEY', '[REDACTED]')}\n${block('PUBLIC KEY', 'MFkwfake-public')}`)
    expect(redactSecretShapes('-----BEGIN EC PRIVATE KEY-----\r\nfake-ec-body\r\n-----END EC PRIVATE KEY-----\r\n'))
      .toBe('-----BEGIN EC PRIVATE KEY-----\n[REDACTED]\n-----END EC PRIVATE KEY-----\r\n')
    expect(redactSecretShapes('-----BEGIN PGP PRIVATE KEY BLOCK-----\nfake-pgp-body cut off here'))
      .toBe('-----BEGIN PGP PRIVATE KEY BLOCK-----\n[REDACTED]')
  })

  // The END line of another block does not close a key that was cut off: the
  // RSA material between the two BEGIN lines is still key material.
  it('hides a cut-off private key to the end even when another block ends further down', () => {
    const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIEfake-rsa-cut-off\n-----BEGIN OPENSSH PRIVATE KEY-----\nfake-openssh-body\n-----END OPENSSH PRIVATE KEY-----\nafter'
    expect(redactSecretShapes(text)).toBe('-----BEGIN RSA PRIVATE KEY-----\n[REDACTED]')
  })

  // One forward scan: the earlier regex searched for the END line again from
  // every BEGIN line, which is quadratic once a log quotes a key file many times
  // (20 000 cut-off BEGIN lines took it about ten seconds).
  it('hides thousands of key blocks in one pass', () => {
    const body = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='.repeat(12)
    const cutOff = Array.from({ length: 20_000 }, () => `-----BEGIN RSA PRIVATE KEY-----\n${body}`).join('\n')
    const complete = Array.from({ length: 2_000 }, (_, index) => `-----BEGIN EC PRIVATE KEY-----\n${body}\n-----END EC PRIVATE KEY-----\nline ${index}`).join('\n')
    const started = performance.now()
    expect(redactSecretShapes(cutOff)).toBe('-----BEGIN RSA PRIVATE KEY-----\n[REDACTED]')
    expect(redactSecretShapes(complete)).toBe(Array.from({ length: 2_000 }, (_, index) => `-----BEGIN EC PRIVATE KEY-----\n[REDACTED]\n-----END EC PRIVATE KEY-----\nline ${index}`).join('\n'))
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('does not treat short look-alikes as keys', () => {
    expect(redactSecretShapes('AIzaShort and xai-short and desk-toolbar')).toBe('AIzaShort and xai-short and desk-toolbar')
  })

  // A website login token Codex reads out of a browser profile or a CLI cache
  // goes to the phone (#1407 P2-4). Why this is safe to widen: it only adds
  // redaction, and nothing but a JSON header encodes to `eyJ` followed by two
  // more dotted segments.
  it('redacts a JWT wherever it appears', () => {
    expect(fakeJwt.startsWith('eyJ')).toBe(true)
    expect(redactSecretShapes(`cached login ${fakeJwt}, expires soon`)).toBe('cached login [REDACTED], expires soon')
    expect(redactSecretShapes(`{"session":"${fakeJwt}"}`)).toBe('{"session":"[REDACTED]"}')
    expect(redactSecretShapes(`https://app.example.invalid/callback#id=${fakeJwt}&state=1`))
      .toBe('https://app.example.invalid/callback#id=[REDACTED]&state=1')
    expect(redactSecretShapes(`Authorization: Bearer ${fakeJwt}`)).toBe('Authorization: Bearer [REDACTED]')
  })

  it('leaves base64 that is not a whole JWT readable', () => {
    const header = Buffer.from('{"alg":"HS256"}').toString('base64url')
    for (const text of [
      `${header}.only-two-segments`,
      `${header}..empty-payload`,
      'eyJshort.a.b',
      `prefix${header}.payload.signature`,
    ]) {
      expect(redactSecretShapes(text)).toBe(text)
    }
  })

  // Only the first `eyJ` of a base64url run may start a match. A `\b` in front
  // would let every `-eyJ` start one and read the rest of the run again; the
  // `_` keeps the URL userinfo rule's own scans short, so this times the JWT
  // rule alone.
  it('scans a long base64url run full of eyJ in linear time', () => {
    const run = `-${'eyJabcdefghijklmnop_-'.repeat(200_000)}`
    const started = performance.now()
    expect(redactSecretShapes(run)).toBe(run)
    expect(performance.now() - started).toBeLessThan(2_000)
  })

  it('redacts AWS, Alibaba Cloud and Tencent Cloud access key IDs', () => {
    expect(fakeAwsKeyId).toHaveLength(20)
    expect(fakeTencentKeyId).toHaveLength(36)
    expect(redactSecretShapes(`aws_access_key_id = ${fakeAwsKeyId}\naws_access_key_id=${fakeAwsTemporaryKeyId}`))
      .toBe('aws_access_key_id = [REDACTED]\naws_access_key_id=[REDACTED]')
    expect(redactSecretShapes(`{"AccessKeyId":"${fakeAliyunKeyId}","SecretId":"${fakeTencentKeyId}"}`))
      .toBe('{"AccessKeyId":"[REDACTED]","SecretId":"[REDACTED]"}')
  })

  it('leaves words and URLs that only start like a cloud key ID readable', () => {
    for (const text of [
      'AKIA alone, AKIAFAKESHORT, ASIA-Pacific region, LTAIshort',
      `${fakeAwsKeyId}X`,
      'X-Amz-Credential=AKIA%2F20261018%2Fus-east-1%2Fs3%2Faws4_request',
    ]) {
      expect(redactSecretShapes(text)).toBe(text)
    }
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

  // `.env` and `export` lines Codex reads on request end up on the phone (YK-4).
  // Why this is safe to widen: it only adds redaction, and a name has to carry a
  // segment in front of `key`, so the bare `key=` the runtime log uses for an
  // installation queue entry is untouched.
  it('redacts .env style names that end in _KEY, and passwd=, in every spelling', () => {
    expect(redactSecretFields('AWS_SECRET_ACCESS_KEY="plain-fake-a" PRIVATE_KEY=plain-fake-b ssh-key: plain-fake-c passwd=plain-fake-d'))
      .toBe('AWS_SECRET_ACCESS_KEY=[REDACTED] PRIVATE_KEY=[REDACTED] ssh-key: [REDACTED] passwd=[REDACTED]')
    expect(redactSecretFields('{"signing_key":"plain-fake-a","passwd":"plain-fake-b"}')).toBe('{"signing_key":"[REDACTED]","passwd":"[REDACTED]"}')
    expect(redactSecretFields("{'license-key': 'plain-fake-a'}")).toBe("{'license-key': '[REDACTED]'}")
  })

  it('leaves a bare key=, camelCase names and words that merely contain key readable', () => {
    for (const text of [
      'install.queued key=claude',
      '{"queueKey":"codex","primaryKey":"id"}',
      'keyboard=us max_tokens=4096 password_hash_rounds=12 secretary: alice tokens: 12',
      'cat /etc/passwd',
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

  // A `.env` or `~/.ssh` file Codex reads reaches the phone through
  // redactRemoteText, which sits on redactSecretPatterns; the logs and exports
  // get the same text when the answer is logged.
  it.each([
    ['redactSecretPatterns', (value: string) => redactSecretPatterns(value)],
    ['redactCommandText', (value: string) => redactCommandText(value)],
    ['redactStartupSecrets', (value: string) => redactStartupSecrets(value)],
    ['redactDiagnosticText', (value: string) => redactDiagnosticText(value)],
    ['redactCrashText', (value: string) => redactCrashText(value, '/home/fake-user')],
  ])('%s hides private key blocks and .env style key names', (_name, redact) => {
    const result = redact('-----BEGIN RSA PRIVATE KEY-----\nplain-fake-pem\n-----END RSA PRIVATE KEY-----\nAWS_SECRET_ACCESS_KEY=plain-fake-env')
    for (const secret of ['plain-fake-pem', 'plain-fake-env']) expect(result).not.toContain(secret)
  })

  it.each([
    ['redactSecretPatterns', (value: string) => redactSecretPatterns(value)],
    ['redactCommandText', (value: string) => redactCommandText(value)],
    ['redactStartupSecrets', (value: string) => redactStartupSecrets(value)],
    ['redactDiagnosticText', (value: string) => redactDiagnosticText(value)],
    ['redactCrashText', (value: string) => redactCrashText(value, '/home/fake-user')],
  ])('%s hides a bare JWT and cloud access key IDs', (_name, redact) => {
    const result = redact(`login ${fakeJwt}\naws_access_key_id = ${fakeAwsKeyId} ${fakeAliyunKeyId} ${fakeTencentKeyId}`)
    for (const secret of [fakeJwt.split('.')[1], fakeAwsKeyId, fakeAliyunKeyId, fakeTencentKeyId]) expect(result).not.toContain(secret)
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
