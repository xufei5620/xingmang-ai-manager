const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  parseFreeMacBuildArguments,
  resolveMacosSecurityCommand,
  resolveFreeMacBuildOptions,
  runCiFreeMacBuild,
  runFreeMacBuild,
} = require('./run-macos-free-build.cjs')

function temporaryProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-free-build-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function writeCertificate({ outputDirectory }) {
  fs.mkdirSync(outputDirectory)
  const certificatePath = path.join(outputDirectory, 'identity.cer')
  const p12Path = path.join(outputDirectory, 'identity.p12')
  fs.writeFileSync(certificatePath, 'certificate')
  fs.writeFileSync(p12Path, 'p12')
  return { certificatePath, p12Path }
}

function sequentialEntropy() {
  let draw = 0
  return (size) => {
    draw += 1
    return Buffer.alloc(size, draw)
  }
}

const fingerprint = 'AB'.repeat(32)
const sha1Fingerprint = 'CD'.repeat(20)

test('macOS security commands never cross an administrator boundary', () => {
  assert.deepEqual(resolveMacosSecurityCommand(['list-keychains', '-d', 'user']), {
    executable: '/usr/bin/security',
    argv: ['list-keychains', '-d', 'user'],
    label: 'security list-keychains',
    stdin: undefined,
    redactions: [],
  })
  assert.deepEqual(resolveMacosSecurityCommand(['delete-keychain', '/tmp/ci-signing.keychain-db']), {
    executable: '/usr/bin/security',
    argv: ['delete-keychain', '/tmp/ci-signing.keychain-db'],
    label: 'security delete-keychain',
    stdin: undefined,
    redactions: [],
  })
})

test('macOS security passwords are fed on stdin instead of argv', () => {
  const password = 'CiKeychain!0f0f0f0fAa1'
  const command = resolveMacosSecurityCommand(
    ['create-keychain', '-p', password, '/tmp/ci-signing.keychain-db'],
    { secrets: [password] },
  )
  assert.deepEqual(command.argv, ['-i'])
  assert.equal(command.label, 'security create-keychain')
  assert.equal(command.argv.includes(password), false)
  assert.equal(
    command.stdin,
    `"create-keychain" "-p" "${password}" "/tmp/ci-signing.keychain-db"\n`,
  )
  assert.deepEqual(command.redactions, [password])

  const quoted = resolveMacosSecurityCommand(
    ['import', '/tmp/a "b"\\c.p12', '-P', password],
    { secrets: [password] },
  )
  assert.equal(quoted.stdin, `"import" "/tmp/a \\"b\\"\\\\c.p12" "-P" "${password}"\n`)

  // A subcommand whose declared secret is not actually one of its arguments
  // means the call site drifted; it must not silently fall back to argv.
  assert.throws(
    () => resolveMacosSecurityCommand(['create-keychain', '-p', password], { secrets: ['other'] }),
    /机密参数/,
  )
  assert.throws(
    () => resolveMacosSecurityCommand(['create-keychain', '-p', 'a\nb'], { secrets: ['a\nb'] }),
    /控制字符/,
  )
})

test('CI signing restores the user search list it temporarily prepends its isolated keychain to', async (t) => {
  const projectRoot = temporaryProject(t)
  const calls = []
  const removed = []
  const originalSearchList = '    "/Users/runner/Library/Keychains/login.keychain-db"\n'
  const result = await runCiFreeMacBuild({
    projectRoot,
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    randomBytes: sequentialEntropy(),
    createCertificate: ({ outputDirectory, commonName, password }) => {
      calls.push(['certificate', { outputDirectory, commonName, password }])
      assert.equal(path.dirname(outputDirectory), fs.realpathSync(path.dirname(outputDirectory)))
      fs.mkdirSync(outputDirectory)
      const certificatePath = path.join(outputDirectory, 'identity.cer')
      const p12Path = path.join(outputDirectory, 'identity.p12')
      fs.writeFileSync(certificatePath, 'certificate')
      fs.writeFileSync(p12Path, 'p12')
      return { certificatePath, p12Path }
    },
    certificateFingerprint: () => fingerprint,
    certificateSha1: () => sha1Fingerprint,
    runSecurity: (args, commandOptions = {}) => {
      calls.push(['security', args, commandOptions])
      if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1), 'keychain')
      if (args[0] === 'list-keychains' && args.length === 3) return originalSearchList
      return ''
    },
    verifyEphemeralSigning: (options) => {
      calls.push(['probe', options])
      return { identitySha1: options.identitySha1 }
    },
    runBuild: async (options) => {
      calls.push(['build', options])
      assert.equal(options.env.CSC_NAME, 'XingMang CI Free Update Identity')
      assert.equal(options.env.XINGMANG_MAC_SIGNING_SHA256, fingerprint)
      assert.equal(options.ephemeralSigning.identitySha1, sha1Fingerprint)
      assert.match(options.ephemeralSigning.keychainPath, /ci-signing\.keychain-db$/)
      assert.match(options.outputDirectory, /^release-free-ci-/)
      fs.mkdirSync(path.join(projectRoot, options.outputDirectory))
      return { outputDirectory: path.join(projectRoot, options.outputDirectory) }
    },
    removeDirectory: (directory) => {
      removed.push(directory)
      fs.rmSync(directory, { recursive: true, force: true })
    },
  })

  assert.equal(result.cleaned, true)
  const securityCalls = calls.filter(([kind]) => kind === 'security')
  const securityArguments = securityCalls.map(([, args]) => args)
  assert.deepEqual(securityArguments.map((args) => args[0]), [
    'create-keychain',
    'set-keychain-settings',
    'unlock-keychain',
    'import',
    'set-key-partition-list',
    'list-keychains',
    'list-keychains',
    'list-keychains',
    'delete-keychain',
  ])
  const keychainPath = securityArguments[0].at(-1)
  const searchListCommands = securityArguments.filter((args) => args[0] === 'list-keychains')
  // Read the current list, prepend the isolated keychain, then restore exactly
  // what was there before. The user domain is the only domain ever touched.
  assert.deepEqual(searchListCommands[0], ['list-keychains', '-d', 'user'])
  assert.deepEqual(searchListCommands[1], [
    'list-keychains', '-d', 'user', '-s', keychainPath,
    '/Users/runner/Library/Keychains/login.keychain-db',
  ])
  assert.deepEqual(searchListCommands[2], [
    'list-keychains', '-d', 'user', '-s',
    '/Users/runner/Library/Keychains/login.keychain-db',
  ])
  assert.equal(searchListCommands.every((args) => !args.includes('system') && !args.includes('admin')), true)
  const probe = calls.find(([kind]) => kind === 'probe')[1]
  assert.equal(probe.identitySha1, sha1Fingerprint)
  assert.equal(probe.keychainPath, keychainPath)
  assert.match(probe.probePath, /private-key-probe$/)
  assert.equal(calls.findIndex(([kind]) => kind === 'probe') < calls.findIndex(([kind]) => kind === 'build'), true)
  assert.equal(securityCalls.every(([, args, options]) => (
    !/trusted-cert|delete-certificate/.test(args[0]) && options.privilege === undefined
  )), true)
  assert.equal(removed.length, 2)
})

