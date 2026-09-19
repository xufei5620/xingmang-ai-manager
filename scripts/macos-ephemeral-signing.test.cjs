const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  isTransientSigningFailure,
  sign,
  verifyEphemeralMacSigningIdentity,
} = require('./macos-ephemeral-signing.cjs')

const identitySha1 = 'CD'.repeat(20)
const keychainPath = '/private/tmp/xingmang-ci-signing.keychain-db'

function signingEnvironment(overrides = {}) {
  return {
    XINGMANG_MAC_CI_EPHEMERAL_SIGNING: '1',
    XINGMANG_MAC_SIGNING_SHA1: identitySha1,
    CSC_KEYCHAIN: keychainPath,
    ...overrides,
  }
}

test('the CI signer replaces the ad-hoc placeholder with the pinned untrusted identity', async () => {
  const calls = []
  const optionsForFile = () => ({ timestamp: 'none' })
  await sign({
    app: '/private/tmp/XingMang.app',
    identity: '-',
    keychain: keychainPath,
    identityValidation: true,
    strictVerify: false,
    platform: 'darwin',
    optionsForFile,
  }, {
    env: signingEnvironment(),
    signAsync: async (options) => calls.push(options),
  })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].app, '/private/tmp/XingMang.app')
  assert.equal(calls[0].identity, identitySha1)
  assert.equal(calls[0].keychain, keychainPath)
  assert.equal(calls[0].identityValidation, false)
  assert.equal(calls[0].strictVerify, true)
  assert.equal(calls[0].optionsForFile, optionsForFile)
})

test('the CI signer fails closed outside its exact ephemeral environment', async () => {
  let signerCalls = 0
  const baseOptions = {
    app: '/private/tmp/XingMang.app',
    identity: '-',
    keychain: keychainPath,
    platform: 'darwin',
  }
  const cases = [
    [signingEnvironment({ XINGMANG_MAC_CI_EPHEMERAL_SIGNING: '0' }), baseOptions],
    [signingEnvironment({ XINGMANG_MAC_SIGNING_SHA1: 'not-a-fingerprint' }), baseOptions],
    [signingEnvironment({ CSC_KEYCHAIN: '/private/tmp/other.keychain-db' }), baseOptions],
    [signingEnvironment(), { ...baseOptions, identity: 'Persistent Identity' }],
    [signingEnvironment(), { ...baseOptions, keychain: '/private/tmp/other.keychain-db' }],
  ]

  for (const [env, options] of cases) {
    await assert.rejects(() => sign(options, {
      env,
      signAsync: async () => { signerCalls += 1 },
    }), /ephemeral|SHA-1|keychain|placeholder/i)
  }
  assert.equal(signerCalls, 0)
})

test('the CI signer retries transient codesign failures with the pinned options intact', async () => {
  const calls = []
  await sign({
    app: '/private/tmp/XingMang.app',
    identity: '-',
    keychain: keychainPath,
    platform: 'darwin',
  }, {
    env: signingEnvironment(),
    retryOptions: { retries: 2, interval: 0, backoff: 0 },
    wait: async () => {},
    signAsync: async (options) => {
      calls.push(options)
      if (calls.length < 3) throw new Error('codesign failed: errSecInternalComponent')
    },
  })

  assert.equal(calls.length, 3)
  assert.equal(calls.every((options) => options.identity === identitySha1), true)
  assert.equal(calls.every((options) => options.keychain === keychainPath), true)
  assert.equal(calls.every((options) => options.identityValidation === false), true)
})

test('the private-key probe signs by fingerprint and performs strict structural verification', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-signing-probe-test-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sourceBinary = path.join(root, 'source-binary')
  const probePath = path.join(root, 'private-key-probe')
  fs.writeFileSync(sourceBinary, 'mach-o fixture')
  const calls = []
  const listings = []
  const env = { PATH: '/usr/bin:/bin' }

  const result = verifyEphemeralMacSigningIdentity({
    platform: 'darwin',
    identitySha1,
    keychainPath,
    sourceBinary,
    probePath,
    env,
    commandRunner: (spec) => calls.push(spec),
    listIdentities: (spec) => {
      listings.push(spec)
      return `  1) ${identitySha1} "XingMang CI Free Update Identity"\n     1 valid identities found\n`
    },
    report: () => {},
  })

  assert.deepEqual(listings.map((spec) => [spec.executable, spec.argv]), [
    ['/usr/bin/security', ['find-identity', '-p', 'codesigning', keychainPath]],
  ])
  assert.equal(result.identitySha1, identitySha1)
  assert.equal(fs.readFileSync(probePath, 'utf8'), 'mach-o fixture')
  assert.notEqual(fs.statSync(probePath).mode & 0o111, 0)
  assert.deepEqual(calls.map((call) => call.argv), [
    [
      '--force', '--sign', identitySha1,
      '--keychain', keychainPath,
      '--timestamp=none',
      '--options', 'runtime',
      probePath,
    ],
    ['--verify', '--strict', '--verbose=2', probePath],
  ])
  assert.equal(calls.every((call) => call.executable === '/usr/bin/codesign'), true)
  assert.equal(calls.every((call) => call.env === env && call.shell === false), true)
})

