const assert = require('node:assert/strict')
const test = require('node:test')
const {
  assertNonIssuingSigningCertificate,
  assertSigningCertificateTeamIdentifier,
  verifyCertificateSelfSignature,
  verifyFreeMacSigningIdentity,
} = require('./verify-macos-free-signing.cjs')
const { SIGNING_TEAM_IDENTIFIER } = require('./create-macos-free-signing-certificate.cjs')

// A real certificate carrying the generator's key, validity and extension
// profile, and the same bytes with the last byte of its signature flipped.
// Its subject predates the team identifier, which is asserted separately
// against subject text rather than against these bytes.
const SELF_SIGNED_CERTIFICATE_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'MIIEVjCCAr6gAwIBAgIUV1m2VTe1ocMhf1Aksp54k8zggPMwDQYJKoZIhvcNAQEL',
  'BQAwKDEmMCQGA1UEAwwdWGluZ01hbmcgRnJlZSBVcGRhdGUgSWRlbnRpdHkwHhcN',
  'MjYwOTE5MDUxMDI3WhcNMzYwOTE2MDUxMDI3WjAoMSYwJAYDVQQDDB1YaW5nTWFu',
  'ZyBGcmVlIFVwZGF0ZSBJZGVudGl0eTCCAaIwDQYJKoZIhvcNAQEBBQADggGPADCC',
  'AYoCggGBANrz0ecTcA8OJR1nMnBCWjwhl52A/wF7lKOnrS/iKg5K1EBNNGFszqZu',
  'J0ZDirQ7nnPx02SYub+Y+ljoh8tEn9cwus8qp1blyHuHawOXF95QKDaHHAMNhque',
  'OkJBiF23qpIefloUv/l5OIiiadyOs8mYcy8C/g2/ZEKhYGr+qlfr6U3Wt/djG+0B',
  'GDa+5wuE22ZU81lle3EwgHz07Oro9Or+K81tPsoTANmddV12M8Ht2CzjL9NZ1fVJ',
  'F3bDNXokgVIv16bVGGgVroBlXo6Xz9xjqjNkiYn8Mv8qBY3UKtkI4TVWZgdCbPd1',
  'Bw4f0VZOSLRlDlGwBs/tsYWzPppPmlh29DMdgRbhzyBAniB3wSh8jY9kgw/aMqaC',
  'mvde9JoZP5BVvSCjHPZk0CXT+ua6aSJEA0gWrvQUa0cBSDNPeu9C5N/f7dstwjky',
  '9zBrF2hWAQCMXsEzVYjb/T0pn7A0++Mk8ifRFpXxU1xDeOyJo4Jl87ba49nikDIR',
  '1UXZTKsMvQIDAQABo3gwdjAdBgNVHQ4EFgQUzMAPNZH0y4nP8HugEDmGBBLqHVEw',
  'HwYDVR0jBBgwFoAUzMAPNZH0y4nP8HugEDmGBBLqHVEwDAYDVR0TAQH/BAIwADAO',
  'BgNVHQ8BAf8EBAMCB4AwFgYDVR0lAQH/BAwwCgYIKwYBBQUHAwMwDQYJKoZIhvcN',
  'AQELBQADggGBAHex4UaiPlofYhLjiLJ+Be7UQ6i0lj6CMZnk7XuDG85jTqTOE6QJ',
  'w/B9eb18gs5UVDDG6URlr8eA8o99bK/IrwEzXf1gPiHOOSaMVxTAmHGsmNo7tp6i',
  'qdLmsGiTbhlZq0AlKUePk0hSmRnul9RE2nIm4vq8OeQ61BMgvPzOzyNzGIBX0ziF',
  '/Feh2qOT4nM7SOxMf7Vsx+od9dG1VhlroMS6HOZIktrgeFhl0UhwDeKwudwa10Ai',
  'Vsv5iF8kTXnmyxIguxhzX0hDuEo7EPvDgKTqZoaMIlJ2oxg8XSy6n6vvzD5kC8sL',
  '2Rt/WPYE/PwKZ2Db8Tsi5QtIbTx/z7uaPdjPRAEfMEnIewDfqdDN/4E8dUmDIWY7',
  'kfpUNAv406qS+ev0SopzGU5adh17WLz+KN3DDlR80vgvOjkArTn0VW9OLNbVi2zd',
  '9HnrwGtjvCb509xnBWNx71vMTOYDnqqUOBz46T0kgsCioB2HG1C+8AWWcVtjl1DK',
  'UmjDwLX8lWOJVw==',
  '-----END CERTIFICATE-----',
].join('\n')