test('CI signing aborts and cleans up when the trust-free private-key probe fails', async (t) => {
  const projectRoot = temporaryProject(t)
  const securityCalls = []

  await assert.rejects(() => runCiFreeMacBuild({
    projectRoot,
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    randomBytes: sequentialEntropy(),
    createCertificate: ({ outputDirectory }) => {
      fs.mkdirSync(outputDirectory)
      const certificatePath = path.join(outputDirectory, 'identity.cer')
      const p12Path = path.join(outputDirectory, 'identity.p12')
      fs.writeFileSync(certificatePath, 'certificate')
      fs.writeFileSync(p12Path, 'p12')
      return { certificatePath, p12Path }
    },
    certificateFingerprint: () => fingerprint,
    certificateSha1: () => sha1Fingerprint,
    runSecurity: (args, commandOptions = {}) => {
      securityCalls.push([args, commandOptions])
      if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1), 'keychain')
      if (args[0] === 'list-keychains' && args.length === 3) {
        return '    "/Users/runner/Library/Keychains/login.keychain-db"\n'
      }
      return ''
    },
    verifyEphemeralSigning: () => {
      throw new Error('private-key signing probe failed')
    },
  }), /private-key signing probe failed/)

  const cleanupCommands = securityCalls.map(([args]) => args)
  assert.deepEqual(cleanupCommands.map((args) => args[0]), [
    'create-keychain',
    'set-keychain-settings',
    'unlock-keychain',
    'import',
    'set-key-partition-list',
    'list-keychains',
    'list-keychains',
    'list-keychains',
    'delete-keychain',
  ])
  assert.equal(cleanupCommands.some((args) => /trusted-cert|delete-certificate/.test(args[0])), false)
})

test('CI signing does not probe or mutate trust before identity import succeeds', async (t) => {
  const projectRoot = temporaryProject(t)
  const securityCalls = []
  let probeCalled = false

  await assert.rejects(() => runCiFreeMacBuild({
    projectRoot,
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    randomBytes: sequentialEntropy(),
    createCertificate: ({ outputDirectory }) => {
      fs.mkdirSync(outputDirectory)
      const certificatePath = path.join(outputDirectory, 'identity.cer')
      const p12Path = path.join(outputDirectory, 'identity.p12')
      fs.writeFileSync(certificatePath, 'certificate')
      fs.writeFileSync(p12Path, 'p12')
      return { certificatePath, p12Path }
    },
    certificateFingerprint: () => fingerprint,
    certificateSha1: () => sha1Fingerprint,
    runSecurity: (args, commandOptions = {}) => {
      securityCalls.push([args, commandOptions])
      if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1), 'keychain')
      if (args[0] === 'import') throw new Error('identity import failed')
      return ''
    },
    verifyEphemeralSigning: () => {
      probeCalled = true
    },
  }), /identity import failed/)

  assert.equal(probeCalled, false)
  assert.deepEqual(
    securityCalls.filter(([args]) => /trusted-cert/.test(args[0])),
    [],
  )
})

test('CI signing cleanup runs when the real free build fails', async (t) => {
  const projectRoot = temporaryProject(t)
  const securityCalls = []
  const removed = []
  await assert.rejects(() => runCiFreeMacBuild({
    projectRoot,
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    randomBytes: sequentialEntropy(),
    createCertificate: ({ outputDirectory }) => {
      fs.mkdirSync(outputDirectory)
      const certificatePath = path.join(outputDirectory, 'identity.cer')
      const p12Path = path.join(outputDirectory, 'identity.p12')
      fs.writeFileSync(certificatePath, 'certificate')
      fs.writeFileSync(p12Path, 'p12')
      return { certificatePath, p12Path }
    },
    certificateFingerprint: () => fingerprint,
    certificateSha1: () => sha1Fingerprint,
    runSecurity: (args, commandOptions = {}) => {
      securityCalls.push([args, commandOptions])
      if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1), 'keychain')
      if (args[0] === 'list-keychains' && args.length === 3) {
        return '    "/Users/runner/Library/Keychains/login.keychain-db"\n'
      }
      return ''
    },
    verifyEphemeralSigning: () => ({ identitySha1: sha1Fingerprint }),
    runBuild: async ({ outputDirectory }) => {
      fs.mkdirSync(path.join(projectRoot, outputDirectory))
      throw new Error('real build failed')
    },
    removeDirectory: (directory) => {
      removed.push(directory)
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }), /real build failed/)

  assert.equal(securityCalls.some(([args]) => args[0] === 'delete-keychain'), true)
  // The search list is restored before the keychain it points at is deleted.
  const commands = securityCalls.map(([args]) => args)
  assert.deepEqual(commands.filter((args) => args[0] === 'list-keychains').at(-1).slice(0, 4), [
    'list-keychains', '-d', 'user', '-s',
  ])
  assert.equal(
    commands.findLastIndex((args) => args[0] === 'list-keychains')
      < commands.findIndex((args) => args[0] === 'delete-keychain'),
    true,
  )
  assert.equal(securityCalls.some(([args]) => /trusted-cert|delete-certificate/.test(args[0])), false)
  assert.equal(removed.length, 2)
})

test('CI signing reports keychain deletion failure after attempting directory cleanup', async (t) => {
  const projectRoot = temporaryProject(t)
  const securityCalls = []
  const removed = []
  await assert.rejects(() => runCiFreeMacBuild({
    projectRoot,
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    randomBytes: sequentialEntropy(),
    createCertificate: ({ outputDirectory }) => {
      fs.mkdirSync(outputDirectory)
      const certificatePath = path.join(outputDirectory, 'identity.cer')
      const p12Path = path.join(outputDirectory, 'identity.p12')
      fs.writeFileSync(certificatePath, 'certificate')
      fs.writeFileSync(p12Path, 'p12')
      return { certificatePath, p12Path }
    },
    certificateFingerprint: () => fingerprint,
    certificateSha1: () => sha1Fingerprint,
    runSecurity: (args, commandOptions = {}) => {
      securityCalls.push([args, commandOptions])
      if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1), 'keychain')
      if (args[0] === 'delete-keychain') throw new Error('temporary keychain deletion failed')
      if (args[0] === 'list-keychains' && args.length === 3) {
        return '    "/Users/runner/Library/Keychains/login.keychain-db"\n'
      }
      return ''
    },
    verifyEphemeralSigning: () => ({ identitySha1: sha1Fingerprint }),
    runBuild: async ({ outputDirectory }) => {
      fs.mkdirSync(path.join(projectRoot, outputDirectory))
      return { outputDirectory }
    },
    removeDirectory: (directory) => {
      removed.push(directory)
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }), /temporary keychain deletion failed/)

  assert.equal(securityCalls.some(([args]) => args[0] === 'list-keychains'), true)
  assert.equal(securityCalls.some(([args]) => args[0] === 'delete-keychain'), true)
  assert.equal(securityCalls.some(([args]) => /trusted-cert|delete-certificate/.test(args[0])), false)
  assert.equal(removed.length, 2)
})

function validOptions(t, overrides = {}) {
  const projectRoot = temporaryProject(t)
  return {
    projectRoot,
    platform: 'darwin',
    packageVersion: '1.2.3',
    npmCliPath: '/trusted/npm-cli.js',
    electronBuilderCliPath: '/trusted/electron-builder-cli.js',
    env: {
      PATH: '/usr/bin:/bin',
      CSC_NAME: 'XingMang Free Update Identity',
      XINGMANG_MAC_SIGNING_SHA256: fingerprint,
    },
    // 这些用例喂的是假的 commandRunner，目录里没有真产物可改名；改名本身由
    // 「renames the artifacts to their chip names before verification」单测覆盖。
    renameArtifacts: async () => {},
    ...overrides,
  }
}

