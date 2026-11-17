const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { execFileSync } = require('node:child_process')
const {
  CHECKLIST_PATH,
  globToRegExp,
  parseChecklist,
  matchChecklist,
  changedLinesFromDiff,
  parseArgs,
  run,
} = require('./reliability-checklist.cjs')

const root = path.resolve(__dirname, '..')
const checklistSource = fs.readFileSync(path.join(root, CHECKLIST_PATH), 'utf8')

function trackedFiles() {
  return execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
}

function change(file, lines = []) {
  let reads = 0
  return {
    file,
    lines() {
      reads += 1
      return lines
    },
    reads: () => reads,
  }
}

function hitIds(markdown, changes) {
  const { items, errors } = parseChecklist(markdown)
  assert.deepEqual(errors, [])
  return matchChecklist(items, changes).map((hit) => hit.item.id)
}

function item(id, triggers, extra = '') {
  return [`### ${id} 标题`, '', ...triggers.map((trigger) => `- 触发：${trigger}`), '- 查什么：看一眼', '- 出自：#1', extra, ''].join('\n')
}

test('the checklist in the repository parses, and every item has a trigger, a check and an origin', () => {
  const { items, errors } = parseChecklist(checklistSource)
  assert.deepEqual(errors, [])
  assert.ok(items.length >= 10, 'the checklist starts from the incidents already on record')
  assert.ok(items.length <= 30, 'past thirty items the checklist is due for pruning (see its own instructions)')
  for (const entry of items) {
    assert.match(entry.id, /^R\d{2}$/)
    assert.ok(entry.check.length > 0, entry.id)
    assert.ok(entry.origin.length > 0, entry.id)
    assert.ok(entry.rules.length > 0, entry.id)
  }
  // Items point at each other by number; a renumbering must not leave a
  // reference to an item that is gone.
  const ids = new Set(items.map((entry) => entry.id))
  for (const entry of items) {
    for (const reference of `${entry.check}${entry.origin}`.match(/R\d{2}/g) || []) {
      assert.ok(ids.has(reference), `${entry.id} points at ${reference}, which is not in the checklist`)
    }
  }
})

// A trigger that matches nothing never fires again, and nothing says so: a
// rename or a deletion would quietly retire the check it guards.
test('every file pattern in the checklist still matches a file in the repository', () => {
  const files = trackedFiles()
  assert.ok(files.length > 100, 'git ls-files must see the repository')
  const { items } = parseChecklist(checklistSource)
  for (const entry of items) {
    for (const rule of entry.rules) {
      for (const glob of [...rule.files, ...rule.excludes]) {
        const pattern = globToRegExp(glob)
        assert.ok(files.some((file) => pattern.test(file)), `${entry.id}: ${glob} matches no file`)
      }
    }
  }
})

test('file patterns read * inside one folder and ** across folders', () => {
  assert.equal(globToRegExp('electron/update-*.ts').test('electron/update-signature.ts'), true)
  assert.equal(globToRegExp('electron/update-*.ts').test('electron/sub/update-signature.ts'), false)
  assert.equal(globToRegExp('electron/update-*.ts').test('electron/updater.ts'), false)
  assert.equal(globToRegExp('electron/**/*.ts').test('electron/ipc.ts'), true)
  assert.equal(globToRegExp('electron/**/*.ts').test('electron/ipc/handlers/config.ts'), true)
  assert.equal(globToRegExp('src/renderer-v2/features/shell/**').test('src/renderer-v2/features/shell/Shell.tsx'), true)
  assert.equal(globToRegExp('src/renderer-v2/features/shell/**').test('src/renderer-v2/features/shellish.tsx'), false)
  assert.equal(globToRegExp('package.json').test('package.json'), true)
  assert.equal(globToRegExp('package.json').test('packageXjson'), false)
  assert.equal(globToRegExp('package.json').test('canvas-v2/package.json'), false)
})