const TAMPERED_CERTIFICATE_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'MIIEVjCCAr6gAwIBAgIUV1m2VTe1ocMhf1Aksp54k8zggPMwDQYJKoZIhvcNAQEL',
  'BQAwKDEmMCQGA1UEAwwdWGluZ01hbmcgRnJlZSBVcGRhdGUgSWRlbnRpdHkwHhcN',
  'MjYwOTE5MDUxMDI3WhcNMzYwOTE2MDUxMDI3WjAoMSYwJAYDVQQDDB1YaW5nTWFu',
  'ZyBGcmVlIFVwZGF0ZSBJZGVudGl0eTCCAaIwDQYJKoZIhvcNAQEBBQADggGPADCC',
  'AYoCggGBANrz0ecTcA8OJR1nMnBCWjwhl52A/wF7lKOnrS/iKg5K1EBNNGFszqZu',
  'J0ZDirQ7nnPx02SYub+Y+ljoh8tEn9cwus8qp1blyHuHawOXF95QKDaHHAMNhque',
  'OkJBiF23qpIefloUv/l5OIiiadyOs8mYcy8C/g2/ZEKhYGr+qlfr6U3Wt/djG+0B',
  'GDa+5wuE22ZU81lle3EwgHz07Oro9Or+K81tPsoTANmddV12M8Ht2CzjL9NZ1fVJ',
  'F3bDNXokgVIv16bVGGgVroBlXo6Xz9xjqjNkiYn8Mv8qBY3UKtkI4TVWZgdCbPd1',
  'Bw4f0VZOSLRlDlGwBs/tsYWzPppPmlh29DMdgRbhzyBAniB3wSh8jY9kgw/aMqaC',
  'mvde9JoZP5BVvSCjHPZk0CXT+ua6aSJEA0gWrvQUa0cBSDNPeu9C5N/f7dstwjky',
  '9zBrF2hWAQCMXsEzVYjb/T0pn7A0++Mk8ifRFpXxU1xDeOyJo4Jl87ba49nikDIR',
  '1UXZTKsMvQIDAQABo3gwdjAdBgNVHQ4EFgQUzMAPNZH0y4nP8HugEDmGBBLqHVEw',
  'HwYDVR0jBBgwFoAUzMAPNZH0y4nP8HugEDmGBBLqHVEwDAYDVR0TAQH/BAIwADAO',
  'BgNVHQ8BAf8EBAMCB4AwFgYDVR0lAQH/BAwwCgYIKwYBBQUHAwMwDQYJKoZIhvcN',
  'AQELBQADggGBAHex4UaiPlofYhLjiLJ+Be7UQ6i0lj6CMZnk7XuDG85jTqTOE6QJ',
  'w/B9eb18gs5UVDDG6URlr8eA8o99bK/IrwEzXf1gPiHOOSaMVxTAmHGsmNo7tp6i',
  'qdLmsGiTbhlZq0AlKUePk0hSmRnul9RE2nIm4vq8OeQ61BMgvPzOzyNzGIBX0ziF',
  '/Feh2qOT4nM7SOxMf7Vsx+od9dG1VhlroMS6HOZIktrgeFhl0UhwDeKwudwa10Ai',
  'Vsv5iF8kTXnmyxIguxhzX0hDuEo7EPvDgKTqZoaMIlJ2oxg8XSy6n6vvzD5kC8sL',
  '2Rt/WPYE/PwKZ2Db8Tsi5QtIbTx/z7uaPdjPRAEfMEnIewDfqdDN/4E8dUmDIWY7',
  'kfpUNAv406qS+ev0SopzGU5adh17WLz+KN3DDlR80vgvOjkArTn0VW9OLNbVi2zd',
  '9HnrwGtjvCb509xnBWNx71vMTOYDnqqUOBz46T0kgsCioB2HG1C+8AWWcVtjl1DK',
  'UmjDwLX8lWOJqA==',
  '-----END CERTIFICATE-----',
].join('\n')

const HEALTHY_CERTIFICATE_TEXT = [
  'Certificate:',
  '    Data:',
  '        X509v3 extensions:',
  '            X509v3 Basic Constraints: critical',
  '                CA:FALSE',
  '            X509v3 Key Usage: critical',
  '                Digital Signature',
  '            X509v3 Extended Key Usage: critical',
  '                Code Signing',
  '',
].join('\n')

function healthyOptions(overrides = {}) {
  return {
    identityName: 'XingMang Free Update Identity',
    verifySelfSignature: () => true,
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
      if (args.includes('-subject')) return 'subject=OU=XINGMANG01, CN=XingMang Free Update Identity\nissuer=OU=XINGMANG01, CN=XingMang Free Update Identity\n'
      if (args.includes('-startdate')) return 'notBefore=Aug  1 00:00:00 2026 GMT\nnotAfter=Jul 28 00:00:00 2036 GMT\n'
      if (args.includes('-text')) return HEALTHY_CERTIFICATE_TEXT
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
    verifySelfSignature: () => true,
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
  // P-22: the self-signature is checked in process now, so no chain-building
  // subprocess is spawned for it.
  assert.equal(calls.some((call) => call.args[0] === 'verify'), false)
})

