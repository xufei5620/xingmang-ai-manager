const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { BUILD_MODE_ENVIRONMENT_NAMES } = require('./run-macos-free-build.cjs')

const root = path.resolve(__dirname, '..')
const configPath = path.join(root, 'electron-builder.config.cjs')
const packageJson = require(path.join(root, 'package.json'))
const afterInstallPath = path.join(root, 'build', 'linux', 'after-install.tpl')
const upstreamAfterInstallPath = require.resolve('app-builder-lib/templates/linux/after-install.tpl')

const SANDBOX_DISABLING = /no-sandbox|disable-gpu-sandbox|disable-setuid-sandbox|ELECTRON_DISABLE_SANDBOX/i

// Same reason as macos-build-config.test.cjs: the child must see only the build
// mode a case asks for, not whatever the shell running npm test carries.
function cleanBuildEnvironment(overrides) {
  const environment = { ...process.env }
  for (const name of BUILD_MODE_ENVIRONMENT_NAMES) delete environment[name]
  return { ...environment, CSC_IDENTITY_AUTO_DISCOVERY: 'false', ...overrides }
}

function loadConfig(overrides = {}) {
  const result = spawnSync(process.execPath, ['-e', `
    const config = require(${JSON.stringify(configPath)})
    process.stdout.write(JSON.stringify({
      productName: config.productName,
      linux: config.linux,
      deb: config.deb,
      appImage: config.appImage,
      snap: config.snap,
      extraMetadata: config.extraMetadata,
      protocols: config.protocols,
    }))
  `], { cwd: root, encoding: 'utf8', env: cleanBuildEnvironment(overrides) })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function runBeforePack(electronPlatformName, overrides = {}) {
  return spawnSync(process.execPath, ['-e', `
    const config = require(${JSON.stringify(configPath)})
    config.beforePack({ electronPlatformName: ${JSON.stringify(electronPlatformName)}, arch: 1 })
      .then(() => process.stdout.write('ok'))
      .catch((error) => { process.stderr.write(String(error && error.message)); process.exit(3) })
  `], { cwd: root, encoding: 'utf8', env: cleanBuildEnvironment(overrides) })
}

test('Linux ships one deb per architecture and nothing else', () => {
  const config = loadConfig({ XINGMANG_LINUX_PACKAGE: '1', XINGMANG_LOCAL_BUILD: '1' })
  // AppImage starts with the Chromium sandbox off on Ubuntu 23.10+ and points
  // Claude Code's hook scripts into a mount that vanishes when the app quits;
  // snap and flatpak confine $HOME and terminal launches. docs/LINUX.md.
  assert.deepEqual(config.linux.target, [{ target: 'deb', arch: ['x64', 'arm64'] }])
  assert.equal(config.appImage, undefined)
  assert.equal(config.snap, undefined)
})

test('the Linux package installs under an ASCII name while the menu keeps the Chinese one', () => {
  const linuxBuild = loadConfig({ XINGMANG_LINUX_PACKAGE: '1', XINGMANG_LOCAL_BUILD: '1' })
  assert.equal(linuxBuild.productName, 'xingmang-ai-manager')
  assert.equal(linuxBuild.linux.executableName, 'xingmang-ai-manager')
  assert.equal(linuxBuild.deb.packageName, 'xingmang-ai-manager')
  assert.equal(linuxBuild.linux.desktop.entry.Name, '星芒AI管理工具')
  // Electron derives the window's app_id from desktopName; electron-builder
  // writes the same name into StartupWMClass only with syncDesktopName.
  assert.equal(linuxBuild.extraMetadata.desktopName, 'xingmang-ai-manager.desktop')
  assert.equal(linuxBuild.linux.syncDesktopName, true)
  assert.deepEqual(linuxBuild.protocols, [{ name: '星芒AI管理工具', schemes: ['xingmang'] }])

  // Every other platform keeps the product name customers already see, and a
  // packaged package.json without the Linux-only fields.
  const otherBuild = loadConfig()
  assert.equal(otherBuild.productName, '星芒AI管理工具')
  for (const field of ['desktopName', 'homepage', 'license']) {
    assert.equal(otherBuild.extraMetadata[field], undefined, field)
  }
})

test('a malformed Linux marker is refused instead of guessed', () => {
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(configPath)})`], {
    cwd: root,
    encoding: 'utf8',
    env: cleanBuildEnvironment({ XINGMANG_LINUX_PACKAGE: 'yes' }),
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /XINGMANG_LINUX_PACKAGE 只接受精确的 0 或 1/)
})

test('beforePack only lets a marked Linux build through, local or unsigned release', () => {
  const linuxLocal = runBeforePack('linux', { XINGMANG_LINUX_PACKAGE: '1', XINGMANG_LOCAL_BUILD: '1' })
  assert.equal(linuxLocal.status, 0, linuxLocal.stderr)

  // Without the marker the payload would land in /opt/星芒AI管理工具.
  const unmarked = runBeforePack('linux', { XINGMANG_LOCAL_BUILD: '1' })
  assert.notEqual(unmarked.status, 0)
  assert.match(unmarked.stderr, /npm run build:linux/)

  // The marker renames the product, so it must never reach another platform.
  for (const platform of ['win32', 'darwin']) {
    const marked = runBeforePack(platform, { XINGMANG_LINUX_PACKAGE: '1', XINGMANG_LOCAL_BUILD: '1' })
    assert.notEqual(marked.status, 0, platform)
    assert.match(marked.stderr, /只用于 Linux 安装包/)
  }

  // The release package (npm run release:package:linux) is the unsigned
  // release mode with the updater on.
  const unsignedRelease = runBeforePack('linux', { XINGMANG_LINUX_PACKAGE: '1', XINGMANG_UNSIGNED_RELEASE: '1', XINGMANG_LOCAL_BUILD: '0' })
  assert.equal(unsignedRelease.status, 0, unsignedRelease.stderr)

  // The two signed release modes promise a signature a deb never carries.
  for (const mode of [{ XINGMANG_RELEASE: '1' }, { XINGMANG_MAC_FREE_RELEASE: '1', CSC_NAME: 'XingMang Test Identity' }]) {
    const signedRelease = runBeforePack('linux', { XINGMANG_LINUX_PACKAGE: '1', ...mode })
    assert.notEqual(signedRelease.status, 0, JSON.stringify(mode))
    assert.match(signedRelease.stderr, /没有代码签名，发布只能走 npm run release:package:linux/)
  }
})

test('nothing in the Linux packaging can switch the Chromium sandbox off', () => {
  const config = loadConfig({ XINGMANG_LINUX_PACKAGE: '1', XINGMANG_LOCAL_BUILD: '1' })
  // executableArgs is copied verbatim into the menu entry's Exec line.
  assert.equal(config.linux.executableArgs, undefined)
  assert.doesNotMatch(JSON.stringify({ linux: config.linux, deb: config.deb }), SANDBOX_DISABLING)
  assert.doesNotMatch(fs.readFileSync(afterInstallPath, 'utf8'), SANDBOX_DISABLING)
  for (const name of ['build:linux', 'build:linux:ci']) {
    assert.doesNotMatch(packageJson.scripts[name], SANDBOX_DISABLING, name)
  }
})

test('postinst always installs chrome-sandbox setuid root', () => {
  const template = fs.readFileSync(afterInstallPath, 'utf8')
  assert.ok(template.startsWith('#!/bin/bash\n'), 'the shebang has to stay on the first line of postinst')
  assert.ok(template.includes("chown root:root '/opt/${sanitizedProductName}/chrome-sandbox'"))
  assert.ok(template.includes("chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox'"))
  // Upstream decides with a user-namespace probe that runs as root inside
  // postinst, where it nearly always succeeds; the customer's own launch then
  // finds neither a usable namespace nor a setuid helper.
  const commands = template.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
  assert.doesNotMatch(commands, /\bunshare\b/)
  // FpmTarget throws on any macro it does not define.
  const macros = new Set([...template.matchAll(/\$\{([a-zA-Z]+)\}/g)].map((match) => match[1]))
  assert.deepEqual([...macros].sort(), ['executable', 'sanitizedProductName'])
})

test('the postinst template tracks upstream outside the chrome-sandbox block', () => {
  // Copied from electron-builder so the rest (update-alternatives, the
  // Ubuntu 24.04 AppArmor profile) keeps upstream's behaviour. When an
  // electron-builder upgrade changes upstream, this fails and the copy has to
  // be re-synced by hand rather than silently drifting.
  const strip = (source) => source
    .replace(/^# Copied from app-builder-lib[^\n]*\n#[^\n]*\n/m, '')
    .replace(/# 星芒AI管理工具: always install chrome-sandbox[\s\S]*?\nfi\n/, '<sandbox>\n')
    .replace(/# Check if user namespaces are supported[\s\S]*?\nfi\n/, '<sandbox>\n')
  assert.equal(
    strip(fs.readFileSync(afterInstallPath, 'utf8')),
    strip(fs.readFileSync(upstreamAfterInstallPath, 'utf8')),
  )
})

test('the deb declares what the Electron binary needs at run time', () => {
  const { deb, linux } = loadConfig({ XINGMANG_LINUX_PACKAGE: '1', XINGMANG_LOCAL_BUILD: '1' })
  assert.equal(deb.afterInstall, 'build/linux/after-install.tpl')
  for (const required of ['libsecret-1-0', 'libgbm1', 'libnss3', 'libxkbcommon0', 'libudev1']) {
    assert.ok(deb.depends.includes(required), required)
  }
  // Ubuntu 24.04's t64 rename: listing only the old name works there through
  // Provides, listing only the new one breaks every older release.
  for (const pair of ['libasound2t64 | libasound2', 'libgtk-3-0t64 | libgtk-3-0', 'libcups2t64 | libcups2']) {
    assert.ok(deb.depends.includes(pair), pair)
  }
  assert.ok(deb.recommends.some((entry) => entry.startsWith('fonts-noto-cjk')), 'the interface is all Chinese')
  // electron-builder's default Recommends no longer exists on current Ubuntu.
  assert.equal(deb.recommends.some((entry) => /^libappindicator3-1\b/.test(entry)), false)
  assert.ok(linux.maintainer && linux.vendor)
})

test('the Linux build scripts produce local deb packages only', () => {
  for (const name of ['build:linux', 'build:linux:ci']) {
    const script = packageJson.scripts[name]
    assert.match(script, /XINGMANG_LINUX_PACKAGE=1/, name)
    assert.match(script, /XINGMANG_LOCAL_BUILD=1/, name)
    assert.match(script, /--linux deb\b/, name)
    assert.match(script, /--publish never/, name)
    assert.match(script, /npm run compile/, name)
  }
  assert.match(packageJson.scripts['build:linux'], /npm run typecheck && npm test/)
})
