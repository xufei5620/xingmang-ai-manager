const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { spawnSync } = require('node:child_process')
const {
  SKIPPED_CHECKS,
  buildLinuxReleaseEnvironment,
  buildLinuxReleaseSteps,
  parseArchitecture,
} = require('./run-linux-release-package.cjs')
const { resolveUpdateUrlForVersion } = require('./update-release-utils.cjs')

const root = path.resolve(__dirname, '..')
const releaseOutputDirectory = path.join(root, 'release-0.0.0-test')
const packageVersion = require('../package.json').version

function relative(argument) {
  return typeof argument === 'string' && argument.startsWith(root)
    ? path.relative(root, argument).split(path.sep).join('/')
    : argument
}

function steps(arch) {
  return buildLinuxReleaseSteps({ npmCli: 'npm-cli.js', releaseOutputDirectory, arch })
    .map((step) => ({ label: step.label, args: step.args.map(relative) }))
}

test('the Linux release gate checks the live manifest first and the deb against its manifest last', () => {
  const gate = steps('x64')
  assert.deepEqual(gate.map((step) => step.args[0]), [
    'scripts/verify-release-environment.cjs',
    'npm-cli.js',
    'node_modules/electron-builder/cli.js',
    'scripts/verify-packaged-hardening.cjs',
    'scripts/verify-linux-deb.cjs',
  ])
  // 线上这个架构的清单已经是本次或更新的版本时，出包之前就停下。
  assert.deepEqual(gate[0].args.slice(1), ['--platform', 'linux', '--arch', 'x64'])
  assert.deepEqual(gate[1].args.slice(1), ['run', 'compile'])
  assert.deepEqual(gate[3].args.slice(1), ['release-0.0.0-test/linux-unpacked'])
  // --release：自动更新必须开着、指向这个版本的正式更新目录，清单必须与 deb 一致。
  assert.deepEqual(gate[4].args.slice(1), ['release-0.0.0-test', '--arch', 'x64', '--release'])
})

test('each architecture packs and checks only its own deb, and nothing is published from here', () => {
  for (const [arch, other, unpacked] of [['x64', 'arm64', 'linux-unpacked'], ['arm64', 'x64', 'linux-arm64-unpacked']]) {
    const gate = steps(arch)
    const builder = gate[2].args
    assert.deepEqual(builder.slice(1), ['--config', 'electron-builder.config.cjs', '--linux', 'deb', `--${arch}`, '--publish', 'never'])
    assert.ok(!builder.includes(`--${other}`), `${arch} gate must not build ${other}`)
    assert.deepEqual(gate[3].args.slice(1), [`release-0.0.0-test/${unpacked}`])
    assert.deepEqual(gate[4].args.slice(2), ['--arch', arch, '--release'])
  }
  assert.throws(() => buildLinuxReleaseSteps({ npmCli: 'npm-cli.js', releaseOutputDirectory, arch: 'ia32' }), /只接受 x64 或 arm64/)
})

test('the checks this gate leaves out are named every time, not silently dropped', () => {
  // 与 Windows 的 release:build:unsigned 相比少了三项；每一项都要说清去了哪里。
  assert.equal(SKIPPED_CHECKS.length, 3)
  assert.match(SKIPPED_CHECKS[0], /linux-checks/)
  assert.match(SKIPPED_CHECKS[1], /chrome-sandbox/)
  assert.match(SKIPPED_CHECKS[2], /ASAR/)
  const commands = steps('x64').flatMap((step) => step.args).join(' ')
  assert.doesNotMatch(commands, /asar-tamper-smoke|electron-ci-smoke|run test\b|run typecheck/)
})

test('the architecture has to be named on the command line', () => {
  assert.equal(parseArchitecture(['--arch', 'x64']), 'x64')
  assert.equal(parseArchitecture(['--arch', 'arm64']), 'arm64')
  // 不猜 process.arch：在 x64 机器上忘了写，就会把 x64 的包当成 arm64 的发出去。
  assert.throws(() => parseArchitecture([]), /--arch x64 或 --arch arm64/)
  assert.throws(() => parseArchitecture(['--arch']), /--arch x64 或 --arch arm64/)
  assert.throws(() => parseArchitecture(['--arch', 'ia32']), /只接受 x64 或 arm64/)
})

test('the Linux release environment is the unsigned release and drops anything that would change the package', () => {
  const inherited = {
    PATH: '/usr/bin',
    XINGMANG_LOCAL_BUILD: '1',
    XINGMANG_RELEASE: '1',
    XINGMANG_MAC_FREE_RELEASE: '1',
    XINGMANG_UPDATE_URL: 'https://elsewhere.example.test/feed/',
    XINGMANG_UPDATE_DEV: '1',
    XINGMANG_ACCELERATION_BUNDLE_DIR: '/tmp/acceleration',
    CSC_LINK: 'certificate.p12',
    CSC_KEY_PASSWORD: 'secret',
    WIN_CSC_LINK: 'windows.p12',
  }
  const environment = buildLinuxReleaseEnvironment(inherited, { releaseOutputDirectory })

  assert.equal(environment.XINGMANG_LOCAL_BUILD, '0')
  assert.equal(environment.XINGMANG_UNSIGNED_RELEASE, '1')
  assert.equal(environment.XINGMANG_LINUX_PACKAGE, '1')
  assert.equal(environment.XINGMANG_OUTPUT_DIR, releaseOutputDirectory)
  assert.equal(environment.CSC_IDENTITY_AUTO_DISCOVERY, 'false')
  assert.equal(environment.PATH, '/usr/bin')
  for (const name of [
    'XINGMANG_RELEASE',
    'XINGMANG_MAC_FREE_RELEASE',
    'XINGMANG_UPDATE_URL',
    'XINGMANG_UPDATE_DEV',
    'XINGMANG_ACCELERATION_BUNDLE_DIR',
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'WIN_CSC_LINK',
  ]) {
    assert.equal(name in environment, false, `${name} must not reach the Linux release build`)
  }
  // 调用方的环境原样不动。
  assert.equal(inherited.XINGMANG_RELEASE, '1')
})

test('the build config sees that environment as an unsigned Linux release with the updater on', () => {
  const environment = buildLinuxReleaseEnvironment({ PATH: process.env.PATH, HOME: process.env.HOME }, { releaseOutputDirectory })
  const result = spawnSync(process.execPath, ['-e', `
    const config = require(${JSON.stringify(path.join(root, 'electron-builder.config.cjs'))})
    process.stdout.write(JSON.stringify({ productName: config.productName, output: config.directories.output, extraMetadata: config.extraMetadata, publish: config.publish }))
  `], { cwd: root, encoding: 'utf8', env: environment })
  assert.equal(result.status, 0, result.stderr)
  const config = JSON.parse(result.stdout)

  assert.equal(config.productName, 'xingmang-ai-manager')
  assert.equal(config.output, releaseOutputDirectory)
  assert.equal(config.extraMetadata.xingmangLocalBuild, false)
  assert.equal(config.extraMetadata.xingmangUnsignedRelease, true)
  assert.equal(config.publish.provider, 'generic')
  assert.equal(config.publish.url, resolveUpdateUrlForVersion(packageVersion))
  // publisherName 会打开 Windows 的 Authenticode 校验，deb 永远过不了。
  assert.equal('publisherName' in config.publish, false)
})
