const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const {
  appendToUnreleasedSection,
  assertAllCollected,
  assertNoDirectUiSpecChangelogEdit,
  assertNoDirectUnreleasedEdit,
  assertUserItemsFit,
  assertUserNotesNotFinalized,
  changedFileStatuses,
  collectChanges,
  collectUiSpecChanges,
  countUserItems,
  finalUserNotesFragment,
  insertUiSpecEntries,
  orderUiSpecEntries,
  parseFragment,
  parseUiSpecFragment,
  readFragments,
  readUiSpecFragments,
  readUnreleasedSection,
  sections,
  uiSpecChangelogFile,
  uiSpecFragmentDirectory,
} = require('./changelog-collect.cjs')
const { MAX_ITEMS } = require('./bundle-release-notes.cjs')

const script = path.resolve(__dirname, 'changelog-collect.cjs')
const repositoryRoot = path.resolve(__dirname, '..')
const [userSection, developerSection] = sections

const releaseNotes = [
  '未发布',
  '',
  '- 已经在 main 上的用户条目。',
  '',
  '0.2.6',
  '',
  '- 上一版的条目。',
  '',
].join('\n')

const changelog = [
  '# Changelog',
  '',
  '> 两份日志的用途说明。',
  '',
  '## Unreleased',
  '',
  '- 已经在 main 上的开发条目。',
  '',
  '## 0.2.6 - 2026-09-19',
  '',
  '- 上一版的条目。',
  '',
].join('\n')

function fixture(fragments = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-changelog-'))
  fs.mkdirSync(path.join(directory, 'changes', 'unreleased'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'release-notes.md'), releaseNotes, 'utf8')
  fs.writeFileSync(path.join(directory, 'CHANGELOG.md'), changelog, 'utf8')
  fs.writeFileSync(path.join(directory, 'changes', 'unreleased', 'README.md'), '# 说明\n\n随便写点什么。\n', 'utf8')
  fs.writeFileSync(path.join(directory, 'changes', 'unreleased', 'TEMPLATE.md.example'), '## 用户\n\n- 模板。\n', 'utf8')
  for (const [name, source] of Object.entries(fragments)) {
    fs.writeFileSync(path.join(directory, 'changes', 'unreleased', name), source, 'utf8')
  }
  return directory
}

function run(directory, argv = []) {
  return spawnSync(process.execPath, [script, ...argv], {
    cwd: directory,
    // The check only consults git when GitHub handed it an event payload.
    env: { ...process.env, GITHUB_EVENT_PATH: '', GITHUB_EVENT_NAME: '' },
    encoding: 'utf8',
  })
}

function pullRequestEvent(base, head = 'b'.repeat(40)) {
  return { pull_request: { base: { sha: base }, head: { sha: head } } }
}

test('a fragment separates the user-facing note from the developer note', () => {
  const entries = parseFragment('r-s7.md', [
    '## 用户',
    '',
    '- 安装工具时首页会显示当前进行到哪一步。',
    '',
    '## 开发',
    '',
    '- `registry/tools.ts` 收口了 provider 联合类型（R-S7）。',
    '  续行也属于同一条。',
    '',
  ].join('\n'))

  assert.deepEqual(entries.user, ['- 安装工具时首页会显示当前进行到哪一步。'])
  assert.deepEqual(entries.developer, [
    '- `registry/tools.ts` 收口了 provider 联合类型（R-S7）。',
    '  续行也属于同一条。',
  ])
})

test('either half of a fragment may be omitted', () => {
  assert.deepEqual(parseFragment('ci.md', '## 开发\n\n- 只改了 CI。\n').user, [])
  assert.deepEqual(parseFragment('ui.md', '## 用户\n\n- 只改了界面文案。\n').developer, [])
})

test('a malformed fragment is rejected with the line that caused it', () => {
  const rejected = [
    ['## 修复\n\n- 条目。\n', /不认识的小节标题/],
    ['## 用户\n\n- 一。\n\n## 用户\n\n- 二。\n', /重复了/],
    ['随手写的一句话。\n\n## 用户\n\n- 条目。\n', /必须写在/],
    ['## 用户\n\n没有用「- 」开头。\n', /都要以/],
    ['## 用户\n\n  续行前面没有条目。\n', /都要以/],
    ['## 用户\n\n## 开发\n', /是空的/],
  ]
  for (const [source, expected] of rejected) {
    assert.throws(() => parseFragment('bad.md', source), expected, source)
  }
  assert.throws(() => parseFragment('bad.md', '## 用户\n\n没有用「- 」开头。\n'), /bad\.md:3/)
})

