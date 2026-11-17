const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const test = require('node:test')
const YAML = require('yaml')

const {
  GUARDS,
  buildAnnotations,
  buildReport,
  fetchPullRequest,
  formatMarkdown,
  guardFor,
  hasFindings,
  isTestFile,
  pullRequestRange,
  resolveRegion,
  runInActions,
  scriptTokens,
  testCounts,
} = require('./report-removed-guards.cjs')

const root = path.resolve(__dirname, '..')
const workflowPath = path.join(root, '.github', 'workflows', 'removed-guards.yml')
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)

function git(directory, args) {
  return execFileSync('git', ['-C', directory, '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' })
}

function writeFiles(directory, files) {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(directory, file)
    if (content === null) {
      fs.rmSync(target, { force: true })
      continue
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content, 'utf8')
  }
}

function commitAll(directory, message) {
  git(directory, ['add', '-A'])
  git(directory, ['commit', '-q', '--allow-empty', '-m', message])
  return git(directory, ['rev-parse', 'HEAD']).trim()
}

// One base commit, then one head commit per scenario; `rename` moves a file
// with git so the diff reports it as a rename.
function scenario(t, base, head, { rename } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-removed-guards-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  git(directory, ['init', '-q', '-b', 'main'])
  writeFiles(directory, base)
  const from = commitAll(directory, 'base')
  if (rename) git(directory, ['mv', rename.from, rename.to])
  writeFiles(directory, head)
  const to = commitAll(directory, 'head')
  return { directory, report: buildReport({ repository: directory, from, head: to }) }
}

function removedTexts(finding) {
  return finding.hunks.flatMap((hunk) => hunk.removed.map((entry) => entry.text.trim()))
}

const qualityBase = [
  'jobs:',
  '  test:',
  '    # Why this job exists.',
  '    runs-on: ubuntu-latest',
  '',
  '  quality-gate:',
  '    needs: [test, audit]',
  '    steps:',
  '      - run: check test',
  '      - run: check audit',
  '',
].join('\n')

test('a removed guard line is reported; blank, comment-only and moved lines are not', (t) => {
  const head = [
    'jobs:',
    '  test:',
    '    runs-on: ubuntu-latest',
    '  quality-gate:',
    '    needs: [test]',
    '    steps:',
    '      - run: check audit',
    '      - run: check test',
    '',
  ].join('\n')
  const { report } = scenario(t, { '.github/workflows/quality.yml': qualityBase }, { '.github/workflows/quality.yml': head })

  assert.equal(report.guards.length, 1)
  const [finding] = report.guards
  assert.equal(finding.guard.id, 'quality')
  assert.equal(finding.newPath, '.github/workflows/quality.yml')
  assert.deepEqual(removedTexts(finding), ['needs: [test, audit]'])
  assert.ok(finding.hunks[0].added.some((text) => text.trim() === 'needs: [test]'), 'the replacement is shown next to what it replaced')
})

const commandRunnerBase = [
  'export function other() {',
  '  const before = 1',
  '}',
  'export function trustedCommandEnvironment(',
  '  baseEnv,',
  ') {',
  '  const unsafeKeys = new Set([',
  "    'node_options',",
  "    'ld_preload',",
  '  ])',
  '}',
  'export function after() {',
  '  return 2',
  '}',
  '',
].join('\n')

test('in command-runner.ts only the trusted environment function is watched', (t) => {
  const head = commandRunnerBase
    .replace('  const before = 1\n', '')
    .replace("    'ld_preload',\n", '')
    .replace('return 2', 'return 3')
  const { report } = scenario(t, { 'electron/command-runner.ts': commandRunnerBase }, { 'electron/command-runner.ts': head })

  assert.equal(report.guards.length, 1)
  assert.equal(report.guards[0].guard.id, 'trusted-env')
  assert.equal(report.guards[0].regionMissing, false)
  assert.deepEqual(removedTexts(report.guards[0]), ["'ld_preload',"])
})

