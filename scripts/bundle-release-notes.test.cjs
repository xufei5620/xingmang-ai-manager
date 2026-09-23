const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
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

test('items are bounded so the main process never has to discard the whole file', () => {
  const many = Array.from({ length: MAX_ITEMS + 5 }, (_, index) => `- 第 ${index} 条`).join('\n')
  assert.equal(splitReleaseNoteItems(many).length, MAX_ITEMS)
  const [long] = splitReleaseNoteItems(`- ${'长'.repeat(MAX_ITEM_LENGTH + 20)}`)
  assert.equal(long.length, MAX_ITEM_LENGTH)
  assert.ok(long.endsWith('…'))
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