test('runs signing preflight, checks, non-publishing builder, then pinned artifact verification', async (t) => {
  const calls = []
  const options = validOptions(t, {
    verifySigning: (value) => {
      calls.push(['signing', value])
      return { identityName: value.identityName, fingerprint }
    },
    commandRunner: async (spec) => {
      calls.push(['command', spec])
    },
    verifyArtifacts: async (value) => {
      calls.push(['artifacts', value])
      return { outputDirectory: value.outputDirectory }
    },
  })

  const result = await runFreeMacBuild(options)

  assert.equal(result.outputDirectory, path.join(options.projectRoot, 'release-free-1.2.3'))
  assert.equal(calls[0][0], 'signing')
  assert.equal(calls[0][1].identityName, 'XingMang Free Update Identity')
  assert.equal(calls[0][1].expectedFingerprint, fingerprint)
  assert.equal(calls[0][1].env.XINGMANG_MAC_FREE_RELEASE, undefined)
  assert.equal(calls[0][1].env.XINGMANG_OUTPUT_DIR, undefined)
  assert.deepEqual(calls.slice(1, 4).map((entry) => entry[1].argv), [
    ['/trusted/npm-cli.js', 'run', 'typecheck'],
    ['/trusted/npm-cli.js', 'test'],
    ['/trusted/npm-cli.js', 'run', 'compile'],
  ])
  const builder = calls[4][1]
  assert.equal(builder.executable, process.execPath)
  assert.deepEqual(builder.argv, [
    '/trusted/electron-builder-cli.js',
    '--config', 'electron-builder.config.cjs',
    '--mac', 'dmg', 'zip',
    '--arm64', '--x64',
    '--publish', 'never',
  ])
  assert.equal(builder.shell, false)
  assert.equal(builder.env.XINGMANG_MAC_FREE_RELEASE, '1')
  assert.equal(builder.env.XINGMANG_RELEASE, undefined)
  assert.equal(builder.env.CSC_NAME, 'XingMang Free Update Identity')
  assert.equal(builder.env.XINGMANG_MAC_SIGNING_SHA256, fingerprint)
  assert.equal(builder.env.XINGMANG_MAC_CI_EPHEMERAL_SIGNING, undefined)
  assert.equal(builder.env.XINGMANG_MAC_SIGNING_SHA1, undefined)
  assert.equal(builder.env.CSC_KEYCHAIN, undefined)
  assert.equal(builder.env.CSC_FOR_PULL_REQUEST, undefined)
  assert.equal(builder.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false')
  assert.equal(builder.env.XINGMANG_OUTPUT_DIR, result.outputDirectory)
  assert.equal(calls[5][0], 'artifacts')
  assert.equal(calls[5][1].identityName, 'XingMang Free Update Identity')
  assert.equal(calls[5][1].signingCertificateSha256, fingerprint)
  assert.equal(calls[5][1].env.XINGMANG_MAC_FREE_RELEASE, undefined)
  assert.equal(calls[5][1].env.XINGMANG_OUTPUT_DIR, undefined)
  for (const command of calls.slice(1, 4)) {
    assert.equal(command[1].env.XINGMANG_MAC_FREE_RELEASE, undefined)
    assert.equal(command[1].env.XINGMANG_OUTPUT_DIR, undefined)
  }
})

test('CI ephemeral signing data reaches only the non-publishing builder process', async (t) => {
  const calls = []
  const options = validOptions(t, {
    skipChecks: true,
    ephemeralSigning: {
      identitySha1: sha1Fingerprint,
      keychainPath: '/private/tmp/xingmang-ci-signing.keychain-db',
    },
    verifySigning: (value) => {
      calls.push(['signing', value])
      return { identityName: value.identityName, fingerprint }
    },
    commandRunner: async (spec) => {
      calls.push(['command', spec])
    },
    verifyArtifacts: async (value) => {
      calls.push(['artifacts', value])
      return { outputDirectory: value.outputDirectory }
    },
  })

  await runFreeMacBuild(options)

  const signing = calls.find(([kind]) => kind === 'signing')[1]
  const builder = calls.find(([kind]) => kind === 'command')[1]
  const artifacts = calls.find(([kind]) => kind === 'artifacts')[1]
  assert.equal(signing.env.XINGMANG_MAC_CI_EPHEMERAL_SIGNING, undefined)
  assert.equal(signing.env.XINGMANG_MAC_SIGNING_SHA1, undefined)
  assert.equal(signing.env.CSC_KEYCHAIN, undefined)
  assert.equal(builder.env.XINGMANG_MAC_CI_EPHEMERAL_SIGNING, '1')
  assert.equal(builder.env.XINGMANG_MAC_SIGNING_SHA1, sha1Fingerprint)
  assert.equal(builder.env.CSC_KEYCHAIN, options.ephemeralSigning.keychainPath)
  assert.equal(builder.env.CSC_FOR_PULL_REQUEST, 'true')
  assert.equal(artifacts.env.XINGMANG_MAC_CI_EPHEMERAL_SIGNING, undefined)
  assert.equal(artifacts.env.XINGMANG_MAC_SIGNING_SHA1, undefined)
  assert.equal(artifacts.env.CSC_KEYCHAIN, undefined)
})

test('fails before work for unsupported platform, conflicts, invalid identity data, or unsafe output', (t) => {
  assert.throws(() => resolveFreeMacBuildOptions(validOptions(t, { platform: 'win32' })), /macOS/)
  assert.throws(() => resolveFreeMacBuildOptions(validOptions(t, {
    env: { CSC_NAME: '', XINGMANG_MAC_SIGNING_SHA256: fingerprint },
  })), /CSC_NAME/)
  assert.throws(() => resolveFreeMacBuildOptions(validOptions(t, {
    env: { CSC_NAME: 'identity', XINGMANG_MAC_SIGNING_SHA256: 'bad' },
  })), /SHA-256/)
  for (const invalidFingerprint of [
    `[${fingerprint}]`,
    `${fingerprint.slice(0, 2)}:${fingerprint.slice(2)}`,
  ]) {
    assert.throws(() => resolveFreeMacBuildOptions(validOptions(t, {
      env: { CSC_NAME: 'identity', XINGMANG_MAC_SIGNING_SHA256: invalidFingerprint },
    })), /SHA-256/)
  }
  const colonSeparatedFingerprint = fingerprint.match(/.{2}/g).join(':')
  assert.equal(resolveFreeMacBuildOptions(validOptions(t, {
    env: { CSC_NAME: 'identity', XINGMANG_MAC_SIGNING_SHA256: colonSeparatedFingerprint },
  })).signingCertificateSha256, fingerprint)
  assert.throws(() => resolveFreeMacBuildOptions(validOptions(t, {
    env: { CSC_NAME: 'identity', XINGMANG_MAC_SIGNING_SHA256: fingerprint, XINGMANG_RELEASE: '1' },
  })), /不能同时|冲突/)

  const rootOptions = validOptions(t)
  assert.throws(() => resolveFreeMacBuildOptions({ ...rootOptions, outputDirectory: '.' }), /独立|根目录/)
  const nonempty = path.join(rootOptions.projectRoot, 'occupied')
  fs.mkdirSync(nonempty)
  fs.writeFileSync(path.join(nonempty, 'keep.txt'), 'preserve')
  assert.throws(() => resolveFreeMacBuildOptions({ ...rootOptions, outputDirectory: nonempty }), /不是空目录/)
  assert.equal(fs.readFileSync(path.join(nonempty, 'keep.txt'), 'utf8'), 'preserve')

  const outside = temporaryProject(t)
  const escaped = path.join(rootOptions.projectRoot, 'escaped')
  fs.symlinkSync(outside, escaped)
  assert.throws(() => resolveFreeMacBuildOptions({
    ...rootOptions,
    outputDirectory: path.join(escaped, 'release-free-1.2.3'),
  }), /链接指向项目目录外/)

  assert.throws(() => resolveFreeMacBuildOptions(validOptions(t, {
    npmCliPath: '',
    env: { CSC_NAME: 'identity', XINGMANG_MAC_SIGNING_SHA256: fingerprint },
  })), /npm CLI/)
  assert.throws(() => resolveFreeMacBuildOptions(validOptions(t, {
    electronBuilderCliPath: undefined,
  })), /electron-builder/)
})

test('CI can reuse completed checks without requiring an npm parent process', (t) => {
  const options = validOptions(t, {
    npmCliPath: '',
    skipChecks: true,
  })
  assert.equal(resolveFreeMacBuildOptions(options).npmCliPath, undefined)
})

test('rejects an ambient development loopback updater before any signing or build work', async (t) => {
  let signingCalls = 0
  let commandCalls = 0
  let artifactCalls = 0
  await assert.rejects(() => runFreeMacBuild(validOptions(t, {
    env: {
      PATH: '/usr/bin:/bin',
      CSC_NAME: 'XingMang Free Update Identity',
      XINGMANG_MAC_SIGNING_SHA256: fingerprint,
      XINGMANG_UPDATE_DEV: '1',
      XINGMANG_UPDATE_URL: 'http://127.0.0.1:8123',
    },
    verifySigning: () => { signingCalls += 1 },
    commandRunner: async () => { commandCalls += 1 },
    verifyArtifacts: async () => { artifactCalls += 1 },
  })), /HTTPS|更新地址/)
  assert.equal(signingCalls, 0)
  assert.equal(commandCalls, 0)
  assert.equal(artifactCalls, 0)

  assert.throws(() => resolveFreeMacBuildOptions(validOptions(t, {
    env: {
      PATH: '/usr/bin:/bin',
      CSC_NAME: 'XingMang Free Update Identity',
      XINGMANG_MAC_SIGNING_SHA256: fingerprint,
      XINGMANG_UPDATE_URL: 'https://127.0.0.1:8123',
    },
  })), /loopback|HTTPS|更新地址/)
})

test('stops immediately after signing or child-command failure', async (t) => {
  let commands = 0
  let artifacts = 0
  await assert.rejects(() => runFreeMacBuild(validOptions(t, {
    verifySigning: () => { throw new Error('identity rejected') },
    commandRunner: async () => { commands += 1 },
    verifyArtifacts: async () => { artifacts += 1 },
  })), /identity rejected/)
  assert.equal(commands, 0)
  assert.equal(artifacts, 0)

  await assert.rejects(() => runFreeMacBuild(validOptions(t, {
    verifySigning: () => ({ identityName: 'XingMang Free Update Identity', fingerprint }),
    commandRunner: async () => {
      commands += 1
      throw new Error('typecheck failed')
    },
    verifyArtifacts: async () => { artifacts += 1 },
  })), /typecheck failed/)
  assert.equal(commands, 1)
  assert.equal(artifacts, 0)
})

test('stops at every nonzero command status and never verifies artifacts after builder failure', async (t) => {
  for (let failedCommand = 0; failedCommand < 4; failedCommand += 1) {
    const commands = []
    let artifacts = 0
    await assert.rejects(() => runFreeMacBuild(validOptions(t, {
      verifySigning: () => ({ identityName: 'XingMang Free Update Identity', fingerprint }),
      commandRunner: async (spec) => {
        commands.push(spec)
        if (commands.length - 1 === failedCommand) throw new Error(`${spec.label} 失败`)
      },
      verifyArtifacts: async () => { artifacts += 1 },
    })), /失败/)
    assert.equal(commands.length, failedCommand + 1)
    assert.equal(artifacts, 0)
  }
})

test('does not forward release secrets or permit a shell/publishing override', async (t) => {
  const commands = []
  const verifierCalls = []
  const secrets = {
    APPLE_API_KEY: 'do-not-forward',
    APPLE_API_KEY_ID: 'do-not-forward',
    APPLE_API_ISSUER: 'do-not-forward',
    APPLE_KEYCHAIN: 'do-not-forward',
    APPLE_KEYCHAIN_PROFILE: 'do-not-forward',
    APPLE_APP_SPECIFIC_PASSWORD: 'do-not-forward',
    APPLE_ID: 'do-not-forward@example.test',
    AZURE_CLIENT_SECRET: 'do-not-forward',
    AZURE_FUTURE_CREDENTIAL: 'do-not-forward',
    CSC_KEYCHAIN: 'do-not-forward',
    CSC_INSTALLER_KEY_PASSWORD: 'do-not-forward',
    CSC_INSTALLER_LINK: 'do-not-forward',
    CSC_KEY_PASSWORD: 'do-not-forward',
    CSC_FOR_PULL_REQUEST: 'do-not-forward',
    CSC_LINK: '/private/signing.p12',
    WIN_CSC_KEY_PASSWORD: 'do-not-forward',
    WIN_CSC_LINK: 'do-not-forward',
    XINGMANG_MAC_CI_EPHEMERAL_SIGNING: '1',
    XINGMANG_MAC_SIGNING_SHA1: 'do-not-forward',
    XINGMANG_MAC_SIGNING_P12_PASSWORD: 'do-not-forward',
  }
  await runFreeMacBuild(validOptions(t, {
    env: {
      PATH: '/usr/bin:/bin',
      CSC_NAME: 'XingMang Free Update Identity',
      XINGMANG_MAC_SIGNING_SHA256: fingerprint,
      XINGMANG_MAC_FREE_RELEASE: 'inherited-parent-value',
      XINGMANG_OUTPUT_DIR: 'inherited-parent-output',
      ...secrets,
    },
    outputDirectory: 'release-free-1.2.3',
    verifySigning: (value) => {
      verifierCalls.push(value)
      return { identityName: 'XingMang Free Update Identity', fingerprint }
    },
    commandRunner: async (spec) => { commands.push(spec) },
    verifyArtifacts: async (value) => {
      verifierCalls.push(value)
      return { outputDirectory: 'verified' }
    },
  }))

  for (const command of [...commands, ...verifierCalls]) {
    if (command.shell !== undefined) assert.equal(command.shell, false)
    if (command.argv) assert.equal(command.argv.includes('always'), false)
    for (const name of Object.keys(secrets)) assert.equal(command.env[name], undefined)
    assert.equal(JSON.stringify(command).includes('do-not-forward'), false)
  }
  assert.equal(verifierCalls[0].identityName, 'XingMang Free Update Identity')
  assert.equal(verifierCalls[0].expectedFingerprint, fingerprint)
  assert.equal(verifierCalls[1].identityName, 'XingMang Free Update Identity')
  assert.equal(verifierCalls[1].signingCertificateSha256, fingerprint)
  for (const command of commands.slice(0, 3)) {
    assert.equal(command.env.XINGMANG_MAC_FREE_RELEASE, undefined)
    assert.equal(command.env.XINGMANG_OUTPUT_DIR, undefined)
  }
  assert.equal(commands[3].env.XINGMANG_MAC_FREE_RELEASE, '1')
  assert.match(commands[3].env.XINGMANG_OUTPUT_DIR, /release-free-1\.2\.3$/)
})

test('scrubs ambient update development mode while propagating a normalized custom HTTPS URL', async (t) => {
  const commands = []
  let signingOptions
  let artifactOptions
  await runFreeMacBuild(validOptions(t, {
    env: {
      PATH: '/usr/bin:/bin',
      CSC_NAME: 'XingMang Free Update Identity',
      XINGMANG_MAC_SIGNING_SHA256: fingerprint,
      XINGMANG_UPDATE_DEV: '1',
      XINGMANG_UPDATE_URL: 'https://updates.example.test/custom',
    },
    verifySigning: (value) => {
      signingOptions = value
      return { identityName: 'XingMang Free Update Identity', fingerprint }
    },
    commandRunner: async (spec) => { commands.push(spec) },
    verifyArtifacts: async (value) => {
      artifactOptions = value
      return { outputDirectory: value.outputDirectory }
    },
  }))

  for (const command of commands) assert.equal(command.env.XINGMANG_UPDATE_DEV, undefined)
  assert.equal(signingOptions.env.XINGMANG_UPDATE_DEV, undefined)
  assert.equal(commands[3].env.XINGMANG_UPDATE_URL, 'https://updates.example.test/custom/')
  assert.equal(artifactOptions.expectedUpdateUrl, 'https://updates.example.test/custom/')
  assert.equal(artifactOptions.env.XINGMANG_UPDATE_DEV, undefined)
})

test('CI signing refuses a runner that is not a disposable hosted one', async (t) => {
  const projectRoot = temporaryProject(t)
  let certificateCalls = 0
  await assert.rejects(() => runCiFreeMacBuild({
    projectRoot,
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin', CI: 'true', RUNNER_ENVIRONMENT: 'self-hosted' },
    randomBytes: sequentialEntropy(),
    createCertificate: (value) => {
      certificateCalls += 1
      return writeCertificate(value)
    },
  }), /托管 runner/)
  assert.equal(certificateCalls, 0)
  assert.deepEqual(fs.readdirSync(projectRoot), [])
})

test('CI signing runs the real certificate preflight instead of a constant (P-20)', async (t) => {
  const projectRoot = temporaryProject(t)
  const preflightCalls = []
  let handedToBuild
  await runCiFreeMacBuild({
    projectRoot,
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    randomBytes: sequentialEntropy(),
    createCertificate: (value) => writeCertificate(value),
    certificateFingerprint: () => fingerprint,
    certificateSha1: () => sha1Fingerprint,
    runSecurity: (args) => {
      if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1), 'keychain')
      if (args[0] === 'list-keychains' && args.length === 3) {
        return '    "/Users/runner/Library/Keychains/login.keychain-db"\n'
      }
      return ''
    },
    verifyEphemeralSigning: () => ({ identitySha1: sha1Fingerprint }),
    verifySigning: (value) => {
      preflightCalls.push(value)
      return { identityName: value.identityName, fingerprint: value.expectedFingerprint }
    },
    runBuild: async (value) => {
      handedToBuild = value.verifySigning
      fs.mkdirSync(path.join(projectRoot, value.outputDirectory))
      return { outputDirectory: value.outputDirectory }
    },
    removeDirectory: (directory) => fs.rmSync(directory, { recursive: true, force: true }),
  })

  // The build resolves the preflight itself, so what matters is that what it
  // receives forwards to the real verifier rather than answering from a
  // literal — that literal is what kept the certificate policy checks out of
  // every CI run.
  assert.equal(typeof handedToBuild, 'function')
  assert.deepEqual(preflightCalls, [])
  const answer = await handedToBuild({
    identityName: 'XingMang CI Free Update Identity',
    expectedFingerprint: fingerprint,
    env: { PATH: '/usr/bin:/bin' },
  })

  assert.deepEqual(answer, { identityName: 'XingMang CI Free Update Identity', fingerprint })
  assert.equal(preflightCalls.length, 1)
  assert.equal(preflightCalls[0].identityName, 'XingMang CI Free Update Identity')
  assert.equal(preflightCalls[0].expectedFingerprint, fingerprint)
  // The throwaway keychain carries no Trust Settings, so only the trust filter
  // is relaxed; every certificate assertion runs unchanged.
  assert.equal(preflightCalls[0].trustedIdentitiesOnly, false)
})