test('signing preflight drops only the trust filter when no Trust Settings can exist', () => {
  const queries = []
  const capture = (overrides) => healthyOptions({
    runSecurity: (args) => {
      queries.push(args)
      return healthyOptions().runSecurity(args)
    },
    ...overrides,
  })

  verifyFreeMacSigningIdentity(capture())
  verifyFreeMacSigningIdentity(capture({ trustedIdentitiesOnly: true }))
  verifyFreeMacSigningIdentity(capture({ trustedIdentitiesOnly: false }))

  const identityQueries = queries.filter((args) => args[0] === 'find-identity')
  assert.deepEqual(identityQueries, [
    ['find-identity', '-v', '-p', 'codesigning'],
    ['find-identity', '-v', '-p', 'codesigning'],
    ['find-identity', '-p', 'codesigning'],
  ])
  // The shape `security` really printed for the CI rehearsal's throwaway
  // keychain, which the first run of this path failed to parse: two sections,
  // and a policy error appended to the entry the `-v` form would have dropped.
  const unfiltered = [
    'Policy: Code Signing',
    '  Matching identities',
    '  1) 11AA22BB33CC44DD55EE66FF77889900AABBCCDD "XingMang Free Update Identity" (CSSMERR_TP_NOT_TRUSTED)',
    '     1 identities found',
    '',
    '  Valid identities only',
    '     0 valid identities found',
    '',
  ].join('\n')
  const withUnfiltered = (overrides) => healthyOptions({
    runSecurity: (args) => args[0] === 'find-certificate'
      ? healthyOptions().runSecurity(args)
      : unfiltered,
    ...overrides,
  })

  assert.equal(
    verifyFreeMacSigningIdentity(withUnfiltered({ trustedIdentitiesOnly: false })).identityName,
    'XingMang Free Update Identity',
  )
  // The release path asks for `-v`, which cannot list an identity the policy
  // rejects; seeing one anyway means that filter did not hold, so it fails
  // closed rather than signing with an untrusted key.
  assert.throws(() => verifyFreeMacSigningIdentity(withUnfiltered()), /信任错误/)
  // Only the matching section is read: the same identity listed again under
  // "Valid identities only" must not read as two competing identities.
  assert.equal(verifyFreeMacSigningIdentity(withUnfiltered({
    trustedIdentitiesOnly: false,
    runSecurity: (args) => args[0] === 'find-certificate'
      ? healthyOptions().runSecurity(args)
      : [
        'Policy: Code Signing',
        '  Matching identities',
        '  1) 11AA22BB33CC44DD55EE66FF77889900AABBCCDD "XingMang Free Update Identity"',
        '     1 identities found',
        '',
        '  Valid identities only',
        '  1) 11AA22BB33CC44DD55EE66FF77889900AABBCCDD "XingMang Free Update Identity"',
        '     1 valid identities found',
        '',
      ].join('\n'),
  })).fingerprint, 'AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899')

  // Nothing else may relax with it: the certificate assertions are the whole
  // point of running the real preflight in CI (P-20).
  assert.throws(() => verifyFreeMacSigningIdentity(capture({
    trustedIdentitiesOnly: false,
    runOpenSsl: (args) => args.includes('-subject')
      ? 'subject=CN=one\nissuer=CN=another\n'
      : healthyOptions().runOpenSsl(args),
  })), /自签/)
  assert.throws(() => verifyFreeMacSigningIdentity(capture({
    trustedIdentitiesOnly: false,
    runOpenSsl: (args) => args.includes('-text')
      ? 'X509v3 Extended Key Usage:\n    Code Signing\n'
      : healthyOptions().runOpenSsl(args),
  })), /codeSigning/)
  assert.throws(() => verifyFreeMacSigningIdentity(capture({
    trustedIdentitiesOnly: false,
    runSecurity: (args) => args[0] === 'find-certificate'
      ? healthyOptions().runSecurity(args)
      : '  1) FFEEDDCCBBAA0099887766554433221100AABBCC "XingMang Free Update Identity"\n',
  })), /私钥/)
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
    verifySelfSignature: () => false,
  })), /自签名验证失败/)
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