test('a guard region that cannot be found makes the whole file count', (t) => {
  const base = 'export function renamedEnvironment() {\n  const keys = 1\n}\nexport function after() {\n  return 2\n}\n'
  const { report } = scenario(t, { 'electron/command-runner.ts': base }, { 'electron/command-runner.ts': base.replace('return 2', 'return 3') })

  assert.equal(report.guards.length, 1)
  assert.equal(report.guards[0].regionMissing, true)
  assert.deepEqual(removedTexts(report.guards[0]), ['return 2'])
  assert.deepEqual(resolveRegion(GUARDS.find((guard) => guard.id === 'trusted-env').region, base), { missing: true })
})

test('a deleted guard file and a renamed one are both reported', (t) => {
  const verify = "// A gate.\nconst test = require('node:test')\ntest('blocks fetch', () => {\n  assert.equal(scan(), 0)\n})\n"
  const policy = "export const policies = {\n  'config:get': { log: 'quiet-success' },\n  'config:save': { log: 'normal' },\n}\n"
  const { report } = scenario(
    t,
    { 'scripts/verify-fixture.test.cjs': verify, 'electron/ipc-channel-policy.ts': policy },
    { 'scripts/verify-fixture.test.cjs': null, 'electron/ipc-policy.ts': policy.replace("'config:get': { log: 'quiet-success' }", "'config:get': { log: 'normal' }") },
    { rename: { from: 'electron/ipc-channel-policy.ts', to: 'electron/ipc-policy.ts' } },
  )

  const deleted = report.guards.find((finding) => finding.guard.id === 'verify')
  assert.equal(deleted.deletedFile, true)
  assert.equal(deleted.newPath, null)
  assert.equal(deleted.lines, 4, 'the comment line is not counted')
  const renamed = report.guards.find((finding) => finding.guard.id === 'ipc-policy')
  assert.equal(renamed.oldPath, 'electron/ipc-channel-policy.ts')
  assert.equal(renamed.newPath, 'electron/ipc-policy.ts')
  assert.deepEqual(removedTexts(renamed), ["'config:get': { log: 'quiet-success' },"])
  // The gate is also a test file, so its cases and assertions are counted.
  assert.deepEqual(report.tests.map((finding) => [finding.oldPath, finding.newPath, finding.before.cases, finding.after.cases]), [['scripts/verify-fixture.test.cjs', null, 1, 0]])
})

test('test cases and assertions are counted per file, so a rewrite stays quiet', (t) => {
  const suite = [
    "import { expect, it } from 'vitest'",
    "it('one', () => { expect(1).toBe(1) })",
    "it('two', () => {",
    '  expect(2).toBe(2)',
    "  expect(pattern.test('x')).toBe(true)",
    '})',
    '',
  ].join('\n')
  const rewritten = suite.replaceAll('toBe(', 'toEqual(')
  const commentedOut = suite.replace("it('two', () => {\n  expect(2).toBe(2)\n  expect(pattern.test('x')).toBe(true)\n})", "// it('two', () => {\n//   expect(2).toBe(2)\n// })")
  const { report } = scenario(
    t,
    {
      'electron/rewrite.test.ts': suite,
      'electron/commented.test.ts': suite,
      'e2e/smoke.mjs': "assert.equal(a, 1)\nassert.ok(b)\n",
      'canvas-v2/src/kernel.test.ts': suite,
    },
    {
      'electron/rewrite.test.ts': rewritten,
      'electron/commented.test.ts': commentedOut,
      'e2e/smoke.mjs': null,
      'canvas-v2/src/kernel.test.ts': null,
      'src/renderer-v2/skipped.test.tsx': "it.skip('later', () => {})\n",
    },
  )

  const byFile = Object.fromEntries(report.tests.map((finding) => [finding.newPath || finding.oldPath, finding]))
  assert.deepEqual(Object.keys(byFile).sort(), ['e2e/smoke.mjs', 'electron/commented.test.ts', 'src/renderer-v2/skipped.test.tsx'])
  assert.deepEqual([byFile['electron/commented.test.ts'].before, byFile['electron/commented.test.ts'].after], [{ cases: 2, assertions: 3, skips: 0 }, { cases: 1, assertions: 1, skips: 0 }])
  assert.equal(byFile['e2e/smoke.mjs'].newPath, null)
  assert.deepEqual(byFile['e2e/smoke.mjs'].before, { cases: 0, assertions: 2, skips: 0 })
  assert.equal(byFile['src/renderer-v2/skipped.test.tsx'].oldPath, null)
  assert.equal(byFile['src/renderer-v2/skipped.test.tsx'].after.skips, 1)
})