test('CI signing draws the keychain password, the P12 password and the output name separately', async (t) => {
  const projectRoot = temporaryProject(t)
  let keychainPassword
  let p12Password
  let outputRequest
  await runCiFreeMacBuild({
    projectRoot,
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    randomBytes: sequentialEntropy(),
    createCertificate: (value) => {
      p12Password = value.password
      return writeCertificate(value)
    },
    certificateFingerprint: () => fingerprint,
    certificateSha1: () => sha1Fingerprint,
    runSecurity: (args) => {
      if (args[0] === 'create-keychain') {
        keychainPassword = args[2]
        fs.writeFileSync(args.at(-1), 'keychain')
      }
      if (args[0] === 'list-keychains' && args.length === 3) {
        return '    "/Users/runner/Library/Keychains/login.keychain-db"\n'
      }
      return ''
    },
    verifyEphemeralSigning: () => ({ identitySha1: sha1Fingerprint }),
    runBuild: async (value) => {
      outputRequest = value.outputDirectory
      fs.mkdirSync(path.join(projectRoot, value.outputDirectory))
      return { outputDirectory: value.outputDirectory }
    },
    removeDirectory: (directory) => fs.rmSync(directory, { recursive: true, force: true }),
  })

  const keychainEntropy = keychainPassword.slice('CiKeychain!'.length, -'Aa1'.length)
  const p12Entropy = p12Password.slice('CiP12!'.length, -'Aa1'.length)
  assert.equal(keychainEntropy.length, 32)
  assert.equal(p12Entropy.length, 32)
  // Either password leaking must not hand over the other, and the output
  // directory name is readable by anyone who can list the project root.
  assert.notEqual(keychainEntropy, p12Entropy)
  assert.equal(outputRequest.includes(keychainEntropy.slice(0, 12)), false)
  assert.equal(outputRequest.includes(p12Entropy.slice(0, 12)), false)
})

