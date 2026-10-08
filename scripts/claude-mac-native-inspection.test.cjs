const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { SOURCES, inspectPackage, validateInspection, darwinClaudeRequirement } = require('./sync-claude-official-cos.cjs')

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'claude-pkg-native-test-'))
  t.after(async function () { await fs.rm(directory, { recursive: true, force: true }) })
  const calls = []
  async function run(executable, args, config) {
    calls.push({ executable, args })
    assert.equal(config.env.COS_SECRET_ID, undefined)
    assert.equal(config.env.COS_SECRET_KEY, undefined)
    assert.equal(config.timeout, 120000)
    if (executable === '/usr/sbin/pkgutil' && args[0] === '--check-signature') {
      return { stdout: `Package "mock.pkg":\n Status: ${options.status || 'signed by a developer certificate issued by Apple for distribution'}\n Certificate Chain:\n 1. ${options.installer || 'Developer ID Installer: Anthropic PBC (Q6L2SF6YDW)'}\n 2. Developer ID Certification Authority\n 3. ${options.rootIssuer || 'Apple Root CA'}\n`, stderr: '' }
    }
    if (executable === '/usr/sbin/pkgutil' && args[0] === '--expand-full') {
      const expanded = args[2]
      await fs.mkdir(expanded)
      await fs.writeFile(path.join(expanded, 'PackageInfo'), '<pkg-info identifier="com.anthropic.claudefordesktop" version="@electron/osx-sign pkg-utils"/>')
      if (options.noApplication) return { stdout: '', stderr: '' }
      for (let index = 0; index < (options.twoApplications ? 2 : 1); index += 1) {
        const application = path.join(expanded, `component-${index}`, 'Payload', 'Applications', 'Claude.app')
        const macos = path.join(application, 'Contents', 'MacOS')
        await fs.mkdir(macos, { recursive: true })
        await fs.writeFile(path.join(application, 'Contents', 'Info.plist'), '<plist/>')
        const binary = path.join(macos, 'Claude')
        if (options.outsideExecutable) {
          const outside = path.join(directory, 'outside-binary')
          await fs.writeFile(outside, Buffer.alloc(16))
          try { await fs.symlink(outside, binary) } catch (error) {
            if (process.platform === 'win32' && error?.code === 'EPERM') options.symlinkPermissionUnavailable = true
            throw error
          }
        } else {
          await fs.writeFile(binary, Buffer.alloc(16))
          if (options.hardlinkExecutable) await fs.link(binary, path.join(macos, 'second-link'))
        }
      }
      return { stdout: '', stderr: '' }
    }
    if (executable === '/usr/bin/plutil') return { stdout: JSON.stringify({ CFBundleExecutable: 'Claude', CFBundleIdentifier: options.identifier || 'com.anthropic.claudefordesktop', CFBundleShortVersionString: '2.19675.0' }), stderr: '' }
    if (executable === '/usr/bin/codesign' && args[0] === '--display') return { stdout: '', stderr: `Authority=Developer ID Application: Anthropic PBC (${options.appTeam || 'Q6L2SF6YDW'})\n` }
    if (executable === '/usr/bin/codesign' && args[0] === '--verify') {
      assert.ok(args.includes('--strict'))
      assert.ok(args.includes('--deep'))
      assert.ok(args.includes(`-R=${darwinClaudeRequirement('Q6L2SF6YDW')}`))
      if (options.nativeVerifyFailure) throw new Error('Mock native Apple chain verification failure')
      return { stdout: '', stderr: '' }
    }
    if (executable === '/usr/bin/lipo') return { stdout: options.architectures || 'x86_64 arm64\n', stderr: '' }
    throw new Error('Unexpected native command')
  }
  return { calls, inspect: function () { return inspectPackage({ filePath: path.join(directory, 'mock.pkg'), source: SOURCES['macos-pkg-universal'], workDirectory: directory, run, platform: 'darwin' }) } }
}

