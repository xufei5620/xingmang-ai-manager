const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const {
  createFreeMacSigningCertificate,
  resolveDedicatedOutputDirectory,
} = require('./create-macos-free-signing-certificate.cjs')

const temporaryDirectories = []

function temporaryDirectory() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-free-signing-test-')))
  temporaryDirectories.push(directory)
  return directory
}

const TEST_P12_PASSWORD = 'test-only-strong-password-2026'

function fixtureOpenSslRunner(invocations = []) {
  return (args) => {
    invocations.push(args)
    const outputIndex = args.indexOf('-out')
    if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], 'fixture')
  }
}

test.afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('certificate output must be a dedicated nonempty directory and never overwrite key material', () => {
  const root = temporaryDirectory()
  const outputDirectory = path.join(root, 'xingmang-free-update-identity')

  assert.equal(resolveDedicatedOutputDirectory(outputDirectory), outputDirectory)
  assert.throws(() => resolveDedicatedOutputDirectory(''), /专用输出目录/)
  assert.throws(() => resolveDedicatedOutputDirectory('.'), /专用输出目录/)

  fs.mkdirSync(outputDirectory)
  fs.writeFileSync(path.join(outputDirectory, 'xingmang-macos-free-signing.p12'), 'existing key material')
  assert.throws(() => createFreeMacSigningCertificate({
    outputDirectory,
    commonName: 'XingMang Free Update Identity',
    password: TEST_P12_PASSWORD,
    runOpenSsl: () => undefined,
  }), /已存在/)

  fs.unlinkSync(path.join(outputDirectory, 'xingmang-macos-free-signing.p12'))
  fs.writeFileSync(path.join(outputDirectory, 'unrelated-file'), 'not a dedicated output directory')
  assert.throws(() => createFreeMacSigningCertificate({
    outputDirectory,
    commonName: 'XingMang Free Update Identity',
    password: TEST_P12_PASSWORD,
    runOpenSsl: () => undefined,
  }), /空的专用输出目录/)
})

test('certificate output rejects paths containing symlink components', () => {
  const root = temporaryDirectory()
  const outside = temporaryDirectory()
  const linkedParent = path.join(root, 'linked-parent')
  fs.symlinkSync(outside, linkedParent)

  assert.throws(
    () => resolveDedicatedOutputDirectory(path.join(linkedParent, 'certificate-output')),
    /符号链接|链接/,
  )
})

test('certificate generation rejects unsafe CN values', () => {
  const root = temporaryDirectory()
  const invalidNames = [
    'XingMang/O=Injected',
    'XingMang,OU=Injected',
    'XingMang\nInjected',
    'X'.repeat(65),
  ]
  for (const [index, commonName] of invalidNames.entries()) {
    assert.throws(() => createFreeMacSigningCertificate({
      outputDirectory: path.join(root, `unsafe-name-${index}`),
      commonName,
      password: TEST_P12_PASSWORD,
      runOpenSsl: fixtureOpenSslRunner(),
    }), /证书名称/)
  }
})

test('certificate generation requires a bounded printable P12 password covering at least three character classes', () => {
  const root = temporaryDirectory()
  const invalidPasswords = [
    '',
    'Aa1!'.repeat(4) + 'Aa1',
    ' '.repeat(20),
    'A'.repeat(20),
    'lowercase-symbols----',
    'Aa1!with-control\nxx',
    'Aa1!password-strong密',
    'Aa1!'.repeat(65),
  ]
  for (const [index, password] of invalidPasswords.entries()) {
    assert.throws(() => createFreeMacSigningCertificate({
      outputDirectory: path.join(root, `weak-password-${index}`),
      commonName: 'XingMang Free Update Identity',
      password,
      runOpenSsl: fixtureOpenSslRunner(),
    }), /P12 密码/)
  }

  for (const [index, password] of [
    'Aa1'.padEnd(20, 'b'),
    'Aa1'.padEnd(256, 'b'),
    TEST_P12_PASSWORD,
  ].entries()) {
    const result = createFreeMacSigningCertificate({
      outputDirectory: path.join(root, `strong-password-${index}`),
      commonName: 'XingMang Free Update Identity',
      password,
      runOpenSsl: fixtureOpenSslRunner(),
    })
    assert.equal(fs.statSync(result.p12Path).mode & 0o777, 0o600)
  }
})

