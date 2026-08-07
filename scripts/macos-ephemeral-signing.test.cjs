const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
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
      if (calls.length < 3) throw new Error('no identity found')
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
  const env = { PATH: '/usr/bin:/bin' }

  const result = verifyEphemeralMacSigningIdentity({
    platform: 'darwin',
    identitySha1,
    keychainPath,
    sourceBinary,
    probePath,
    env,
    commandRunner: (spec) => calls.push(spec),
  })

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
      ...overrides,
    }), /macOS|SHA-1|absolute/i)
  }
  assert.equal(fs.existsSync(probePath), false)
})
