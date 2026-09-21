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

// The Windows checks used to be one ~27 minute job, which was the pipeline's
// whole wall clock. They are now a matrix of test shards plus the packaging
// job, so every question of the form "does Windows still run X" has to be put
// to both, and to the matrix commands rather than to the one step that
// interpolates them.
function windowsShardCommands() {
  return workflow.jobs['windows-test'].strategy.matrix.include.map((entry) => entry.command)
}

function windowsCommands() {
  return [...windowsShardCommands(), ...runSteps('windows-package')]
}

function shardStepIndex() {
  return workflow.jobs['windows-test'].steps.findIndex((step) => String(step.run || '').includes('matrix.command'))
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

  // Every Windows shard installs it, rather than only the ones whose suites
  // need a browser today: --shard partitions by a hash of each file's path, so
  // which half holds electron/codex-desktop-cdp.browser.test.ts moves with the
  // next added or renamed test file.
  const steps = workflow.jobs['windows-test'].steps
  const installIndex = steps.findIndex((step) => step.run === 'npx --no-install playwright install chromium')

  assert.notEqual(installIndex, -1, 'the Windows shards must install Chromium')
  assert.notEqual(shardStepIndex(), -1, 'the Windows shards must run their matrix command')
  assert.ok(installIndex < shardStepIndex(), 'Chromium must be installed before any shard runs')
})

test('the Windows job enables unprivileged symlink creation before security tests', () => {
  const steps = workflow.jobs['windows-test'].steps
  const enableStepIndex = steps.findIndex((step) => (
    step.name === 'Enable Windows Developer Mode for symlink security tests'
  ))

  assert.notEqual(enableStepIndex, -1, 'Windows CI must enable Developer Mode')
  assert.notEqual(shardStepIndex(), -1, 'Windows CI must run its test shards')
  // Enabled for every shard for the same reason Chromium is: the symlink
  // security tests land in whichever --shard half their path hashes into.
  assert.ok(enableStepIndex < shardStepIndex(), 'Developer Mode must be enabled before tests')

  const enableStep = steps[enableStepIndex]
  assert.equal(enableStep.shell, 'pwsh')
  assert.match(String(enableStep.run), /AllowDevelopmentWithoutDevLicense/)
})

// windows-latest images already ship `C:\` and `D:\` in Defender's exclusion
// list — quality run 35548878416 printed `Get-MpPreference` and found both
// whole drives there before this workflow touched anything. Real-time scanning
// therefore explains nothing about these runners, whatever the comments around
// this repository say, and a step that adds the workspace to that list is
// ceremony. Do not add one: measure first, and if a stall source is ever found,
// pin the measurement here rather than the folklore.
test('the Windows jobs do not re-exclude paths the runner image already excludes', () => {
  for (const jobName of ['windows-test', 'windows-package']) {
    for (const step of workflow.jobs[jobName].steps) {
      assert.doesNotMatch(String(step.run || ''), /Add-MpPreference/,
        `${jobName} must not spend a step on Defender exclusions the image already has`)
    }
  }
})

test('the Windows required job tests and compiles the default renderer v2', () => {
  const shardCommands = windowsShardCommands()
  const shardSteps = workflow.jobs['windows-test'].steps
  const dirtyCheckIndex = shardSteps.findIndex((step) => step.name === 'Fail if the test run left files in the working tree')

  // Both halves of test:v2 still run on the shipping platform; they are simply
  // no longer queued behind `npm test` on the same runner.
  assert.ok(shardCommands.includes('npm run test:v2:vitest'), 'Windows CI must run the renderer v2 unit suite')
  assert.ok(shardCommands.some((command) => command.startsWith('npm run test:v2:browser')),
    'Windows CI must run the renderer v2 browser suites')
  assert.notEqual(dirtyCheckIndex, -1, 'every Windows shard must guard against a dirty working tree')
  assert.ok(shardStepIndex() < dirtyCheckIndex, 'a shard must run before its dirty-tree guard')

  const packageSteps = workflow.jobs['windows-package'].steps
  const compileIndex = packageSteps.findIndex((step) => step.run === 'npm run compile')
  const flagCheckIndex = packageSteps.findIndex((step) => step.name === 'Verify the default compile selected renderer v2')

  assert.notEqual(compileIndex, -1, 'the packaging job must run the default compile')
  assert.ok(compileIndex < flagCheckIndex, 'the default compile must be checked for its v2 marker')
  assert.match(String(packageSteps[flagCheckIndex].run), /dist\/renderer-v2\.flag/)
})