test('pre-existing certificate output directories must be private and owned by the current uid', (t) => {
  const root = temporaryDirectory()
  const secureDirectory = path.join(root, 'secure-existing-output')
  fs.mkdirSync(secureDirectory, { mode: 0o700 })
  createFreeMacSigningCertificate({
    outputDirectory: secureDirectory,
    commonName: 'XingMang Free Update Identity',
    password: TEST_P12_PASSWORD,
    runOpenSsl: fixtureOpenSslRunner(),
  })

  for (const [name, mode] of [['group-writable', 0o720], ['world-writable', 0o702]]) {
    const outputDirectory = path.join(root, name)
    fs.mkdirSync(outputDirectory, { mode: 0o700 })
    fs.chmodSync(outputDirectory, mode)
    assert.throws(() => createFreeMacSigningCertificate({
      outputDirectory,
      commonName: 'XingMang Free Update Identity',
      password: TEST_P12_PASSWORD,
      runOpenSsl: fixtureOpenSslRunner(),
    }), /权限|所有者/)
  }

  if (typeof process.getuid === 'function') {
    const outputDirectory = path.join(root, 'different-owner')
    fs.mkdirSync(outputDirectory, { mode: 0o700 })
    const actualUid = process.getuid()
    t.mock.method(process, 'getuid', () => actualUid + 1)
    assert.throws(() => createFreeMacSigningCertificate({
      outputDirectory,
      commonName: 'XingMang Free Update Identity',
      password: TEST_P12_PASSWORD,
      runOpenSsl: fixtureOpenSslRunner(),
    }), /权限|所有者/)
  }
})

test('certificate generation requests a long-lived RSA-3072 SHA-256 code-signing certificate and Keychain-compatible encrypted P12', () => {
  const outputDirectory = path.join(temporaryDirectory(), 'xingmang-free-update-identity')
  const invocations = []

  const result = createFreeMacSigningCertificate({
    outputDirectory,
    commonName: 'XingMang Free Update Identity',
    password: TEST_P12_PASSWORD,
    runOpenSsl: fixtureOpenSslRunner(invocations),
  })

  assert.equal(result.p12Path, path.join(outputDirectory, 'xingmang-macos-free-signing.p12'))
  assert.equal(result.certificatePath, path.join(outputDirectory, 'xingmang-macos-free-signing.cer'))
  const certificateCommand = invocations.find((args) => args.includes('-newkey'))
  assert.ok(certificateCommand)
  assert.ok(certificateCommand.includes('rsa:3072'))
  assert.ok(certificateCommand.includes('-sha256'))
  assert.ok(certificateCommand.includes('basicConstraints=critical,CA:TRUE,pathlen:0'))
  assert.ok(certificateCommand.includes('keyUsage=critical,digitalSignature,keyCertSign'))
  assert.ok(certificateCommand.includes('extendedKeyUsage=critical,codeSigning'))
  assert.ok(certificateCommand.includes('7300'))
  const exportCommand = invocations.find((args) => args[0] === 'pkcs12')
  assert.ok(exportCommand)
  assert.ok(exportCommand.includes('-descert'))
  assert.equal(exportCommand.includes('-aes-256-cbc'), false)
  assert.ok(exportCommand.includes('env:XINGMANG_MAC_SIGNING_P12_PASSWORD'))
  assert.equal(fs.statSync(outputDirectory).mode & 0o777, 0o700)
  assert.equal(fs.statSync(result.p12Path).mode & 0o777, 0o600)
  assert.equal(fs.existsSync(path.join(outputDirectory, 'xingmang-macos-free-signing.key')), false)
})

test('certificate generation pins /usr/bin/openssl and preserves the injected env and spawnSync boundary', () => {
  const outputDirectory = path.join(temporaryDirectory(), 'xingmang-free-update-identity')
  const calls = []
  const env = { PATH: '/untrusted/bin', TEST_ENVIRONMENT_MARKER: 'preserved' }

  createFreeMacSigningCertificate({
    outputDirectory,
    commonName: 'XingMang Free Update Identity',
    password: TEST_P12_PASSWORD,
    env,
    spawnSync: (executable, args, options) => {
      calls.push({ executable, args, options })
      const outputIndex = args.indexOf('-out')
      if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], 'fixture')
      return { status: 0, stdout: '', stderr: '' }
    },
  })

  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.executable, '/usr/bin/openssl')
    assert.equal(call.options.shell, false)
    assert.equal(call.options.env.PATH, env.PATH)
    assert.equal(call.options.env.TEST_ENVIRONMENT_MARKER, env.TEST_ENVIRONMENT_MARKER)
    assert.equal(call.options.env.XINGMANG_MAC_SIGNING_P12_PASSWORD, TEST_P12_PASSWORD)
  }
})

