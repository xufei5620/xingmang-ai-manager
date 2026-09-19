const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { NEW_UPDATE_URL } = require('./update-release-utils.cjs')
const { BUILD_MODE_ENVIRONMENT_NAMES } = require('./run-macos-free-build.cjs')

const root = path.resolve(__dirname, '..')
const configPath = path.join(root, 'electron-builder.config.cjs')
const packageJson = require(path.join(root, 'package.json'))

const STRICT_ENTITLEMENT_KEYS = ['com.apple.security.cs.allow-jit']
const LIBRARY_VALIDATION_ESCAPE = 'com.apple.security.cs.disable-library-validation'

// 这些用例靠 spawn 一个子进程加载 electron-builder.config.cjs 来观察它的判断，
// 所以子进程看到的构建模式变量必须由用例自己说了算。直接摊开 process.env 会让
// 结果取决于谁在跑：`release:build:unsigned` 的发布门禁自己就带着
// XINGMANG_UNSIGNED_RELEASE=1 跑 npm test，配置于是在用例的断言之前先抛「两种
// 发布模式不能同时启用」，五条用例一起红，而在开发机上它们全绿。
function cleanBuildEnvironment() {
  const environment = { ...process.env }
  for (const name of BUILD_MODE_ENVIRONMENT_NAMES) delete environment[name]
  return environment
}

function entitlementKeys(relativePath) {
  const contents = fs.readFileSync(path.join(root, relativePath), 'utf8')
  const dictionary = contents.slice(contents.indexOf('<dict>'), contents.indexOf('</dict>'))
  return [...dictionary.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1])
}

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
      ...cleanBuildEnvironment(),
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

function runBeforePack({ electronPlatformName, releaseMode = false, freeReleaseMode = false, signingIdentity }) {
  return spawnSync(process.execPath, ['-e', `
    const config = require(${JSON.stringify(configPath)})
    config.beforePack({ electronPlatformName: ${JSON.stringify(electronPlatformName)}, arch: 1 })
      .then(() => process.stdout.write('ok'))
      .catch((error) => { process.stderr.write(String(error && error.message)); process.exit(3) })
  `], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...cleanBuildEnvironment(),
      XINGMANG_RELEASE: releaseMode ? '1' : '0',
      XINGMANG_MAC_FREE_RELEASE: freeReleaseMode ? '1' : '0',
      XINGMANG_LOCAL_BUILD: '0',
      CSC_NAME: signingIdentity || '',
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      CSC_FOR_PULL_REQUEST: undefined,
      XINGMANG_MAC_CI_EPHEMERAL_SIGNING: '0',
      XINGMANG_UPDATE_DEV: '0',
      XINGMANG_UNSIGNED_RELEASE: '0',
      XINGMANG_UPDATE_URL: '',
      XINGMANG_ACCELERATION_BUNDLE_DIR: '',
    },
  })
}

