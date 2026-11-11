const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')

const {
  describeOutcome,
  formatDuration,
  inspectPrerequisites,
  installDependenciesCommand,
  installElectronCommand,
  renderReport,
  resolveContainerChromium,
  runStage,
  selfCheckStages,
  summarizeOutput,
} = require('./self-check.cjs')

const root = path.resolve(__dirname, '..')
const packageJson = require(path.join(root, 'package.json'))

function pullRequestTemplateSelfCheckCommands() {
  const template = fs.readFileSync(path.join(root, '.github', 'pull_request_template.md'), 'utf8')
  const section = template.split(/^## /m).find((part) => part.startsWith('自查'))
  assert.ok(section, 'the PR template still has a 自查 section')
  return [...section.matchAll(/^- \[ \] `(npm [^`]+)`$/gm)].map((match) => match[1])
}

function passedResult(overrides = {}) {
  return {
    label: 'npm run typecheck',
    status: 0,
    signal: null,
    error: null,
    durationMs: 68_000,
    summary: [],
    logFile: '/tmp/1-npm-run-typecheck.log',
    ...overrides,
  }
}

test('the stages are the four checks the PR template asks for, in the same order', () => {
  assert.deepEqual(
    selfCheckStages.map((stage) => stage.label),
    pullRequestTemplateSelfCheckCommands(),
  )
})

test('every stage runs exactly the npm script its label names', () => {
  for (const stage of selfCheckStages) {
    assert.equal(`npm ${stage.npmArguments.join(' ')}`, stage.label)
    const scriptName = stage.npmArguments.at(-1)
    assert.equal(typeof packageJson.scripts[scriptName], 'string', `${scriptName} is an npm script`)
  }
})

test('npm run selfcheck starts this script and takes no arguments of its own', () => {
  assert.equal(packageJson.scripts.selfcheck, 'node scripts/self-check.cjs')
})

test('the install commands it prints are the ones the quality workflow runs', () => {
  const workflow = YAML.parse(
    fs.readFileSync(path.join(root, '.github', 'workflows', 'quality.yml'), 'utf8'),
  )
  const commands = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run)
    .filter((command) => typeof command === 'string')
  assert.ok(commands.includes(installDependenciesCommand))
  assert.ok(commands.includes(installElectronCommand))
  assert.ok(fs.existsSync(path.join(root, installElectronCommand.replace(/^node /, ''))))
})

test('inspectPrerequisites lists both installs when node_modules is missing', () => {
  const missing = inspectPrerequisites({ root: '/repo', exists: () => false })
  assert.deepEqual(
    missing.map((entry) => entry.command),
    [installDependenciesCommand, installElectronCommand],
  )
})

test('inspectPrerequisites lists only the Electron binary when dependencies are installed', () => {
  const lockMarker = path.join('/repo', 'node_modules', '.package-lock.json')
  const missing = inspectPrerequisites({
    root: '/repo',
    exists: (candidate) => candidate === lockMarker,
  })
  assert.deepEqual(missing.map((entry) => entry.command), [installElectronCommand])
})

test('inspectPrerequisites reports nothing once the Electron binary is unpacked', () => {
  assert.deepEqual(inspectPrerequisites({ root: '/repo', exists: () => true }), [])
})

test('resolveContainerChromium points at the container browser only when Playwright has none', () => {
  const containerChromium = path.join('/opt/pw-browsers', 'chromium')
  assert.equal(
    resolveContainerChromium({
      environment: { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' },
      playwrightChromium: '/opt/pw-browsers/chromium-1234/chrome-linux64/chrome',
      isFile: (candidate) => candidate === containerChromium,
    }),
    containerChromium,
  )
  assert.equal(
    resolveContainerChromium({
      environment: { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' },
      playwrightChromium: null,
      isFile: (candidate) => candidate === containerChromium,
    }),
    containerChromium,
  )
})

test('resolveContainerChromium leaves a caller-provided browser alone', () => {
  assert.equal(
    resolveContainerChromium({
      environment: {
        PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers',
        XINGMANG_E2E_CHROMIUM: '/somewhere/else/chrome',
      },
      playwrightChromium: null,
      isFile: () => true,
    }),
    null,
  )
})

test('resolveContainerChromium leaves CI and local machines on the browser Playwright installed', () => {
  const playwrightChromium = '/home/runner/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'
  assert.equal(
    resolveContainerChromium({
      environment: { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' },
      playwrightChromium,
      isFile: () => true,
    }),
    null,
  )
  assert.equal(
    resolveContainerChromium({
      environment: {},
      playwrightChromium,
      isFile: (candidate) => candidate !== playwrightChromium,
    }),
    null,
  )
})

test('resolveContainerChromium does not invent a path the container does not have', () => {
  assert.equal(
    resolveContainerChromium({
      environment: { PLAYWRIGHT_BROWSERS_PATH: '/opt/pw-browsers' },
      playwrightChromium: null,
      isFile: () => false,
    }),
    null,
  )
})

test('summarizeOutput keeps the vitest summary lines and names the npm script they belong to', () => {
  const output = [
    '',
    '> xingmang-ai-manager@0.2.24 test:vitest',
    '> vitest run electron src --no-file-parallelism --testTimeout=30000',
    '',
    ' ✓ electron/catalog.test.ts (10 tests) 12ms',
    '',
    ' Test Files  412 passed (412)',
    '      Tests  9731 passed | 12 skipped (9743)',
    '   Start at  03:40:12',
    '   Duration  512.30s',
    '',
  ].join('\n')
  assert.deepEqual(summarizeOutput(output), [
    'test:vitest  Test Files  412 passed (412)',
    'test:vitest  Tests  9731 passed | 12 skipped (9743)',
  ])
})

test('summarizeOutput joins the node --test counters of each suite group on one line', () => {
  const output = [
    '> xingmang-ai-manager@0.2.24 test:scripts',
    '> node --test scripts/a.test.cjs',
    '',
    'ok 1 - first',
    '# tests 21',
    '# suites 0',
    '# pass 21',
    '# fail 0',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
    '# duration_ms 812.5',
    '',
    '> xingmang-ai-manager@0.2.24 posttest:scripts',
    '> node --test scripts/b.test.cjs',
    '',
    'ℹ tests 4',
    'ℹ suites 1',
    'ℹ pass 3',
    'ℹ fail 1',
    'ℹ cancelled 0',
    'ℹ skipped 0',
    'ℹ todo 0',
    'ℹ duration_ms 90.1',
  ].join('\r\n')
  assert.deepEqual(summarizeOutput(output), [
    'test:scripts  # tests 21  # suites 0  # pass 21  # fail 0  # cancelled 0  # skipped 0  # todo 0',
    'posttest:scripts  ℹ tests 4  ℹ suites 1  ℹ pass 3  ℹ fail 1  ℹ cancelled 0  ℹ skipped 0  ℹ todo 0',
  ])
})

test('summarizeOutput keeps two suite groups of the same npm script apart', () => {
  const output = ['# tests 2', '# pass 2', '# fail 0', '# tests 5', '# pass 4', '# fail 1'].join('\n')
  assert.deepEqual(summarizeOutput(output), [
    '# tests 2  # pass 2  # fail 0',
    '# tests 5  # pass 4  # fail 1',
  ])
})

test('summarizeOutput reads through terminal colors and reports failures as printed', () => {
  const output = [
    '\u001b[2m Test Files \u001b[22m \u001b[1m\u001b[31m1 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m3 passed\u001b[39m\u001b[22m\u001b[90m (4)\u001b[39m',
    '\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[31m2 failed\u001b[39m\u001b[22m\u001b[2m | \u001b[22m\u001b[1m\u001b[32m30 passed\u001b[39m\u001b[22m\u001b[90m (32)\u001b[39m',
  ].join('\n')
  assert.deepEqual(summarizeOutput(output), [
    'Test Files  1 failed | 3 passed (4)',
    'Tests  2 failed | 30 passed (32)',
  ])
})

test('summarizeOutput falls back to the last line a check printed', () => {
  const output = [
    '',
    '> xingmang-ai-manager@0.2.24 check:v2',
    '> node e2e/renderer-v2-testid-inventory.cjs',
    '',
    '{"files":619,"testIds":2104}',
    '',
  ].join('\n')
  assert.deepEqual(summarizeOutput(output), ['{"files":619,"testIds":2104}'])
})

test('summarizeOutput is empty for a check that prints nothing of its own', () => {
  const output = [
    '',
    '> xingmang-ai-manager@0.2.24 typecheck',
    '> tsc --noEmit && tsc -p tsconfig.electron.json --noEmit',
    '',
  ].join('\n')
  assert.deepEqual(summarizeOutput(output), [])
})

test('formatDuration rounds to whole seconds and switches to minutes after one minute', () => {
  assert.equal(formatDuration(499), '0 秒')
  assert.equal(formatDuration(5_400), '5 秒')
  assert.equal(formatDuration(59_400), '59 秒')
  assert.equal(formatDuration(60_000), '1 分 0 秒')
  assert.equal(formatDuration(68_300), '1 分 8 秒')
})

test('describeOutcome tells a pass, a failure, a signal and a failed start apart', () => {
  assert.equal(describeOutcome(passedResult()), '通过')
  assert.equal(describeOutcome(passedResult({ status: 1 })), '没过（退出码 1）')
  assert.equal(describeOutcome(passedResult({ status: null, signal: 'SIGTERM' })), '被 SIGTERM 中止')
  assert.equal(
    describeOutcome(passedResult({ status: null, error: new Error('spawn ENOENT') })),
    '没跑起来（spawn ENOENT）',
  )
})

test('renderReport lists every stage with its summary lines when all four passed', () => {
  const results = [
    passedResult(),
    passedResult({
      label: 'npm test',
      durationMs: 1_500_000,
      summary: ['test:vitest  Test Files  412 passed (412)'],
    }),
  ]
  assert.deepEqual(renderReport(results, { chromium: '/opt/pw-browsers/chromium' }), [
    '',
    '===== 自查汇总（原样贴进 PR 的「自查」一节）=====',
    '浏览器套件用的是 XINGMANG_E2E_CHROMIUM=/opt/pw-browsers/chromium',
    'npm run typecheck：通过，用时 1 分 8 秒',
    'npm test：通过，用时 25 分 0 秒',
    '  test:vitest  Test Files  412 passed (412)',
    '2 道都过了。',
  ])
})

test('renderReport names the failed stages and where their full output is', () => {
  const results = [
    passedResult(),
    passedResult({
      label: 'npm test',
      status: 1,
      durationMs: 30_000,
      summary: ['test:vitest  Tests  2 failed | 30 passed (32)'],
      logFile: '/tmp/2-npm-test.log',
    }),
    passedResult({ label: 'npm run check:v2', durationMs: 5_000 }),
    passedResult({
      label: 'npm run test:v2',
      status: null,
      signal: 'SIGKILL',
      durationMs: 1_000,
      logFile: '/tmp/4-npm-run-test-v2.log',
    }),
  ]
  assert.deepEqual(renderReport(results), [
    '',
    '===== 自查汇总（原样贴进 PR 的「自查」一节）=====',
    'npm run typecheck：通过，用时 1 分 8 秒',
    'npm test：没过（退出码 1），用时 30 秒',
    '  test:vitest  Tests  2 failed | 30 passed (32)',
    '  完整输出：/tmp/2-npm-test.log',
    'npm run check:v2：通过，用时 5 秒',
    'npm run test:v2：被 SIGKILL 中止，用时 1 秒',
    '  完整输出：/tmp/4-npm-run-test-v2.log',
    '4 道里有 2 道没过：npm test、npm run test:v2。',
  ])
})

test('runStage runs npm with the stage arguments, mirrors the output and keeps a full log', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-selfcheck-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const fakeNpm = path.join(directory, 'fake-npm.cjs')
  fs.writeFileSync(fakeNpm, [
    "const [, , ...npmArguments] = process.argv",
    "process.stdout.write(`argv ${JSON.stringify(npmArguments)}\\n`)",
    "process.stdout.write(`browser ${process.env.XINGMANG_E2E_CHROMIUM}\\n`)",
    "process.stderr.write(' Test Files  1 failed | 3 passed (4)\\n')",
    "process.stdout.write('      Tests  2 failed | 30 passed (32)\\n')",
    "process.exitCode = npmArguments.includes('test:v2') ? 3 : 0",
    '',
  ].join('\n'))

  const mirrored = []
  const passed = await runStage(
    { label: 'npm test', npmArguments: ['test'] },
    {
      npmCli: fakeNpm,
      environment: { ...process.env, XINGMANG_E2E_CHROMIUM: '/opt/pw-browsers/chromium' },
      logFile: path.join(directory, 'passed.log'),
      write: (chunk) => mirrored.push(chunk),
      cwd: directory,
    },
  )
  assert.equal(passed.label, 'npm test')
  assert.equal(passed.status, 0)
  assert.equal(passed.signal, null)
  assert.equal(passed.error, null)
  assert.deepEqual([...passed.summary].sort(), [
    'Test Files  1 failed | 3 passed (4)',
    'Tests  2 failed | 30 passed (32)',
  ])
  const log = fs.readFileSync(passed.logFile, 'utf8')
  assert.match(log, /^argv \["test"\]$/m)
  assert.match(log, /^browser \/opt\/pw-browsers\/chromium$/m)
  assert.equal(Buffer.concat(mirrored).toString('utf8').length, log.length)

  const failed = await runStage(
    { label: 'npm run test:v2', npmArguments: ['run', 'test:v2'] },
    {
      npmCli: fakeNpm,
      environment: process.env,
      logFile: path.join(directory, 'failed.log'),
      write: () => {},
      cwd: directory,
    },
  )
  assert.equal(failed.status, 3)
  assert.equal(describeOutcome(failed), '没过（退出码 3）')
  assert.match(fs.readFileSync(failed.logFile, 'utf8'), /^argv \["run","test:v2"\]$/m)
})