test('certificate publication is exclusive and rolls back its own partial output without overwriting a raced artifact', () => {
  const outputDirectory = path.join(temporaryDirectory(), 'xingmang-free-update-identity')
  const existingP12 = path.join(outputDirectory, 'xingmang-macos-free-signing.p12')

  assert.throws(() => createFreeMacSigningCertificate({
    outputDirectory,
    commonName: 'XingMang Free Update Identity',
    password: TEST_P12_PASSWORD,
    runOpenSsl: (args) => {
      const outputIndex = args.indexOf('-out')
      if (outputIndex >= 0) fs.writeFileSync(args[outputIndex + 1], 'fixture')
      if (args[0] === 'pkcs12') fs.writeFileSync(existingP12, 'raced-existing-p12')
    },
  }), /覆盖|存在|EEXIST/)

  assert.equal(fs.readFileSync(existingP12, 'utf8'), 'raced-existing-p12')
  assert.equal(fs.existsSync(path.join(outputDirectory, 'xingmang-macos-free-signing.cer')), false)
})

test('Darwin system OpenSSL output imports into an isolated temporary keychain', {
  skip: process.platform !== 'darwin',
}, () => {
  const root = temporaryDirectory()
  const outputDirectory = path.join(root, 'certificate-output')
  const keychainPath = path.join(root, 'import-smoke-test.keychain-db')
  const keychainPassword = 'temporary-keychain-password-2026'
  const env = { ...process.env, PATH: '/usr/bin:/bin' }
  const securityCalls = []
  const runSecurity = (args) => {
    securityCalls.push(args)
    return spawnSync('/usr/bin/security', args, { encoding: 'utf8', env, shell: false })
  }
  const beforeSearchList = runSecurity(['list-keychains', '-d', 'user'])
  assert.equal(beforeSearchList.status, 0, beforeSearchList.stderr)
  let keychainCreated = false

  try {
    const result = createFreeMacSigningCertificate({
      outputDirectory,
      commonName: 'XingMang Free Update Identity',
      password: TEST_P12_PASSWORD,
      env,
    })
    const selfSignatureResult = spawnSync('/usr/bin/openssl', [
      'verify', '-check_ss_sig', '-CAfile', result.certificatePath, result.certificatePath,
    ], { encoding: 'utf8', env, shell: false })
    assert.equal(
      selfSignatureResult.status,
      0,
      `${selfSignatureResult.stdout}${selfSignatureResult.stderr}`,
    )
    const createResult = runSecurity([
      'create-keychain', '-p', keychainPassword, keychainPath,
    ])
    assert.equal(createResult.status, 0, createResult.stderr)
    keychainCreated = true

    const unlockResult = runSecurity([
      'unlock-keychain', '-p', keychainPassword, keychainPath,
    ])
    assert.equal(unlockResult.status, 0, unlockResult.stderr)

    const importResult = runSecurity([
      'import', result.p12Path,
      '-k', keychainPath,
      '-f', 'pkcs12',
      '-P', TEST_P12_PASSWORD,
    ])
    assert.equal(importResult.status, 0, importResult.stderr)

    const certificateResult = runSecurity([
      'find-certificate', '-c', 'XingMang Free Update Identity', keychainPath,
    ])
    assert.equal(certificateResult.status, 0, certificateResult.stderr)
  } finally {
    if (keychainCreated) {
      const deleteResult = runSecurity([
        'delete-keychain', keychainPath,
      ])
      assert.equal(deleteResult.status, 0, deleteResult.stderr)
    }
    const afterSearchList = runSecurity(['list-keychains', '-d', 'user'])
    assert.equal(afterSearchList.status, 0, afterSearchList.stderr)
    assert.equal(afterSearchList.stdout, beforeSearchList.stdout)
  }

  assert.equal(fs.existsSync(keychainPath), false)
  assert.equal(
    securityCalls.some((args) => /trust|trusted-cert/.test(args[0])),
    false,
  )
})