test('macOS targets produce per-architecture DMG and ZIP candidates', () => {
  const config = loadConfig()

  assert.deepEqual(config.mac.target, [
    { target: 'dmg', arch: ['arm64', 'x64'] },
    { target: 'zip', arch: ['arm64', 'x64'] },
  ])
  assert.equal(config.mac.artifactName, 'XingMang-AI-Manager-${version}-${arch}.${ext}')
  assert.equal(config.mac.icon, 'assets/brand/v3/app-icon.icns')
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

test('unsigned releases tell the main process that no installer signature is checked', () => {
  // The flag is what switches the updater to user-confirmed download/install
  // plus its own manifest digest check (M-02), so it has to track publisherName.
  const unsigned = loadConfig({ unsignedRelease: true })
  assert.equal(unsigned.extraMetadata.xingmangUnsignedRelease, true)
  assert.equal(unsigned.publish.publisherName, undefined)

  const signed = loadConfig({ releaseMode: true })
  assert.equal(signed.extraMetadata.xingmangUnsignedRelease, false)
  assert.deepEqual(signed.publish.publisherName, ['绍兴星芒文化传媒有限责任公司'])

  assert.equal(loadConfig().extraMetadata.xingmangUnsignedRelease, false)
  assert.equal(
    loadConfig({ unsignedRelease: true, localBuildMode: true }).extraMetadata.xingmangUnsignedRelease,
    false,
  )
})

test('macOS local builds use only an ad-hoc identity while release mode discovers one', () => {
  const localConfig = loadConfig()
  const releaseConfig = loadConfig({ releaseMode: true })

  assert.equal(localConfig.mac.identity, '-')
  assert.equal(localConfig.forceCodeSigning, false)
  assert.equal(localConfig.extraMetadata.xingmangLocalBuild, true)
  assert.equal(releaseConfig.mac.identity, undefined)
  assert.equal(releaseConfig.forceCodeSigning, true)
  assert.equal(releaseConfig.extraMetadata.xingmangLocalBuild, false)
})

test('notarization stays explicitly disabled in every build mode (P-23)', () => {
  // `false` is load-bearing, not a default: electron-builder only skips
  // notarization when the option is exactly false. Left undefined it derives
  // credentials from whatever APPLE_* variables happen to be exported and
  // uploads the app to Apple - on the very Mac that signs the free builds.
  for (const mode of [
    {},
    { localBuildMode: true },
    { releaseMode: true },
    { unsignedRelease: true },
    { freeReleaseMode: true, signingIdentity: 'XingMang Free Update Identity' },
  ]) {
    // assert.equal also rejects undefined, which is the failure being guarded.
    assert.equal(loadConfig(mode).mac.notarize, false)
  }
})

test('packaging a macOS artifact under the Windows release channel fails closed (P-23)', () => {
  // A Developer ID signature without notarization packages cleanly and is then
  // refused by Gatekeeper on every customer machine, so the build must stop.
  const rejected = runBeforePack({ electronPlatformName: 'darwin', releaseMode: true })
  assert.equal(rejected.status, 3, rejected.stdout)
  assert.match(rejected.stderr, /XINGMANG_RELEASE=1|XINGMANG_MAC_FREE_RELEASE/)

  for (const allowed of [
    { electronPlatformName: 'win32', releaseMode: true },
    { electronPlatformName: 'darwin' },
    {
      electronPlatformName: 'darwin',
      freeReleaseMode: true,
      signingIdentity: 'XingMang Free Update Identity',
    },
  ]) {
    const result = runBeforePack(allowed)
    assert.equal(result.status, 0, result.stderr)
  }
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
        ...cleanBuildEnvironment(),
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
        ...cleanBuildEnvironment(),
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
        ...cleanBuildEnvironment(),
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
      ...cleanBuildEnvironment(),
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
      ...cleanBuildEnvironment(),
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
        ...cleanBuildEnvironment(),
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

test('the strict entitlements stay on disk for the day an Apple issued signature exists', () => {
  // These files are what every macOS build used until 2026-09-19, and what it
  // goes back to once a Developer ID signature is available. Without them on
  // disk electron-builder silently falls back to its own template, which
  // grants the escape hatch plus two more keys to every build.
  for (const file of ['build/entitlements.mac.plist', 'build/entitlements.mac.inherit.plist']) {
    assert.deepEqual(entitlementKeys(file), STRICT_ENTITLEMENT_KEYS, file)
  }
})

test('every macOS build this repository can sign grants the library validation exception', () => {
  // Library validation compares team identifiers, and only Apple issues one.
  // An ad-hoc signature has none and neither does any self-signed certificate
  // this repository can mint, so a build that withholds the exception is
  // killed by dyld while loading its own Electron framework -- which is what
  // the 2026-09-19 test package did on both architectures. Every mode below
  // is signed that way, so every mode gets the exception.
  for (const mode of [
    {},
    { localBuildMode: true },
    { releaseMode: true, localBuildMode: true },
    { freeReleaseMode: true, signingIdentity: 'XingMang Free Update Identity' },
    {
      freeReleaseMode: true,
      signingIdentity: 'XingMang CI Free Update Identity',
      ephemeralSigning: true,
      signingSha1: 'CD'.repeat(20),
      keychainPath: '/private/tmp/xingmang-ci-signing.keychain-db',
    },
  ]) {
    const config = loadConfig(mode)
    assert.equal(config.mac.entitlements, 'build/entitlements.mac.adhoc.plist')
    assert.equal(config.mac.entitlementsInherit, 'build/entitlements.mac.adhoc.inherit.plist')
  }

  for (const file of ['build/entitlements.mac.adhoc.plist', 'build/entitlements.mac.adhoc.inherit.plist']) {
    const keys = entitlementKeys(file)
    assert.deepEqual(keys, [...STRICT_ENTITLEMENT_KEYS, LIBRARY_VALIDATION_ESCAPE], file)
  }
})

test('every entitlements plist stays a well-formed dictionary of granted keys', () => {
  for (const file of [
    'build/entitlements.mac.plist',
    'build/entitlements.mac.inherit.plist',
    'build/entitlements.mac.adhoc.plist',
    'build/entitlements.mac.adhoc.inherit.plist',
  ]) {
    const contents = fs.readFileSync(path.join(root, file), 'utf8')
    // A double hyphen inside a comment makes the document invalid XML, and
    // codesign then fails the whole build with an unhelpful parse error.
    for (const [, comment] of contents.matchAll(/<!--([\s\S]*?)-->/g)) {
      assert.ok(!comment.includes('--'), `${file} has a comment XML cannot represent`)
    }
    const dictionary = contents.slice(contents.indexOf('<dict>'), contents.indexOf('</dict>'))
    const entries = [...dictionary.matchAll(/<key>([^<]+)<\/key>\s*<(\w+)\/>/g)]
    assert.equal(entries.length, entitlementKeys(file).length, `${file} must grant every key it lists`)
    for (const [, key, value] of entries) {
      assert.equal(value, 'true', `${file} must grant ${key} as a boolean`)
    }
  }
})

test('a build mode inherited from the surrounding process cannot decide what these tests see', () => {
  // 这条钉的是 2026-09-19 那次 CI 出包失败：发布门禁（release:build:unsigned）自己
  // 带着 XINGMANG_UNSIGNED_RELEASE=1 跑 npm test，本文件里几处 spawn 摊开 process.env
  // 就把它带给了子进程，electron-builder.config.cjs 于是在用例的断言之前先抛「两种
  // 发布模式不能同时启用」。表现是「开发机上全绿、发布门禁里红五条」，而报错内容
  // 看起来像配置坏了，很难往环境继承上想。
  const previous = process.env.XINGMANG_UNSIGNED_RELEASE
  process.env.XINGMANG_UNSIGNED_RELEASE = '1'
  try {
    for (const name of BUILD_MODE_ENVIRONMENT_NAMES) {
      assert.equal(name in cleanBuildEnvironment(), false, `${name} 不能从外层环境继承进来`)
    }
    // 真的加载一次配置：loadConfig 自己会断言子进程退出码为 0。
    assert.equal(typeof loadConfig().forceCodeSigning, 'boolean')
  } finally {
    if (previous === undefined) delete process.env.XINGMANG_UNSIGNED_RELEASE
    else process.env.XINGMANG_UNSIGNED_RELEASE = previous
  }
})
