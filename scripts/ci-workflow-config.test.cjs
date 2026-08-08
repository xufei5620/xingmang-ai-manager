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

test('the common test suite excludes Darwin filesystem and signing fixtures', () => {
  const commonTestCommand = packageJson.scripts.test
  const macSigningCommand = packageJson.scripts['test:mac:free-signing']

  for (const fixture of darwinOnlyTests) {
    assert.equal(commonTestCommand.includes(fixture), false, `${fixture} must not run on Windows`)
    assert.equal(macSigningCommand.includes(fixture), true, `${fixture} must run in the macOS job`)
  }
})

test('browser-backed tests install Chromium first on every job that runs npm test', () => {
  for (const [jobName, testCommand] of [
    ['test', 'npm run test:windows'],
    ['macos-test', 'npm test'],
  ]) {
    const commands = runSteps(jobName)
    const installIndex = commands.indexOf('npx --no-install playwright install chromium')
    const testIndex = commands.indexOf(testCommand)

    assert.notEqual(testIndex, -1, `${jobName} must run ${testCommand}`)
    assert.notEqual(installIndex, -1, `${jobName} must install Chromium`)
    assert.ok(installIndex < testIndex, `${jobName} must install Chromium before ${testCommand}`)
  }
})

test('the Windows suite serializes filesystem-heavy files with a bounded test timeout', () => {
  const command = packageJson.scripts['test:windows']

  assert.match(command, /vitest run electron src/)
  assert.match(command, /--no-file-parallelism/)
  assert.match(command, /--testTimeout=30000/)
  assert.match(command, /npm run test:node/)
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

test('superseded branch runs are cancelled while main runs to completion', () => {
  assert.equal(workflow.concurrency.group, '${{ github.workflow }}-${{ github.ref }}')
  assert.equal(
    workflow.concurrency['cancel-in-progress'],
    "${{ github.ref != 'refs/heads/main' }}",
  )
})

test('quality checks cannot publish a release', () => {
  assert.equal(workflow.permissions.contents, 'read')

  const serialized = JSON.stringify(workflow.jobs)
  assert.doesNotMatch(serialized, /gh release|create-release|dist:mac:free|release:build/i)
})
