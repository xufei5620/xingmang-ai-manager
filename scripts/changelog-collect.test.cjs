const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const {
  appendToUnreleasedSection,
  assertNoDirectUnreleasedEdit,
  changedFileStatuses,
  collectChanges,
  parseFragment,
  readFragments,
  readUnreleasedSection,
  sections,
} = require('./changelog-collect.cjs')

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
