const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { buildReleaseEnvironment, buildReleaseSteps } = require('./run-release-build.cjs')

const root = path.resolve(__dirname, '..')
const releaseOutputDirectory = path.join(root, 'release-0.0.0-test')

function stepLabels(options) {
  return buildReleaseSteps({
    npmCli: 'npm-cli.js',
    releaseOutputDirectory,
    platform: 'win32',
    ...options,
  }).map((step) => step.label)
}

function stepArguments(options) {
  return buildReleaseSteps({
    npmCli: 'npm-cli.js',
    releaseOutputDirectory,
    platform: 'win32',
    ...options,
  }).flatMap((step) => step.args)
}

test('the unsigned release runs exactly the same gate steps as the signed release', () => {
  // M-01: release:build:unsigned used to be `compile + electron-builder` and
  // skipped all ten gates. Only the Authenticode subject comparison may differ
  // between the two modes, so the step counts must stay identical.
  const signed = stepLabels({ unsignedReleaseMode: false })
  const unsigned = stepLabels({ unsignedReleaseMode: true })

  assert.equal(signed.length, unsigned.length)
  assert.equal(signed.length, 14)
})

test('the release gate covers the renderer that actually ships', () => {
  // M-03: `npm test` is `vitest run electron src`, so the gate used to verify
  // the main process and nothing of the interface a paying customer receives.
  // The renderer-v2 browser regression and the canvas suites have their own
  // entry points and were never reached at release time.
  for (const mode of [false, true]) {
    const commands = buildReleaseSteps({
      npmCli: 'npm-cli.js',
      releaseOutputDirectory,
      platform: 'win32',
      unsignedReleaseMode: mode,
    }).map((step) => step.args.join(' '))

    for (const suite of ['run test:v2', 'run test:canvas', 'run test:ui']) {
      assert.ok(commands.some((command) => command.includes(suite)),
        `the ${mode ? 'unsigned' : 'signed'} gate must run npm ${suite}`)
    }
  }
})

test('the unsigned gate keeps every check that does not need a certificate', () => {
  const steps = buildReleaseSteps({
    npmCli: 'npm-cli.js',
    releaseOutputDirectory,
    platform: 'win32',
    unsignedReleaseMode: true,
  })
  const scripts = steps
    .flatMap((step) => step.args)
    .filter((argument) => typeof argument === 'string')
    .map((argument) => (argument.startsWith(root) ? path.relative(root, argument).split(path.sep).join('/') : argument))

  for (const required of [
    'scripts/verify-release-environment.cjs',
    'scripts/verify-packaged-hardening.cjs',
    'scripts/verify-release-artifacts.cjs',
    'e2e/electron-ci-smoke.mjs',
    'e2e/onboarding-smoke.mjs',
    'e2e/packaged-hardening-smoke.mjs',
    'e2e/asar-tamper-smoke.mjs',
  ]) {
    assert.ok(scripts.includes(required), `unsigned release must still run ${required}`)
  }
  assert.ok(scripts.includes('typecheck'), 'unsigned release must still type-check')
  assert.ok(scripts.includes('test'), 'unsigned release must still run the full suite')
  assert.ok(scripts.includes('compile'), 'unsigned release must still compile the application')
})

test('the unsigned gate states which check it skips instead of dropping the whole step', () => {
  const steps = buildReleaseSteps({
    npmCli: 'npm-cli.js',
    releaseOutputDirectory,
    platform: 'win32',
    unsignedReleaseMode: true,
  })
  const artifactStep = steps.at(-1)

  assert.match(artifactStep.label, /latest\.yml/)
  assert.deepEqual(artifactStep.skippedChecks, ['Authenticode 签名主体比对：无签名模式下没有可比对的证书主体'])
  assert.ok(artifactStep.args.includes(path.join(root, 'scripts', 'verify-release-artifacts.cjs')))

  const signedArtifactStep = buildReleaseSteps({
    npmCli: 'npm-cli.js',
    releaseOutputDirectory,
    platform: 'win32',
    unsignedReleaseMode: false,
  }).at(-1)
  assert.match(signedArtifactStep.label, /Authenticode/)
  assert.deepEqual(signedArtifactStep.skippedChecks, [])
})