test('the counting rules see test calls, not lookalikes', () => {
  assert.deepEqual(testCounts([
    "it.runIf(process.platform === 'win32')('gated', () => {})",
    "test('node', (t) => { t.assert.equal(1, 1); assert(ok); assert.deepEqual(a, b) })",
    "expect.soft(value).toBe(1)",
    "const matched = pattern.test(text) && regex.test(other)",
    "describe.only('focus', () => { it.todo('later') })",
    '/* it(\'gone\', () => { expect(1).toBe(1) }) */',
  ].join('\n')), { cases: 3, assertions: 3, skips: 2 })
  assert.equal(isTestFile('electron/x.test.ts'), true)
  assert.equal(isTestFile('src/renderer-v2/features/app-check.mjs'), true)
  assert.equal(isTestFile('canvas-v2/src/x.test.ts'), false)
  assert.equal(isTestFile('electron/x.ts'), false)
})

test('test commands that stop running something are reported, suites moved between them are not', (t) => {
  const scripts = {
    test: 'npm run test:a && npm run test:b',
    'test:a': 'node --test x.test.cjs y.test.cjs',
    'test:b': 'node --test z.test.cjs',
    build: 'vite build',
  }
  const packageJson = (value) => `${JSON.stringify({ name: 'fixture', scripts: value }, null, 2)}\n`

  const moved = scenario(t, { 'package.json': packageJson(scripts) }, { 'package.json': packageJson({ ...scripts, 'test:a': 'node --test x.test.cjs', 'test:b': 'node --test y.test.cjs z.test.cjs w.test.cjs', build: 'vite build --minify' }) })
  assert.equal(moved.report.scripts, null)

  const dropped = scenario(t, { 'package.json': packageJson(scripts) }, { 'package.json': packageJson({ ...scripts, 'test:b': 'node --test w.test.cjs' }) })
  assert.deepEqual(dropped.report.scripts, { removed: ['z.test.cjs'] })

  const whole = scenario(t, { 'package.json': packageJson(scripts) }, { 'package.json': packageJson({ test: 'npm run test:a', 'test:a': scripts['test:a'] }) })
  assert.deepEqual(whole.report.scripts.removed.sort(), ['&&', '<test:b>', 'test:b', 'z.test.cjs'])

  const broken = scenario(t, { 'package.json': packageJson(scripts) }, { 'package.json': '{ "scripts": ' })
  assert.deepEqual(broken.report.scripts, { unreadable: true, removed: [] })

  assert.deepEqual([...scriptTokens(packageJson({ build: 'vite', typecheck: 'tsc -b' }))], ['<typecheck>', 'tsc', '-b'])
})

test('a change that only adds stays quiet', (t) => {
  const { report } = scenario(
    t,
    { '.github/workflows/quality.yml': qualityBase, 'electron/a.test.ts': "it('one', () => { expect(1).toBe(1) })\n", 'electron/other.ts': 'export const a = 1\n' },
    {
      '.github/workflows/quality.yml': qualityBase.replace('      - run: check audit\n', '      - run: check audit\n      - run: check secrets\n'),
      'electron/a.test.ts': "it('one', () => { expect(1).toBe(1) })\nit('two', () => { expect(2).toBe(2) })\n",
      'electron/other.ts': null,
    },
  )
  assert.equal(hasFindings(report), false)
  assert.match(formatMarkdown(report, { base: SHA_A }), /没有删门禁里的行，测试用例和断言也没有变少。[\s\S]*main 上 aaaaaaa 那一份/)
})