test('the directory README and template are not fragments', () => {
  const directory = fixture({ 'n4.md': '## 用户\n\n- 条目。\n' })
  try {
    assert.deepEqual(readFragments(directory).map((fragment) => fragment.name), ['n4.md'])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('collecting appends below the entries already in the unreleased sections', () => {
  const directory = fixture({
    'b-second.md': '## 用户\n\n- 第二条用户条目。\n',
    'a-first.md': '## 用户\n\n- 第一条用户条目。\n\n## 开发\n\n- 第一条开发条目。\n',
  })
  try {
    const result = collectChanges(directory)

    assert.deepEqual(result.fragments, ['a-first.md', 'b-second.md'])
    assert.deepEqual(
      readUnreleasedSection(fs.readFileSync(path.join(directory, 'release-notes.md'), 'utf8'), userSection),
      ['- 已经在 main 上的用户条目。', '- 第一条用户条目。', '- 第二条用户条目。'],
    )
    assert.deepEqual(
      readUnreleasedSection(fs.readFileSync(path.join(directory, 'CHANGELOG.md'), 'utf8'), developerSection),
      ['- 已经在 main 上的开发条目。', '- 第一条开发条目。'],
    )
    // The released sections below must survive untouched, blank lines included.
    assert.match(fs.readFileSync(path.join(directory, 'release-notes.md'), 'utf8'), /\n\n0\.2\.6\n\n- 上一版的条目。\n/)
    assert.match(fs.readFileSync(path.join(directory, 'CHANGELOG.md'), 'utf8'), /\n\n## 0\.2\.6 - 2026-09-19\n\n- 上一版的条目。\n/)
    assert.deepEqual(fs.readdirSync(path.join(directory, 'changes', 'unreleased')).sort(), ['README.md', 'TEMPLATE.md.example'])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('collecting recreates the unreleased section a release renamed away', () => {
  for (const [section, source, expected] of [
    [userSection, '0.2.6\n\n- 上一版的条目。\n', /^未发布\n\n- 新条目。\n\n0\.2\.6\n/],
    [developerSection, '# Changelog\n\n> 说明。\n\n## 0.2.6 - 2026-09-19\n\n- 上一版的条目。\n', /> 说明。\n\n## Unreleased\n\n- 新条目。\n\n## 0\.2\.6 - /],
  ]) {
    assert.match(appendToUnreleasedSection(source, section, ['- 新条目。']), expected)
  }
})

test('collecting fills an unreleased section that has no entries yet', () => {
  const emptied = appendToUnreleasedSection('未发布\n\n0.2.6\n\n- 上一版的条目。\n', userSection, ['- 新条目。'])

  assert.match(emptied, /^未发布\n\n- 新条目。\n\n0\.2\.6\n/)
})

test('collecting without fragments leaves both files byte-identical', () => {
  const directory = fixture()
  try {
    assert.deepEqual(collectChanges(directory), { fragments: [], written: [] })
    assert.equal(fs.readFileSync(path.join(directory, 'release-notes.md'), 'utf8'), releaseNotes)
    assert.equal(fs.readFileSync(path.join(directory, 'CHANGELOG.md'), 'utf8'), changelog)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('git name-status output is paired back to files, renames included', () => {
  const base = 'a'.repeat(40)
  const diff = changedFileStatuses('.', pullRequestEvent(base), 'pull_request', (_command, argv) => {
    assert.deepEqual(argv.slice(0, 3), ['diff', '--name-status', '-z'])
    return ['M', 'CHANGELOG.md', 'D', 'changes/unreleased/n4.md', 'R100', 'old.md', 'new.md', 'A', 'src/app.ts'].join('\0')
  })

  assert.equal(diff.base, base)
  assert.deepEqual(diff.changes, [
    { status: 'M', file: 'CHANGELOG.md' },
    { status: 'D', file: 'changes/unreleased/n4.md' },
    { status: 'R', file: 'new.md' },
    { status: 'A', file: 'src/app.ts' },
  ])
})

test('an unreachable base commit skips the comparison instead of failing the job', () => {
  const unreachable = () => { throw new Error('fatal: bad object') }

  assert.equal(changedFileStatuses('.', pullRequestEvent('a'.repeat(40)), 'pull_request', unreachable), null)
  assert.equal(changedFileStatuses('.', { before: '0'.repeat(40), after: 'b'.repeat(40) }, 'push', unreachable), null)
  assert.equal(changedFileStatuses('.', { pull_request: { base: { sha: 'nope' } } }, 'pull_request', unreachable), null)
})

test('editing an unreleased section directly is rejected with the fragment recipe', () => {
  const directory = fixture()
  try {
    fs.writeFileSync(
      path.join(directory, 'release-notes.md'),
      releaseNotes.replace('- 已经在 main 上的用户条目。', '- 已经在 main 上的用户条目。\n- 直接加进来的一行。'),
      'utf8',
    )
    const git = (_command, argv) => (
      argv[0] === 'diff' ? ['M', 'release-notes.md'].join('\0') : releaseNotes
    )

    assert.throws(
      () => assertNoDirectUnreleasedEdit(directory, pullRequestEvent('a'.repeat(40)), 'pull_request', git),
      /release-notes\.md 的「未发布」段被直接改动了/,
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('touching a released section or another file is allowed', () => {
  const directory = fixture()
  try {
    fs.writeFileSync(path.join(directory, 'release-notes.md'), releaseNotes.replace('- 上一版的条目。', '- 上一版的条目（订正错字）。'), 'utf8')
    const git = (_command, argv) => (
      argv[0] === 'diff' ? ['M', 'release-notes.md', 'A', 'src/app.ts'].join('\0') : releaseNotes
    )

    assert.doesNotThrow(() => assertNoDirectUnreleasedEdit(directory, pullRequestEvent('a'.repeat(40)), 'pull_request', git))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the release commit that collects fragments away may fill both sections', () => {
  const directory = fixture()
  try {
    fs.writeFileSync(path.join(directory, 'CHANGELOG.md'), changelog.replace('- 已经在 main 上的开发条目。', '- 已经在 main 上的开发条目。\n- 汇总进来的一行。'), 'utf8')
    const git = (_command, argv) => (
      argv[0] === 'diff' ? ['M', 'CHANGELOG.md', 'D', 'changes/unreleased/n4.md'].join('\0') : changelog
    )

    assert.doesNotThrow(() => assertNoDirectUnreleasedEdit(directory, pullRequestEvent('a'.repeat(40)), 'pull_request', git))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the check reports malformed fragments and leaves the repository alone', () => {
  const directory = fixture({ 'bad.md': '没有小节标题。\n' })
  try {
    const result = run(directory, ['--check'])

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /变更分片处理失败/)
    assert.match(result.stderr, /bad\.md:1/)
    assert.equal(fs.readFileSync(path.join(directory, 'CHANGELOG.md'), 'utf8'), changelog)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

// count 条用户条目，每条都带一行续行：续行属于上一条，不能多算。
function userFragment(count, label = '条目') {
  const lines = []
  for (let index = 1; index <= count; index += 1) lines.push(`- ${label}${index}。`, '  续行。')
  return `## 用户\n\n${lines.join('\n')}\n\n## 开发\n\n- 技术说明。\n`
}

test('the user entries are counted the way the update page counts them', () => {
  // 未发布段里原有 1 条，加上两个分片的 3 条；开发条目和续行都不算。
  const directory = fixture({ 'a.md': userFragment(2), 'b.md': '## 开发\n\n- 只有开发。\n', 'c.md': userFragment(1, '另一条') })
  try {
    assert.equal(countUserItems(directory, readFragments(directory)), 4)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the check refuses user entries that would overflow the update page', () => {
  // 未发布段里原有 1 条：再加 MAX_ITEMS - 1 条正好放满，再多一条就该报，不能等到发版构建才发现。
  const full = fixture({ 'full.md': userFragment(MAX_ITEMS - 1) })
  const over = fixture({ 'full.md': userFragment(MAX_ITEMS - 1), 'one-more.md': userFragment(1, '多出来的') })
  try {
    assert.equal(assertUserItemsFit(full, readFragments(full)), MAX_ITEMS)
    assert.throws(
      () => assertUserItemsFit(over, readFragments(over)),
      new RegExp(`已经 ${MAX_ITEMS + 1} 条，装完后的更新页一版最多放 ${MAX_ITEMS} 条`),
    )

    const passed = run(full, ['--check'])
    assert.equal(passed.status, 0, passed.stderr)
    assert.match(passed.stdout, new RegExp(`「## 用户」合计 ${MAX_ITEMS} 条（一版最多 ${MAX_ITEMS} 条）`))
    const refused = run(over, ['--check'])
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /变更分片处理失败/)
    assert.match(refused.stderr, /并成一条/)
    assert.match(refused.stderr, /001- 开头的分片/)
    // 只报不改：并哪几条要人来挑。
    assert.deepEqual(fs.readdirSync(path.join(over, 'changes', 'unreleased')).sort(), ['README.md', 'TEMPLATE.md.example', 'full.md', 'one-more.md'])
    assert.equal(fs.readFileSync(path.join(over, 'release-notes.md'), 'utf8'), releaseNotes)
  } finally {
    fs.rmSync(full, { recursive: true, force: true })
    fs.rmSync(over, { recursive: true, force: true })
  }
})

test('the check reports the user entry count even without fragments', () => {
  const directory = fixture()
  try {
    const result = run(directory, ['--check'])

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /本次没有分片，「## 用户」合计 1 条/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

const finalNotes = '## 用户\n\n- 定稿的第一句。\n- 定稿的第二句。\n\n## 开发\n\n- 为什么定稿。\n'

test('once the customer notes are finalized, other fragments may carry only a developer half', () => {
  const directory = fixture({ [finalUserNotesFragment]: finalNotes, 'later.md': '## 开发\n\n- 定稿之后合进来的改动。\n' })
  try {
    assert.doesNotThrow(() => assertUserNotesNotFinalized(readFragments(directory)))
    const result = run(directory, ['--check'])
    assert.equal(result.status, 0, result.stderr)
    // 未发布段里原有 1 条，加上定稿那 2 句。
    assert.match(result.stdout, /「## 用户」合计 3 条/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a fragment that adds a customer line to finalized notes is refused by the check and by collect', () => {
  const fragments = { [finalUserNotesFragment]: finalNotes, 'late.md': userFragment(1, '定稿后又加的'), 'quiet.md': '## 开发\n\n- 只有开发。\n' }
  const directory = fixture(fragments)
  try {
    assert.throws(() => assertUserNotesNotFinalized(readFragments(directory)), /已经定稿[\s\S]*late\.md/)

    const checked = run(directory, ['--check'])
    assert.notEqual(checked.status, 0)
    assert.match(checked.stderr, /变更分片处理失败/)
    assert.match(checked.stderr, new RegExp(`整份写在 changes/unreleased/${finalUserNotesFragment.replace('.', '\\.')}`))
    assert.match(checked.stderr, /删掉这几个分片里的「## 用户」：late\.md。/)

    // 发版时汇总也拦下，一个文件都不动，免得多出来的那句跟着定稿的几句进了更新页。
    const collected = run(directory)
    assert.notEqual(collected.status, 0)
    assert.deepEqual(fs.readdirSync(path.join(directory, 'changes', 'unreleased')).sort(), ['README.md', 'TEMPLATE.md.example', finalUserNotesFragment, 'late.md', 'quiet.md'].sort())
    assert.equal(fs.readFileSync(path.join(directory, 'release-notes.md'), 'utf8'), releaseNotes)
    assert.equal(fs.readFileSync(path.join(directory, 'CHANGELOG.md'), 'utf8'), changelog)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('customer lines in several fragments are fine while no version has finalized its notes', () => {
  const directory = fixture({ 'a.md': userFragment(1), 'b.md': userFragment(1, '另一条') })
  try {
    assert.doesNotThrow(() => assertUserNotesNotFinalized(readFragments(directory)))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('collecting finalized notes ships them in order and removes the fragment, so the next version starts open', () => {
  const directory = fixture({ [finalUserNotesFragment]: finalNotes, 'later.md': '## 开发\n\n- 定稿之后合进来的改动。\n' })
  try {
    const result = run(directory)
    assert.equal(result.status, 0, result.stderr)
    const notes = readUnreleasedSection(fs.readFileSync(path.join(directory, 'release-notes.md'), 'utf8'), userSection)
    assert.deepEqual(notes, ['- 已经在 main 上的用户条目。', '- 定稿的第一句。', '- 定稿的第二句。'])
    assert.deepEqual(fs.readdirSync(path.join(directory, 'changes', 'unreleased')).sort(), ['README.md', 'TEMPLATE.md.example'])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the collect command reports what it merged and what it removed', () => {
  const directory = fixture({ 'n4.md': '## 用户\n\n- 条目。\n\n## 开发\n\n- 技术说明。\n  续行。\n\n- 第二条。\n' })
  try {
    const result = run(directory)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /已汇入 release-notes\.md：1 条/)
    // A wrapped entry counts once, not once per line.
    assert.match(result.stdout, /已汇入 CHANGELOG\.md：2 条/)
    assert.match(result.stdout, /已删除 1 个分片：n4\.md/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a release is only clear once every fragment has been collected', () => {
  // #1086：publish-release 占 tag 之前跑这一条。说明和模板常驻，不算漏收。
  const empty = fixture()
  const pending = fixture({ 'p-10.md': '## 开发\n\n- 条目。\n', 'n4.md': '## 用户\n\n- 条目。\n' })
  try {
    assert.doesNotThrow(() => assertAllCollected(empty))
    assert.throws(() => assertAllCollected(pending), /还有 2 个没汇总的分片：n4\.md、p-10\.md/)

    const clear = run(empty, ['--assert-collected'])
    assert.equal(clear.status, 0, clear.stderr)
    assert.match(clear.stdout, /分片都已汇总/)
    const refused = run(pending, ['--assert-collected'])
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /n4\.md、p-10\.md/)
    assert.match(refused.stderr, /npm run changelog:collect/)
    // 只报不改：汇总要人在定版分支上做，顺手删掉分片就成了悄悄丢条目。
    assert.deepEqual(fs.readdirSync(path.join(pending, 'changes', 'unreleased')).sort(), ['README.md', 'TEMPLATE.md.example', 'n4.md', 'p-10.md'])
    assert.equal(fs.readFileSync(path.join(pending, 'release-notes.md'), 'utf8'), releaseNotes)
  } finally {
    fs.rmSync(empty, { recursive: true, force: true })
    fs.rmSync(pending, { recursive: true, force: true })
  }
})

test('every fragment committed to this repository parses', () => {
  // Deliberately not checkChanges(): that consults GITHUB_EVENT_PATH, and the
  // jobs running this suite check out a single commit the base is unreachable
  // from.
  assert.doesNotThrow(() => readFragments(repositoryRoot))
})

test('both unreleased sections are still where the collector expects them', () => {
  for (const section of sections) {
    const source = fs.readFileSync(path.join(repositoryRoot, section.file), 'utf8')
    const appended = appendToUnreleasedSection(source, section, ['- 探针条目。'])

    assert.notEqual(appended, source, `${section.file} 必须有「${section.unreleasedHeading}」段或可以新建一个`)
    assert.deepEqual(
      readUnreleasedSection(appended, section),
      [...readUnreleasedSection(source, section), '- 探针条目。'],
      `${section.file} 的未发布段必须原样保留并追加`,
    )
  }
})

// ui-spec/CHANGELOG.md：界面改动记录，一个 PR 一个分片，发版时按日期汇总到最上面。
const uiSpecLog = [
  '# CHANGELOG',
  '',
  '> 新的记录写在 ui-spec/changes/。',
  '',
  '格式：日期 · 版本 · 层级 · 改了什么 · 为什么 · 影响的页面',
  '',
  '- 2026-11-20 · v4.0 · 受控 · 已经在 main 上的较新一条 · 原因 · 首页',
  '- 2026-11-01 · v4.0 · 自由 · 已经在 main 上的较早一条 · 原因 · 设置',
  '',
].join('\n')

function uiSpecFixture(uiFragments = {}, fragments = {}) {
  const directory = fixture(fragments)
  fs.mkdirSync(path.join(directory, uiSpecFragmentDirectory), { recursive: true })
  fs.writeFileSync(path.join(directory, uiSpecChangelogFile), uiSpecLog, 'utf8')
  fs.writeFileSync(path.join(directory, uiSpecFragmentDirectory, 'README.md'), '# 说明\n\n- 这不是一条记录。\n', 'utf8')
  for (const [name, source] of Object.entries(uiFragments)) {
    fs.writeFileSync(path.join(directory, uiSpecFragmentDirectory, name), source, 'utf8')
  }
  return directory
}

function uiSpecLogEntries(directory) {
  return fs.readFileSync(path.join(directory, uiSpecChangelogFile), 'utf8').split('\n').filter((line) => line.startsWith('- ') || line.startsWith('  '))
}

test('an interface fragment holds log lines in the log format, wrapped lines included', () => {
  const entries = parseUiSpecFragment('wording-batch-14.md', [
    '',
    '- 2026-11-22 · v4.0 · 受控 · 第十四批改字 · 口吻定 · 配置',
    '  续行也属于同一条。',
    '- 2026-11-21 · v4.0 · 自由 · 另一块 · — · 设置',
    '',
  ].join('\n'))

  assert.deepEqual(entries, [
    { date: '2026-11-22', lines: ['- 2026-11-22 · v4.0 · 受控 · 第十四批改字 · 口吻定 · 配置', '  续行也属于同一条。'] },
    { date: '2026-11-21', lines: ['- 2026-11-21 · v4.0 · 自由 · 另一块 · — · 设置'] },
  ])
})

test('a malformed interface fragment is rejected with the file and line that caused it', () => {
  const rejected = [
    ['## 界面\n\n- 2026-11-22 · v4.0 · 受控 · 改了什么\n', /不写小节标题/],
    ['- 改了什么，忘了写日期\n', /每条要以「- 日期 · 」开头/],
    ['- 2026/11/22 · v4.0 · 受控 · 日期写法不对\n', /每条要以「- 日期 · 」开头/],
    ['- 2026-11-22 v4.0 少了分隔符\n', /每条要以「- 日期 · 」开头/],
    ['- 2026-02-30 · v4.0 · 受控 · 没有这一天\n', /日期「2026-02-30」不存在/],
    ['随手写的一句话。\n', /每个非空行都要以「- 日期 · 」开头/],
    ['  续行前面没有条目。\n', /每个非空行都要以「- 日期 · 」开头/],
    ['\n\n', /是空的/],
  ]
  for (const [source, expected] of rejected) {
    assert.throws(() => parseUiSpecFragment('bad.md', source), expected, source)
  }
  assert.throws(
    () => parseUiSpecFragment('bad.md', '- 2026-11-22 · v4.0 · 受控 · 好的一条\n\n- 坏的一条\n'),
    /ui-spec\/changes\/bad\.md:3/,
  )
})

test('the interface fragment README is not a fragment, and a tree without the directory has none', () => {
  const directory = uiSpecFixture({ 'a.md': '- 2026-11-22 · v4.0 · 自由 · 一条 · — · 首页\n' })
  const bare = fixture()
  try {
    assert.deepEqual(readUiSpecFragments(directory).map((fragment) => fragment.name), ['a.md'])
    assert.deepEqual(readUiSpecFragments(bare), [])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
    fs.rmSync(bare, { recursive: true, force: true })
  }
})

test('collected interface lines go above the log, newest date first, ties in file then written order', () => {
  const directory = uiSpecFixture({
    'b-same-day.md': '- 2026-11-22 · v4.0 · 自由 · b 文件那天的一条 · — · 设置\n',
    'a-two.md': [
      '- 2026-11-21 · v4.0 · 受控 · a 文件较早的一条 · 原因 · 首页',
      '  续行。',
      '- 2026-11-22 · v4.0 · 受控 · a 文件同一天的一条 · 原因 · 首页',
    ].join('\n'),
    'c-oldest.md': '- 2026-11-20 · v4.0 · 自由 · c 文件的一条 · — · 创作\n',
  })
  try {
    const result = collectUiSpecChanges(directory)

    assert.deepEqual(result, { fragments: ['a-two.md', 'b-same-day.md', 'c-oldest.md'], count: 4 })
    assert.deepEqual(uiSpecLogEntries(directory), [
      '- 2026-11-22 · v4.0 · 受控 · a 文件同一天的一条 · 原因 · 首页',
      '- 2026-11-22 · v4.0 · 自由 · b 文件那天的一条 · — · 设置',
      '- 2026-11-21 · v4.0 · 受控 · a 文件较早的一条 · 原因 · 首页',
      '  续行。',
      '- 2026-11-20 · v4.0 · 自由 · c 文件的一条 · — · 创作',
      '- 2026-11-20 · v4.0 · 受控 · 已经在 main 上的较新一条 · 原因 · 首页',
      '- 2026-11-01 · v4.0 · 自由 · 已经在 main 上的较早一条 · 原因 · 设置',
    ])
    // The title, the note and the format line stay where they were.
    assert.ok(fs.readFileSync(path.join(directory, uiSpecChangelogFile), 'utf8').startsWith(uiSpecLog.split('- 2026-11-20')[0]))
    assert.deepEqual(fs.readdirSync(path.join(directory, uiSpecFragmentDirectory)), ['README.md'])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('collecting into a log with no entries yet starts the list below its header', () => {
  const entries = orderUiSpecEntries([{ name: 'a.md', entries: parseUiSpecFragment('a.md', '- 2026-11-22 · v4.0 · 自由 · 第一条 · — · 首页\n') }])

  assert.equal(insertUiSpecEntries('# CHANGELOG\n\n格式：说明\n\n', entries), '# CHANGELOG\n\n格式：说明\n\n- 2026-11-22 · v4.0 · 自由 · 第一条 · — · 首页\n')
})

test('collecting without interface fragments leaves the log byte-identical', () => {
  const directory = uiSpecFixture()
  try {
    assert.deepEqual(collectUiSpecChanges(directory), { fragments: [], count: 0 })
    assert.equal(fs.readFileSync(path.join(directory, uiSpecChangelogFile), 'utf8'), uiSpecLog)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the collect command gathers interface fragments together with the release fragments', () => {
  const directory = uiSpecFixture(
    { 'create-library.md': '- 2026-11-22 · v4.0 · 受控 · 作品库 · 原因 · 创作\n' },
    { 'create-library.md': '## 开发\n\n- 作品库。\n' },
  )
  try {
    const result = run(directory)

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /已删除 1 个分片：create-library\.md/)
    assert.match(result.stdout, /已汇入 ui-spec\/CHANGELOG\.md：1 条/)
    assert.match(result.stdout, /已删除 1 个界面改动分片：create-library\.md/)
    assert.equal(uiSpecLogEntries(directory)[0], '- 2026-11-22 · v4.0 · 受控 · 作品库 · 原因 · 创作')
    assert.deepEqual(fs.readdirSync(path.join(directory, 'changes', 'unreleased')).sort(), ['README.md', 'TEMPLATE.md.example'])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('a malformed interface fragment stops the collect before any file is written', () => {
  const directory = uiSpecFixture({ 'bad.md': '- 没有日期\n' }, { 'n4.md': '## 用户\n\n- 条目。\n' })
  try {
    const result = run(directory)

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /ui-spec\/changes\/bad\.md:1/)
    assert.equal(fs.readFileSync(path.join(directory, 'release-notes.md'), 'utf8'), releaseNotes)
    assert.equal(fs.readFileSync(path.join(directory, uiSpecChangelogFile), 'utf8'), uiSpecLog)
    assert.ok(fs.existsSync(path.join(directory, 'changes', 'unreleased', 'n4.md')))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('the check parses every interface fragment and reports how many are pending', () => {
  const good = uiSpecFixture({ 'a.md': '- 2026-11-22 · v4.0 · 自由 · 一条 · — · 首页\n', 'b.md': '- 2026-11-22 · v4.0 · 自由 · 另一条 · — · 设置\n' })
  const bad = uiSpecFixture({ 'bad.md': '## 标题\n' })
  try {
    const passed = run(good, ['--check'])
    assert.equal(passed.status, 0, passed.stderr)
    assert.match(passed.stdout, /界面改动分片校验通过：ui-spec\/changes 下 2 个/)

    const refused = run(bad, ['--check'])
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /ui-spec\/changes\/bad\.md:1/)
  } finally {
    fs.rmSync(good, { recursive: true, force: true })
    fs.rmSync(bad, { recursive: true, force: true })
  }
})

// A fake git over named revisions: each holds the log's text and the fragment
// names under ui-spec/changes/ at that commit.
function fakeUiSpecGit(revisions, forkPoint) {
  return (_command, argv) => {
    if (argv[0] === 'merge-base') {
      if (forkPoint === null) throw new Error('fatal: no merge base')
      return `${forkPoint}\n`
    }
    if (argv[0] === 'ls-tree') {
      const revision = revisions[argv[3]]
      assert.equal(argv[4], `${uiSpecFragmentDirectory}/`)
      return revision.fragments.map((name) => `${uiSpecFragmentDirectory}/${name}`).join('\0')
    }
    if (argv[0] === 'show') {
      const [revision, file] = argv[1].split(':')
      assert.equal(file, uiSpecChangelogFile)
      return revisions[revision].log
    }
    throw new Error(`unexpected git ${argv.join(' ')}`)
  }
}

const mainNow = 'a'.repeat(40)
const prHead = 'b'.repeat(40)
const forkedFrom = 'c'.repeat(40)
const newerLog = uiSpecLog.replace('- 2026-11-20', '- 2026-11-22 · v4.0 · 受控 · 直接加在最上面的一行 · 原因 · 首页\n- 2026-11-20')

test('a pull request that adds a line to the interface log directly is refused with the fragment recipe', () => {
  const git = fakeUiSpecGit({
    [forkedFrom]: { log: uiSpecLog, fragments: ['README.md'] },
    [prHead]: { log: newerLog, fragments: ['README.md'] },
    [mainNow]: { log: uiSpecLog, fragments: ['README.md'] },
  }, forkedFrom)

  assert.throws(
    () => assertNoDirectUiSpecChangelogEdit('.', pullRequestEvent(mainNow, prHead), 'pull_request', git),
    /ui-spec\/CHANGELOG\.md 里直接加了 1 条记录[\s\S]*挪到 ui-spec\/changes\/ 下一个新文件里[\s\S]*npm run changelog:collect/,
  )
})

test('lines main gained after the fork are not counted against the pull request', () => {
  // main 在这个 PR 拉分支之后汇总过一次：拿 main 现在的样子比，就会误算成这个 PR 加的。
  const git = fakeUiSpecGit({
    [forkedFrom]: { log: uiSpecLog, fragments: ['README.md', 'early.md'] },
    [prHead]: { log: uiSpecLog, fragments: ['README.md', 'early.md', 'mine.md'] },
    [mainNow]: { log: newerLog, fragments: ['README.md'] },
  }, forkedFrom)

  assert.doesNotThrow(() => assertNoDirectUiSpecChangelogEdit('.', pullRequestEvent(mainNow, prHead), 'pull_request', git))
})

test('the release commit that collects interface fragments may grow the log', () => {
  const git = fakeUiSpecGit({
    [forkedFrom]: { log: uiSpecLog, fragments: ['README.md', 'wording-batch-14.md'] },
    [prHead]: { log: newerLog, fragments: ['README.md'] },
  }, forkedFrom)

  assert.doesNotThrow(() => assertNoDirectUiSpecChangelogEdit('.', pullRequestEvent(mainNow, prHead), 'pull_request', git))
})

test('correcting an old line in the interface log is allowed', () => {
  const git = fakeUiSpecGit({
    [forkedFrom]: { log: uiSpecLog, fragments: ['README.md'] },
    [prHead]: { log: uiSpecLog.replace('较早一条', '较早一条（订正错字）'), fragments: ['README.md'] },
  }, forkedFrom)

  assert.doesNotThrow(() => assertNoDirectUiSpecChangelogEdit('.', pullRequestEvent(mainNow, prHead), 'pull_request', git))
})

test('the interface log check only stops pull requests and skips what it cannot reach', () => {
  const unexpected = () => { throw new Error('git should not run') }
  assert.doesNotThrow(() => assertNoDirectUiSpecChangelogEdit('.', { before: mainNow, after: prHead }, 'push', unexpected))
  assert.doesNotThrow(() => assertNoDirectUiSpecChangelogEdit('.', { pull_request: { base: { sha: 'nope' }, head: { sha: prHead } } }, 'pull_request', unexpected))
  assert.doesNotThrow(() => assertNoDirectUiSpecChangelogEdit('.', pullRequestEvent(mainNow, prHead), 'pull_request', fakeUiSpecGit({}, null)))
})

test('every interface fragment committed to this repository parses', () => {
  assert.doesNotThrow(() => readUiSpecFragments(repositoryRoot))
})

test('the interface log is still where the collector expects it, entries below its header', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, uiSpecChangelogFile), 'utf8')
  const probe = orderUiSpecEntries([{ name: 'probe.md', entries: parseUiSpecFragment('probe.md', '- 2099-01-01 · v4.0 · 自由 · 探针条目 · — · —\n') }])
  const inserted = insertUiSpecEntries(source, probe).split('\n')
  const firstEntry = inserted.findIndex((line) => line.startsWith('- '))

  assert.equal(inserted[firstEntry], '- 2099-01-01 · v4.0 · 自由 · 探针条目 · — · —')
  assert.ok(inserted.slice(0, firstEntry).some((line) => line.startsWith('格式：')), 'the format line stays above every entry')
  // Every line already in the log keeps the date-first shape the collector orders by.
  for (const line of source.split('\n').filter((entry) => entry.startsWith('- '))) {
    assert.match(line, /^- \d{4}-\d{2}-\d{2} · /)
  }
})