test('a broken entry is reported, not silently skipped', () => {
  const broken = [
    item('R01', ['文件 `a.ts`']),
    item('R01', ['文件 `b.ts`']),
    '### R02 没有触发\n\n- 查什么：x\n- 出自：y\n',
    '### R03 坏正则\n\n- 触发：改动行含 `(`\n- 查什么：x\n- 出自：y\n',
    '### R04 读不懂\n\n- 触发：路径 `a.ts`\n- 查什么：x\n- 出自：y\n',
    '### R05 只有排除\n\n- 触发：文件 `!a.ts`\n- 查什么：x\n- 出自：y\n',
    '### R06 缺两项\n\n- 触发：文件 `a.ts`\n',
    '### R07 多了一种开头\n\n- 触发：文件 `a.ts`\n- 怎么查：x\n- 查什么：x\n- 出自：y\n',
    '### 没编号\n',
  ].join('\n')
  const { errors } = parseChecklist(broken)
  const text = errors.join('\n')
  assert.match(text, /R01 重复了/)
  assert.match(text, /R02 没有「触发」/)
  assert.match(text, /R03）：正则 \( 编不过/)
  assert.match(text, /R04）：读不懂「路径/)
  assert.match(text, /R05）：只有排除/)
  assert.match(text, /R06 没有「查什么」/)
  assert.match(text, /R06 没有「出自」/)
  assert.match(text, /R07）：条目里只认/)
  assert.match(text, /条目标题要写成/)
  assert.deepEqual(parseChecklist('# 空的\n').errors, ['清单里一条都没读到'])
})

test('a trigger fires on files, on changed lines, or on lines inside the named files', () => {
  const markdown = [
    item('R01', ['文件 `electron/updater.ts` `electron/update-*.ts`']),
    item('R02', ['改动行含 `safeStorage`']),
    item('R03', ['文件 `package.json`，改动行含 `"electron":`']),
    item('R04', ['文件 `electron/**/*.ts` `!electron/**/*.test.ts`，改动行含 `net\\.request`']),
    item('R05', ['文件 `a.ts`', '文件 `b.ts`']),
  ].join('\n')
  assert.deepEqual(hitIds(markdown, [change('electron/update-signature.ts')]), ['R01'])
  assert.deepEqual(hitIds(markdown, [change('docs/x.md', ['use safeStorage here'])]), ['R02'])
  assert.deepEqual(hitIds(markdown, [change('package.json', ['    "electron": "46.0.0",'])]), ['R03'])
  // The file alone is not enough when the trigger names the lines too.
  assert.deepEqual(hitIds(markdown, [change('package.json', ['    "vite": "8.0.1",'])]), [])
  assert.deepEqual(hitIds(markdown, [change('electron/x.ts', ['net.request(url)'])]), ['R04'])
  assert.deepEqual(hitIds(markdown, [change('electron/x.test.ts', ['net.request(url)'])]), [])
  // Lines from another file do not complete a trigger scoped to these files.
  assert.deepEqual(hitIds(markdown, [change('electron/x.ts', ['nothing']), change('src/y.ts', ['net.request(url)'])]), [])
  // Any one of an item's triggers is enough.
  assert.deepEqual(hitIds(markdown, [change('b.ts')]), ['R05'])

  // A file no trigger names never has its diff read.
  const untouched = change('README.md', ['net.request'])
  hitIds(item('R01', ['文件 `electron/**`，改动行含 `net`']), [untouched])
  assert.equal(untouched.reads(), 0)
})

test('only added and removed lines count, not the diff headers', () => {
  const diff = [
    'diff --git a/package.json b/package.json',
    'index 1..2 100644',
    '--- a/package.json',
    '+++ b/package.json',
    '@@ -10 +10 @@',
    '-    "electron": "45.1.0",',
    '+    "electron": "46.0.0",',
  ].join('\n')
  assert.deepEqual(changedLinesFromDiff(diff), ['    "electron": "45.1.0",', '    "electron": "46.0.0",'])
})

// Each case is an incident the item was written for: if its trigger stops
// firing on the change that caused it, the item has lost its reason to exist.
test('the recorded incidents still trip the items written for them', () => {
  const cases = [
    ['R01', change('src/renderer-v2/styles/shell.css')],
    ['R02', change('electron/payment-window.ts')],
    ['R03', change('electron/config-files.ts')],
    ['R04', change('electron/cli-verified-versions.ts')],
    ['R05', change('electron/updater.ts')],
    ['R06', change('electron/managed-key-replacement-store.ts')],
    ['R07', change('electron/realm-account-vault.ts', ['const encrypted = safeStorage.encryptString(value)'])],
    ['R08', change('electron/codex-desktop-service.ts', ["    '$ErrorActionPreference = \"Stop\"',"])],
    ['R09', change('package.json', ['    "electron": "46.0.0",'])],
    ['R10', change('electron/updater.ts', ["  return error.message === 'net::ERR_PROXY_CONNECTION_FAILED'"])],
    ['R11', change('electron/ipc-contract.ts')],
    ['R12', change('src/renderer-v2/features/settings/VersionCard.tsx', ["        <span>装新版前先看一眼</span>"])],
    ['R13', change('electron/new-api-client.ts')],
    ['R14', change('electron/command-runner.ts')],
    ['R15', change('build/installer.nsh')],
    ['R16', change('electron/codex-remote-service.test.ts', ['    await vi.waitFor(() => expect(sent).toHaveLength(1))'])],
    ['R17', change('.github/workflows/upgrade-smoke.yml')],
  ]
  for (const [id, entry] of cases) {
    assert.ok(hitIds(checklistSource, [entry]).includes(id), `${id} must fire on ${entry.file}`)
  }
  // The near misses stay quiet.
  assert.equal(hitIds(checklistSource, [change('package.json', ['    "vite": "8.0.1",'])]).includes('R09'), false)
  assert.equal(hitIds(checklistSource, [change('src/renderer-v2/features/settings/VersionCard.tsx', ['  // 这里只记一笔为什么'])]).includes('R12'), false)
  assert.equal(hitIds(checklistSource, [change('src/renderer-v2/features/video-studio/VideoStudio.tsx', ["  const label = '加字幕'"])]).includes('R12'), false)
  assert.equal(hitIds(checklistSource, [change('docs/GUIDE.md', ['app-region'])]).includes('R01'), false)
  assert.equal(hitIds(checklistSource, [change('electron/config-files.test.ts', ['safeStorage'])]).includes('R07'), false)
})

test('arguments are checked before anything runs', () => {
  assert.deepEqual(parseArgs([]), { base: 'origin/main', from: 'origin/main', local: false, markdown: false })
  assert.deepEqual(parseArgs(['--base', 'abc', '--from', 'main', '--local', '--markdown']), { base: 'abc', from: 'main', local: true, markdown: true })
  assert.throws(() => parseArgs(['--base']), /--base 后面要跟/)
  assert.throws(() => parseArgs(['--from', '--local']), /--from 后面要跟/)
  assert.throws(() => parseArgs(['--fix']), /不认识的参数/)
})

function makeRepository(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-checklist-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' })
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), text)
  }
  git('init', '-q', '-b', 'main')
  write('electron/updater.ts', 'export {}\n')
  write('package.json', '{\n  "devDependencies": {\n    "electron": "45.1.0"\n  }\n}\n')
  return { dir, git, write }
}