test('CI signing keeps passwords off argv by feeding the subcommand on stdin', async (t) => {
  const projectRoot = temporaryProject(t)
  const declared = []
  let keychainPassword
  let p12Password
  await runCiFreeMacBuild({
    projectRoot,
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    randomBytes: sequentialEntropy(),
    createCertificate: (value) => {
      p12Password = value.password
      return writeCertificate(value)
    },
    certificateFingerprint: () => fingerprint,
    certificateSha1: () => sha1Fingerprint,
    runSecurity: (args, commandOptions = {}) => {
      declared.push([args, commandOptions])
      if (args[0] === 'create-keychain') {
        keychainPassword = args[2]
        fs.writeFileSync(args.at(-1), 'keychain')
      }
      if (args[0] === 'list-keychains' && args.length === 3) {
        return '    "/Users/runner/Library/Keychains/login.keychain-db"\n'
      }
      return ''
    },
    verifyEphemeralSigning: () => ({ identitySha1: sha1Fingerprint }),
    runBuild: async (value) => {
      fs.mkdirSync(path.join(projectRoot, value.outputDirectory))
      return { outputDirectory: value.outputDirectory }
    },
    removeDirectory: (directory) => fs.rmSync(directory, { recursive: true, force: true }),
  })

  for (const [args, commandOptions] of declared) {
    const carriesSecret = args.some((argument) => argument === keychainPassword || argument === p12Password)
    assert.equal(carriesSecret, (commandOptions.secrets || []).length > 0)
    // Whatever the call site declares must actually resolve to a stdin-fed
    // invocation, otherwise the password is back on the command line.
    const command = resolveMacosSecurityCommand(args, commandOptions)
    if (carriesSecret) {
      assert.deepEqual(command.argv, ['-i'])
      assert.equal(command.stdin.includes(args[2]), true)
    } else {
      assert.equal(command.stdin, undefined)
    }
  }
  assert.equal(declared.some(([args]) => args[0] === 'import'), true)
})

test('CI signing restores the machine when the run is interrupted', async (t) => {
  const projectRoot = temporaryProject(t)
  const securityCalls = []
  const killed = []
  const listeners = new Map()
  const signalHandle = {
    pid: 4321,
    on: (signal, handler) => listeners.set(signal, [...(listeners.get(signal) || []), handler]),
    removeListener: (signal, handler) => listeners.set(
      signal,
      (listeners.get(signal) || []).filter((entry) => entry !== handler),
    ),
    kill: (pid, signal) => killed.push([pid, signal]),
  }
  let outputPath

  await runCiFreeMacBuild({
    projectRoot,
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    randomBytes: sequentialEntropy(),
    signalHandle,
    createCertificate: writeCertificate,
    certificateFingerprint: () => fingerprint,
    certificateSha1: () => sha1Fingerprint,
    runSecurity: (args) => {
      securityCalls.push(args)
      if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1), 'keychain')
      if (args[0] === 'list-keychains' && args.length === 3) {
        return '    "/Users/runner/Library/Keychains/login.keychain-db"\n'
      }
      return ''
    },
    verifyEphemeralSigning: () => ({ identitySha1: sha1Fingerprint }),
    runBuild: async (value) => {
      outputPath = path.join(projectRoot, value.outputDirectory)
      fs.mkdirSync(outputPath)
      assert.equal(listeners.get('SIGINT').length, 1)
      assert.equal(listeners.get('SIGTERM').length, 1)
      for (const handler of [...listeners.get('SIGINT')]) handler('SIGINT')
      return { outputDirectory: value.outputDirectory }
    },
    removeDirectory: (directory) => fs.rmSync(directory, { recursive: true, force: true }),
  })

  // The interrupt cleans up before the process dies, and re-raises the signal
  // so the caller still sees an interrupted run.
  assert.deepEqual(killed, [[4321, 'SIGINT']])
  assert.equal(fs.existsSync(outputPath), false)
  const restores = securityCalls.filter((args) => args[0] === 'list-keychains' && args[3] === '-s' && args.length === 5)
  assert.equal(restores.length, 1)
  assert.deepEqual(restores[0], [
    'list-keychains', '-d', 'user', '-s', '/Users/runner/Library/Keychains/login.keychain-db',
  ])
  // Cleanup is idempotent: the `finally` after the interrupt must not run it twice.
  assert.equal(securityCalls.filter((args) => args[0] === 'delete-keychain').length, 1)
  assert.deepEqual(listeners.get('SIGINT'), [])
  assert.deepEqual(listeners.get('SIGTERM'), [])
})

