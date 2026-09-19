const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')

const root = path.resolve(__dirname, '..')
const packageJson = require(path.join(root, 'package.json'))
const workflow = YAML.parse(
  fs.readFileSync(path.join(root, '.github', 'workflows', 'quality.yml'), 'utf8'),
)
const viteConfigSource = fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8')
const platformEntrySource = fs.readFileSync(
  path.join(root, 'electron', 'platform', 'desktop-entry.ts'),
  'utf8',
)
const entryRouterSource = fs.readFileSync(path.join(root, 'electron', 'platform', 'entry.ts'), 'utf8')

const darwinOnlyTests = [
  'scripts/create-macos-free-signing-certificate.test.cjs',
  'scripts/macos-ephemeral-signing.test.cjs',
  'scripts/verify-macos-free-signing.test.cjs',
  'scripts/verify-macos-free-artifacts.test.cjs',
  'scripts/run-macos-free-build.test.cjs',
]

function runSteps(jobName) {
  return workflow.jobs[jobName].steps
    .map((step) => step.run)
    .filter((command) => typeof command === 'string')
}

test('renderer v2 is the default and legacy remains an explicit rollback mode', () => {
  const scripts = packageJson.scripts

  assert.match(scripts.dev, /XINGMANG_RENDERER=v2\s+npm run dev:runtime/)
  assert.match(scripts['dev:legacy'], /XINGMANG_RENDERER=legacy\s+npm run dev:runtime/)
  assert.match(scripts.compile, /XINGMANG_RENDERER=v2\s+npm run compile:runtime/)
  assert.match(scripts['compile:legacy'], /XINGMANG_RENDERER=legacy\s+npm run compile:runtime/)
  for (const name of ['build', 'build:win:ci', 'build:mac:dir', 'build:mac:ci']) {
    assert.match(scripts[name], /npm run compile/, `${name} must use the default v2 compile`)
    assert.doesNotMatch(scripts[name], /compile:legacy/, `${name} must not package the rollback renderer`)
  }
  // release:build:unsigned no longer compiles inline: it delegates to the shared
  // release gate, which runs `npm run compile` as one of its steps (M-01).
  assert.match(scripts['release:build:unsigned'], /node scripts\/run-release-build\.cjs/)
  assert.doesNotMatch(scripts['release:build:unsigned'], /compile:legacy/)

  assert.match(viteConfigSource, /requestedRenderer === 'legacy' \? 'legacy' : 'v2'/)
  assert.match(viteConfigSource, /Unsupported XINGMANG_RENDERER value/)
  assert.match(viteConfigSource, /fileName: 'renderer-v2\.flag'/)
  assert.match(entryRouterSource, /require\('\.\/desktop-entry'\)/)
  assert.match(platformEntrySource, /requestedRenderer !== 'legacy'/)
  assert.match(platformEntrySource, /Boolean\(process\.env\.VITE_DEV_SERVER_URL\)/)
  assert.match(platformEntrySource, /usesDevServer \? requestedRenderer !== 'legacy' : builtWithV2/)
})

test('the common test suite excludes Darwin filesystem and signing fixtures', () => {
  const commonTestCommand = packageJson.scripts.test
  const macSigningCommand = packageJson.scripts['test:mac:free-signing']

  for (const fixture of darwinOnlyTests) {
    assert.equal(commonTestCommand.includes(fixture), false, `${fixture} must not run on Windows`)
    assert.equal(macSigningCommand.includes(fixture), true, `${fixture} must run in the macOS job`)
  }
})

test('browser-backed tests install Chromium first on every job that runs npm test', () => {
  for (const [jobName, testCommand, installCommand] of [
    ['test', 'npm run test:windows', 'npx --no-install playwright install chromium'],
    ['macos-test', 'npm test', 'npx --no-install playwright install chromium'],
    // Linux-only: --with-deps also apt-installs the shared libraries Chromium
    // links against, which (unlike Windows/macOS) a bare runner image lacks.
    ['linux-test', 'npm test', 'npx --no-install playwright install --with-deps chromium'],
  ]) {
    const commands = runSteps(jobName)
    const installIndex = commands.indexOf(installCommand)
    const testIndex = commands.indexOf(testCommand)

    assert.notEqual(testIndex, -1, `${jobName} must run ${testCommand}`)
    assert.notEqual(installIndex, -1, `${jobName} must install Chromium`)
    assert.ok(installIndex < testIndex, `${jobName} must install Chromium before ${testCommand}`)
  }
})

