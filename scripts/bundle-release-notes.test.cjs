const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')
const { buildBundledReleaseNotes, splitReleaseNoteItems, parseArguments, main, MAX_ITEMS, MAX_ITEM_LENGTH } = require('./bundle-release-notes.cjs')

const projectRoot = path.resolve(__dirname, '..')

const sample = [
  '0.2.9',
  '',
  '- 更新装完第一次打开时会告诉你已经更新到哪一版。',
  '- 修复开着本机加速时安装 CLI 却下载不动：安装用的下载以前从不经过加速线路，',
  '  所以加速对「下载慢」这件事一直没有作用。',
  '- 参数里以 `-` 开头的内容会原样交给 MCP server',
  '  and nothing else.',
  '',
  '0.2.8',
  '',
  '- 上一版的内容。',
  '',
].join('\n')

test('the top section becomes one plain-text item per bullet with wrapped lines rejoined', () => {
  assert.deepEqual(buildBundledReleaseNotes(sample, '0.2.9'), {
    version: '0.2.9',
    notes: [
      '更新装完第一次打开时会告诉你已经更新到哪一版。',
      '修复开着本机加速时安装 CLI 却下载不动：安装用的下载以前从不经过加速线路，所以加速对「下载慢」这件事一直没有作用。',
      '参数里以 「-」 开头的内容会原样交给 MCP server and nothing else.',
    ],
  })
})

test('a build whose top section is another version ships no notes instead of the wrong ones', () => {
  // 日常 CI 测试包与还没做版本收口的构建：顶节是上一版或「未发布」。把上一版的改动
  // 当成这一版显示出去比不显示更糟，但构建本身不该因此失败。
  assert.deepEqual(buildBundledReleaseNotes(sample, '0.3.0'), { version: '0.3.0', notes: null })
  assert.deepEqual(buildBundledReleaseNotes(`未发布\n\n- 还没发。\n\n${sample}`, '0.2.9'), { version: '0.2.9', notes: null })
  assert.deepEqual(buildBundledReleaseNotes('0.2.9\n\n0.2.8\n\n- 旧的。\n', '0.2.9'), { version: '0.2.9', notes: null })
})

test('an invalid package version is a build error, not a silently empty file', () => {
  assert.throws(() => buildBundledReleaseNotes(sample, 'v0.2.9'), /版本号格式无效/)
})

function releaseWithItems(version, count) {
  const items = Array.from({ length: count }, (_, index) => `- 第 ${index + 1} 条`)
  return [version, '', ...items, '', '0.2.8', '', '- 上一版的内容。', ''].join('\n')
}

test('a release with more items than the update page holds fails the build instead of hiding the rest', () => {
  // 以前悄悄截到前 60 条，0.2.20 后 24 条（几位客户报过的修复）装完后的更新页一条不提（#1334）。
  assert.throws(
    () => buildBundledReleaseNotes(releaseWithItems('0.2.9', MAX_ITEMS + 1), '0.2.9'),
    (error) => {
      assert.equal(error.code, 'RELEASE_NOTES_TOO_MANY')
      assert.match(error.message, new RegExp(`0\\.2\\.9 这一版有 ${MAX_ITEMS + 1} 条`))
      assert.match(error.message, new RegExp(`最多放 ${MAX_ITEMS} 条`))
      return true
    },
  )
  assert.equal(buildBundledReleaseNotes(releaseWithItems('0.2.9', MAX_ITEMS), '0.2.9').notes.length, MAX_ITEMS)
})

test('a build that ships no notes is never failed by the item count', () => {
  // 日常测试包的顶节是「未发布」，条数再多也只是「这一版没有随包说明」，不能挡住构建。
  const unreleased = releaseWithItems('未发布', MAX_ITEMS + 30)
  assert.deepEqual(buildBundledReleaseNotes(unreleased, '0.2.9'), { version: '0.2.9', notes: null })
  assert.deepEqual(buildBundledReleaseNotes(releaseWithItems('0.2.8', MAX_ITEMS + 30), '0.2.9'), { version: '0.2.9', notes: null })
})

