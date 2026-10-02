const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  assertReleaseNotesVersionIsPublishable,
  assertRemoteVersionIsPublishable,
  parsePreflightArguments,
  readReleaseNotesVersion,
} = require('./verify-release-environment.cjs')

const repositoryRoot = path.resolve(__dirname, '..')
const publicRelease = { publicReleaseMode: true }
const localBuild = { publicReleaseMode: false }

function releaseNotes(firstLine) {
  return [firstLine, '', '- 本次的条目。', '', '0.2.5', '', '- 上一版的条目。', ''].join('\n')
}

test('the first non-empty line is the version the notes declare', () => {
  assert.equal(readReleaseNotesVersion(releaseNotes('0.2.6')), '0.2.6')
  assert.equal(readReleaseNotesVersion('\r\n\r\n  0.2.6  \r\n\r\n- 条目\r\n'), '0.2.6')
  assert.equal(readReleaseNotesVersion(''), '')
})

test('a public release requires the notes to declare the version being built', () => {
  assert.equal(assertReleaseNotesVersionIsPublishable(publicRelease, releaseNotes('0.2.6'), '0.2.6'), true)
})

test('a public release refuses notes still headed by the unreleased section', () => {
  assert.throws(
    () => assertReleaseNotesVersionIsPublishable(publicRelease, releaseNotes('未发布'), '0.2.6'),
    (error) => {
      assert.equal(error.code, 'RELEASE_NOTES_VERSION_MISMATCH')
      assert.match(error.message, /未发布/)
      assert.match(error.message, /0\.2\.6/)
      return true
    },
  )
})

test('a public release refuses notes left on the previous version', () => {
  assert.throws(
    () => assertReleaseNotesVersionIsPublishable(publicRelease, releaseNotes('0.2.5'), '0.2.6'),
    (error) => error.code === 'RELEASE_NOTES_VERSION_MISMATCH',
  )
})

test('a public release refuses empty notes', () => {
  assert.throws(
    () => assertReleaseNotesVersionIsPublishable(publicRelease, '\n\n', '0.2.6'),
    (error) => {
      assert.equal(error.code, 'RELEASE_NOTES_VERSION_MISMATCH')
      assert.match(error.message, /空文件/)
      return true
    },
  )
})

test('a local debug build does not require the notes to be renamed yet', () => {
  assert.equal(assertReleaseNotesVersionIsPublishable(localBuild, releaseNotes('未发布'), '0.2.6'), false)
})

test('the committed notes are either still unreleased or exactly the packaged version', () => {
  const declared = readReleaseNotesVersion(fs.readFileSync(path.join(repositoryRoot, 'release-notes.md'), 'utf8'))
  const { version } = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'))
  assert.ok(
    declared === '未发布' || declared === version,
    `release-notes.md 的第一行是「${declared}」，既不是「未发布」也不是 package.json 的 ${version}`,
  )
})

test('a public release refuses an update feed that is not older than the build', () => {
  const feed = { missing: false, metadata: { version: '0.2.6' } }
  assert.throws(() => assertRemoteVersionIsPublishable(publicRelease, feed, '0.2.6'))
  assert.equal(assertRemoteVersionIsPublishable(publicRelease, { missing: true }, '0.2.6'), false)
  assert.equal(assertRemoteVersionIsPublishable(localBuild, feed, '0.2.6'), false)
})

test('the preflight compares the Windows manifest unless a Linux architecture is named', () => {
  // release:build 与 release:build:unsigned 一直不带参数调它，那条路不能变。
  assert.deepEqual(parsePreflightArguments([]), { platform: 'windows', metadataFile: 'latest.yml' })
  // Linux 每个架构只比它自己那份：先发 Windows、之后在同一个 commit 上补发 Linux 时，
  // 拿 latest.yml 来比会把补发当成「同版本已发布」拦下。
  assert.deepEqual(parsePreflightArguments(['--platform', 'linux', '--arch', 'x64']), { platform: 'linux', arch: 'x64', metadataFile: 'latest-linux.yml' })
  assert.deepEqual(parsePreflightArguments(['--platform', 'linux', '--arch', 'arm64']), { platform: 'linux', arch: 'arm64', metadataFile: 'latest-linux-arm64.yml' })
  const invalid = (error) => error.code === 'PREFLIGHT_PLATFORM_INVALID'
  assert.throws(() => parsePreflightArguments(['--platform', 'linux']), invalid)
  assert.throws(() => parsePreflightArguments(['--platform', 'linux', '--arch', 'ia32']), invalid)
  // macOS 出包走 dist:mac:free，从不调这道前置检查；认不出的平台照样拒绝，不猜。
  assert.throws(() => parsePreflightArguments(['--platform', 'macos']), invalid)
})