test('the Windows job enables unprivileged symlink creation before security tests', () => {
  const steps = workflow.jobs.test.steps
  const enableStepIndex = steps.findIndex((step) => (
    step.name === 'Enable Windows Developer Mode for symlink security tests'
  ))
  const testStepIndex = steps.findIndex((step) => step.run === 'npm run test:windows')

  assert.notEqual(enableStepIndex, -1, 'Windows CI must enable Developer Mode')
  assert.notEqual(testStepIndex, -1, 'Windows CI must run the Windows test suite')
  assert.ok(enableStepIndex < testStepIndex, 'Developer Mode must be enabled before tests')

  const enableStep = steps[enableStepIndex]
  assert.equal(enableStep.shell, 'pwsh')
  assert.match(String(enableStep.run), /AllowDevelopmentWithoutDevLicense/)
})

test('the Windows required job tests and compiles the default renderer v2', () => {
  const steps = workflow.jobs.test.steps
  const commands = runSteps('test')
  const browserInstallIndex = commands.indexOf('npx --no-install playwright install chromium')
  const v2TestIndex = commands.indexOf('npm run test:v2')
  const dirtyCheckIndex = steps.findIndex((step) => step.name === 'Fail if the test run left files in the working tree')
  const compileIndex = steps.findIndex((step) => step.run === 'npm run compile')
  const flagCheckIndex = steps.findIndex((step) => step.name === 'Verify the default compile selected renderer v2')

  assert.notEqual(v2TestIndex, -1, 'Windows CI must run the renderer v2 suite')
  assert.ok(browserInstallIndex < v2TestIndex, 'Chromium must be installed before renderer v2 browser tests')
  assert.ok(v2TestIndex < dirtyCheckIndex, 'renderer v2 tests must run before the dirty-tree guard')
  assert.ok(dirtyCheckIndex < compileIndex, 'the default compile must run after tests')
  assert.ok(compileIndex < flagCheckIndex, 'the default compile must be checked for its v2 marker')
  assert.match(String(steps[flagCheckIndex].run), /dist\/renderer-v2\.flag/)
})

test('the release gate only runs smoke scripts the Windows required job also runs', () => {
  // M-01's lower half: the release gate used to run e2e/electron-smoke.mjs, a
  // script no CI job executed. It kept its legacy `.app-shell` selectors long
  // after renderer v2 became the default compile, so the gate's fourth step
  // could only ever time out. Pinning the gate's smoke scripts to the Windows
  // required job is what stops that from happening again.
  const { buildReleaseSteps } = require('./run-release-build.cjs')
  const ciCommands = runSteps('test')
  for (const unsignedReleaseMode of [false, true]) {
    const steps = buildReleaseSteps({
      npmCli: 'npm-cli.js',
      releaseOutputDirectory: path.join(root, 'release-test'),
      platform: 'win32',
      unsignedReleaseMode,
    })
    const smokeScripts = steps
      .flatMap((step) => step.args)
      .filter((argument) => typeof argument === 'string' && argument.includes(`${path.sep}e2e${path.sep}`))
      .map((argument) => path.relative(root, argument).split(path.sep).join('/'))
    assert.ok(smokeScripts.length > 0, 'the release gate must run at least one e2e smoke script')
    for (const script of smokeScripts) {
      assert.ok(
        ciCommands.some((command) => command.includes(script)),
        `${script} runs in the release gate and must also run in the Windows required job`,
      )
      assert.ok(fs.existsSync(path.join(root, script)), `${script} must exist`)
    }
  }
})