test('splitting the Windows job did not drop a suite it used to run', () => {
  // The split is a wall-clock change and nothing else, so the shards have to
  // add up to exactly what the one job ran. vitest --shard partitions by a
  // hash of each file's path: the halves reconstitute the unsharded file set,
  // but only while every half is actually dispatched, which is what the
  // exhaustiveness check below is for.
  const scripts = packageJson.scripts
  const shardCommands = windowsShardCommands()

  assert.equal(scripts['test:vitest'], 'vitest run electron src --no-file-parallelism --testTimeout=30000')
  assert.equal(scripts.test, 'npm run test:vitest && npm run test:scripts && npm run test:browser')
  assert.equal(scripts['test:v2'], 'npm run test:v2:vitest && npm run test:v2:browser')

  // P-12: `test:windows` meant "the serialised suite" until test:vitest took
  // --no-file-parallelism and --testTimeout=30000 on itself, after which it
  // was `npm test` spelled a second time. Nothing dispatches it any more, and
  // a reintroduced copy would be a second definition of the same run, free to
  // drift from this one.
  assert.equal(scripts['test:windows'], undefined,
    'test:windows became a duplicate of npm test and must stay deleted')

  for (const [script, count] of [['test:vitest', 2]]) {
    for (let index = 1; index <= count; index += 1) {
      assert.ok(shardCommands.includes(`npm run ${script}:${index}`), `the matrix must dispatch ${script}:${index}`)
    }
    assert.equal(scripts[`${script}:${count + 1}`], undefined,
      `${script} declares a shard the matrix never dispatches`)
  }

  // The vitest halves are the same command plus the flag that selects the
  // half, so the suite, its serialisation and its 30s timeout cannot drift
  // between them.
  assert.equal(scripts['test:vitest:1'], 'npm run test:vitest -- --shard=1/2')
  assert.equal(scripts['test:vitest:2'], 'npm run test:vitest -- --shard=2/2')

  // test:v2:browser is dispatched whole, and must stay that way. Its files each
  // build a Vite dev server on the same `configFile: false` root, so they share
  // one on-disk node_modules/.vite dependency cache that the earlier files warm
  // for the later ones. Split across runners, app-check.mjs — which runs last
  // and benefits most — got a cold cache and blew its 90s fixture mount budget
  // on a mid-run re-optimisation.
  assert.ok(shardCommands.includes('npm run test:v2:browser'), 'the matrix must dispatch test:v2:browser whole')
  assert.equal(scripts['test:v2:browser:1'], undefined, 'test:v2:browser must not be split across runners')
  assert.match(scripts['test:v2:browser'], /--test-concurrency=1/, 'the browser suites must stay serialised')
  assert.ok(scripts['test:v2:browser'].split(/\s+/).filter((token) => /\.mjs$/.test(token)).length > 0,
    'test:v2:browser must still name its suites')

  // T-B6: the matrix has to cover exactly the leaves `npm test` runs, so a
  // leaf added later that no shard dispatches fails here instead of silently
  // going untested on the shipping platform. test:vitest is the one exception:
  // it is dispatched as the two --shard halves checked above.
  const dispatched = shardCommands.flatMap((command) => command.split('&&').map((part) => part.trim()))
  const testLeaves = scripts.test.split('&&').map((part) => part.trim())
  assert.deepEqual(testLeaves, ['npm run test:vitest', 'npm run test:scripts', 'npm run test:browser'])
  for (const leaf of testLeaves.filter((leaf) => leaf !== 'npm run test:vitest')) {
    assert.ok(dispatched.includes(leaf), `the matrix must dispatch ${leaf}`)
  }

  // T-G10: each of these two suites launches its own Chromium against its own
  // Vite dev server. Running them together bought no wall clock (~31s either
  // way) and doubled the shard's peak memory, which on a Defender-throttled
  // Windows runner is how a timeout gets manufactured. test:v2:browser and
  // test:ui were already serialised for the same reason.
  assert.match(scripts['test:browser'], /^node --test --test-concurrency=1 /)

  // T-B6: the split only pays for itself while the names keep meaning what
  // they say — the build and release script suites in one, the browser suites
  // in the other.
  const named = (script, pattern) => scripts[script].split(/\s+/).filter((token) => pattern.test(token))
  assert.deepEqual(named('test:scripts', /\.mjs$/), [])
  assert.ok(named('test:scripts', /\.test\.cjs$/).length > 0, 'test:scripts must still name its suites')
  assert.ok(named('test:scripts', /\.test\.cjs$/).every((token) => token.startsWith('scripts/')))
  assert.deepEqual(named('test:browser', /\.cjs$/), [])
  assert.ok(named('test:browser', /\.mjs$/).length > 0, 'test:browser must still name its suites')
  assert.ok(named('test:browser', /\.mjs$/).every((token) => token.startsWith('e2e/')))
})

test('the release gate only runs smoke scripts the Windows required job also runs', () => {
  // M-01's lower half: the release gate used to run e2e/electron-smoke.mjs, a
  // script no CI job executed. It kept its legacy `.app-shell` selectors long
  // after renderer v2 became the default compile, so the gate's fourth step
  // could only ever time out. Pinning the gate's smoke scripts to the Windows
  // required job is what stops that from happening again.
  const { buildReleaseSteps } = require('./run-release-build.cjs')
  const ciCommands = windowsCommands()
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
  // Sharding moved files onto other runners; it must not have turned file
  // parallelism back on inside a shard, which is what kept the
  // filesystem-heavy tests from racing each other under Defender.
  for (const name of ['test:vitest', 'test:v2:vitest']) {
    const command = packageJson.scripts[name]

    assert.match(command, /vitest run/, name)
    assert.match(command, /--no-file-parallelism/, name)
    assert.match(command, /--testTimeout=30000/, name)
  }

  assert.match(packageJson.scripts['test:vitest'], /vitest run electron src/)
  assert.match(packageJson.scripts['test:browser'], /--test-concurrency=1/)
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
  // P-12 deleted the only variant that ever existed; this keeps the job honest
  // if another one grows back.
  assert.equal(commands.some((command) => /^npm run test:(windows|macos|linux)\b/.test(command)), false)
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
  assert.equal(packageJson.scripts['test:browser'].includes('test:ui'), false,
    'test:ui must not ride along with test:browser onto every platform')
  assert.equal(packageJson.scripts.test.includes('test:ui'), false)

  const jobsRunningUi = Object.entries(workflow.jobs)
    .filter(([, job]) => (job.steps || []).some((step) => step.run === 'npm run test:ui'))
    .map(([name]) => name)

  assert.deepEqual(jobsRunningUi, ['linux-test'])
})

test('the rollback renderer is built somewhere before a rollback needs it', () => {
  // R-G12: `legacy` exists to be shipped on the day v2 has to be pulled, and
  // nothing in CI used to build it. Its React 18 alias table in vite.config.ts
  // is applied only under XINGMANG_RENDERER=legacy, so the pinned runtime in
  // tooling/legacy-renderer could rot — or the shared src/ tree could grow an
  // import the React 18 runtime cannot satisfy — with every check still green.
  assert.match(packageJson.scripts['check:legacy'], /XINGMANG_RENDERER=legacy\s+vite build/)
  // Packaging is deliberately not part of it: the question is whether the
  // bundle still builds, and --outDir keeps the answer out of the dist/ the
  // shipping compile owns.
  assert.match(packageJson.scripts['check:legacy'], /--outDir dist-legacy/)
  assert.doesNotMatch(packageJson.scripts['check:legacy'], /electron-builder/)
  assert.ok(
    fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/).includes('dist-legacy/'),
    'the throwaway bundle must not reach the dirty-tree guard',
  )

  const jobsBuildingLegacy = Object.entries(workflow.jobs)
    .filter(([, job]) => (job.steps || []).some((step) => step.run === 'npm run check:legacy'))
    .map(([name]) => name)

  assert.deepEqual(jobsBuildingLegacy, ['linux-test'])
})