test('CI signing refuses to touch a keychain search list it cannot put back', async (t) => {
  for (const reply of ['', '   \n', '    "Library/Keychains/login.keychain-db"\n']) {
    const projectRoot = temporaryProject(t)
    const securityCalls = []
    await assert.rejects(() => runCiFreeMacBuild({
      projectRoot,
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin' },
      randomBytes: sequentialEntropy(),
      createCertificate: writeCertificate,
      certificateFingerprint: () => fingerprint,
      certificateSha1: () => sha1Fingerprint,
      runSecurity: (args) => {
        securityCalls.push(args)
        if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1), 'keychain')
        if (args[0] === 'list-keychains' && args.length === 3) return reply
        return ''
      },
      verifyEphemeralSigning: () => ({ identitySha1: sha1Fingerprint }),
      runBuild: async () => { throw new Error('unreachable') },
      removeDirectory: (directory) => fs.rmSync(directory, { recursive: true, force: true }),
    }), /搜索列表/)

    // Nothing was written to the search list, so nothing has to be restored —
    // and in particular no bare `-s` that would empty it.
    assert.equal(securityCalls.some((args) => args[0] === 'list-keychains' && args.includes('-s')), false)
    assert.equal(securityCalls.filter((args) => args[0] === 'delete-keychain').length, 1)
  }
})

test('build-mode and private packaging variables never reach the build children', async (t) => {
  const commands = []
  const verifierCalls = []
  const stripped = {
    XINGMANG_UNSIGNED_RELEASE: '1',
    XINGMANG_ACCELERATION_BUNDLE_DIR: '/private/acceleration',
    XINGMANG_SIGNING_PUBLISHER: 'CN=Someone Else',
    XINGMANG_LOCAL_BUILD: '1',
  }
  await runFreeMacBuild(validOptions(t, {
    env: {
      PATH: '/usr/bin:/bin',
      CSC_NAME: 'XingMang Free Update Identity',
      XINGMANG_MAC_SIGNING_SHA256: fingerprint,
      ...stripped,
    },
    verifySigning: (value) => {
      verifierCalls.push(value)
      return { identityName: value.identityName, fingerprint }
    },
    commandRunner: async (spec) => { commands.push(spec) },
    verifyArtifacts: async (value) => {
      verifierCalls.push(value)
      return { outputDirectory: value.outputDirectory }
    },
  }))

  for (const call of [...commands, ...verifierCalls]) {
    for (const name of Object.keys(stripped)) assert.equal(call.env[name], undefined)
  }
})

test('a failed build removes the output directory it created so the next run is re-enterable', async (t) => {
  const projectRoot = temporaryProject(t)
  const outputDirectory = path.join(projectRoot, 'release-free-1.2.3')
  const base = {
    projectRoot,
    platform: 'darwin',
    packageVersion: '1.2.3',
    skipChecks: true,
    npmCliPath: '/trusted/npm-cli.js',
    electronBuilderCliPath: '/trusted/electron-builder-cli.js',
    env: {
      PATH: '/usr/bin:/bin',
      CSC_NAME: 'XingMang Free Update Identity',
      XINGMANG_MAC_SIGNING_SHA256: fingerprint,
    },
    verifySigning: () => ({ identityName: 'XingMang Free Update Identity', fingerprint }),
    renameArtifacts: async () => {},
  }

  await assert.rejects(() => runFreeMacBuild({
    ...base,
    commandRunner: async () => {
      fs.writeFileSync(path.join(outputDirectory, 'half-written.dmg'), 'partial')
      throw new Error('electron-builder 中途失败')
    },
    verifyArtifacts: async () => { throw new Error('unreachable') },
  }), (error) => /electron-builder 中途失败/.test(error.message) && error.message.includes(outputDirectory))
  assert.equal(fs.existsSync(outputDirectory), false)

  const result = await runFreeMacBuild({
    ...base,
    commandRunner: async () => {},
    verifyArtifacts: async (value) => ({ outputDirectory: value.outputDirectory }),
  })
  assert.equal(result.outputDirectory, outputDirectory)
  assert.equal(fs.existsSync(outputDirectory), true)
})

test('renames the artifacts to their chip names before verification, with and without acceleration', async (t) => {
  for (const withAcceleration of [false, true]) {
    const order = []
    const renames = []
    const overrides = {
      skipChecks: true,
      verifySigning: () => ({ identityName: 'XingMang Free Update Identity', fingerprint }),
      commandRunner: async () => { order.push('build') },
      mergeArtifacts: async () => { order.push('merge') },
      renameArtifacts: async (value) => {
        order.push('rename')
        renames.push(value)
      },
      verifyArtifacts: async (value) => {
        order.push('verify')
        return { outputDirectory: value.outputDirectory }
      },
    }
    if (withAcceleration) {
      overrides.accelerationBundles = {
        arm64: stageAccelerationBundle(t, 'arm64'),
        x64: stageAccelerationBundle(t, 'x64'),
      }
    }
    const options = validOptions(t, overrides)

    await runFreeMacBuild(options)

    // 改名要在合并之后、校验之前：产物校验、SHA256SUMS 和更新清单核对认的都是
    // 带芯片名的发行名，改名跑晚一步就等于把构建名发出去。
    assert.deepEqual(
      order,
      withAcceleration ? ['build', 'build', 'merge', 'rename', 'verify'] : ['build', 'rename', 'verify'],
    )
    assert.deepEqual(renames, [{
      outputDirectory: path.join(options.projectRoot, 'release-free-1.2.3'),
      version: '1.2.3',
    }])
  }
})

test('a failed build keeps an output directory it did not create and names it in the error', async (t) => {
  const projectRoot = temporaryProject(t)
  const outputDirectory = path.join(projectRoot, 'caller-owned')
  fs.mkdirSync(outputDirectory)

  await assert.rejects(() => runFreeMacBuild({
    projectRoot,
    platform: 'darwin',
    packageVersion: '1.2.3',
    skipChecks: true,
    outputDirectory: 'caller-owned',
    npmCliPath: '/trusted/npm-cli.js',
    electronBuilderCliPath: '/trusted/electron-builder-cli.js',
    env: {
      PATH: '/usr/bin:/bin',
      CSC_NAME: 'XingMang Free Update Identity',
      XINGMANG_MAC_SIGNING_SHA256: fingerprint,
    },
    verifySigning: () => ({ identityName: 'XingMang Free Update Identity', fingerprint }),
    commandRunner: async () => {
      fs.writeFileSync(path.join(outputDirectory, 'half-written.dmg'), 'partial')
      throw new Error('产物验证失败')
    },
    verifyArtifacts: async () => { throw new Error('unreachable') },
  }), (error) => error.message.includes(outputDirectory))
  assert.equal(fs.existsSync(path.join(outputDirectory, 'half-written.dmg')), true)
})

function stageAccelerationBundle(t, architecture, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `xingmang-acceleration-${architecture}-`))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const manifest = {
    version: 2,
    platform: 'darwin',
    arch: architecture,
    coreFile: 'mihomo',
    coreSha256: 'a'.repeat(64),
    profileFile: 'profile.yaml',
    profileSha256: 'b'.repeat(64),
    coreVersion: 'v1.19.29',
    sourceRef: 'v1.19.29',
    sourceUrl: 'https://github.com/MetaCubeX/mihomo/tree/v1.19.29',
    licenseFile: 'LICENSE-mihomo.txt',
    noticesFile: 'THIRD-PARTY-NOTICES.txt',
    ...overrides,
  }
  fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return directory
}

