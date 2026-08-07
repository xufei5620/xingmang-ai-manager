const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
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

const fingerprint = 'AB'.repeat(32)
const sha1Fingerprint = 'CD'.repeat(20)

test('admin trust commands use absolute non-interactive sudo while user commands do not', () => {
  assert.deepEqual(resolveMacosSecurityCommand(['list-keychains', '-d', 'user']), {
    executable: '/usr/bin/security',
    argv: ['list-keychains', '-d', 'user'],
    label: 'security list-keychains',
  })
  assert.deepEqual(resolveMacosSecurityCommand([
    'add-trusted-cert', '-d', '/tmp/identity.cer',
  ], { privilege: 'admin' }), {
    executable: '/usr/bin/sudo',
    argv: [
      '-n', '/usr/bin/security',
      'add-trusted-cert', '-d', '/tmp/identity.cer',
    ],
    label: '无交互管理员 security add-trusted-cert',
  })
})

test('CI signing uses an isolated keychain and always restores and removes it', async (t) => {
  const projectRoot = temporaryProject(t)
  const calls = []
  const removed = []
  const result = await runCiFreeMacBuild({
    projectRoot,
    env: { PATH: '/usr/bin:/bin' },
    randomBytes: () => Buffer.from('1234567890abcdef', 'hex'),
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
      if (args[0] === 'list-keychains' && !args.includes('-s')) {
        return '    "/Users/runner/Library/Keychains/login.keychain-db"\n'
      }
      return ''
    },
    runBuild: async (options) => {
      calls.push(['build', options])
      assert.equal(options.env.CSC_NAME, 'XingMang CI Free Update Identity')
      assert.equal(options.env.XINGMANG_MAC_SIGNING_SHA256, fingerprint)
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
  const userSecurityCalls = securityCalls
    .filter(([, , commandOptions]) => commandOptions.privilege !== 'admin')
    .map(([, args]) => args)
  const adminSecurityCalls = securityCalls
    .filter(([, , commandOptions]) => commandOptions.privilege === 'admin')
    .map(([, args]) => args)
  assert.deepEqual(userSecurityCalls.map((args) => args[0]), [
    'list-keychains',
    'create-keychain',
    'set-keychain-settings',
    'unlock-keychain',
    'import',
    'set-key-partition-list',
    'list-keychains',
    'list-keychains',
    'delete-keychain',
  ])
  assert.deepEqual(userSecurityCalls.at(6), [
    'list-keychains', '-d', 'user', '-s',
    userSecurityCalls[1].at(-1),
  ])
  assert.deepEqual(userSecurityCalls.at(-2), [
    'list-keychains', '-d', 'user', '-s', '/Users/runner/Library/Keychains/login.keychain-db',
  ])
  assert.deepEqual(adminSecurityCalls.map((args) => args[0]), [
    'add-trusted-cert',
    'remove-trusted-cert',
    'delete-certificate',
  ])
  assert.equal(adminSecurityCalls[0].includes('-d'), true)
  assert.equal(adminSecurityCalls[1].includes('-d'), true)
  assert.deepEqual(adminSecurityCalls[2], [
    'delete-certificate', '-Z', sha1Fingerprint, '/Library/Keychains/System.keychain',
  ])
  assert.equal(removed.length, 2)
})

test('CI signing never restores an empty keychain list when the initial snapshot fails', async (t) => {
  const projectRoot = temporaryProject(t)
  const securityCalls = []
  const removed = []

  await assert.rejects(() => runCiFreeMacBuild({
    projectRoot,
    env: { PATH: '/usr/bin:/bin' },
    randomBytes: () => Buffer.from('1234567890abcdef', 'hex'),
    runSecurity: (args) => {
      securityCalls.push(args)
      throw new Error('keychain snapshot failed')
    },
    removeDirectory: (directory) => {
      removed.push(directory)
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }), /keychain snapshot failed/)

  assert.deepEqual(securityCalls, [['list-keychains', '-d', 'user']])
  assert.equal(removed.length, 2)
})

test('CI signing compensates a partially applied administrator trust command', async (t) => {
  const projectRoot = temporaryProject(t)
  const securityCalls = []

  await assert.rejects(() => runCiFreeMacBuild({
    projectRoot,
    env: { PATH: '/usr/bin:/bin' },
    randomBytes: () => Buffer.from('1234567890abcdef', 'hex'),
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
      if (args[0] === 'list-keychains' && !args.includes('-s')) {
        return '"/Users/runner/Library/Keychains/login.keychain-db"\n'
      }
      if (args[0] === 'add-trusted-cert') throw new Error('trust command timed out')
      return ''
    },
  }), /trust command timed out/)

  const cleanupCommands = securityCalls
    .filter(([, commandOptions]) => commandOptions.privilege === 'admin')
    .map(([args]) => args)
  assert.deepEqual(cleanupCommands.map((args) => args[0]), [
    'add-trusted-cert',
    'remove-trusted-cert',
    'delete-certificate',
  ])
  assert.deepEqual(cleanupCommands[2], [
    'delete-certificate', '-Z', sha1Fingerprint, '/Library/Keychains/System.keychain',
  ])
})

test('CI signing does not run administrator cleanup before trust mutation starts', async (t) => {
  const projectRoot = temporaryProject(t)
  const securityCalls = []

  await assert.rejects(() => runCiFreeMacBuild({
    projectRoot,
    env: { PATH: '/usr/bin:/bin' },
    randomBytes: () => Buffer.from('1234567890abcdef', 'hex'),
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
      if (args[0] === 'list-keychains' && !args.includes('-s')) {
        return '"/Users/runner/Library/Keychains/login.keychain-db"\n'
      }
      if (args[0] === 'import') throw new Error('identity import failed')
      return ''
    },
  }), /identity import failed/)

  assert.deepEqual(
    securityCalls.filter(([, options]) => options.privilege === 'admin'),
    [],
  )
})

test('CI signing cleanup runs when the real free build fails', async (t) => {
  const projectRoot = temporaryProject(t)
  const securityCalls = []
  const removed = []
  await assert.rejects(() => runCiFreeMacBuild({
    projectRoot,
    env: { PATH: '/usr/bin:/bin' },
    randomBytes: () => Buffer.from('1234567890abcdef', 'hex'),
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
      return args[0] === 'list-keychains' && !args.includes('-s')
        ? '"/Users/runner/Library/Keychains/login.keychain-db"\n'
        : ''
    },
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
  assert.equal(securityCalls.some(([args]) => args[0] === 'list-keychains' && args.includes('-s')), true)
  assert.equal(securityCalls.some(([args, options]) => (
    args[0] === 'remove-trusted-cert' && options.privilege === 'admin'
  )), true)
  assert.equal(removed.length, 2)
})

test('CI signing attempts every cleanup action when one cleanup command fails', async (t) => {
  const projectRoot = temporaryProject(t)
  const securityCalls = []
  const removed = []
  await assert.rejects(() => runCiFreeMacBuild({
    projectRoot,
    env: { PATH: '/usr/bin:/bin' },
    randomBytes: () => Buffer.from('1234567890abcdef', 'hex'),
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
      if (args[0] === 'remove-trusted-cert' && commandOptions.privilege === 'admin') {
        throw new Error('cleanup trust failed')
      }
      return ''
    },
    runBuild: async ({ outputDirectory }) => {
      fs.mkdirSync(path.join(projectRoot, outputDirectory))
      return { outputDirectory }
    },
    removeDirectory: (directory) => {
      removed.push(directory)
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }), /cleanup trust failed/)

  assert.equal(securityCalls.filter(([args]) => args[0] === 'list-keychains' && args.includes('-s')).length, 2)
  assert.equal(securityCalls.some(([args]) => args[0] === 'delete-keychain'), true)
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
        return { status: commands.length - 1 === failedCommand ? 1 : 0 }
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
    CSC_LINK: '/private/signing.p12',
    WIN_CSC_KEY_PASSWORD: 'do-not-forward',
    WIN_CSC_LINK: 'do-not-forward',
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
