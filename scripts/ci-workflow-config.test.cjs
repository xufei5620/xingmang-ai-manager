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
  for (const jobName of ['test', 'macos-test']) {
    const commands = runSteps(jobName)
    const installIndex = commands.indexOf('npx --no-install playwright install chromium')
    const testIndex = commands.indexOf('npm test')

    assert.notEqual(testIndex, -1, `${jobName} must run npm test`)
    assert.notEqual(installIndex, -1, `${jobName} must install Chromium`)
    assert.ok(installIndex < testIndex, `${jobName} must install Chromium before npm test`)
  }
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

test('quality checks cannot publish a release', () => {
  assert.equal(workflow.permissions.contents, 'read')

  const serialized = JSON.stringify(workflow.jobs)
  assert.doesNotMatch(serialized, /gh release|create-release|dist:mac:free|release:build/i)
})