test('carrying the private acceleration nodes is opt-in through the command line only', () => {
  assert.deepEqual(parseFreeMacBuildArguments([]), {
    ciTemporarySigning: false,
    keepPackage: false,
    rehearsalIdentity: undefined,
    accelerationBundles: undefined,
  })
  assert.deepEqual(parseFreeMacBuildArguments(['--ci-temporary-signing']), {
    ciTemporarySigning: true,
    keepPackage: false,
    rehearsalIdentity: undefined,
    accelerationBundles: undefined,
  })
  assert.deepEqual(
    parseFreeMacBuildArguments(['--acceleration-arm64', '/private/arm64', '--acceleration-x64', '/private/x64']),
    {
      ciTemporarySigning: false,
      keepPackage: false,
      rehearsalIdentity: undefined,
      accelerationBundles: { arm64: '/private/arm64', x64: '/private/x64' },
    },
  )

  // 只带一个架构会做出「一半用户有线路」的版本，产物校验也过不了。
  assert.throws(() => parseFreeMacBuildArguments(['--acceleration-arm64', '/private/arm64']), /同时提供/)
  assert.throws(() => parseFreeMacBuildArguments([
    '--acceleration-arm64', '/private/arm64',
    '--acceleration-arm64', '/private/again',
    '--acceleration-x64', '/private/x64',
  ]), /只能出现一次/)
  assert.throws(() => parseFreeMacBuildArguments([
    '--acceleration-arm64', '--acceleration-x64', '/private/x64',
  ]), /绝对路径/)
  // 2026-09-19 起线路资源可以在 runner 上现场准备，所以临时签名的 CI 构建也能
  // 带上线路；一次性签名身份与带不带线路本来就是两件事。
  assert.deepEqual(parseFreeMacBuildArguments([
    '--ci-temporary-signing',
    '--acceleration-arm64', '/private/arm64',
    '--acceleration-x64', '/private/x64',
  ]), {
    ciTemporarySigning: true,
    keepPackage: false,
    rehearsalIdentity: undefined,
    accelerationBundles: { arm64: '/private/arm64', x64: '/private/x64' },
  })
  assert.throws(() => parseFreeMacBuildArguments(['--acceleration']), /无法识别的参数/)
})

test('keeping the built package is opt-in and only meaningful for the CI signing rehearsal', () => {
  assert.deepEqual(parseFreeMacBuildArguments(['--ci-temporary-signing', '--ci-keep-package']), {
    ciTemporarySigning: true,
    keepPackage: true,
    rehearsalIdentity: undefined,
    accelerationBundles: undefined,
  })

  // 发布构建的产物本来就归发布者保管，静默接受这个开关会让人以为
  // dist:mac:free 也认它。
  assert.throws(() => parseFreeMacBuildArguments(['--ci-keep-package']), /只能与 --ci-temporary-signing/)
  assert.throws(() => parseFreeMacBuildArguments([
    '--ci-keep-package',
    '--acceleration-arm64', '/private/arm64',
    '--acceleration-x64', '/private/x64',
  ]), /只能与 --ci-temporary-signing/)
})

test('the release-path rehearsal is its own mode and cannot be mixed with temporary signing', () => {
  const rehearsal = 'A'.repeat(64)
  assert.deepEqual(parseFreeMacBuildArguments([
    '--rehearsal-identity', rehearsal,
    '--acceleration-arm64', '/private/arm64',
    '--acceleration-x64', '/private/x64',
  ]), {
    ciTemporarySigning: false,
    keepPackage: false,
    rehearsalIdentity: rehearsal,
    accelerationBundles: { arm64: '/private/arm64', x64: '/private/x64' },
  })

  // 一次性签名走自定义 sign 钩子，排练走的正是发布那条「electron-builder 自己按
  // 名字找身份」。同时给就说不清在验哪一条。
  assert.throws(
    () => parseFreeMacBuildArguments(['--ci-temporary-signing', '--rehearsal-identity', rehearsal]),
    /不能同时使用/,
  )
  assert.throws(() => parseFreeMacBuildArguments(['--rehearsal-identity']), /需要一个 SHA-256 指纹/)
  assert.throws(
    () => parseFreeMacBuildArguments(['--rehearsal-identity', '--acceleration-arm64']),
    /需要一个 SHA-256 指纹/,
  )
  assert.throws(
    () => parseFreeMacBuildArguments(['--rehearsal-identity', rehearsal, '--rehearsal-identity', rehearsal]),
    /只能出现一次/,
  )
})

test('a pull request build has to ask for signing explicitly or electron-builder skips it', (t) => {
  // electron-builder 在 pull_request 上默认整段跳过 macOS 签名，而且跳得很安静：
  // 包照样出，只是没签。排练不打开这一条，就会"通过"一个根本没签名的包，正好把
  // 它要验的东西验丢。发布走 workflow_dispatch，不需要它。
  assert.equal(
    resolveFreeMacBuildOptions(validOptions(t)).builderEnvironment.CSC_FOR_PULL_REQUEST,
    undefined,
  )
  assert.equal(
    resolveFreeMacBuildOptions(validOptions(t, { pullRequestSigning: true }))
      .builderEnvironment.CSC_FOR_PULL_REQUEST,
    'true',
  )
})

test('a kept CI package lands in a directory the workflow can name in advance', async (t) => {
  const projectRoot = temporaryProject(t)
  const removed = []
  let outputRequest
  const result = await runCiFreeMacBuild({
    projectRoot,
    platform: 'darwin',
    keepPackage: true,
    packageVersion: '9.9.9',
    env: { PATH: '/usr/bin:/bin' },
    randomBytes: sequentialEntropy(),
    createCertificate: (value) => writeCertificate(value),
    certificateFingerprint: () => fingerprint,
    certificateSha1: () => sha1Fingerprint,
    runSecurity: (args) => {
      if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1), 'keychain')
      if (args[0] === 'list-keychains' && args.length === 3) {
        return '    "/Users/runner/Library/Keychains/login.keychain-db"\n'
      }
      return ''
    },
    verifyEphemeralSigning: () => ({ identitySha1: sha1Fingerprint }),
    verifySigning: () => ({}),
    runBuild: async (value) => {
      outputRequest = value.outputDirectory
      fs.mkdirSync(path.join(projectRoot, value.outputDirectory))
      fs.writeFileSync(path.join(projectRoot, value.outputDirectory, 'SHA256SUMS'), 'sums')
      return { outputDirectory: path.join(projectRoot, value.outputDirectory) }
    },
    removeDirectory: (directory) => {
      removed.push(directory)
      fs.rmSync(directory, { recursive: true, force: true })
    },
  })

  // 工作流要在 upload-artifact 的 path 里写死这个名字，所以它不能带进程号或随机数。
  assert.equal(outputRequest, 'release-free-ci-9.9.9')
  assert.equal(result.keptOutputDirectory, path.join(projectRoot, 'release-free-ci-9.9.9'))
  assert.deepEqual(fs.readdirSync(projectRoot), ['release-free-ci-9.9.9'])
  assert.equal(removed.includes(path.join(projectRoot, 'release-free-ci-9.9.9')), false)
  // 签名材料照旧清理：留下的只有产物。
  const temporaryRoots = removed.filter((directory) => /xingmang-macos-free-ci-/.test(directory))
  assert.equal(temporaryRoots.length, 1)
})