function guardFinding(overrides = {}) {
  return {
    guard: GUARDS[0],
    oldPath: '.github/workflows/quality.yml',
    newPath: '.github/workflows/quality.yml',
    deletedFile: false,
    regionMissing: false,
    hunks: [{ oldStart: 7, newStart: 0, removed: [{ line: 7, text: 'needs: [test, audit]' }], added: [] }],
    ...overrides,
  }
}

test('pull request text stays inside its code block and table cell', () => {
  const sneaky = guardFinding({ hunks: [{ oldStart: 3, newStart: 3, removed: [{ line: 3, text: '```\n## 假标题 ````' }], added: ['ok'] }] })
  const markdown = formatMarkdown({
    guards: [sneaky],
    tests: [{ oldPath: 'e2e/a|b`c\n.test.mjs', newPath: 'e2e/a|b`c\n.test.mjs', before: { cases: 2, assertions: 4, skips: 0 }, after: { cases: 1, assertions: 4, skips: 0 } }],
    scripts: null,
  }, { base: SHA_A })

  // The removed text holds a four-backtick run, so the block needs five.
  const fence = /^ {2}(`{3,})diff$/m.exec(markdown)[1]
  assert.equal(fence.length, 5)
  assert.match(markdown, /^ {2}-```\?## 假标题 ````$/m)
  const row = markdown.split('\n').find((line) => line.includes('a\\|b'))
  assert.equal(row, '| `` e2e/a\\|b`c?.test.mjs `` | 2 → 1 | 4 | 0 |')
  assert.match(markdown, /要 yoyo \*\*亲手打字同意\*\*才能合/)
})

test('annotations sit on the changed line, escape their properties and stop at the display limit', () => {
  const sneaky = guardFinding({ newPath: 'scripts/verify-a,b:c.test.cjs', hunks: [{ oldStart: 1, newStart: 0, removed: [{ line: 1, text: '::stop-commands::pwned' }], added: [] }] })
  const tests = Array.from({ length: 12 }, (_, index) => ({ oldPath: `electron/t${index}.test.ts`, newPath: `electron/t${index}.test.ts`, before: { cases: 2, assertions: 2, skips: 0 }, after: { cases: 1, assertions: 2, skips: 0 } }))
  const notes = buildAnnotations({ guards: [sneaky], tests, scripts: null })

  assert.equal(notes.length, 10)
  assert.match(notes[0], /^::warning file=scripts\/verify-a%2Cb%3Ac\.test\.cjs,line=1,title=门禁删行提醒::/)
  assert.match(notes[1], /^::warning file=electron\/t0\.test\.ts,title=门禁删行提醒::测试变少了：用例 2 → 1。/)
  assert.match(notes[9], /^::warning title=门禁删行提醒::还有 4 处没标出来/)
  // Pull request text never reaches standard output, where a line opening
  // with :: would be read as a workflow command.
  for (const note of notes) assert.doesNotMatch(note, /stop-commands|pwned/)
  for (const note of notes) assert.equal(note.split('\n').length, 1)
})

test('the range comes from a pull_request_target event and anything malformed is refused', () => {
  const event = (pull) => ({ pull_request: { number: 12, base: { sha: SHA_A }, head: { sha: SHA_B.toUpperCase() }, ...pull } })
  assert.deepEqual(pullRequestRange(event()), { number: 12, base: SHA_A, head: SHA_B })
  for (const number of ['12', 0, -1, 1.5, undefined]) assert.throws(() => pullRequestRange(event({ number })), /PR 编号/)
  assert.throws(() => pullRequestRange(event({ head: { sha: 'main' } })), /提交号/)
  assert.throws(() => pullRequestRange(event({ base: { sha: `${SHA_A}; rm -rf /` } })), /提交号/)
  assert.throws(() => pullRequestRange({}), /PR 编号/)
})

test('the pull request is fetched as data and measured from where it left the base', () => {
  const calls = []
  function run(command, args) {
    calls.push([command, ...args])
    if (args.includes('merge-base')) return `${SHA_C}\n`
    return ''
  }
  assert.equal(fetchPullRequest('/repo', { number: 7, base: SHA_A, head: SHA_B }, run), SHA_C)
  assert.deepEqual(calls, [
    ['git', '-C', '/repo', 'fetch', '--no-tags', '--quiet', 'origin', '+refs/pull/7/head:refs/remotes/origin/removed-guards-head'],
    ['git', '-C', '/repo', 'cat-file', '-e', `${SHA_B}^{commit}`],
    ['git', '-C', '/repo', 'merge-base', SHA_A, SHA_B],
  ])

  function moved(command, args) {
    if (args.includes('cat-file')) throw new Error('missing')
    return ''
  }
  assert.throws(() => fetchPullRequest('/repo', { number: 7, base: SHA_A, head: SHA_B }, moved), /新推的那次运行会接着查/)
})

test('in Actions the report reads main, fetches the pull request ref and writes the summary', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-removed-guards-actions-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const origin = path.join(directory, 'origin.git')
  const author = path.join(directory, 'author')
  const checkout = path.join(directory, 'checkout')
  git(directory, ['init', '-q', '--bare', '-b', 'main', origin])
  git(directory, ['init', '-q', '-b', 'main', author])
  writeFiles(author, { '.github/workflows/quality.yml': qualityBase })
  const base = commitAll(author, 'base')
  git(author, ['push', '-q', origin, 'main'])
  writeFiles(author, { '.github/workflows/quality.yml': qualityBase.replace('      - run: check audit\n', '') })
  const head = commitAll(author, 'pull request')
  git(author, ['push', '-q', origin, 'HEAD:refs/pull/42/head'])
  // Like actions/checkout on pull_request_target: main, not the pull request.
  git(directory, ['clone', '-q', origin, checkout])

  const eventPath = path.join(directory, 'event.json')
  const summaryPath = path.join(directory, 'summary.md')
  fs.writeFileSync(eventPath, JSON.stringify({ pull_request: { number: 42, base: { sha: base }, head: { sha: head } } }))
  const logged = []
  const report = runInActions({ env: { GITHUB_EVENT_PATH: eventPath, GITHUB_STEP_SUMMARY: summaryPath }, repository: checkout, log: (line) => logged.push(line) })

  assert.deepEqual(report.guards.map(removedTexts), [['- run: check audit']])
  assert.equal(git(checkout, ['rev-parse', 'HEAD']).trim(), base, 'the working tree stays on main')
  const summary = fs.readFileSync(summaryPath, 'utf8')
  assert.match(summary, /## 门禁删行提醒/)
  assert.match(summary, new RegExp(`main 上 ${base.slice(0, 7)} 那一份`))
  assert.match(summary, /-      - run: check audit/)
  assert.match(logged[0], /^::warning file=\.github\/workflows\/quality\.yml,line=9,title=/)
  assert.match(logged.at(-1), /1 份门禁文件、0 份测试文件有删减/)
  for (const line of logged) assert.doesNotMatch(line, /check audit/)
})

test('the reminder runs from main, never runs pull request code and never blocks a merge', () => {
  const text = fs.readFileSync(workflowPath, 'utf8')
  const workflow = YAML.parse(text)
  // Only pull_request_target takes the workflow and the checkout from the base
  // branch; with pull_request the change under review could rewrite its judge.
  assert.deepEqual(Object.keys(workflow.on), ['pull_request_target'])
  assert.deepEqual(workflow.on.pull_request_target.branches, ['main'])
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.doesNotMatch(YAML.stringify(workflow), /secrets\.|environment:/)

  const jobs = Object.entries(workflow.jobs)
  assert.equal(jobs.length, 1)
  const [, job] = jobs[0]
  assert.equal(job.permissions, undefined)
  assert.equal(job['continue-on-error'], undefined)
  assert.ok(job['timeout-minutes'] > 0)
  const checkout = job.steps.find((step) => String(step.uses || '').startsWith('actions/checkout@'))
  // No `ref`: the default on pull_request_target is the base branch. Pointing
  // it at the pull request would put its code in the workspace of a job that
  // holds the base repository's token.
  assert.equal(checkout.with.ref, undefined)
  assert.equal(checkout.with.repository, undefined)
  assert.equal(checkout.with['persist-credentials'], false)
  for (const step of job.steps) {
    if (step.uses) assert.match(step.uses, /^[^@]+@[0-9a-f]{40}$/, step.uses)
    if (String(step.uses || '').startsWith('actions/setup-node@')) {
      assert.equal(step.with.cache, undefined)
      assert.equal(step.with['package-manager-cache'], false)
    }
  }
  assert.deepEqual(job.steps.filter((step) => step.run).map((step) => step.run.trim()), ['node scripts/report-removed-guards.cjs'])

  const quality = YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'quality.yml'), 'utf8'))
  const qualityCheckout = quality.jobs.changes.steps.find((step) => String(step.uses || '').startsWith('actions/checkout@'))
  assert.equal(checkout.uses, qualityCheckout.uses, 'same pinned checkout as quality.yml')
  // Report only: nothing the merge waits for can depend on it.
  const protection = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'main-branch-protection.json'), 'utf8'))
  assert.deepEqual(protection.required_status_checks.checks.map((check) => check.context), ['quality-gate'])
})