test('the Windows suite serializes filesystem-heavy files with a bounded test timeout', () => {
  const command = packageJson.scripts['test:windows']

  assert.match(command, /vitest run electron src/)
  assert.match(command, /--no-file-parallelism/)
  assert.match(command, /--testTimeout=30000/)
  assert.match(command, /npm run test:node/)
})

test('the Linux suite type-checks and runs the common test command', () => {
  const job = workflow.jobs['linux-test']
  const commands = runSteps('linux-test')

  assert.equal(job['runs-on'], 'ubuntu-latest')
  assert.ok(commands.includes('npm run typecheck'), 'linux-test must run npm run typecheck')
  assert.ok(commands.includes('npm test'), 'linux-test must run npm test')
  // Regression coverage for #4: cross-platform breakage (e.g. #2's tmpfs inode
  // reuse) only surfaces on a real Linux filesystem, so this job must run the
  // unmodified common suite rather than a Windows- or macOS-flavored variant.
  assert.equal(commands.includes('npm run test:windows'), false)
})

test('the Linux job carries the shipping renderer coverage the Windows job used to own alone', () => {
  // M-03: test:v2 and test:canvas ran only on windows-latest, the slowest and
  // least reliable job in the matrix, so one Defender timeout took the renderer
  // that actually ships out of a pull request's coverage entirely.
  const steps = workflow.jobs['linux-test'].steps
  const commands = runSteps('linux-test')
  const dirtyCheckIndex = steps.findIndex((step) => step.name === 'Fail if the test run left files in the working tree')

  assert.notEqual(dirtyCheckIndex, -1, 'linux-test must still guard against a dirty working tree')
  for (const command of ['npm run test:v2', 'npm run test:canvas', 'npm run test:ui', 'npm run check:v2']) {
    const index = commands.indexOf(command)
    assert.notEqual(index, -1, `linux-test must run ${command}`)
    assert.ok(steps.findIndex((step) => step.run === command) < dirtyCheckIndex,
      `${command} must run before the dirty-tree guard`)
  }

  // T-S4: check:v2 only earns its place in front of that guard while it stays
  // report-free. Passing --report here would write three generatedAt-stamped
  // files into the tree and fail every run.
  assert.equal(packageJson.scripts['check:v2'].includes('--report'), false)
  assert.equal(commands.some((command) => command.includes('check:v2 -- --report')), false)
})

test('the legacy rollback UI suites are verified on exactly one platform', () => {
  // They render markup through renderToStaticMarkup and assert on the HTML, so
  // the three platforms were answering the same question three times while the
  // shipping renderer was answered once.
  assert.equal(packageJson.scripts['test:node'].includes('test:ui'), false,
    'test:ui must not ride along with test:node onto every platform')
  assert.equal(packageJson.scripts.test.includes('test:ui'), false)
  assert.equal(packageJson.scripts['test:windows'].includes('test:ui'), false)

  const jobsRunningUi = Object.entries(workflow.jobs)
    .filter(([, job]) => (job.steps || []).some((step) => step.run === 'npm run test:ui'))
    .map(([name]) => name)

  assert.deepEqual(jobsRunningUi, ['linux-test'])
})

test('the supported macOS runner runs the real isolated free-distribution build and verifier', () => {
  const macJob = workflow.jobs['macos-test']
  const commands = runSteps('macos-test')

  assert.equal(macJob['runs-on'], 'macos-15')
  assert.ok(commands.includes('npm run test:mac:free-signing'))
  assert.ok(commands.includes('npm run test:mac:dev-origin'))
  assert.ok(commands.includes('node scripts/run-macos-free-build.cjs --ci-temporary-signing'))
  assert.equal(commands.some((command) => /build:mac:ci|--dir/.test(command)), false)
  assert.equal(macJob.steps.some((step) => String(step.uses || '').includes('upload-artifact')), false)
})