test('verifies the exact Apple installer and payload signer and takes version and architecture from the real app', async t => {
  const value = await fixture(t)
  const report = await value.inspect()
  const validated = validateInspection(report, SOURCES['macos-pkg-universal'])
  assert.equal(validated.version, '2.19675.0')
  assert.equal(validated.teamIdentifier, 'Q6L2SF6YDW')
  assert.equal(validated.installerSignatureStatus, 'Valid')
  assert.equal(validated.architectureProof, 'native-payload-mach-o')
  assert.deepEqual(validated.architectures, ['arm64', 'x86_64'])
  assert.ok(value.calls.some(call => call.executable === '/usr/bin/lipo'))
  assert.equal(value.calls.some(call => call.args.includes('--expand')), false)
  assert.equal(value.calls.some(call => /installer|open|osascript/.test(call.executable)), false)
})

test('rejects another installer team, organization, root or untrusted status before archive expansion', async t => {
  for (const options of [{ installer: 'Developer ID Installer: Anthropic PBC (TEAM000001)' },
    { installer: 'Developer ID Installer: Attacker (Q6L2SF6YDW)' }, { rootIssuer: 'Attacker Root CA' }, { status: 'signed by an untrusted certificate' }]) {
    const value = await fixture(t, options)
    await assert.rejects(value.inspect(), /官方安装者签名或可信链无效/)
    assert.equal(value.calls.some(call => call.args[0] === '--expand-full'), false)
  }
})

test('rejects a missing or ambiguous payload app before treating a PKG URL as architecture proof', async t => {
  for (const options of [{ noApplication: true }, { twoApplications: true }]) {
    const value = await fixture(t, options)
    await assert.rejects(value.inspect(), /唯一的实际 Claude.app/)
    assert.equal(value.calls.some(call => call.executable === '/usr/bin/lipo'), false)
  }
})

test('rejects another payload team and native verification failure before claiming a trusted application', async t => {
  const team = await fixture(t, { appTeam: 'TEAM000001' })
  await assert.rejects(team.inspect(), /Team 候选/)
  assert.equal(team.calls.some(call => call.args[0] === '--verify'), false)
  const rejected = await fixture(t, { nativeVerifyFailure: true })
  await assert.rejects(rejected.inspect(), /原生只读包检查失败/)
  assert.equal(rejected.calls.some(call => call.executable === '/usr/bin/lipo'), false)
})

test('rejects single-architecture or incorrect-bundle reports and obsolete URL-only architecture claims', async t => {
  for (const options of [{ architectures: 'arm64\n' }, { identifier: 'com.attacker.app' }]) {
    const value = await fixture(t, options)
    const report = await value.inspect()
    assert.throws(() => validateInspection(report, SOURCES['macos-pkg-universal']), /应用身份、固定 Team 或 Universal/)
  }
  const valid = await fixture(t)
  const report = await valid.inspect()
  report.architectureProof = 'official-universal-endpoint'
  assert.throws(() => validateInspection(report, SOURCES['macos-pkg-universal']), /实际架构记录无效/)
})

test('rejects a hardlinked payload executable before native code is inspected', async t => {
  const value = await fixture(t, { hardlinkExecutable: true })
  await assert.rejects(value.inspect(), /不是单链接普通文件/)
  assert.equal(value.calls.some(call => call.args[0] === '--verify'), false)
})

test('rejects an executable symlink outside private payload staging', async t => {
  const options = { outsideExecutable: true }
  const value = await fixture(t, options)
  let failure
  try { await value.inspect() } catch (error) { failure = error }
  if (options.symlinkPermissionUnavailable) { t.skip('Windows symbolic link permission is unavailable'); return }
  assert.match(failure?.message || '', /越出私有目录或不是单链接普通文件/)
  assert.equal(value.calls.some(call => call.args[0] === '--verify'), false)
})