test('the report script only ever runs git, and reads pull request files as text', () => {
  const source = fs.readFileSync(path.join(__dirname, 'report-removed-guards.cjs'), 'utf8')
  assert.deepEqual([...source.matchAll(/\brun\(\s*'([^']+)'/g)].map((match) => match[1]), ['git'])
  assert.deepEqual([...source.matchAll(/require\('node:child_process'\)/g)].length, 1)
  assert.match(source, /^const \{ execFileSync \} = require\('node:child_process'\)$/m)
  assert.doesNotMatch(source, /\b(?:spawn|spawnSync|execSync|fork)\s*\(/)
  assert.doesNotMatch(source, /'checkout'|'switch'|'worktree'/)
})

test('every guard still names a file on this branch', () => {
  const tracked = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  const files = new Set([...tracked, 'scripts/report-removed-guards.cjs', '.github/workflows/removed-guards.yml'])
  for (const guard of GUARDS) {
    for (const file of guard.paths || []) assert.ok(files.has(file) && fs.existsSync(path.join(root, file)), `${guard.id}: ${file} is gone, move the guard with it`)
    if (guard.pattern) assert.ok([...files].some((file) => guard.pattern.test(file)), `${guard.id}: nothing matches ${guard.pattern}`)
    if (guard.region) {
      const [file] = guard.paths
      const region = resolveRegion(guard.region, fs.readFileSync(path.join(root, file), 'utf8'))
      assert.equal(region.missing, undefined, `${guard.id}: the watched function in ${file} was renamed`)
      assert.ok(region.to - region.from > 20, `${guard.id}: the watched region in ${file} looks truncated`)
    }
  }
  assert.equal(guardFor('scripts/verify-renderer-boundary.test.cjs').id, 'verify')
  assert.equal(guardFor('scripts/verify-update-feed.cjs'), null)
  assert.equal(guardFor('electron/command-runner.ts').id, 'trusted-env')
})