test('the Windows job packages and exercises a hardened non-publishing build', () => {
  const commands = runSteps('test')
  const buildCommand = packageJson.scripts['build:win:ci']

  assert.ok(commands.includes('npm run build:win:ci'))
  assert.ok(commands.includes('node scripts/verify-packaged-hardening.cjs release/win-unpacked'))
  assert.ok(commands.includes('node e2e/packaged-hardening-smoke.mjs "release/win-unpacked/星芒AI管理工具.exe"'))
  assert.ok(commands.includes('node e2e/asar-tamper-smoke.mjs release/win-unpacked'))
  assert.match(buildCommand, /XINGMANG_LOCAL_BUILD=1/)
  assert.match(buildCommand, /--win/)
  assert.match(buildCommand, /--x64/)
  assert.match(buildCommand, /--dir/)
  assert.match(buildCommand, /--publish never/)
})

test('a branch push with an open pull request triggers exactly one run', () => {
  // `on:` parses to the `true` key because YAML reads a bare `on` as a boolean.
  const triggers = workflow.on ?? workflow[true]

  assert.deepEqual(triggers.push.branches, ['main'])
  assert.ok('pull_request' in triggers, 'pull_request must stay enabled')
  // pull_request already covers every push to a branch under review, so an
  // unfiltered push trigger would double every run's billed minutes.
  assert.deepEqual(Object.keys(triggers).sort(), ['pull_request', 'push'])
})

test('superseded runs are cancelled instead of billing a full matrix each', () => {
  assert.equal(workflow.concurrency.group, '${{ github.workflow }}-${{ github.ref }}')
  // Includes main while the project is pre-release: a burst of merges would
  // otherwise run the whole matrix once per merge with no way to supersede an
  // obsolete one. Revisit once releases start.
  assert.equal(workflow.concurrency['cancel-in-progress'], true)
})

test('documentation-only changes do not build and package the app', () => {
  const triggers = workflow.on ?? workflow[true]
  for (const event of ['push', 'pull_request']) {
    assert.equal(triggers[event]?.['paths-ignore'], undefined, 'required checks must trigger on documentation PRs')
  }
  for (const job of ['test', 'macos-test', 'linux-test', 'audit']) {
    assert.equal(workflow.jobs[job].needs, 'changes')
    assert.equal(workflow.jobs[job].if, "needs.changes.outputs.code == 'true'")
  }
})

test('the change-scope job also gates the unreleased changelog fragments', () => {
  const job = workflow.jobs.changes
  const checkout = job.steps.find((step) => String(step.uses || '').includes('actions/checkout'))
  const commands = runSteps('changes')

  // Parallel pull requests used to append to the same two "unreleased" sections,
  // and a conflicted pull request has no merge ref, so GitHub never triggered
  // this workflow for it at all. Fragments removed the shared text; this step is
  // what stops the habit from coming back.
  assert.ok(commands.includes('npm run changelog:check'))
  assert.match(packageJson.scripts['changelog:check'], /scripts\/changelog-collect\.cjs --check/)
  assert.match(packageJson.scripts['changelog:collect'], /scripts\/changelog-collect\.cjs/)
  assert.ok(packageJson.scripts['test:node'].includes('scripts/changelog-collect.test.cjs'))

  // The guard diffs both unreleased sections against the pull request base, so
  // the base commit has to be reachable...
  assert.equal(checkout.with['fetch-depth'], 0)
  // ...and this is the only job without a documentation-only skip, which is
  // exactly the shape a bare CHANGELOG.md edit has.
  assert.equal(job.if, undefined, 'the fragment gate must run for every change')
  // No npm ci here: the gate has to keep running on node builtins alone.
  assert.equal(commands.some((command) => command.startsWith('npm ci')), false)
})