test('compile stops with a readable error and writes nothing when the release has too many items', () => {
  // 脚本按自己所在目录的上一级找 package.json 和 release-notes.md，所以把它连同依赖拷进一棵
  // 临时目录树里跑，跑的是 compile 最后一步那条命令本身。
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-release-notes-cap-'))
  try {
    fs.mkdirSync(path.join(directory, 'scripts'))
    for (const name of ['bundle-release-notes.cjs', 'extract-release-notes.cjs']) {
      fs.copyFileSync(path.join(__dirname, name), path.join(directory, 'scripts', name))
    }
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '0.2.9' }))
    fs.writeFileSync(path.join(directory, 'release-notes.md'), releaseWithItems('0.2.9', MAX_ITEMS + 1))
    const output = path.join(directory, 'dist-electron', 'release-notes.json')
    const result = spawnSync(process.execPath, [path.join(directory, 'scripts', 'bundle-release-notes.cjs')], {
      cwd: directory,
      encoding: 'utf8',
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, new RegExp(`写入随包更新说明失败：.*最多放 ${MAX_ITEMS} 条`))
    assert.equal(fs.existsSync(output), false)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a single over-long item is cut with an ellipsis so the reader can tell', () => {
  const [long] = splitReleaseNoteItems(`- ${'长'.repeat(MAX_ITEM_LENGTH + 20)}`)
  assert.equal(long.length, MAX_ITEM_LENGTH)
  assert.ok(long.endsWith('…'))
})

test('the main process reads with the same limits the build enforces', () => {
  // 构建放行 60 条、主进程却只读 50 条，又会回到悄悄少显示几条的老路。
  const source = fs.readFileSync(path.join(projectRoot, 'electron', 'installed-release.ts'), 'utf8')
  assert.match(source, new RegExp(`^const MAX_NOTES = ${MAX_ITEMS}$`, 'm'))
  assert.match(source, new RegExp(`^const MAX_NOTE_LENGTH = ${MAX_ITEM_LENGTH}$`, 'm'))
})

test('only an explicit --output is accepted', () => {
  assert.equal(parseArguments([]).outputPath, path.join(projectRoot, 'dist-electron', 'release-notes.json'))
  assert.equal(parseArguments(['--output', 'out.json']).outputPath, path.resolve('out.json'))
  assert.throws(() => parseArguments(['--version', '0.2.9']), /参数无效/)
  assert.throws(() => parseArguments(['--output']), /参数无效/)
})

test('compile writes the bundled notes after the main process build', () => {
  // dist-electron 先被 clean 再由 tsc 填满，这一步必须排在它们后面，否则写进去的文件
  // 会被清掉，打出来的包里没有随包说明。
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  const steps = packageJson.scripts['compile:runtime'].split('&&').map((step) => step.trim())
  const bundleStep = steps.indexOf('node scripts/bundle-release-notes.cjs')
  assert.ok(bundleStep > steps.findIndex((step) => step.startsWith('node scripts/clean-electron.mjs')))
  assert.ok(bundleStep > steps.findIndex((step) => step.startsWith('tsc -p tsconfig.electron.json')))
  assert.ok(packageJson.scripts['test:scripts'].includes('scripts/bundle-release-notes.test.cjs'))
})

test('the real release-notes.md produces a well-formed file for the current version', () => {
  const version = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-release-notes-'))
  try {
    const output = path.join(directory, 'release-notes.json')
    main(['--output', output])
    const bundled = JSON.parse(fs.readFileSync(output, 'utf8'))
    assert.equal(bundled.version, version)
    assert.ok(bundled.notes === null || (bundled.notes.length > 0 && bundled.notes.every((item) => typeof item === 'string' && item.length > 0)))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