test('the advisory job caches nothing because it installs nothing', () => {
  // P-32: `npm audit` reads package-lock.json, so this job deliberately has no
  // `npm ci`. A cache declaration without a restore target still costs a
  // lookup and a save on every run and reports coverage this job never had.
  const auditJob = workflow.jobs.audit
  const setupNode = auditJob.steps.find((step) => String(step.uses || '').startsWith('actions/setup-node@'))

  assert.ok(setupNode, 'the audit job still pins its Node version')
  assert.equal(setupNode.with.cache, undefined, 'a job that never runs npm ci must not declare a dependency cache')
  assert.equal(runSteps('audit').some((command) => /npm ci/.test(command)), false)
  assert.deepEqual(runSteps('audit'), ['npm run audit:production', 'npm run audit:ci'])
})

test('the supported macOS runner runs the real isolated free-distribution build and verifier', () => {
  const macJob = workflow.jobs['macos-test']
  const commands = runSteps('macos-test')

  assert.equal(macJob['runs-on'], 'macos-15')
  assert.ok(commands.includes('npm run test:mac:free-signing'))
  assert.ok(commands.includes('npm run test:mac:dev-origin'))
  assert.ok(commands.includes('node scripts/run-macos-free-build.cjs --ci-temporary-signing --ci-keep-package'))
  // Every check around it reads the artifact, and the artifact was perfect on
  // 2026-09-19 while the app it described could not start. This one runs it.
  assert.ok(commands.includes('node e2e/macos-launch-smoke.mjs'))
  // publish-release.yml 的 macos-build 挂 environment: release，PR 上从来不跑，
  // 所以发布签名 keychain 那条链路只能在这里排练。2026-09-20 正式发布连红四次，
  // 其中两次都该在这一步就红。
  assert.ok(commands.includes('npm run test:mac:release-keychain'))
  assert.equal(commands.some((command) => /build:mac:ci|--dir/.test(command)), false)
  assert.equal(macJob.steps.some((step) => String(step.uses || '').includes('upload-artifact')), false)
})

test('the release path itself is rehearsed on every pull request, not only when a release is cut', () => {
  const job = workflow.jobs['macos-release-rehearsal']
  const commands = runSteps('macos-release-rehearsal')

  assert.equal(job['runs-on'], 'macos-15')
  // 排练跳过 typecheck 与 npm test（别的作业已经跑过），但 electron-builder 打的
  // 是编译产物，所以 compile 不能省。
  assert.ok(commands.includes('npm run compile'))
  assert.ok(commands.some((command) => command.includes('prepare-acceleration-bundle.cjs --target darwin-arm64')))
  assert.ok(commands.some((command) => command.includes('prepare-acceleration-bundle.cjs --target darwin-x64')))
  // 暂存工具读的是主进程产物，所以它必须排在一次 tsc 之后、且在 compile 之前——
  // compile 会先清空 dist-electron，顺序反了就等于没编译过。这与
  // publish-release.yml 的 macos-build 是同一条先后。
  const tscIndex = commands.findIndex((command) => command.includes('tsc -p tsconfig.electron.json'))
  const prepareIndex = commands.findIndex((command) => command.includes('prepare-acceleration-bundle.cjs'))
  assert.ok(tscIndex >= 0 && tscIndex < prepareIndex)
  assert.ok(prepareIndex < commands.indexOf('npm run compile'))
  assert.ok(commands.includes('npm run test:mac:release-path'))
  assert.match(packageJson.scripts['test:mac:release-path'], /macos-release-keychain-rehearsal\.sh --with-release-build/)
  // 一次性签名那条路是另一回事（自定义 sign 钩子），它由 macos-test 覆盖。这里
  // 要验的恰恰是发布路径独有的那一段，两者不能互相顶替。
  assert.equal(commands.some((command) => command.includes('--ci-temporary-signing')), false)
  // 十几分钟的打包如果没有步骤级上界，一处 codesign 卡住只会在作业上限才失败，
  // 而且说不出卡在哪一步。
  const rehearsal = job.steps.find((step) => String(step.run || '').includes('test:mac:release-path'))
  assert.ok(Number.isInteger(rehearsal['timeout-minutes']))
  assert.ok(rehearsal['timeout-minutes'] < job['timeout-minutes'])
  // 不读任何 secret 是这个作业能挂在 PR 上的前提。
  assert.equal(/secrets\./.test(JSON.stringify(job)), false)
})

// T-G5: each of these was committed, documented and then reachable only by
// hand. A smoke nothing runs asserts nothing, and both are the only coverage
// their Windows-only guarantee has.
test('the Windows packaging job runs every smoke that has no other home', () => {
  const packageSteps = workflow.jobs['windows-package'].steps
  const commands = runSteps('windows-package')
  const compileIndex = commands.indexOf('npm run compile')

  assert.notEqual(compileIndex, -1)
  for (const smoke of [
    'node e2e/acceleration-profile-isolation-smoke.mjs',
    'node e2e/realm-vault-recovery-smoke.mjs',
  ]) {
    const index = commands.indexOf(smoke)
    assert.notEqual(index, -1, `${smoke} must run somewhere in CI`)
    assert.ok(index > compileIndex, `${smoke} needs the compiled application`)
    const step = packageSteps.find((entry) => entry.run === smoke)
    // Both drive Electron child processes; a hang in either would otherwise
    // consume the whole job cap and report nothing about which step hung.
    assert.ok(step['timeout-minutes'] > 0, `${smoke} must carry its own step bound`)
  }
})

// T-G5: these two were the last never-wired smokes. The first used to pin CI to
// an expectation the product contradicted at the time — it read the zoom floor
// off window-preferences.ts (then 0.8) while the window that actually receives
// the zoom is driven by platform/renderer-v2.ts (0.7) — and both used to assume
// a desktop big enough that resolveWindowPlacement would not maximize the
// window. The two floors no longer disagree: platform/zoom.ts now delegates to
// calculateUiZoom, which is the product's single formula and floors at 0.7.
// Both are reconciled, so the gate flips: they must run, after the compile they
// need, each under its own step bound.
test('both native renderer smokes run in CI once the application is compiled', () => {
  const commands = runSteps('windows-package')
  const packageSteps = workflow.jobs['windows-package'].steps
  const compileIndex = commands.indexOf('npm run compile')

  assert.notEqual(compileIndex, -1)
  for (const smoke of [
    'node e2e/renderer-v2-native.mjs',
    'node e2e/renderer-v2-native-close-race.mjs',
  ]) {
    const index = commands.indexOf(smoke)
    assert.notEqual(index, -1, `${smoke} must run somewhere in CI`)
    assert.ok(index > compileIndex, `${smoke} needs the compiled application`)
    const step = packageSteps.find((entry) => entry.run === smoke)

    assert.ok(step['timeout-minutes'] > 0, `${smoke} must carry its own step bound`)
  }
})

