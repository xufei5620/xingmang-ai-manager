const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { NEW_UPDATE_URL } = require('./update-release-utils.cjs')

const root = path.resolve(__dirname, '..')
const configPath = path.join(root, 'electron-builder.config.cjs')
const packageJson = require(path.join(root, 'package.json'))

function loadConfig({
  releaseMode = false,
  freeReleaseMode = false,
  localBuildMode = false,
  signingIdentity,
  ephemeralSigning = false,
  signingSha1,
  keychainPath,
  updateDev = false,
  unsignedRelease = false,
  updateUrl,
} = {}) {
  const result = spawnSync(process.execPath, ['-e', `
    const config = require(${JSON.stringify(configPath)})
    process.stdout.write(JSON.stringify({
      forceCodeSigning: config.forceCodeSigning,
      mac: config.mac,
      dmg: config.dmg,
      win: config.win,
      extraMetadata: config.extraMetadata,
      publish: config.publish,
    }))
  `], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      XINGMANG_RELEASE: releaseMode ? '1' : '0',
      XINGMANG_MAC_FREE_RELEASE: freeReleaseMode ? '1' : '0',
      XINGMANG_LOCAL_BUILD: localBuildMode ? '1' : '0',
      CSC_NAME: signingIdentity || '',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      CSC_KEYCHAIN: keychainPath || '',
      ...(ephemeralSigning ? { CSC_FOR_PULL_REQUEST: 'true' } : { CSC_FOR_PULL_REQUEST: undefined }),
      XINGMANG_MAC_CI_EPHEMERAL_SIGNING: ephemeralSigning ? '1' : '0',
      XINGMANG_MAC_SIGNING_SHA1: signingSha1 || '',
      XINGMANG_UPDATE_DEV: updateDev ? '1' : '0',
      XINGMANG_UNSIGNED_RELEASE: unsignedRelease ? '1' : '0',
      XINGMANG_UPDATE_URL: updateUrl || '',
    },
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('macOS targets produce per-architecture DMG and ZIP candidates', () => {
  const config = loadConfig()

  assert.deepEqual(config.mac.target, [
    { target: 'dmg', arch: ['arm64', 'x64'] },
    { target: 'zip', arch: ['arm64', 'x64'] },
  ])
  assert.equal(config.mac.artifactName, 'XingMang-AI-Manager-${version}-${arch}.${ext}')
  assert.equal(config.mac.icon, 'assets/icon.icns')
  assert.equal(config.mac.category, 'public.app-category.developer-tools')
  assert.equal(config.mac.minimumSystemVersion, '13.0')
  assert.equal(config.mac.hardenedRuntime, true)
  assert.deepEqual(config.win.target, [{ target: 'nsis', arch: ['x64'] }])
})

test('current package builds embed the new R2 update feed by default', () => {
  assert.equal(loadConfig().publish.url, NEW_UPDATE_URL)
})

test('explicit unsigned release mode keeps the updater enabled without forcing signing', () => {
  const config = loadConfig({ unsignedRelease: true })
  assert.equal(config.extraMetadata.xingmangLocalBuild, false)
  assert.equal(config.forceCodeSigning, false)
  assert.equal(config.publish.publisherName, undefined)
})

test('macOS local builds use only an ad-hoc identity while notarization stays release-only', () => {
  const localConfig = loadConfig()
  const releaseConfig = loadConfig({ releaseMode: true })

  assert.equal(localConfig.mac.notarize, false)
  assert.equal(localConfig.mac.identity, '-')
  assert.equal(localConfig.forceCodeSigning, false)
  assert.equal(localConfig.extraMetadata.xingmangLocalBuild, true)
  assert.equal(releaseConfig.mac.notarize, true)
  assert.equal(releaseConfig.mac.identity, undefined)
  assert.equal(releaseConfig.forceCodeSigning, true)
  assert.equal(releaseConfig.extraMetadata.xingmangLocalBuild, false)
})

test('explicit local build mode cannot inherit a public release mode', () => {
  for (const inheritedMode of [
    { releaseMode: true },
    { freeReleaseMode: true, signingIdentity: 'XingMang Free Update Identity' },
  ]) {
    const config = loadConfig({ ...inheritedMode, localBuildMode: true })
    assert.equal(config.mac.notarize, false)
    assert.equal(config.mac.identity, '-')
    assert.equal(config.forceCodeSigning, false)
    assert.equal(config.extraMetadata.xingmangLocalBuild, true)
    assert.equal(config.publish.publisherName, undefined)
  }
})

test('ordinary build commands explicitly select local mode before electron-builder', () => {
  for (const name of ['build', 'build:mac', 'build:mac:dir']) {
    const command = packageJson.scripts[name]
    const builderIndex = command.indexOf('electron-builder')
    assert.notEqual(builderIndex, -1, `${name} must invoke electron-builder`)
    const environmentPrefix = command.slice(0, builderIndex)
    assert.match(environmentPrefix, /XINGMANG_LOCAL_BUILD=1/)
  }
})

test('free macOS releases use the selected persistent identity without notarization', () => {
  const freeConfig = loadConfig({
    freeReleaseMode: true,
    signingIdentity: 'XingMang Free Update Identity',
    updateUrl: 'https://updates.example.test/free',
  })

  assert.equal(freeConfig.mac.identity, 'XingMang Free Update Identity')
  assert.equal(freeConfig.mac.notarize, false)
  assert.equal(freeConfig.mac.timestamp, 'none')
  assert.equal(freeConfig.mac.sign, undefined)
  assert.equal(freeConfig.dmg.writeUpdateInfo, false)
  assert.equal(freeConfig.forceCodeSigning, true)
  assert.equal(freeConfig.extraMetadata.xingmangLocalBuild, false)
  assert.equal(freeConfig.publish.url, 'https://updates.example.test/free/')
})

test('CI free signing bypasses trusted-identity discovery only through the pinned custom signer', () => {
  const config = loadConfig({
    freeReleaseMode: true,
    signingIdentity: 'XingMang CI Free Update Identity',
    ephemeralSigning: true,
    signingSha1: 'CD'.repeat(20),
    keychainPath: '/private/tmp/xingmang-ci-signing.keychain-db',
    updateUrl: 'https://updates.example.test/free',
  })

  assert.equal(config.mac.identity, '-')
  assert.equal(config.mac.sign, './scripts/macos-ephemeral-signing.cjs')
  assert.equal(config.mac.notarize, false)
  assert.equal(config.mac.timestamp, 'none')
  assert.equal(config.forceCodeSigning, true)
  assert.equal(config.extraMetadata.xingmangLocalBuild, false)
})

test('ephemeral signing rejects missing pins and every non-CI build mode', () => {
  for (const environment of [
    {
      XINGMANG_MAC_FREE_RELEASE: '0',
      XINGMANG_MAC_CI_EPHEMERAL_SIGNING: '1',
      XINGMANG_MAC_SIGNING_SHA1: 'CD'.repeat(20),
      CSC_KEYCHAIN: '/private/tmp/xingmang-ci-signing.keychain-db',
      CSC_FOR_PULL_REQUEST: 'true',
    },
    {
      XINGMANG_MAC_FREE_RELEASE: '1',
      XINGMANG_MAC_CI_EPHEMERAL_SIGNING: '1',
      XINGMANG_MAC_SIGNING_SHA1: '',
      CSC_KEYCHAIN: '/private/tmp/xingmang-ci-signing.keychain-db',
      CSC_FOR_PULL_REQUEST: 'true',
    },
    {
      XINGMANG_MAC_FREE_RELEASE: '1',
      XINGMANG_MAC_CI_EPHEMERAL_SIGNING: '1',
      XINGMANG_MAC_SIGNING_SHA1: 'CD'.repeat(20),
      CSC_KEYCHAIN: '',
      CSC_FOR_PULL_REQUEST: 'true',
    },
    {
      XINGMANG_MAC_FREE_RELEASE: '1',
      XINGMANG_MAC_CI_EPHEMERAL_SIGNING: '1',
      XINGMANG_MAC_SIGNING_SHA1: 'CD'.repeat(20),
      CSC_KEYCHAIN: '/private/tmp/xingmang-ci-signing.keychain-db',
      CSC_FOR_PULL_REQUEST: '',
    },
  ]) {
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(configPath)})`], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        XINGMANG_RELEASE: '0',
        XINGMANG_LOCAL_BUILD: '0',
        CSC_NAME: 'XingMang CI Free Update Identity',
        XINGMANG_UPDATE_URL: 'https://updates.example.test/free',
        ...environment,
      },
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /ephemeral|SHA-1|keychain|CI/i)
  }
})

test('ephemeral signing mode rejects every non-empty marker other than exact 0 or 1', () => {
  for (const marker of ['true', '01', ' 1']) {
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(configPath)})`], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        XINGMANG_RELEASE: '0',
        XINGMANG_MAC_FREE_RELEASE: '1',
        XINGMANG_LOCAL_BUILD: '0',
        XINGMANG_MAC_CI_EPHEMERAL_SIGNING: marker,
        XINGMANG_MAC_SIGNING_SHA1: 'CD'.repeat(20),
        CSC_NAME: 'XingMang CI Free Update Identity',
        CSC_KEYCHAIN: '/private/tmp/xingmang-ci-signing.keychain-db',
        CSC_FOR_PULL_REQUEST: 'true',
      },
    })
    assert.notEqual(result.status, 0, `marker ${JSON.stringify(marker)} must fail closed`)
    assert.match(result.stderr, /XINGMANG_MAC_CI_EPHEMERAL_SIGNING|0|1/)
  }
})