test('the CI signing path hands the acceleration directories on to the build', async (t) => {
  // 这条链路上，线路资源是 runner 现场准备的，而 runCiFreeMacBuild 自己要组装
  // 一整套临时签名参数；漏掉转发不会报错，只会安静地做出一个没有加速的包。
  const projectRoot = temporaryProject(t)
  let received
  await runCiFreeMacBuild({
    projectRoot,
    platform: 'darwin',
    accelerationBundles: { arm64: '/private/arm64', x64: '/private/x64' },
    env: { PATH: '/usr/bin:/bin' },
    randomBytes: sequentialEntropy(),
    createCertificate: (value) => writeCertificate(value),
    certificateFingerprint: () => fingerprint,
    certificateSha1: () => sha1Fingerprint,
    runSecurity: (args) => {
      if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1), 'keychain')
      if (args[0] === 'list-keychains' && args.length === 3) {
        return '    "/Users/runner/Library/Keychains/login.keychain-db"\n'
      }
      return ''
    },
    verifyEphemeralSigning: () => ({ identitySha1: sha1Fingerprint }),
    verifySigning: () => ({}),
    runBuild: async (value) => {
      received = value.accelerationBundles
      fs.mkdirSync(path.join(projectRoot, value.outputDirectory))
      return { outputDirectory: path.join(projectRoot, value.outputDirectory) }
    },
    removeDirectory: (directory) => fs.rmSync(directory, { recursive: true, force: true }),
  })

  assert.deepEqual(received, { arm64: '/private/arm64', x64: '/private/x64' })
})

test('the rehearsal still takes its own output away when the package is not asked for', async (t) => {
  const projectRoot = temporaryProject(t)
  const result = await runCiFreeMacBuild({
    projectRoot,
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    randomBytes: sequentialEntropy(),
    createCertificate: (value) => writeCertificate(value),
    certificateFingerprint: () => fingerprint,
    certificateSha1: () => sha1Fingerprint,
    runSecurity: (args) => {
      if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1), 'keychain')
      if (args[0] === 'list-keychains' && args.length === 3) {
        return '    "/Users/runner/Library/Keychains/login.keychain-db"\n'
      }
      return ''
    },
    verifyEphemeralSigning: () => ({ identitySha1: sha1Fingerprint }),
    verifySigning: () => ({}),
    runBuild: async (value) => {
      fs.mkdirSync(path.join(projectRoot, value.outputDirectory))
      return { outputDirectory: path.join(projectRoot, value.outputDirectory) }
    },
    removeDirectory: (directory) => fs.rmSync(directory, { recursive: true, force: true }),
  })

  assert.equal(result.keptOutputDirectory, undefined)
  assert.deepEqual(fs.readdirSync(projectRoot), [])
})

test('an acceleration directory is checked against its own architecture before any build work', (t) => {
  const arm64 = stageAccelerationBundle(t, 'arm64')
  const x64 = stageAccelerationBundle(t, 'x64')
  const swapped = validOptions(t, { accelerationBundles: { arm64: x64, x64: arm64 } })
  assert.throws(() => resolveFreeMacBuildOptions(swapped), /不是 arm64 架构/)

  assert.throws(() => resolveFreeMacBuildOptions(validOptions(t, {
    accelerationBundles: { arm64, x64: arm64 },
  })), /不是 x64 架构/)

  const windowsBundle = stageAccelerationBundle(t, 'arm64', {
    version: 1,
    platform: undefined,
    arch: undefined,
    coreFile: 'mihomo.exe',
  })
  assert.throws(() => resolveFreeMacBuildOptions(validOptions(t, {
    accelerationBundles: { arm64: windowsBundle, x64 },
  })), /不是 arm64 架构|资源清单无效/)

  assert.throws(() => resolveFreeMacBuildOptions(validOptions(t, {
    accelerationBundles: { arm64: 'private/arm64', x64 },
  })), /必须是绝对路径/)

  const inProject = validOptions(t)
  const inside = path.join(inProject.projectRoot, 'acceleration')
  fs.mkdirSync(inside)
  assert.throws(() => resolveFreeMacBuildOptions({
    ...inProject,
    accelerationBundles: { arm64: inside, x64 },
  }), /项目目录之外/)

  const missingManifest = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-acceleration-empty-'))
  t.after(() => fs.rmSync(missingManifest, { recursive: true, force: true }))
  assert.throws(() => resolveFreeMacBuildOptions(validOptions(t, {
    accelerationBundles: { arm64: missingManifest, x64 },
  })), /缺少资源清单/)
})

test('an acceleration build packs each architecture on its own and merges the two outputs', async (t) => {
  const arm64 = stageAccelerationBundle(t, 'arm64')
  const x64 = stageAccelerationBundle(t, 'x64')
  const builds = []
  const merges = []
  const options = validOptions(t, {
    skipChecks: true,
    accelerationBundles: { arm64, x64 },
    env: {
      PATH: '/usr/bin:/bin',
      CSC_NAME: 'XingMang Free Update Identity',
      XINGMANG_MAC_SIGNING_SHA256: fingerprint,
      // 继承来的同名变量仍然被清洗掉，只有命令行给的目录会被写回。
      XINGMANG_ACCELERATION_BUNDLE_DIR: '/private/stale',
    },
    verifySigning: () => ({ identityName: 'XingMang Free Update Identity', fingerprint }),
    commandRunner: async (spec) => { builds.push(spec) },
    mergeArtifacts: async (value) => { merges.push(value) },
    verifyArtifacts: async (value) => ({ outputDirectory: value.outputDirectory }),
  })

  const result = await runFreeMacBuild(options)

  const outputDirectory = path.join(options.projectRoot, 'release-free-1.2.3')
  assert.equal(result.outputDirectory, outputDirectory)
  assert.equal(builds.length, 2)
  assert.deepEqual(builds.map((spec) => spec.argv), [
    [
      '/trusted/electron-builder-cli.js',
      '--config', 'electron-builder.config.cjs',
      '--mac', 'dmg', 'zip',
      '--arm64',
      '--publish', 'never',
    ],
    [
      '/trusted/electron-builder-cli.js',
      '--config', 'electron-builder.config.cjs',
      '--mac', 'dmg', 'zip',
      '--x64',
      '--publish', 'never',
    ],
  ])
  assert.deepEqual(builds.map((spec) => spec.env.XINGMANG_ACCELERATION_BUNDLE_DIR), [arm64, x64])
  assert.deepEqual(builds.map((spec) => spec.env.XINGMANG_OUTPUT_DIR), [
    path.join(outputDirectory, 'arch-arm64'),
    path.join(outputDirectory, 'arch-x64'),
  ])
  for (const spec of builds) assert.equal(spec.env.XINGMANG_MAC_FREE_RELEASE, '1')
  assert.deepEqual(merges, [{
    outputDirectory,
    version: '1.2.3',
    stages: [
      { architecture: 'arm64', directory: path.join(outputDirectory, 'arch-arm64') },
      { architecture: 'x64', directory: path.join(outputDirectory, 'arch-x64') },
    ],
  }])
})

test('without the flags the build stays one dual-architecture run that carries no private resources', async (t) => {
  const builds = []
  const merges = []
  const options = validOptions(t, {
    skipChecks: true,
    env: {
      PATH: '/usr/bin:/bin',
      CSC_NAME: 'XingMang Free Update Identity',
      XINGMANG_MAC_SIGNING_SHA256: fingerprint,
      XINGMANG_ACCELERATION_BUNDLE_DIR: '/private/stale',
    },
    verifySigning: () => ({ identityName: 'XingMang Free Update Identity', fingerprint }),
    commandRunner: async (spec) => { builds.push(spec) },
    mergeArtifacts: async (value) => { merges.push(value) },
    verifyArtifacts: async (value) => ({ outputDirectory: value.outputDirectory }),
  })

  await runFreeMacBuild(options)

  assert.equal(builds.length, 1)
  assert.deepEqual(builds[0].argv.slice(-4), ['--arm64', '--x64', '--publish', 'never'])
  assert.equal(builds[0].env.XINGMANG_ACCELERATION_BUNDLE_DIR, undefined)
  assert.equal(
    builds[0].env.XINGMANG_OUTPUT_DIR,
    path.join(options.projectRoot, 'release-free-1.2.3'),
  )
  assert.deepEqual(merges, [])
})