test('the fragment directory keeps its instructions after a release collects it', () => {
  // Collecting deletes every *.md fragment; these two are what keep the
  // directory — and the format it documents — in git afterwards.
  for (const file of ['changes/unreleased/README.md', 'changes/unreleased/TEMPLATE.md.example']) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} must exist`)
  }
})

test('the required aggregate fails for incomplete checks and accepts documentation-only changes', () => {
  const vm = require('node:vm')
  const gate = workflow.jobs['quality-gate']
  assert.equal(gate.if, 'always()')
  assert.deepEqual(gate.needs, ['changes', 'test', 'macos-test', 'linux-test', 'audit'])
  const source = gate.steps[0].run.split("node <<'NODE'\n")[1].split('\nNODE')[0]
  const verify = (code, changeResult, results) => {
    const jobs = { changes: { outputs: { code }, result: changeResult } }
    for (const name of ['test', 'macos-test', 'linux-test', 'audit']) jobs[name] = { result: results[name] || 'success' }
    assert.doesNotThrow(() => JSON.stringify(jobs))
    let failed = false
    try { vm.runInNewContext(source, { process: { env: { JOB_RESULTS: JSON.stringify(jobs) }, exit: () => { throw new Error('failed') } } }) } catch { failed = true }
    return !failed
  }
  assert.equal(verify('true', 'success', {}), true)
  assert.equal(verify('true', 'success', { test: 'failure' }), false)
  assert.equal(verify('true', 'success', { audit: 'skipped' }), false)
  assert.equal(verify('false', 'failure', {}), false)
  assert.equal(verify('', 'success', {}), false)
  assert.equal(verify('false', 'success', Object.fromEntries(['test', 'macos-test', 'linux-test', 'audit'].map(name => [name, 'skipped']))), true)
})

test('change classification does not skip code, workflow, or unknown revisions', () => {
  const { requiresCodeChecks, changedFiles } = require('./ci-change-scope.cjs')
  assert.equal(requiresCodeChecks(['README.md', 'docs/guide.md']), false)
  assert.equal(requiresCodeChecks(['README.md', '.github/workflows/quality.yml']), true)
  assert.equal(requiresCodeChecks(['electron/ipc.ts']), true)
  assert.equal(changedFiles({ before: '0'.repeat(40), after: 'a'.repeat(40) }, 'push'), null)
  assert.equal(changedFiles({ before: 'unsafe;command', after: 'a'.repeat(40) }, 'push'), null)
  const values = changedFiles({ pull_request: { base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } } }, 'pull_request', (_cmd, argv) => { assert.equal(argv.at(-1), '--'); return 'docs/guide.md\0src/app.ts\0' })
  assert.deepEqual(values, ['docs/guide.md', 'src/app.ts'])
})

test('packaged Markdown and validation data always require code checks', () => {
  const { requiresCodeChecks } = require('./ci-change-scope.cjs')
  for (const file of [
    'docs/canvas-third-party.json',
    'docs/CANVAS-THIRD-PARTY.md',
    'bundled-skills/xingmang-ai/SKILL.md',
    'bundled-skills/xingmang-ai/references.md',
    'assets/brand/v3/README.md',
    'release-notes.md',
    '.gitattributes',
    '.editorconfig',
  ]) {
    assert.equal(requiresCodeChecks(['README.md', file]), true, file)
  }
})

test('documentation skips are limited to known documentation locations', () => {
  const { requiresCodeChecks } = require('./ci-change-scope.cjs')
  assert.equal(requiresCodeChecks(['README.md', 'CHANGELOG.md', 'docs/guide.md', 'docs/plans/reliability.md']), false)
  assert.equal(requiresCodeChecks(['new-runtime/resources.md']), true)
  assert.equal(requiresCodeChecks(['docs/new-script.cjs']), true)
})

test('the macOS release build runs on main rather than on every pull request', () => {
  const macBuild = workflow.jobs['macos-test'].steps
    .find((step) => String(step.run || '').includes('run-macos-free-build.cjs'))

  assert.ok(macBuild, 'the macOS free-distribution build must still exist')
  // Half the billed minutes of an average run. It answers a release question,
  // while the cross-platform regressions a pull request must catch are covered
  // by the typecheck, test and dev-origin steps that stay unconditional.
  assert.equal(macBuild.if, "github.event_name == 'push'")

  const commands = runSteps('macos-test')
  for (const guarded of ['npm run typecheck', 'npm test', 'npm run test:mac:dev-origin']) {
    const step = workflow.jobs['macos-test'].steps.find((entry) => entry.run === guarded)
    assert.ok(step, `${guarded} must still run`)
    assert.equal(step.if, undefined, `${guarded} must stay unconditional`)
  }
  assert.ok(commands.includes('npm run test:mac:free-signing'))
})

test('quality checks cannot publish a release', () => {
  assert.equal(workflow.permissions.contents, 'read')

  const serialized = JSON.stringify(workflow.jobs)
  assert.doesNotMatch(serialized, /gh release|create-release|dist:mac:free|release:build/i)
})

const playwrightElectronSmokes = ['e2e/electron-ci-smoke.mjs', 'e2e/window-close-smoke.mjs']

test('a Playwright Electron smoke can never consume a whole job again', () => {
  // #131 and #133: a wedged Electron made the close smoke run for ten minutes
  // and print nothing, cancelling the Windows job at its cap; #139 died in the
  // startup smoke. Three bounds now stack — the script's own budget, the step
  // timeout, then the job timeout — and each must stay strictly inside the next
  // so the innermost one, the only one that prints a diagnosis, is what fires.
  for (const smoke of playwrightElectronSmokes) {
    const budget = fs.readFileSync(path.join(root, smoke), 'utf8')
      .match(/XINGMANG_SMOKE_TOTAL_TIMEOUT_MS \?\? (\d[\d_]*)\)/)

    assert.ok(budget, `${smoke} must budget its whole run`)
    const budgetMs = Number(budget[1].replaceAll('_', ''))
    const jobs = Object.entries(workflow.jobs)
      .filter(([, job]) => (job.steps || []).some((entry) => String(entry.run || '').includes(smoke)))

    assert.ok(jobs.length > 0, `${smoke} must still run in CI`)
    for (const [jobName, job] of jobs) {
      const step = job.steps.find((entry) => String(entry.run || '').includes(smoke))

      assert.equal(typeof step['timeout-minutes'], 'number', `${jobName} must bound ${smoke}`)
      assert.ok(step['timeout-minutes'] * 60_000 > budgetMs,
        `${jobName} must let ${smoke} report its own timeout before the runner cancels the step`)
      assert.ok(job['timeout-minutes'] > step['timeout-minutes'], `${jobName} must outlive its ${smoke} step`)
    }
  }

  // test:windows (~13m) and test:v2 (~10m) alone reach ~28 minutes, so the
  // Windows cap has to clear that plus the packaging steps that follow.
  assert.ok(workflow.jobs.test['timeout-minutes'] >= 45)
})

test('no wait in a Playwright Electron smoke is left unbounded', () => {
  for (const smoke of playwrightElectronSmokes) {
    const source = fs.readFileSync(path.join(root, smoke), 'utf8')

    // page.evaluate, ElectronApplication.evaluate and ElectronApplication
    // .close() have no default timeout of their own. Awaiting one of them
    // directly is how a failing assertion ended up hidden behind a ten minute
    // hang instead of being printed.
    assert.doesNotMatch(source, /await page\.evaluate\(/, smoke)
    assert.doesNotMatch(source, /await application\.evaluate\(/, smoke)
    assert.doesNotMatch(source, /await application\.close\(\)/, smoke)
    assert.match(source, /createSmokeRuntime\(/, `${smoke} must use the shared smoke runtime`)
  }

  assert.match(fs.readFileSync(path.join(root, 'e2e', 'smoke-runtime.mjs'), 'utf8'), /export function killProcessTree\(/)
})

const fixtureReadinessModule = 'e2e/fixture-readiness.mjs'
// Every suite whose fixture mount used to borrow Playwright's 30s action
// default, and whose first open therefore reported a cold start as an
// assertion failure.
const fixtureReadinessConsumers = [
  'e2e/primary-views-interactions.test.mjs',
  'e2e/start-guide-interactions.test.mjs',
  'e2e/account-switcher-interactions.test.mjs',
  'e2e/maintenance-pages-interactions.test.mjs',
  'e2e/shell-navigation-interactions.test.mjs',
  'e2e/ui-interactions.test.mjs',
  'src/renderer-v2/testing/app-check.mjs',
  'e2e/account-commerce-interactions.test.mjs',
  'e2e/maintenance-layout.test.mjs',
]

test('a cold fixture open cannot be reported as a failed assertion again', () => {
  const budget = fs.readFileSync(path.join(root, fixtureReadinessModule), 'utf8')
    .match(/XINGMANG_FIXTURE_READY_TIMEOUT_MS \?\? (\d[\d_]*)\)/)

  assert.ok(budget, `${fixtureReadinessModule} must declare the shared mount budget`)
  const budgetMs = Number(budget[1].replaceAll('_', ''))
  // Wider than the 30s default the cold opens in quality runs #264 and #284
  // blew through, and still small enough that a fixture which never mounts
  // fails long before the Windows job runs out of time.
  assert.ok(budgetMs > 30_000, 'the mount budget must exceed the Playwright default it replaces')
  assert.ok(budgetMs <= 300_000, 'the mount budget must stay well inside the Windows job timeout')

  for (const consumer of fixtureReadinessConsumers) {
    const source = fs.readFileSync(path.join(root, consumer), 'utf8')

    assert.match(source, /fixtureReadyTimeoutMs/, `${consumer} must bound its fixture mount with the shared budget`)
    assert.match(source, /from '[./]*(?:e2e\/)?fixture-readiness\.mjs'/, `${consumer} must import the shared budget rather than restate it`)
  }

  // page.goto resolves on `load`, which happens before the fixture module has
  // installed its globals and can be followed by a Vite dependency reload.
  const appCheck = fs.readFileSync(path.join(root, 'src/renderer-v2/testing/app-check.mjs'), 'utf8')
  assert.match(appCheck, /await waitForFixtureReady\(page\)/, 'every app-check page must wait for the fixture to install')
})

// A React render crash or an unhandled rejection inside a fixture leaves the
// page standing with whatever it had already committed, so a suite that only
// asserts on the elements it touches stays green through it. Every browser
// suite therefore records pageerror and empties the record before it finishes;
// this keeps a new suite from quietly opting out of that (T-G3).
test('no browser suite can go green while its fixture threw', () => {
  const suites = fs.readdirSync(path.join(root, 'e2e'))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `e2e/${name}`)

  assert.ok(suites.length >= 15, 'the e2e suite list must not silently shrink')
  for (const suite of suites) {
    const source = fs.readFileSync(path.join(root, suite), 'utf8')
    const shared = /from '\.\/page-errors\.mjs'/.test(source) && /pageErrors\.assertNone\(\)/.test(source)
    const inline = /page\.on\('pageerror'/.test(source) && /assert\.deepEqual\(errors, \[\]\)/.test(source)

    assert.ok(shared || inline, `${suite} must record pageerror and assert it stayed empty`)
  }
})

test('the window close smoke survives a transient Windows filesystem error', () => {
  const source = fs.readFileSync(path.join(root, 'e2e', 'window-close-smoke.mjs'), 'utf8')

  // The main process registers uncaughtExceptionMonitor rather than
  // uncaughtException, so anything thrown out of the control interval ends the
  // run: the next command is never acknowledged and the smoke can only report a
  // timeout. Defender holding the command file for a moment is enough to do it.
  assert.match(source, /recordCommandFailure\('read', error\)/, 'a failed command read must be retried, not thrown')
  assert.match(source, /commandFailures/, 'the evidence file must carry what the control channel refused')
  // Polling for an acknowledgement asserts nothing about behaviour, so it may
  // have more headroom than the native visibility waits, but it must give up at
  // once when the application it is polling has already exited.
  assert.match(source, /XINGMANG_SMOKE_COMMAND_TIMEOUT_MS/, 'the acknowledgement wait must stay bounded and overridable')
  assert.match(source, /abandonedByExit/, 'the acknowledgement wait must stop as soon as the application exits')
  assert.match(source, /main \$\{label\}/, "the main process's own output must reach the log")
})
