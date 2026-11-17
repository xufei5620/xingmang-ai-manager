const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { execFileSync } = require('node:child_process')
const { LEDGER_PATH, REPEAT_WINDOW_DAYS, parseLedger, findEntries, mergeRows, beijingToday, parseArgs, run } = require('./ci-rerun-ledger.cjs')

const root = path.resolve(__dirname, '..')
const header = '| 日期 | 用例或步骤 | 作业 | 指纹 | 运行 | PR | 处理 |\n|---|---|---|---|---|---|---|'

function ledger(...rows) {
  return ['# 记账', '', '## 账', '', header, ...rows, ''].join('\n')
}

function row(date, key, action = '重跑一次过', runId = '42992280184', pr = '#1756') {
  return `| ${date} | ${key} | windows-test (vitest-2) | 超时 | ${runId} | ${pr} | ${action} |`
}

test('the ledger in the repository follows its own rules', () => {
  const { rows, errors } = parseLedger(fs.readFileSync(path.join(root, LEDGER_PATH), 'utf8'))
  assert.deepEqual(errors, [])
  assert.ok(rows.length > 0)
})

test('a malformed row is reported with its line', () => {
  const { errors } = parseLedger(ledger(
    '| 2026-02-30 | a | job | f | 42992280184 | #1 | 重跑一次过 |',
    '| 2026-11-11 | b | job | f | run | 1756 | 重跑一次过 |',
    '| 2026-11-12 |  |  |  | 42992280184 | main |  |',
    '| 2026-11-13 | c | job | f | 42992280184 | main |',
    '| 2026-11-01 | d | job | f | 42992280184 | main | 重跑一次过 |',
  ))
  const text = errors.join('\n')
  assert.match(text, /第 7 行：日期要写成 YYYY-MM-DD 的真实日期/)
  assert.match(text, /第 8 行：「运行」写运行号/)
  assert.match(text, /第 8 行：「PR」写 #1234 或 main/)
  assert.match(text, /第 9 行：「用例或步骤」空着/)
  assert.match(text, /第 9 行：「作业」空着/)
  assert.match(text, /第 9 行：「指纹」空着/)
  assert.match(text, /第 9 行：「处理」空着/)
  assert.match(text, /第 10 行：要 7 列，这一行有 6 列/)
  assert.match(text, /第 11 行：日期比上一行早/)
  assert.deepEqual(parseLedger('# 空\n').errors, ['找不到「## 账」这一节'])
  assert.deepEqual(parseLedger('## 账\n\n没有表\n').errors, ['「## 账」下面没有表'])
  assert.match(parseLedger('## 账\n\n| 日期 | 用例 |\n|---|---|\n').errors.join('\n'), /表头要是/)
})

// yoyo, 2026-11-17: the second rerun-to-pass of the same check within two
// weeks has to be investigated, not rerun again.
test('a second occurrence within two weeks must go to a root-cause investigation', () => {
  const key = 'electron/x.test.ts › waits for the file'
  assert.deepEqual(parseLedger(ledger(row('2026-11-01', key), row('2026-11-20', key))).errors, [])
  const repeat = parseLedger(ledger(row('2026-11-01', key), row('2026-11-15', key)))
  assert.match(repeat.errors.join('\n'), /第 8 行：2026-11-01（第 7 行）已经记过同一条，两周内第二次/)
  assert.equal(REPEAT_WINDOW_DAYS, 14)
  // How the name is typed does not hide the repeat.
  assert.equal(parseLedger(ledger(row('2026-11-01', key), row('2026-11-02', '`Electron/x.test.ts  ›  waits for the FILE`'))).errors.length, 1)
  assert.deepEqual(parseLedger(ledger(row('2026-11-01', key), row('2026-11-02', key, '查根因：#1900'))).errors, [])
  // Another test is another entry.
  assert.deepEqual(parseLedger(ledger(row('2026-11-01', key), row('2026-11-02', 'electron/y.test.ts › other'))).errors, [])
  // A third time is measured from the most recent one before it.
  assert.equal(parseLedger(ledger(row('2026-11-01', key), row('2026-11-20', key), row('2026-11-30', key))).errors.length, 1)
})

test('looking a failure up says whether a rerun is still allowed', () => {
  const { rows } = parseLedger(ledger(row('2026-11-01', 'electron/x.test.ts › waits for the file'), row('2026-11-10', 'e2e/y.test.mjs › clicks add')))
  const old = findEntries(rows, ['waits for'], '2026-11-20')
  assert.equal(old.length, 1)
  assert.equal(old[0].recent, false)
  const recent = findEntries(rows, ['CLICKS', 'y.test'], '2026-11-20')
  assert.equal(recent.length, 1)
  assert.equal(recent[0].recent, true)
  assert.deepEqual(findEntries(rows, ['nothing'], '2026-11-20'), [])
})

test('today is the Beijing date, which is what the ledger is written in', () => {
  assert.equal(beijingToday(new Date('2026-11-17T15:59:00Z')), '2026-11-17')
  assert.equal(beijingToday(new Date('2026-11-17T16:00:00Z')), '2026-11-18')
})

test('rows from main and from the branch are read together, once each', () => {
  const a = parseLedger(ledger(row('2026-11-01', 'a', '重跑一次过', '41193398956'))).rows
  const b = parseLedger(ledger(row('2026-11-01', 'a', '重跑一次过', '41193398956'), row('2026-11-05', 'b'))).rows
  assert.deepEqual(mergeRows([b, a]).map((entry) => entry.key), ['a', 'b'])
})

test('arguments are checked before anything runs', () => {
  assert.deepEqual(parseArgs(['waits', 'file']), { words: ['waits', 'file'], today: null })
  assert.deepEqual(parseArgs(['x', '--today', '2026-11-20']), { words: ['x'], today: '2026-11-20' })
  assert.throws(() => parseArgs([]), /用法/)
  assert.throws(() => parseArgs(['x', '--today', '11-20']), /--today/)
  assert.throws(() => parseArgs(['x', '--rerun']), /不认识的参数/)
})

test('the command reads the working copy when main has no ledger and refuses a broken one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-rerun-ledger-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir })
  fs.mkdirSync(path.join(dir, 'docs'))
  fs.writeFileSync(path.join(dir, LEDGER_PATH), ledger(row('2026-11-10', 'e2e/y.test.mjs › clicks add')))
  const recent = run(['clicks add', '--today', '2026-11-17'], dir)
  assert.equal(recent.recent, true)
  assert.match(recent.text, /两周内记过：不许再重跑/)
  const later = run(['clicks add', '--today', '2026-11-30'], dir)
  assert.equal(later.recent, false)
  assert.match(later.text, /可以重跑一次/)
  fs.writeFileSync(path.join(dir, LEDGER_PATH), ledger(row('2026-11-10', 'k'), row('2026-11-11', 'k')))
  assert.throws(() => run(['k'], dir), /工作区 的账写得有问题/)
})

test('npm run ci:rerun-ledger runs this script and test:scripts runs this file', () => {
  const scripts = require(path.join(root, 'package.json')).scripts
  assert.equal(scripts['ci:rerun-ledger'], 'node scripts/ci-rerun-ledger.cjs')
  assert.ok(scripts['test:scripts'].split(/\s+/).includes('scripts/ci-rerun-ledger.test.cjs'))
})