test('the private-key probe rejects unsupported or unpinned inputs before copying a binary', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-signing-probe-test-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sourceBinary = path.join(root, 'source-binary')
  const probePath = path.join(root, 'private-key-probe')
  fs.writeFileSync(sourceBinary, 'fixture')

  for (const overrides of [
    { platform: 'win32' },
    { identitySha1: 'bad' },
    { keychainPath: 'relative.keychain-db' },
    { probePath: 'relative-probe' },
  ]) {
    assert.throws(() => verifyEphemeralMacSigningIdentity({
      platform: 'darwin',
      identitySha1,
      keychainPath,
      sourceBinary,
      probePath,
      commandRunner: () => {},
      listIdentities: () => assert.fail('inputs must be validated before the keychain is queried'),
      report: () => {},
      ...overrides,
    }), /macOS|SHA-1|absolute/i)
  }
  assert.equal(fs.existsSync(probePath), false)
})

test('the private-key probe fails before signing when the keychain exposes no matching identity', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-signing-probe-test-')))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sourceBinary = path.join(root, 'source-binary')
  const probePath = path.join(root, 'private-key-probe')
  fs.writeFileSync(sourceBinary, 'mach-o fixture')

  assert.throws(() => verifyEphemeralMacSigningIdentity({
    platform: 'darwin',
    identitySha1,
    keychainPath,
    sourceBinary,
    probePath,
    commandRunner: () => assert.fail('codesign must not run without a resolvable identity'),
    listIdentities: () => '     0 valid identities found\n',
    report: () => {},
  }), new RegExp(`${identitySha1} is missing from`))
  assert.equal(fs.existsSync(probePath), false)
})

test('the CI signer reports a deterministic signing failure without spending the retry budget (P-38)', async () => {
  for (const failure of [
    new Error('no identity found'),
    new Error('codesign failed: bundle format unrecognized, invalid, or unsuitable'),
    Object.assign(new Error('keychain missing'), { code: 'ENOENT' }),
  ]) {
    let attempts = 0
    let waits = 0
    await assert.rejects(() => sign({
      app: '/private/tmp/XingMang.app',
      identity: '-',
      keychain: keychainPath,
      platform: 'darwin',
    }, {
      env: signingEnvironment(),
      retryOptions: { retries: 3, interval: 0, backoff: 0 },
      wait: async () => { waits += 1 },
      signAsync: async () => {
        attempts += 1
        throw failure
      },
    }), (error) => error === failure)

    assert.equal(attempts, 1)
    assert.equal(waits, 0)
  }
})

test('only contention failures count as transient (P-38)', () => {
  for (const transient of [
    new Error('codesign failed: errSecInternalComponent'),
    new Error('spawn codesign EAGAIN'),
    new Error('Resource temporarily unavailable'),
    new Error('EIO: i/o error, copyfile'),
    Object.assign(new Error('too many open files'), { code: 'EMFILE' }),
    Object.assign(new Error('opaque'), { code: 'ETIMEDOUT' }),
  ]) {
    assert.equal(isTransientSigningFailure(transient), true, transient.message)
  }

  for (const deterministic of [
    undefined,
    null,
    new Error('no identity found'),
    new Error('ephemeral macOS signer requires the ad-hoc identity placeholder'),
    new Error('code object is not signed at all'),
    Object.assign(new Error('keychain missing'), { code: 'ENOENT' }),
    Object.assign(new Error('permission denied'), { code: 'EACCES' }),
  ]) {
    assert.equal(isTransientSigningFailure(deterministic), false, String(deterministic))
  }
})
