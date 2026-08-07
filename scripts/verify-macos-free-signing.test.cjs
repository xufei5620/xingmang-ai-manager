const assert = require('node:assert/strict')
const test = require('node:test')
const { verifyFreeMacSigningIdentity } = require('./verify-macos-free-signing.cjs')

function healthyOptions(overrides = {}) {
  return {
    identityName: 'XingMang Free Update Identity',
    expectedFingerprint: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
    now: new Date('2026-08-03T00:00:00Z'),
    runSecurity: (args) => {
      if (args[0] === 'find-certificate') return '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n'
      if (args[0] === 'find-identity') return '  1) 11AA22BB33CC44DD55EE66FF77889900AABBCCDD "XingMang Free Update Identity"\n     1 valid identities found\n'
      throw new Error(`Unexpected security command: ${args.join(' ')}`)
    },
    runOpenSsl: (args) => {
      if (args.includes('-fingerprint') && args.includes('-sha256')) return 'sha256 Fingerprint=AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99\n'
      if (args.includes('-fingerprint') && args.includes('-sha1')) return 'sha1 Fingerprint=11:AA:22:BB:33:CC:44:DD:55:EE:66:FF:77:88:99:00:AA:BB:CC:DD\n'
      if (args.includes('-subject')) return 'subject=CN=XingMang Free Update Identity\nissuer=CN=XingMang Free Update Identity\n'
      if (args.includes('-startdate')) return 'notBefore=Aug  1 00:00:00 2026 GMT\nnotAfter=Jul 28 00:00:00 2046 GMT\n'
      if (args.includes('-text')) return 'X509v3 Extended Key Usage: critical\n    Code Signing\n'
      if (args[0] === 'verify') return 'certificate: OK\n'
      throw new Error(`Unexpected OpenSSL command: ${args.join(' ')}`)
    },
    ...overrides,
  }
}

test('signing preflight accepts only the configured available self-signed code-signing identity', () => {
  const result = verifyFreeMacSigningIdentity(healthyOptions())
  assert.equal(result.fingerprint, 'AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899')
  assert.equal(result.identityName, 'XingMang Free Update Identity')
})

test('signing preflight passes its explicit environment to every default security and openssl process', () => {
  const calls = []
  const env = {
    CSC_NAME: 'XingMang Free Update Identity',
    XINGMANG_MAC_SIGNING_SHA256: 'AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899',
    CSC_LINK: undefined,
    APPLE_API_KEY: undefined,
    AZURE_CLIENT_SECRET: undefined,
  }
  const expected = healthyOptions()
  const result = verifyFreeMacSigningIdentity({
    env,
    now: expected.now,
    spawnSync: (executable, args, options) => {
      calls.push({ executable, args, options })
      const output = executable === '/usr/bin/security'
        ? expected.runSecurity(args)
        : expected.runOpenSsl(args)
      return { status: 0, stdout: output, stderr: '' }
    },
  })

  assert.equal(result.identityName, env.CSC_NAME)
  assert.equal(result.fingerprint, env.XINGMANG_MAC_SIGNING_SHA256)
  assert.ok(calls.length > 0)
  for (const call of calls) {
    assert.ok(['/usr/bin/security', '/usr/bin/openssl'].includes(call.executable))
    assert.equal(call.options.env, env)
    assert.equal(call.options.shell, false)
    assert.equal(call.options.timeout, 30_000)
  }
  assert.deepEqual(
    calls.filter((call) => call.executable === '/usr/bin/security').map((call) => call.args[0]),
    ['find-certificate', 'find-identity'],
  )
  const verifyCall = calls.find((call) => call.args[0] === 'verify')
  assert.ok(verifyCall)
  assert.ok(verifyCall.args.includes('-check_ss_sig'))
  assert.equal(verifyCall.args.includes('-check_ssig'), false)
})

test('signing preflight rejects a different certificate with the same CN', () => {
  assert.throws(() => verifyFreeMacSigningIdentity(healthyOptions({ expectedFingerprint: 'FF:EE:DD:CC:BB:AA:99:88:77:66:55:44:33:22:11:00:FF:EE:DD:CC:BB:AA:99:88:77:66:55:44:33:22:11:00' })), /指纹/)
})

