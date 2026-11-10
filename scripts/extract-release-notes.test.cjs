const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { extractReleaseNotes, feedReleaseNotes, parseArguments } = require('./extract-release-notes.cjs')
const { BUILD_MODE_ENVIRONMENT_NAMES } = require('./run-macos-free-build.cjs')

const projectRoot = path.resolve(__dirname, '..')

const sample = [
  '0.2.7',
  '',
  '- 新增了一件事。',
  '- 修了另一件事。',
  '',
  '0.2.6',
  '',
  '- 上一版的内容。',
  '',
].join('\n')

test('only the section being released is taken, not the whole file', () => {
  assert.equal(extractReleaseNotes(sample, '0.2.7'), '- 新增了一件事。\n- 修了另一件事。\n')
})

test('asking for a version that is not the newest fails instead of quietly shipping it', () => {
  // release-notes.md 的首行必须等于 package.json 的版本号（P-14），所以要发的那一版
  // 必然是第一节。取到别的节说明版本收口没做或做错了，这时候发出去比失败更糟。
  assert.throws(() => extractReleaseNotes(sample, '0.2.6'), /第一节是 0\.2\.7/)
  assert.throws(() => extractReleaseNotes(sample, '0.9.9'), /第一节是 0\.2\.7/)
})

test('a section with nothing under it is refused', () => {
  // 空正文的 Release 读起来像"这一版什么都没改"，而真实原因多半是汇总那一步漏了。
  assert.throws(() => extractReleaseNotes('0.2.7\n\n0.2.6\n\n- 旧的。\n', '0.2.7'), /这一节是空的/)
  assert.throws(() => extractReleaseNotes('还没发布过任何版本\n', '0.2.7'), /找不到任何版本小节/)
})

test('the last section runs to the end of the file', () => {
  assert.equal(extractReleaseNotes('0.2.7\n\n- 唯一一条。\n', '0.2.7'), '- 唯一一条。\n')
})

test('a version that is not a version number is refused before the file is read', () => {
  for (const value of ['', 'v0.2.7', '0.2', '0.2.7-beta', '../../etc/passwd']) {
    assert.throws(() => extractReleaseNotes(sample, value), /版本号格式无效/)
  }
})

test('the release notes shipped in the repository yield a non-empty section', () => {
  // 这条同时钉住了两件事：文件格式没被改成别的样子，以及首节与 package.json 一致。
  const version = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version
  const notes = extractReleaseNotes(fs.readFileSync(path.join(projectRoot, 'release-notes.md'), 'utf8'), version)
  assert.ok(notes.trim().startsWith('- '), notes.slice(0, 80))
})

test('the update feed carries only the section being released, without its version line', () => {
  // 原来整份 release-notes.md 都进了 latest.yml，0.2.22、0.2.23 的版本页把它挤成一大段、还接着前几版
  // （yoyo 2026-11-10「清单改」）。版本页标题已经写着版本号，这一节就不再带那一行。
  assert.equal(feedReleaseNotes(sample, '0.2.7'), '- 新增了一件事。\n- 修了另一件事。')
  assert.equal(feedReleaseNotes('0.2.7\r\n\r\n- 唯一一条。\r\n', '0.2.7'), '- 唯一一条。')
})

test('the update feed falls back to the whole file when the newest section is not this version', () => {
  // 升级冒烟、出测试包会把版本号临时调到比所有已发版本都高，首节对不上是正常的，照原来整份写进去；
  // 真发版首行必须等于版本号，由发布前置检查拦（P-14），走不到这里。
  assert.equal(feedReleaseNotes(sample, '0.2.9'), null)
  assert.equal(feedReleaseNotes(sample, '0.2.6'), null)
  assert.equal(feedReleaseNotes('0.2.7\n\n0.2.6\n\n- 旧的。\n', '0.2.7'), null)
  assert.equal(feedReleaseNotes('未发布\n\n- 还没汇总。\n', '0.2.7'), null)
  assert.equal(feedReleaseNotes(sample, 'v0.2.7'), null)
})

test('the packaging config hands electron-builder only this version of the release notes', () => {
  const version = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version
  const source = fs.readFileSync(path.join(projectRoot, 'release-notes.md'), 'utf8')
  const environment = { ...process.env }
  for (const name of BUILD_MODE_ENVIRONMENT_NAMES) delete environment[name]
  delete environment.XINGMANG_UNSIGNED_RELEASE
  for (const unsignedRelease of ['0', '1']) {
    const result = spawnSync(process.execPath, ['-e', `
      const config = require(${JSON.stringify(path.join(projectRoot, 'electron-builder.config.cjs'))})
      process.stdout.write(JSON.stringify(config.releaseInfo))
    `], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...environment, XINGMANG_UNSIGNED_RELEASE: unsignedRelease, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
    })
    assert.equal(result.status, 0, result.stderr)
    const releaseInfo = JSON.parse(result.stdout)
    // releaseNotesFile 还在的话 electron-builder 会照旧去读整份文件（app-builder-lib 的 getReleaseInfo）。
    assert.equal(releaseInfo.releaseNotesFile, undefined)
    assert.equal(releaseInfo.releaseNotes, feedReleaseNotes(source, version))
    assert.ok(releaseInfo.releaseNotes.startsWith('- '), releaseInfo.releaseNotes.slice(0, 80))
    assert.ok(!/^\d+\.\d+\.\d+$/m.test(releaseInfo.releaseNotes), 'the feed must not run on into an older version')
    assert.ok(releaseInfo.releaseNotes.length < source.length / 4, `${releaseInfo.releaseNotes.length} of ${source.length}`)
  }
})

test('the command line takes exactly one version and one destination', () => {
  assert.deepEqual(parseArguments(['--version', '0.2.7', '--output', '/tmp/notes.md']), { version: '0.2.7', outputPath: '/tmp/notes.md' })
  assert.throws(() => parseArguments([]), /缺少/)
  assert.throws(() => parseArguments(['--version', '0.2.7']), /参数无效|缺少/)
  assert.throws(() => parseArguments(['--version', '0.2.7', '--version', '0.2.6', '--output', '/tmp/n']), /参数无效/)
  assert.throws(() => parseArguments(['--notes', 'x', '--output', '/tmp/n']), /参数无效/)
})