test('the release gate runs the renderer v2 smoke scripts, not the deleted legacy one', () => {
  const scripts = stepArguments({ unsignedReleaseMode: true })
    .filter((argument) => typeof argument === 'string')

  assert.ok(scripts.some((argument) => argument.endsWith(path.join('e2e', 'electron-ci-smoke.mjs'))))
  assert.equal(scripts.some((argument) => argument.endsWith('electron-smoke.mjs')), false)
})

test('every host runs the same common suite', () => {
  // P-12: the gate used to branch to test:windows on win32 for the serialised
  // run. test:vitest carries --no-file-parallelism and --testTimeout=30000
  // itself now, so `npm test` is that run on every platform and the branch was
  // selecting between two spellings of one command.
  for (const platform of ['linux', 'darwin', 'win32']) {
    const args = stepArguments({ platform, unsignedReleaseMode: true })
    assert.ok(args.includes('test'), `${platform} must run the common suite`)
    assert.equal(args.includes('test:windows'), false, `${platform} must not run a platform-specific variant`)
  }
})

test('unsigned mode never inherits the signed release markers or a signing certificate', () => {
  // electron-builder.config.cjs refuses both release modes at once, and a
  // leaked CSC_LINK would silently produce a signed installer from an entry
  // point that promises an unsigned one.
  const environment = buildReleaseEnvironment({
    PATH: '/usr/bin',
    XINGMANG_RELEASE: '1',
    CSC_LINK: 'file:///certificate.pfx',
    WIN_CSC_LINK: 'file:///certificate.pfx',
    CSC_KEY_PASSWORD: 'secret',
    WIN_CSC_KEY_PASSWORD: 'secret',
  }, { releaseOutputDirectory, unsignedReleaseMode: true })

  assert.equal(environment.XINGMANG_UNSIGNED_RELEASE, '1')
  assert.equal('XINGMANG_RELEASE' in environment, false)
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) {
    assert.equal(name in environment, false, `${name} must not reach an unsigned release build`)
  }
  assert.equal(environment.XINGMANG_LOCAL_BUILD, '0')
  assert.equal(environment.XINGMANG_OUTPUT_DIR, releaseOutputDirectory)
  assert.equal(environment.CSC_IDENTITY_AUTO_DISCOVERY, 'false')
})

test('signed mode still forwards the configured certificate and drops the unsigned marker', () => {
  const environment = buildReleaseEnvironment({
    PATH: '/usr/bin',
    XINGMANG_UNSIGNED_RELEASE: '1',
    WIN_CSC_LINK: 'file:///certificate.pfx',
    WIN_CSC_KEY_PASSWORD: 'secret',
  }, { releaseOutputDirectory, unsignedReleaseMode: false })

  assert.equal(environment.XINGMANG_RELEASE, '1')
  assert.equal('XINGMANG_UNSIGNED_RELEASE' in environment, false)
  assert.equal(environment.WIN_CSC_LINK, 'file:///certificate.pfx')
  assert.equal(environment.WIN_CSC_KEY_PASSWORD, 'secret')
})

test('the unsigned release still refuses to publish a version the update feed already carries', () => {
  const { assertRemoteVersionIsPublishable } = require('./verify-release-environment.cjs')
  const unsigned = { releaseMode: false, unsignedReleaseMode: true, publicReleaseMode: true }
  const localBuild = { releaseMode: false, unsignedReleaseMode: false, publicReleaseMode: false }

  assert.throws(
    () => assertRemoteVersionIsPublishable(unsigned, { missing: false, metadata: { version: '0.2.6' } }, '0.2.6'),
    { code: 'REMOTE_VERSION_ALREADY_PUBLISHED' },
  )
  assert.throws(
    () => assertRemoteVersionIsPublishable(unsigned, { missing: false, metadata: { version: '0.2.7' } }, '0.2.6'),
    { code: 'REMOTE_VERSION_NEWER_THAN_LOCAL' },
  )
  assert.equal(
    assertRemoteVersionIsPublishable(unsigned, { missing: false, metadata: { version: '0.2.5' } }, '0.2.6'),
    true,
  )
  assert.equal(assertRemoteVersionIsPublishable(unsigned, { missing: true }, '0.2.6'), false)
  assert.equal(
    assertRemoteVersionIsPublishable(localBuild, { missing: false, metadata: { version: '0.2.6' } }, '0.2.6'),
    false,
  )
})
