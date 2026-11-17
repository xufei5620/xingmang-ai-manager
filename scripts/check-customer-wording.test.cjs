const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  allowlist,
  bannedWords,
  customerTextIn,
  formatMarkdown,
  formatText,
  headline,
  isScannedFile,
  scanCustomerWording,
  scannedAreas,
} = require('./check-customer-wording.cjs')

const projectRoot = path.resolve(__dirname, '..')

function texts(source, fileName = 'sample.tsx') {
  return customerTextIn(source, fileName).map((entry) => entry.text)
}

function matchedWords(text) {
  return bannedWords.filter((banned) => banned.pattern.test(text)).map((banned) => banned.word)
}

test('reads what reaches the screen: JSX text, Chinese strings and visible labels', () => {
  const source = [
    'export function Page() {',
    '  const notice = { label: \'API Key\', message: \'装好了\' }',
    '  return (',
    '    <section title="npm" aria-label="PATH help">',
    '      <p>请把工具加进 PATH</p>',
    '      <span>{\'TOML\'}</span>',
    '      <input placeholder="sk-..." />',
    '      <Dialog confirmLabel="Open Key" />',
    '    </section>',
    '  )',
    '}',
  ].join('\n')
  assert.deepEqual(texts(source), ['API Key', '装好了', 'npm', 'PATH help', '请把工具加进 PATH', 'TOML', 'sk-...', 'Open Key'])
})

test('leaves out logs, comparisons, matching, search words, test ids and types', () => {
  const source = [
    'import { thing } from \'./不算.ts\'',
    'type Stage = \'正在用 npm 安装\'',
    'export function work(message: string, options: { log?: (text: string) => void }) {',
    '  log(\'npm 日志\')',
    '  options.log?.(\'warn\', \'PATH 日志\', { detail: \'日志里的细节\' })',
    '  console.warn(\'控制台\')',
    '  native.reportRendererError({ message: `补跑 Key 同步：${message}` })',
    '  if (message === \'环境变量比对\') return',
    '  if (message.includes(\'找 npm 报错\')) return',
    '  if (/x/.test(message.replace(\'替换 Key\', \'\'))) return',
    '  const pattern = new RegExp(\'正则 npm\')',
    '  const credential = \'(?:API\\\\s*Key|密钥)\'',
    '  switch (message) { case \'分支 TOML\': return }',
    '  const topic = { keywords: [\'中转\', \'npm 搜索词\'], map: { \'键名 PATH\': 1 } }',
    '  return <div className="npm" data-testid="key-row" testId="tool-key" />',
    '}',
  ].join('\n')
  assert.deepEqual(texts(source), [])
})

test('reports only the Chinese lines of a multi-line script, each on its own line number', () => {
  const source = [
    'export const script = String.raw`',
    '# converts every value of a key',
    'Write-Output \'没有找到 npm\'',
    '$path = $env:PATH',
    '`',
  ].join('\n')
  assert.deepEqual(customerTextIn(source, 'script.ts'), [{ line: 3, text: 'Write-Output \'没有找到 npm\'' }])
})

test('still reads a Windows path inside a Chinese message', () => {
  assert.deepEqual(texts('throw new Error(\'C:\\\\System32\\\\cmd.exe 不在 PATH 里\')', 'paths.ts'), ['C:\\System32\\cmd.exe 不在 PATH 里'])
})

test('matches the banned words and not the identifiers that contain them', () => {
  const cases = [
    ['把工具加进 PATH', ['PATH']],
    ['PATHEXT 不对', []],
    ['从 npm 官方源下载', ['npm']],
    ['pnpm 装的', []],
    ['Codex config.toml 读不出来', ['TOML']],
    ['连接里的环境变量', ['环境变量']],
    ['Sub2API 后台', ['Sub2API']],
    ['NewAPI 返回', ['new-api']],
    ['new-api 返回', ['new-api']],
    ['打开 xm.solov.cc', ['站点域名']],
    ['所选站点无效', ['站点']],
    ['当前账号的 Key 用不了了', ['Key']],
    ['API key 无效', ['Key']],
    ['apiKey 字段', []],
    ['Keychain 里的密码', []],
    ['hotkey 冲突', []],
    ['当前账号的密钥用不了了', []],
  ]
  for (const [text, expected] of cases) assert.deepEqual(matchedWords(text), expected, text)
})

test('scans product sources only', () => {
  assert.equal(isScannedFile('src/renderer-v2/features/tools/Home.tsx'), true)
  assert.equal(isScannedFile('electron/config-files.ts'), true)
  for (const file of [
    'src/renderer-v2/features/tools/Home.test.tsx',
    'src/renderer-v2/testing/app-fixture.tsx',
    'src/renderer-v2/features/auth/browser-fixture.tsx',
    'src/renderer-v2/gallery.tsx',
    'electron/fixtures/canvas-kernel-contract/sample.ts',
    'electron/slow-download.test-support.ts',
    'electron/types.d.ts',
    'src/renderer-v2/features/chat/browser-check.mjs',
  ]) assert.equal(isScannedFile(file), false, file)
})

test('every allowlist entry says why and still matches something in the tree', () => {
  for (const entry of allowlist) {
    assert.ok(entry.file && entry.reason, `allowlist entry needs a file and a reason: ${JSON.stringify(entry)}`)
    assert.ok(fs.existsSync(path.join(projectRoot, entry.file)), `allowlist file is gone: ${entry.file}`)
  }
  const result = scanCustomerWording()
  assert.deepEqual(result.unusedAllowlist, [], 'the text an allowlist entry covered has changed; drop the entry')
})

test('reports without failing, in the log and in the job summary', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-wording-'))
  try {
    const summary = path.join(directory, 'summary.md')
    const run = childProcess.spawnSync(process.execPath, [path.join(__dirname, 'check-customer-wording.cjs')], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
    })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /^客户看得到的字里的禁用词（只报不拦）：界面 \d+ 处、主进程 \d+ 处；按名单放过 \d+ 处/)
    assert.match(fs.readFileSync(summary, 'utf8'), /^### 客户看得到的字里的禁用词/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('formats hits grouped by area and word', () => {
  const result = {
    hits: [
      { area: '界面', file: 'src/renderer-v2/a.tsx', line: 3, word: 'npm', rule: '技术词', text: '用 npm | 装' },
      { area: '主进程', file: 'electron/b.ts', line: 9, word: 'Key', rule: '「Key」叫「密钥」', text: '当前 <Key>' },
    ],
    allowedHits: [],
    unusedAllowlist: [],
  }
  assert.equal(headline(result, scannedAreas), '客户看得到的字里的禁用词（只报不拦）：界面 1 处、主进程 1 处；按名单放过 0 处')
  const text = formatText(result, scannedAreas)
  assert.match(text, /界面（1 处）\n {2}npm（技术词）1 处\n {4}src\/renderer-v2\/a\.tsx:3 {2}用 npm \| 装/)
  const markdown = formatMarkdown(result, scannedAreas)
  assert.match(markdown, /<details open><summary>界面 1 处（npm 1）<\/summary>/)
  assert.match(markdown, /\| npm \| `src\/renderer-v2\/a\.tsx:3` \| 用 npm \\\| 装 \|/)
  assert.match(markdown, /当前 &lt;Key&gt;/)
})