test('persistent signing rejects every electron-builder-truthy PR override', () => {
  for (const pullRequestValue of ['true', '1', '']) {
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(configPath)})`], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        XINGMANG_RELEASE: '1',
        XINGMANG_MAC_FREE_RELEASE: '0',
        XINGMANG_LOCAL_BUILD: '0',
        XINGMANG_MAC_CI_EPHEMERAL_SIGNING: '0',
        CSC_FOR_PULL_REQUEST: pullRequestValue,
      },
    })
    assert.notEqual(result.status, 0, `CSC_FOR_PULL_REQUEST=${JSON.stringify(pullRequestValue)} must fail closed`)
    assert.match(result.stderr, /CSC_FOR_PULL_REQUEST|PR|ephemeral/i)
  }
})

test('free macOS releases reject development updater mode before emitting a public artifact config', () => {
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(configPath)})`], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      XINGMANG_RELEASE: '0',
      XINGMANG_MAC_FREE_RELEASE: '1',
      CSC_NAME: 'XingMang Free Update Identity',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      XINGMANG_UPDATE_DEV: '1',
      XINGMANG_UPDATE_URL: 'http://127.0.0.1:8123',
    },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /XINGMANG_UPDATE_DEV|免费发布|开发更新/)
})

test('Developer ID releases reject development updater mode before emitting a public artifact config', () => {
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(configPath)})`], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      XINGMANG_RELEASE: '1',
      XINGMANG_MAC_FREE_RELEASE: '0',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      XINGMANG_UPDATE_DEV: '1',
      XINGMANG_UPDATE_URL: 'http://127.0.0.1:8123',
    },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /XINGMANG_UPDATE_DEV|公开发布|开发更新/)
})

test('unpackaged development builds retain their explicit loopback update feed', () => {
  const config = loadConfig({
    updateDev: true,
    updateUrl: 'http://127.0.0.1:8123',
  })
  assert.equal(config.publish.url, 'http://127.0.0.1:8123/')
  assert.equal(config.extraMetadata.xingmangLocalBuild, true)
})

test('free macOS releases require a selected identity and cannot overlap Developer ID mode', () => {
  for (const environment of [
    { freeReleaseMode: true },
    { releaseMode: true, freeReleaseMode: true, signingIdentity: 'XingMang Free Update Identity' },
  ]) {
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(configPath)})`], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        XINGMANG_RELEASE: environment.releaseMode ? '1' : '0',
        XINGMANG_MAC_FREE_RELEASE: environment.freeReleaseMode ? '1' : '0',
        CSC_NAME: environment.signingIdentity || '',
        CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      },
    })
    assert.notEqual(result.status, 0)
  }
})

test('free macOS certificate creation is exposed through a focused command', () => {
  assert.equal(
    packageJson.scripts['mac:free:create-certificate'],
    'node scripts/create-macos-free-signing-certificate.cjs',
  )
})