test('the Windows job packages and exercises a hardened non-publishing build', () => {
  const commands = runSteps('windows-package')
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
  for (const job of ['windows-test', 'windows-package', 'macos-test', 'macos-release-rehearsal', 'linux-test', 'audit']) {
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
  assert.ok(packageJson.scripts['test:scripts'].includes('scripts/changelog-collect.test.cjs'))

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
  assert.deepEqual(gate.needs, ['changes', 'test', 'macos-test', 'macos-release-rehearsal', 'linux-test', 'audit'])
  const source = gate.steps[0].run.split("node <<'NODE'\n")[1].split('\nNODE')[0]
  const run = (source, jobs) => {
    assert.doesNotThrow(() => JSON.stringify(jobs))
    let failed = false
    try { vm.runInNewContext(source, { process: { env: { JOB_RESULTS: JSON.stringify(jobs) }, exit: () => { throw new Error('failed') } } }) } catch { failed = true }
    return !failed
  }
  const verify = (code, changeResult, results) => {
    const jobs = { changes: { outputs: { code }, result: changeResult } }
    for (const name of ['macos-test', 'macos-release-rehearsal', 'linux-test', 'audit']) {
      jobs[name] = { result: results[name] || 'success' }
    }
    jobs.test = { result: results.test || 'success' }
    return run(source, jobs)
  }
  assert.equal(verify('true', 'success', {}), true)
  assert.equal(verify('true', 'success', { test: 'failure' }), false)
  // A failing shard leaves the fold-in job failed rather than skipped, and a
  // skipped `test` must not read as a pass either — that is the shape a
  // cancelled matrix would otherwise take.
  assert.equal(verify('true', 'success', { test: 'skipped' }), false)
  assert.equal(verify('true', 'success', { audit: 'skipped' }), false)
  assert.equal(verify('false', 'failure', {}), false)
  assert.equal(verify('', 'success', {}), false)
  assert.equal(verify('true', 'success', { 'macos-release-rehearsal': 'failure' }), false)
  assert.equal(verify('false', 'success', Object.fromEntries(
    ['macos-test', 'macos-release-rehearsal', 'linux-test', 'audit'].map(name => [name, 'skipped']),
  )), true)

  // The fold-in job itself: it is what keeps a single `test` check meaning
  // "Windows is green" after the matrix replaced the job that used to be it.
  const fold = workflow.jobs.test
  // Not always(): that also runs on a cancelled run and posts a red `test`
  // against a superseded commit. The aggregate above refuses a skipped `test`,
  // so a cancelled run still cannot read as a pass.
  assert.equal(fold.if, '${{ !cancelled() }}')
  assert.equal(verify('true', 'success', { test: 'skipped' }), false)
  assert.deepEqual(fold.needs, ['changes', 'windows-test', 'windows-package'])
  assert.equal(fold['runs-on'], 'ubuntu-latest')
  const foldSource = fold.steps[0].run.split("node <<'NODE'\n")[1].split('\nNODE')[0]
  const fold_ = (code, results) => run(foldSource, {
    changes: { outputs: { code }, result: 'success' },
    'windows-test': { result: results['windows-test'] || 'success' },
    'windows-package': { result: results['windows-package'] || 'success' },
  })
  assert.equal(fold_('true', {}), true)
  assert.equal(fold_('true', { 'windows-test': 'failure' }), false)
  assert.equal(fold_('true', { 'windows-test': 'cancelled' }), false)
  assert.equal(fold_('true', { 'windows-package': 'skipped' }), false)
  // A documentation-only change skips both Windows jobs, and the fold-in job
  // still has to report success rather than inherit their skip.
  assert.equal(fold_('false', { 'windows-test': 'skipped', 'windows-package': 'skipped' }), true)
  assert.equal(fold_('false', {}), false)
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

test('the macOS packaging gate runs on every pull request, not only after a merge', () => {
  const macBuild = workflow.jobs['macos-test'].steps
    .find((step) => String(step.run || '').includes('run-macos-free-build.cjs'))

  assert.ok(macBuild, 'the macOS free-distribution build must still exist')
  // P-20: it used to be `github.event_name == 'push'` to save macOS minutes.
  // Actions bills nothing on a public repository, and the saving bought a gate
  // that could only report a broken macOS package after it was already on main.
  assert.equal(macBuild.if, undefined, 'the macOS packaging gate must not be conditional')
  assert.ok(macBuild['timeout-minutes'] > 0, 'the macOS packaging gate needs its own step bound')

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

// T-G5: the last two entries were written, documented and never wired; they
// join this list the moment they run in CI, because an unbounded wait inside a
// Playwright Electron smoke is what #131 and #133 cost a whole job.
const playwrightElectronSmokes = [
  'e2e/electron-ci-smoke.mjs',
  'e2e/window-close-smoke.mjs',
  'e2e/realm-account-smoke.mjs',
  'e2e/renderer-v2-native.mjs',
  'e2e/renderer-v2-native-close-race.mjs',
]

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

  // The Windows work is spread over the shards and the packaging job now, and
  // the longest of them is well under ten minutes. The caps below are a
  // backstop for a wedged runner rather than a bound the work approaches, but
  // each still has to outlive the longest step timeout inside it.
  for (const name of ['windows-test', 'windows-package']) {
    const job = workflow.jobs[name]
    // A shard's step timeout is written as ${{ matrix.timeout }}, so resolve it
    // against the matrix rather than reading it as the literal zero it parses
    // to — otherwise this check would quietly stop checking anything.
    const stepTimeouts = job.steps.flatMap((step) => {
      const declared = step['timeout-minutes']
      if (typeof declared === 'number') return [declared]
      if (String(declared || '').includes('matrix.timeout')) {
        return (job.strategy?.matrix?.include || []).map((entry) => entry.timeout)
      }
      return []
    })

    assert.equal(job['runs-on'], 'windows-latest')
    assert.ok(stepTimeouts.every((value) => typeof value === 'number' && value > 0),
      `${name} must resolve every step timeout to a number`)
    assert.ok(job['timeout-minutes'] > Math.max(0, ...stepTimeouts),
      `${name} must outlive its longest bounded step`)
  }

  // Every shard bounds its own command. test:v2 stalled for 42 minutes on #172
  // and was cancelled by the job cap, which reports nothing about which suite
  // hung; a step timeout names the shard and leaves the siblings alone.
  const shardStep = workflow.jobs['windows-test'].steps[shardStepIndex()]
  assert.match(String(shardStep['timeout-minutes']), /matrix\.timeout/, 'each shard must bound its own command')
  for (const entry of workflow.jobs['windows-test'].strategy.matrix.include) {
    assert.equal(typeof entry.timeout, 'number', `${entry.shard} must declare a step timeout`)
    assert.ok(entry.timeout >= 10, `${entry.shard} must leave a slow Windows runner room to finish`)
  }

  // fail-fast would cancel the sibling shards on the first failure, turning a
  // run that could report every problem at once back into one push per bug.
  assert.equal(workflow.jobs['windows-test'].strategy['fail-fast'], false)
})

test('no wait in a Playwright Electron smoke is left unbounded', () => {
  for (const smoke of playwrightElectronSmokes) {
    const source = fs.readFileSync(path.join(root, smoke), 'utf8')

    // page.evaluate, ElectronApplication.evaluate and ElectronApplication
    // .close() have no default timeout of their own. Awaiting one of them
    // directly is how a failing assertion ended up hidden behind a ten minute
    // hang instead of being printed.
    // The two assertions below name the handle, so a smoke that calls its
    // ElectronApplication something else would slip past them unbounded — which
    // is exactly what e2e/renderer-v2-native.mjs did until quality run
    // 35542609628 lost an iteration to a collected inspector promise.
    assert.match(source, /\bapplication = await\b/, `${smoke} must call its ElectronApplication handle "application"`)
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
  'src/renderer-v2/features/auth/browser-check.mjs',
  'e2e/v2-business.test.mjs',
  'e2e/app-v3-interactions.test.mjs',
  'scripts/audit/renderer-v2-gap-audit.mjs',
  'e2e/account-commerce-interactions.test.mjs',
  'e2e/maintenance-layout.test.mjs',
  // D-12: the dual-site account smoke waits on the same cold Electron start
  // the Windows runner takes ~16s over, three times per run.
  'e2e/realm-account-smoke.mjs',
  // The chat fixture was left off this list when #164 built it, because nothing
  // checked the list against the suites that exist. Its open() waited on the
  // element under test with the 30s default, so a cold Windows start was
  // reported as "chat-composer-input" never becoming visible, 30.1s in, while
  // the same case finished in 12.6s on Linux.
  'src/renderer-v2/features/chat/browser-check.mjs',
  // Found by the scan below rather than by anyone reading the list, and
  // budgeted once the scan made them visible. All four waited on an element of
  // the page under test - the acceleration nav, the announcement button, the
  // parser import, the gallery heading - so a cold open was reported as that
  // element being missing.
  'src/renderer-v2/features/acceleration/browser-check.mjs',
  'src/renderer-v2/features/shell/announcement-persistence.browser-check.mjs',
  'src/renderer-v2/features/shell/newapi-announcements.browser-check.mjs',
  'src/renderer-v2/ui/browser-check.mjs',
]

// A hand-kept list only covers what someone remembered to add. These are the
// suites that open a page of their own and still borrow Playwright's default
// for the mount: naming them here is what lets the scan below insist that every
// other suite is budgeted, so the next one added lands in neither list and
// fails rather than waiting for a Windows runner to report it as a broken
// feature.
const fixtureReadinessUnbudgeted = [
  // The canvas is frozen to its owner's own rework, so this one is left where
  // the scan can still see it rather than touched. Everything else the scan
  // found has since been budgeted.
  'e2e/canvas-group-refresh.mjs',
]

// The roots whose .mjs suites run under `npm test` / `npm run test:v2`, which is
// where a cold mount can take a job down.
const fixtureReadinessScanRoots = ['e2e', 'src/renderer-v2']

function browserSuitesUnder(directory) {
  const found = []
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      found.push(...browserSuitesUnder(relative))
      continue
    }
    if (!entry.name.endsWith('.mjs')) continue
    // The budget module itself only mentions newPage() in the comment that
    // explains why the budget exists.
    if (relative === fixtureReadinessModule) continue
    const source = fs.readFileSync(path.join(root, relative), 'utf8')
    // openFixturePage counts as navigating: a suite that hands its navigation
    // to the shared retry has no page.goto of its own left to match on, and
    // dropping out of this scan is exactly how a budgeted suite would slip
    // back out of the gate that guards it.
    if (/browser\.newPage\(/.test(source) && /\.goto\(|openFixturePage\(/.test(source)) found.push(relative)
  }
  return found
}

// Playwright's action default. A mount wait exists because it has to outlast
// this; anything shorter is an assertion that something happens quickly, which
// is the opposite thing and stays as written.
const playwrightActionDefaultMs = 30_000

// Expressed once so the gate and its own test measure the same thing.
function fixtureMountBudgetProblems(consumer, source) {
  const problems = []
  // Either the budget itself, the shared wait that spends it, or the shared
  // open that spends it as several navigations.
  if (!/fixtureReadyTimeoutMs|waitForFixtureMount|fixtureMountSliceMs|openFixturePage/.test(source)) {
    problems.push(`${consumer} must bound its fixture mount with the shared budget`)
  }
  if (!/from '[./]*(?:e2e\/)?fixture-readiness\.mjs'/.test(source)) {
    problems.push(`${consumer} must import the shared budget rather than restate it`)
  }
  for (const restated of source.matchAll(/timeout:\s*(\d[\d_]*)/g)) {
    if (Number(restated[1].replaceAll('_', '')) < playwrightActionDefaultMs) continue
    problems.push(`${consumer} must not restate a mount wait of its own (${restated[0]})`)
  }
  return problems
}

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

    assert.deepEqual(fixtureMountBudgetProblems(consumer, source), [])
  }

  // page.goto resolves on `load`, which happens before the fixture module has
  // installed its globals and can be followed by a Vite dependency reload.
  const appCheck = fs.readFileSync(path.join(root, 'src/renderer-v2/testing/app-check.mjs'), 'utf8')
  assert.match(appCheck, /openFixturePage\(page, `\$\{origin\}\/src\/renderer-v2\/testing\/app\.html/,
    'every app-check page must open through the shared fixture navigation')
  assert.match(appCheck, /waitForFixtureReady\(page, timeout\)/, 'every app-check page must wait for the fixture to install')
  assert.doesNotMatch(appCheck, /await page\.goto\(`\$\{origin\}\/src\/renderer-v2\/testing\/app\.html\?\$\{query\}/,
    'app-check must not navigate its fixture without the retry that owns the budget')
})

// The Windows browser shard failed 14 of its 141 completed quality runs between
// 2026-09-19 and 2026-09-21, and every one of those was a single page that died
// on its own: a mount wait that spent the whole 90s, a locator that spent 30s on
// an empty document, or net::ERR_NO_BUFFER_SPACE thrown 69ms into page.goto.
// Ten green runs of the same shard hold no test slower than 22.4s, so the budget
// was never the problem — a lost navigation was. The budget therefore has to
// stay where it is and be spent as more than one navigation.
test('a lost fixture navigation is retried inside the budget rather than waited out', async () => {
  const readiness = await import(require('node:url').pathToFileURL(path.join(root, fixtureReadinessModule)).href)

  assert.ok(readiness.fixtureMountAttempts >= 2, 'one navigation that dies must not end the run')
  const slice = readiness.fixtureMountSliceMs()
  assert.ok(slice * readiness.fixtureMountAttempts <= readiness.fixtureReadyTimeoutMs,
    'the navigations together must not widen the budget they spend from')
  // Comfortably above the 22.4s ceiling the ten green runs measured, so a
  // fixture that is merely slow still mounts on its first navigation.
  assert.ok(slice > 22_400, 'a single navigation must still outlast the slowest observed green mount')

  for (const consumer of ['src/renderer-v2/testing/app-check.mjs', 'e2e/v2-business.test.mjs',
    'e2e/maintenance-layout.test.mjs', 'src/renderer-v2/features/chat/browser-check.mjs',
    'src/renderer-v2/ui/browser-check.mjs']) {
    const source = fs.readFileSync(path.join(root, consumer), 'utf8')
    assert.match(source, /openFixturePage\(/, `${consumer} must open its fixture through the shared retry`)
  }

  // Structure is not enough: retrying is only free while every attempt shares
  // one deadline. An attempt budget multiplied by an attempt count is how a
  // 90s wait quietly becomes a 180s one.
  let navigations = 0
  const started = Date.now()
  const fixtureIsDead = () => { throw new Error('lost') }
  await assert.rejects(
    readiness.openFixturePage({ goto: async () => { navigations += 1 } }, 'about:blank', fixtureIsDead,
      { label: 'probe', timeout: 600 }),
    /probe did not finish installing within 600ms after 3 navigations/)

  assert.equal(navigations, readiness.fixtureMountAttempts, 'every attempt must be a fresh navigation')
  assert.ok(Date.now() - started < 600, 'the attempts must share one deadline rather than each taking the whole budget')
})

// The list above was right about every suite on it and blind to every suite
// that was not: nothing tied it to the suites that actually exist, so the chat
// fixture under src/renderer-v2/ was never noticed. Discovering the suites
// instead of trusting the list is what makes the next omission fail here.
test('every browser suite is accounted for by the fixture mount gate', () => {
  const discovered = fixtureReadinessScanRoots.flatMap((directory) => browserSuitesUnder(directory)).sort()
  const accounted = new Set([...fixtureReadinessConsumers, ...fixtureReadinessUnbudgeted])

  assert.ok(discovered.includes('src/renderer-v2/features/chat/browser-check.mjs'),
    'the scan must reach the renderer tree the chat fixture lives in, not only e2e/')

  for (const suite of discovered) {
    assert.ok(accounted.has(suite),
      `${suite} opens pages of its own: budget its mount and list it, or record it as unbudgeted`)
  }
  // A suite that has since been budgeted or deleted must leave the debt list
  // rather than sit there granting an exemption nobody needs.
  for (const suite of fixtureReadinessUnbudgeted) {
    assert.ok(discovered.includes(suite), `${suite} no longer opens pages: drop it from the unbudgeted list`)
    const source = fs.readFileSync(path.join(root, suite), 'utf8')
    assert.doesNotMatch(source, /fixtureReadyTimeoutMs|waitForFixtureMount/, `${suite} now takes the shared budget: move it to the consumers`)
  }
})

// The gate is only worth the scan if it rejects the two ways a covered suite
// can end up back on a wait of its own.
test('the fixture mount gate rejects a suite that waits on a number of its own', () => {
  const budgeted = [
    "import { fixtureReadyTimeoutMs } from '../../../../e2e/fixture-readiness.mjs'",
    "await page.locator('#root > *').first().waitFor({ timeout: fixtureReadyTimeoutMs })",
  ].join('\n')

  assert.deepEqual(fixtureMountBudgetProblems('fake/browser-check.mjs', budgeted), [])

  // Spending the budget through the shared wait counts as taking it.
  const shared = [
    "import { waitForFixtureMount } from '../../../../e2e/fixture-readiness.mjs'",
    "await waitForFixtureMount(page, { what: 'the fake fixture' })",
  ].join('\n')
  assert.deepEqual(fixtureMountBudgetProblems('fake/browser-check.mjs', shared), [])

  const restated = budgeted.replace('fixtureReadyTimeoutMs })', '60_000 })')
  assert.deepEqual(fixtureMountBudgetProblems('fake/browser-check.mjs', restated),
    ['fake/browser-check.mjs must not restate a mount wait of its own (timeout: 60_000)'])

  // An assertion that something happens faster than the default is the opposite
  // of a mount wait - src/renderer-v2/ui/browser-check.mjs asserts a toast is
  // gone within 4s - and must survive the suite being budgeted.
  const shorterThanDefault = `${shared}\nawait toast.waitFor({ state: 'detached', timeout: 4000 })`
  assert.deepEqual(fixtureMountBudgetProblems('fake/browser-check.mjs', shorterThanDefault), [])

  // What the chat fixture looked like: no import, no budget, the element under
  // test doubling as the mount wait on Playwright's default.
  const unbudgeted = "await page.getByTestId('chat-composer-input').waitFor()"
  assert.deepEqual(fixtureMountBudgetProblems('fake/browser-check.mjs', unbudgeted), [
    'fake/browser-check.mjs must bound its fixture mount with the shared budget',
    'fake/browser-check.mjs must import the shared budget rather than restate it',
  ])
})

// The inspector replay used to wait a flat 500ms three times, so on a Windows
// runner all three landed inside one Defender stall (run #236 spent the whole
// allowance between 131.0s and 132.0s) and took the packaging job with them.
// Backing off only helps while the waits actually grow and while the smoke
// keeps reading them from the shared module instead of restating a number.
test('the inspector replay backs off instead of repeating on a fixed interval', async () => {
  const readiness = await import(require('node:url').pathToFileURL(path.join(root, fixtureReadinessModule)).href)

  assert.ok(readiness.collectedPromiseAttempts >= 3, 'a single collected promise must not end the run')
  assert.ok(readiness.collectedPromiseBackoffMs > 0, 'the replay must wait before it retries')
  assert.ok(readiness.collectedPromiseBackoffCapMs >= readiness.collectedPromiseBackoffMs,
    'the ceiling must not sit below the first wait')

  const waits = Array.from({ length: readiness.collectedPromiseAttempts - 1 },
    (_, index) => readiness.collectedPromiseBackoffFor(index + 1))

  assert.equal(waits[0], readiness.collectedPromiseBackoffMs)
  for (const [index, wait] of waits.entries()) {
    assert.ok(wait <= readiness.collectedPromiseBackoffCapMs, 'no single wait may exceed the ceiling')
    if (index > 0) assert.ok(wait > waits[index - 1] || waits[index - 1] === readiness.collectedPromiseBackoffCapMs,
      'each wait must grow until it reaches the ceiling')
  }
  // Wide enough to outlast the stall that collected the wrapper three times in
  // a second, and still a small fraction of the step budget it spends from.
  const total = waits.reduce((sum, wait) => sum + wait, 0)
  assert.ok(total >= 3_000, `the replays must spread over at least 3s of backoff, got ${total}ms`)

  const smoke = fs.readFileSync(path.join(root, 'e2e/realm-account-smoke.mjs'), 'utf8')
  assert.match(smoke, /collectedPromiseBackoffFor/, 'the smoke must take its backoff from the shared module')
  assert.doesNotMatch(smoke, /setTimeout\(resolve, \d/, 'the smoke must not restate a retry interval of its own')
})

// A React render crash or an unhandled rejection inside a fixture leaves the
// page standing with whatever it had already committed, so a suite that only
// asserts on the elements it touches stays green through it. Every browser
// suite therefore records pageerror and empties the record before it finishes;
// this keeps a new suite from quietly opting out of that (T-G3).
test('no browser suite can go green while its fixture threw', () => {
  // A suite with no browser has no page to listen to. Selecting on the import
  // rather than the file name keeps a real browser suite from opting out by
  // dropping its listener, which a name based allowlist would not notice.
  // T-B1 moved most launches behind e2e/harness.mjs, so a suite now reaches a
  // browser through either import.
  const suites = fs.readdirSync(path.join(root, 'e2e'))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `e2e/${name}`)
    .filter((suite) => /@playwright\/test|from '\.\/harness\.mjs'/.test(fs.readFileSync(path.join(root, suite), 'utf8')))

  assert.ok(suites.length >= 15, 'the e2e browser suite list must not silently shrink')
  for (const suite of suites) {
    const source = fs.readFileSync(path.join(root, suite), 'utf8')
    // The harness owns the listener and the assertion for everything it opens;
    // a suite that uses it must still be the one that empties the record, so
    // that dropping the call is what fails rather than nothing at all.
    const harnessed = /from '\.\/harness\.mjs'/.test(source)
      && (/\.assertNoPageErrors\(\)/.test(source) || /withBrowserFixture\(/.test(source))
    const shared = /from '\.\/page-errors\.mjs'/.test(source) && /pageErrors\.assertNone\(\)/.test(source)
    const inline = /page\.on\('pageerror'/.test(source) && /assert\.deepEqual\(errors, \[\]\)/.test(source)

    assert.ok(harnessed || shared || inline, `${suite} must record pageerror and assert it stayed empty`)
  }

  // Everything above now leans on the harness actually doing it.
  const harness = fs.readFileSync(path.join(root, 'e2e', 'harness.mjs'), 'utf8')
  assert.match(harness, /from '\.\/page-errors\.mjs'/, 'the harness must collect pageerror for every page it opens')
  assert.match(harness, /pageErrors\.watch\(/, 'every page the harness hands out must be watched')
  assert.match(harness, /pageErrors\.assertNone\(\)/, 'the harness must expose the assertion its suites call')
  // T-S5: the container fallback lives in exactly one place now.
  assert.match(harness, /XINGMANG_E2E_CHROMIUM/, 'the harness must honour the container browser override')
})

// Scans for the call that starts a Vite dev server, so a suite cannot drop out
// of the gate below by being renamed.
function viteServerSuitesUnder(directory, found = []) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      viteServerSuitesUnder(relative, found)
      continue
    }
    if (!entry.name.endsWith('.mjs')) continue
    const source = fs.readFileSync(path.join(root, relative), 'utf8')
    if (/from 'vite'/.test(source) && /createServer\(/.test(source)) found.push(relative)
  }
  return found
}

// Every fixture dev server the test scripts start, and the one file that is
// still allowed to start its own.
const fixtureServerSuites = [
  'e2e/harness.mjs',
  'e2e/macos-dev-origin.test.mjs',
  'src/renderer-v2/testing/app-check.mjs',
  'src/renderer-v2/ui/browser-check.mjs',
  'src/renderer-v2/features/auth/browser-check.mjs',
  'src/renderer-v2/features/chat/browser-check.mjs',
  'src/renderer-v2/features/acceleration/browser-check.mjs',
  'src/renderer-v2/features/shell/newapi-announcements.browser-check.mjs',
  'src/renderer-v2/features/shell/announcement-persistence.browser-check.mjs',
]

// The canvas is frozen to its owner's own rework, so it keeps its own
// createServer call rather than being touched for this.
const fixtureServerExempt = ['e2e/canvas-group-refresh.mjs']

// macos-dev-origin also asserts that the *public* dev server refuses an
// occupied port, which only the repository's own vite.config can answer, so it
// keeps a bare createServer for that case alongside the shared fixture server.
const fixtureServerOwnVite = new Set(['e2e/harness.mjs', 'e2e/macos-dev-origin.test.mjs'])

// T-B2 started as two suites with a hardcoded preferred port (5191 / 5196) and
// was "fixed" by passing `port: 0`, on the belief that Vite would then let the
// kernel choose. It does not: `startServer` reads
// `(!configPort || …) ? server._currentServerPort : configPort) ?? 5173`, so a
// configured 0 is indistinguishable from no port at all and falls through to
// 5173, which strictPort:false then walks upward from. Measured on vite 8.1.5,
// three servers started in one process took 5173, 5174 and 5175 - the same
// well-known port every other fixture server, and every `npm run dev` on the
// machine, starts from. A free port has to be reserved before Vite is asked to
// bind it, and pinned with strictPort so Vite cannot walk away from it.
test('every fixture dev server binds a port that was free when it asked for it', () => {
  const harness = fs.readFileSync(path.join(root, 'e2e', 'harness.mjs'), 'utf8')

  assert.match(harness, /export function reserveFreePort\(/, 'the harness must reserve the port itself')
  assert.match(harness, /probe\.listen\(0, '127\.0\.0\.1'/, 'the reservation is what asks the kernel for a port')
  assert.match(harness, /strictPort: true/, 'the reserved port must be pinned rather than used as a starting guess')
  assert.doesNotMatch(harness, /port: 0/, 'vite reads a configured 0 as "no port" and falls back to 5173')
  assert.doesNotMatch(harness, /port: [1-9]/, 'the shared fixture server must not prefer a fixed port')

  for (const suite of fixtureServerSuites) {
    const source = fs.readFileSync(path.join(root, suite), 'utf8')
    if (suite !== 'e2e/harness.mjs') {
      assert.match(source, /createFixtureServer\(/, `${suite} must take its dev server from e2e/harness.mjs`)
    }
    if (!fixtureServerOwnVite.has(suite)) {
      assert.doesNotMatch(source, /createServer\(/, `${suite} must not start a Vite server of its own`)
    }
    assert.doesNotMatch(source, /port: \d/, `${suite} must not name a port for its fixture server`)
  }

  // A new suite that starts its own server lands in neither list and fails
  // here rather than quietly reintroducing the 5173 race.
  const accounted = new Set([...fixtureServerSuites, ...fixtureServerExempt])
  for (const directory of fixtureReadinessScanRoots) {
    for (const suite of viteServerSuitesUnder(directory)) {
      assert.ok(accounted.has(suite),
        `${suite} starts a Vite dev server: take it from e2e/harness.mjs, or record it as exempt`)
    }
  }
  for (const suite of fixtureServerExempt) {
    assert.ok(fs.existsSync(path.join(root, suite)), `${suite} is gone: drop it from the exempt list`)
  }
})

// Two fixture servers started back to back must not be handed the same port,
// which is exactly what the 5173 walk could do across processes: both probe
// 5173 as free, both try to bind, and only one of them keeps it.
test('two fixture servers started together land on different ports', async () => {
  const harness = await import(require('node:url').pathToFileURL(path.join(root, 'e2e', 'harness.mjs')).href)

  const ports = await Promise.all(Array.from({ length: 8 }, () => harness.reserveFreePort()))

  assert.equal(new Set(ports).size, ports.length, `reserved ports collided: ${ports.join(', ')}`)
  // 5173 is not forbidden - the kernel may hand it out - but a run that took
  // the default eight times over would mean nothing was reserved at all.
  assert.ok(ports.some((port) => port !== 5173), 'the reservation must ask the kernel rather than restate the default')
  assert.ok(harness.fixtureServerPortAttempts >= 2, 'losing a reserved port to another process must not end the run')
})

// T-B1: the boilerplate the harness replaced must not grow back one suite at a
// time. A suite that launches its own Chromium is also a suite that silently
// opts out of the container override and the pageerror collection above.
test('e2e browser suites launch through the shared harness', () => {
  const exempt = new Set([
    // Drives Electron rather than Chromium, and asserts on the dev-server
    // origin the main process is given, so it needs its own server options.
    'e2e/macos-dev-origin.test.mjs',
  ])
  for (const name of fs.readdirSync(path.join(root, 'e2e')).filter((entry) => entry.endsWith('.test.mjs'))) {
    const suite = `e2e/${name}`
    if (exempt.has(suite)) continue
    const source = fs.readFileSync(path.join(root, suite), 'utf8')
    if (!/chromium\.launch\(/.test(source)) continue

    assert.fail(`${suite} must open its browser through e2e/harness.mjs rather than launching its own`)
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

// 验收证据里写死的 `true` 会在部分失败时照样打印出来，看起来像"这条也过了"。
const evidenceProducers = [
  'e2e/onboarding-smoke.mjs',
  'e2e/canvas-group-refresh.mjs',
  'e2e/acceleration-profile-isolation-smoke.mjs',
  'e2e/renderer-v2-native.mjs',
  // T-G8 的最后一处：这条冒烟的证据文件里还躺着 `actualNetworkRequests: 0` 和
  // `generatedContent: false` 两个没有计数器支撑的常量。
  'e2e/realm-account-smoke.mjs',
]

test('acceptance evidence reports what the run observed, not literals', () => {
  for (const producer of evidenceProducers) {
    const source = fs.readFileSync(path.join(root, producer), 'utf8')

    assert.match(source, /passedAssertions/, `${producer} must report the assertions this run actually passed`)
    // Only names pushed after an assertion ran may reach the evidence, so the
    // payload carrying them must not restate any behaviour as a constant.
    for (const payload of source.matchAll(/JSON\.stringify\(\{[^}]*passedAssertions[^}]*\}/g)) {
      assert.doesNotMatch(payload[0], /:\s*(?:true|false)\b/,
        `${producer} must not state a behaviour as a literal beside the assertions it measured`)
    }
  }

  // The realm smoke builds its payload as a named object rather than inline, so
  // the scan above cannot see it. Its every field is either the recorded list or
  // a number read back out of the fixture; the two constants T-G8 named must not
  // come back, and the recorded list must be checked against the names the run
  // was supposed to reach rather than simply written out however short it is.
  const realmSmoke = fs.readFileSync(path.join(root, 'e2e/realm-account-smoke.mjs'), 'utf8')
  const payload = realmSmoke.match(/const result = \{[\s\S]*?\n {4}\}\n/)

  assert.ok(payload, 'the realm smoke must build its evidence payload in one place')
  assert.doesNotMatch(payload[0], /:\s*(?:true|false)\b/, 'no field in the realm evidence may be a literal verdict')
  assert.doesNotMatch(payload[0], /actualNetworkRequests|generatedContent/,
    'both constants T-G8 named had no counter behind them')
  assert.match(realmSmoke, /assert\.deepEqual\(\[\.\.\.passedAssertions\]\.sort\(\), \[\.\.\.expectedAssertions\]\.sort\(\)\)/,
    'a run that stopped reaching a step must fail rather than ship a shorter list')
})