const repositoryChecklist = [
  '# 清单',
  '',
  item('R01', ['文件 `electron/updater.ts`']),
  item('R02', ['文件 `package.json`，改动行含 `"electron":`']),
].join('\n')

test('the checklist is read from main, so a branch cannot drop the item it trips', (t) => {
  const { dir, git, write } = makeRepository(t)
  write(CHECKLIST_PATH, repositoryChecklist)
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  git('checkout', '-q', '-b', 'topic')
  write('electron/updater.ts', 'export const changed = true\n')
  // The branch rewrites R01 so that it would no longer fire.
  write(CHECKLIST_PATH, repositoryChecklist.replace('文件 `electron/updater.ts`', '文件 `nothing.ts`'))
  git('commit', '-q', '-am', 'topic')

  const fromMain = run(['--base', 'main', '--from', 'main'], dir)
  assert.deepEqual(fromMain.hits.map((hit) => hit.item.id), ['R01'])
  assert.match(fromMain.output, /按 main 上的可靠性清单/)
  assert.match(fromMain.output, /改了清单本身/)

  const fromBranch = run(['--base', 'main', '--local'], dir)
  assert.deepEqual(fromBranch.hits.map((hit) => hit.item.id), [])
  assert.match(fromBranch.output, /按工作区里的可靠性清单/)
})

test('uncommitted and untracked changes count, and the markdown is ready to paste', (t) => {
  const { dir, git, write } = makeRepository(t)
  write(CHECKLIST_PATH, repositoryChecklist)
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  write('package.json', '{\n  "devDependencies": {\n    "electron": "46.0.0"\n  }\n}\n')
  write('electron/new-file.ts', 'export {}\n')

  const result = run(['--base', 'main', '--from', 'main', '--markdown'], dir)
  assert.deepEqual(result.hits.map((hit) => hit.item.id), ['R02'])
  assert.match(result.output, /^命中 1 条（清单取自 main 上）：/)
  assert.match(result.output, /- \*\*R02 标题\*\*（`package\.json`）/)
  assert.equal(result.hits[0].files.includes('package.json'), true)
  const text = run(['--base', 'main', '--from', 'main'], dir).output
  assert.match(text, /改动的 2 个文件/)
})

test('a branch that adds the checklist uses its own copy and says so, and nothing hit is said plainly', (t) => {
  const { dir, git, write } = makeRepository(t)
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  write(CHECKLIST_PATH, repositoryChecklist)
  const result = run(['--base', 'main', '--from', 'main'], dir)
  assert.deepEqual(result.hits, [])
  assert.match(result.output, /main 上还没有这份清单，用的是工作区这份/)
  // The checklist file itself is not one of the changes it describes.
  assert.doesNotMatch(result.output, /改了清单本身/)
  assert.match(result.output, /一条都没命中/)
  assert.match(run(['--base', 'main', '--from', 'main', '--markdown'], dir).output, /^没命中（清单取自工作区里）/)
})

test('a checklist that does not parse stops the run with the reasons', (t) => {
  const { dir, git, write } = makeRepository(t)
  write(CHECKLIST_PATH, '### R01 坏的\n\n- 触发：文件 `a.ts`\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  assert.throws(() => run(['--base', 'main', '--from', 'main'], dir), /写得有问题：\nR01 没有「查什么」/)
  assert.throws(() => run(['--base', 'no-such-branch'], dir), /找不到 no-such-branch/)
})

test('npm run checklist runs this script and test:scripts runs this file', () => {
  const scripts = require(path.join(root, 'package.json')).scripts
  assert.equal(scripts.checklist, 'node scripts/reliability-checklist.cjs')
  assert.ok(scripts['test:scripts'].split(/\s+/).includes('scripts/reliability-checklist.test.cjs'))
})