test('signing preflight fails closed for missing identity, invalid certificate properties, and unavailable private key', () => {
  assert.throws(() => verifyFreeMacSigningIdentity(healthyOptions({ identityName: '' })), /CSC_NAME/)
  assert.throws(() => verifyFreeMacSigningIdentity(healthyOptions({ expectedFingerprint: 'not a fingerprint' })), /SHA-256/)
  assert.throws(() => verifyFreeMacSigningIdentity(healthyOptions({
    runOpenSsl: (args) => args.includes('-subject')
      ? 'subject=CN=one\nissuer=CN=another\n'
      : healthyOptions().runOpenSsl(args),
  })), /自签/)
  assert.throws(() => verifyFreeMacSigningIdentity(healthyOptions({
    runOpenSsl: (args) => args.includes('-text') ? 'X509v3 Extended Key Usage:\n    TLS Web Server Authentication\n' : healthyOptions().runOpenSsl(args),
  })), /codeSigning/)
  assert.throws(() => verifyFreeMacSigningIdentity(healthyOptions({
    runSecurity: (args) => args[0] === 'find-certificate'
      ? healthyOptions().runSecurity(args)
      : '     0 valid identities found\n',
  })), /私钥/)
})

test('signing preflight accepts only plain or fully colon-separated SHA-256 input', () => {
  const fingerprint = 'AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899'
  assert.equal(verifyFreeMacSigningIdentity(healthyOptions({ expectedFingerprint: fingerprint })).fingerprint, fingerprint)
  for (const invalid of [
    `[${fingerprint}]`,
    ` ${fingerprint.slice(0, 2)}:${fingerprint.slice(2)} `,
    `${fingerprint.slice(0, 63)}-`,
  ]) {
    assert.throws(
      () => verifyFreeMacSigningIdentity(healthyOptions({ expectedFingerprint: invalid })),
      /SHA-256/,
    )
  }
})

test('signing preflight parses only a critical codeSigning EKU with no unrelated usage', () => {
  for (const text of [
    [
      'Certificate:',
      '    Subject: CN=Code Signing',
      '    Issuer: CN=Code Signing',
      '    X509v3 extensions:',
      '        X509v3 Extended Key Usage: critical',
      '            TLS Web Server Authentication',
    ].join('\n'),
    '        X509v3 Extended Key Usage:\n            Code Signing\n',
    '        X509v3 Extended Key Usage: critical\n            Code Signing, TLS Web Client Authentication\n',
  ]) {
    assert.throws(() => verifyFreeMacSigningIdentity(healthyOptions({
      runOpenSsl: (args) => args.includes('-text') ? text : healthyOptions().runOpenSsl(args),
    })), /codeSigning/)
  }
})

test('signing preflight rejects exact-name, substring, and multiple-match identity ambiguity', () => {
  const matching = '11AA22BB33CC44DD55EE66FF77889900AABBCCDD'
  const other = 'FFEEDDCCBBAA0099887766554433221100AABBCC'
  const cases = [
    `  1) ${matching} "Different Identity"\n     1 valid identities found\n`,
    `  1) ${matching} "Prefix XingMang Free Update Identity Suffix"\n     1 valid identities found\n`,
    `  1) ${other} "Prefix XingMang Free Update Identity Suffix"\n  2) ${matching} "XingMang Free Update Identity"\n     2 valid identities found\n`,
    `  1) ${matching} "XingMang Free Update Identity"\n  2) ${other} "XingMang Free Update Identity"\n     2 valid identities found\n`,
  ]

  for (const identities of cases) {
    assert.throws(() => verifyFreeMacSigningIdentity(healthyOptions({
      runSecurity: (args) => args[0] === 'find-certificate'
        ? healthyOptions().runSecurity(args)
        : identities,
    })), /身份|私钥|歧义|精确/)
  }
})

test('signing preflight rejects invalid self-signatures and certificates outside their validity window', () => {
  assert.throws(() => verifyFreeMacSigningIdentity(healthyOptions({
    runOpenSsl: (args) => args[0] === 'verify'
      ? (() => { throw new Error('invalid self-signature') })()
      : healthyOptions().runOpenSsl(args),
  })), /invalid self-signature/)
  assert.throws(() => verifyFreeMacSigningIdentity(healthyOptions({
    runOpenSsl: (args) => args.includes('-startdate')
      ? 'notBefore=Aug  1 00:00:00 2020 GMT\nnotAfter=Jul 28 00:00:00 2021 GMT\n'
      : healthyOptions().runOpenSsl(args),
  })), /过期/)
  assert.throws(() => verifyFreeMacSigningIdentity(healthyOptions({
    runOpenSsl: (args) => args.includes('-startdate')
      ? 'notBefore=Aug  1 00:00:00 2030 GMT\nnotAfter=Jul 28 00:00:00 2046 GMT\n'
      : healthyOptions().runOpenSsl(args),
  })), /尚未生效/)
})
