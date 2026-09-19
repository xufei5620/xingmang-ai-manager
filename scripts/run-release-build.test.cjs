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
  assert.equal(signed.length, 11)
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
  assert.ok(scripts.includes('test:windows'), 'unsigned release must still run the full Windows suite')
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

test('non-Windows hosts run the common suite while Windows runs the serialized one', () => {
  assert.ok(stepArguments({ platform: 'linux', unsignedReleaseMode: true }).includes('test'))
  assert.equal(stepArguments({ platform: 'linux', unsignedReleaseMode: true }).includes('test:windows'), false)
  assert.ok(stepArguments({ platform: 'win32', unsignedReleaseMode: true }).includes('test:windows'))
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