test('signing preflight refuses a certificate that can issue further certificates (P-22)', () => {
  const caCertificate = HEALTHY_CERTIFICATE_TEXT
    .replace('                CA:FALSE', '                CA:TRUE, pathlen:0')
  const issuingKeyUsage = HEALTHY_CERTIFICATE_TEXT
    .replace('                Digital Signature', '                Digital Signature, Certificate Sign')
  const nonCriticalConstraints = HEALTHY_CERTIFICATE_TEXT
    .replace('X509v3 Basic Constraints: critical', 'X509v3 Basic Constraints:')
  const missingConstraints = HEALTHY_CERTIFICATE_TEXT
    .split('\n')
    .filter((line) => !/Basic Constraints|CA:FALSE/.test(line))
    .join('\n')

  for (const [text, pattern] of [
    [caCertificate, /CA/],
    [nonCriticalConstraints, /CA/],
    [missingConstraints, /CA/],
    [issuingKeyUsage, /keyUsage/],
  ]) {
    assert.throws(() => assertNonIssuingSigningCertificate(text), pattern)
    assert.throws(() => verifyFreeMacSigningIdentity(healthyOptions({
      runOpenSsl: (args) => args.includes('-text') ? text : healthyOptions().runOpenSsl(args),
    })), pattern)
  }

  assert.equal(assertNonIssuingSigningCertificate(HEALTHY_CERTIFICATE_TEXT), undefined)
})

test('signing preflight refuses a certificate that outlives the ten-year cap (P-22)', () => {
  assert.throws(() => verifyFreeMacSigningIdentity(healthyOptions({
    runOpenSsl: (args) => args.includes('-startdate')
      ? 'notBefore=Aug  1 00:00:00 2026 GMT\nnotAfter=Jul 28 00:00:00 2046 GMT\n'
      : healthyOptions().runOpenSsl(args),
  })), /有效期不能超过 3650 天/)

  // The generator's own output sits just inside the cap.
  const notBefore = new Date('2026-08-01T00:00:00Z')
  const notAfter = new Date(notBefore.getTime() + 3650 * 24 * 60 * 60 * 1000)
  assert.equal(verifyFreeMacSigningIdentity(healthyOptions({
    runOpenSsl: (args) => args.includes('-startdate')
      ? `notBefore=${notBefore.toUTCString()}\nnotAfter=${notAfter.toUTCString()}\n`
      : healthyOptions().runOpenSsl(args),
  })).identityName, 'XingMang Free Update Identity')
})

test('P-22: the self-signature check accepts the generator profile and rejects tampered signatures', () => {
  const certificate = new (require('node:crypto').X509Certificate)(SELF_SIGNED_CERTIFICATE_PEM)
  assert.equal(certificate.subject, certificate.issuer)
  assert.equal(certificate.ca, false)

  assert.equal(verifyCertificateSelfSignature(SELF_SIGNED_CERTIFICATE_PEM), true)
  assert.equal(verifyCertificateSelfSignature(TAMPERED_CERTIFICATE_PEM), false)

  // The real certificate also satisfies the non-issuing profile assertions,
  // so the two checks agree about the same bytes.
  assert.equal(assertNonIssuingSigningCertificate([
    '            X509v3 Basic Constraints: critical',
    '                CA:FALSE',
    '            X509v3 Key Usage: critical',
    '                Digital Signature',
  ].join('\n')), undefined)
})

test('signing preflight refuses a certificate whose subject carries no team identifier', () => {
  const withoutTeamIdentifier = 'subject=CN=XingMang Free Update Identity\nissuer=CN=XingMang Free Update Identity\n'
  assert.throws(() => verifyFreeMacSigningIdentity(healthyOptions({
    runOpenSsl: (args) => args.includes('-subject')
      ? withoutTeamIdentifier
      : healthyOptions().runOpenSsl(args),
  })), /team identifier/)
})

test('the team identifier assertion reads both OpenSSL subject spellings and fails closed on anything else', () => {
  const identity = SIGNING_TEAM_IDENTIFIER
  assert.equal(assertSigningCertificateTeamIdentifier(`OU=${identity}, CN=XingMang Free Update Identity`), undefined)
  assert.equal(assertSigningCertificateTeamIdentifier(`/OU=${identity}/CN=XingMang Free Update Identity`), undefined)
  assert.equal(assertSigningCertificateTeamIdentifier(` ou = ${identity} , CN=XingMang Free Update Identity`), undefined)

  for (const subject of [
    'CN=XingMang Free Update Identity',
    `OU=${identity.toLowerCase()}, CN=XingMang Free Update Identity`,
    'OU=SOMEONEELSE, CN=XingMang Free Update Identity',
    `OU=${identity}, OU=SOMEONEELSE, CN=XingMang Free Update Identity`,
    `OU=${identity}${identity}, CN=XingMang Free Update Identity`,
    '',
  ]) {
    assert.throws(() => assertSigningCertificateTeamIdentifier(subject), /team identifier/, subject)
  }
})
