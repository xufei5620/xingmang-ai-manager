const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  BUILDS,
  RELEASE_PREFIX,
  TREES,
  parseArguments,
  planSourceMapUploads,
  renderSummary,
  uploadSourceMaps,
} = require('./sentry-sourcemaps.cjs')

const root = path.resolve(__dirname, '..')
const ENV = { SENTRY_AUTH_TOKEN: 'sntrys_test', SENTRY_ORG: 'org', SENTRY_PROJECT: 'electron', PATH: '/usr/bin', HOME: '/home/runner', R2_SECRET_ACCESS_KEY: 'must-not-leak' }

function downloaded(t, builds) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-sentry-maps-')))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  for (const [build, trees] of Object.entries(builds)) {
    for (const tree of trees) {
      const target = path.join(directory, build, tree)
      fs.mkdirSync(path.join(target, 'nested'), { recursive: true })
      fs.writeFileSync(path.join(target, 'nested', 'main.js'), 'x')
      fs.writeFileSync(path.join(target, 'nested', 'main.js.map'), '{}')
    }
  }
  return directory
}

const BOTH = ['dist-electron', 'dist']

test('each build is uploaded under every dist its installers report, for both trees', (t) => {
  const directory = downloaded(t, { windows: BOTH, macos: BOTH })
  const calls = []
  const result = uploadSourceMaps({ directory, version: '0.2.23', cli: '/tmp/sentry-cli', env: ENV, run: (cli, args, env) => calls.push({ cli, args, env }) })

  assert.equal(result.release, 'xingmang-ai-manager@0.2.23')
  const commands = calls.map((call) => call.args)
  assert.deepEqual(commands[0], ['releases', 'new', 'xingmang-ai-manager@0.2.23', '--org', 'org', '--project', 'electron'])
  assert.deepEqual(commands.at(-1), ['releases', 'finalize', 'xingmang-ai-manager@0.2.23', '--org', 'org'])
  const uploads = commands.slice(1, -1).map((args) => [args[args.indexOf('--dist') + 1], args[args.indexOf('--url-prefix') + 1], path.relative(directory, args.at(-1))])
  assert.deepEqual(uploads, [
    ['darwin-arm64', 'app:///dist', path.join('macos', 'dist')],
    ['darwin-arm64', 'app:///dist-electron', path.join('macos', 'dist-electron')],
    ['darwin-x64', 'app:///dist', path.join('macos', 'dist')],
    ['darwin-x64', 'app:///dist-electron', path.join('macos', 'dist-electron')],
    ['win32-x64', 'app:///dist', path.join('windows', 'dist')],
    ['win32-x64', 'app:///dist-electron', path.join('windows', 'dist-electron')],
  ])
  for (const args of commands.slice(1, -1)) {
    assert.equal(args[args.indexOf('--release') + 1], 'xingmang-ai-manager@0.2.23')
    assert.ok(args.includes('--wait'))
  }
  // sentry-cli gets the token and nothing else the job happens to hold.
  for (const call of calls) {
    assert.equal(call.cli, '/tmp/sentry-cli')
    assert.equal(call.env.SENTRY_AUTH_TOKEN, 'sntrys_test')
    assert.equal(call.env.R2_SECRET_ACCESS_KEY, undefined)
  }
})

test('the Linux builds each upload their own copy', (t) => {
  const directory = downloaded(t, { 'linux-x64': BOTH, 'linux-arm64': BOTH })
  const dists = planSourceMapUploads(directory).map((upload) => `${upload.build}:${upload.dist}`)
  assert.deepEqual([...new Set(dists)], ['linux-arm64:linux-arm64', 'linux-x64:linux-x64'])
})

test('an unknown, incomplete or empty download stops before anything is sent', (t) => {
  assert.throws(() => planSourceMapUploads(downloaded(t, { 'windows-arm64': BOTH })), /认不出的对照表：windows-arm64/)
  assert.throws(() => planSourceMapUploads(downloaded(t, { windows: ['dist-electron'] })), /windows 的对照表不全/)
  assert.throws(() => planSourceMapUploads(downloaded(t, {})), /一份对照表都没有/)
  assert.throws(() => planSourceMapUploads(path.join(os.tmpdir(), 'xingmang-no-such-maps')), /没有找到对照表目录/)
  const directory = downloaded(t, { windows: BOTH })
  const calls = []
  for (const env of [{ ...ENV, SENTRY_AUTH_TOKEN: '' }, { ...ENV, SENTRY_PROJECT: undefined }]) {
    assert.throws(() => uploadSourceMaps({ directory, version: '0.2.23', cli: 'x', env, run: () => calls.push(1) }))
  }
  assert.equal(calls.length, 0)
})

test('a failed sentry-cli call stops the rest instead of finalizing a half-uploaded release', (t) => {
  const directory = downloaded(t, { windows: BOTH })
  const calls = []
  assert.throws(() => uploadSourceMaps({
    directory,
    version: '0.2.23',
    cli: 'x',
    env: ENV,
    run: (cli, args) => {
      calls.push(args.slice(0, 2).join(' '))
      if (args[0] === 'sourcemaps') throw new Error('upload failed')
    },
  }), /upload failed/)
  assert.deepEqual(calls, ['releases new', 'sourcemaps upload'])
})

test('arguments are checked before any directory is read', () => {
  assert.deepEqual(parseArguments(['--directory', 'maps', '--version', '0.2.23', '--cli', '/tmp/cli']), { directory: 'maps', version: '0.2.23', cli: '/tmp/cli' })
  assert.throws(() => parseArguments(['--directory', 'maps', '--version', '0.2.23']), /缺少 --cli/)
  assert.throws(() => parseArguments(['--directory', 'maps', '--version', '0.2.23; rm -rf /', '--cli', 'x']), /版本号不对/)
  assert.throws(() => parseArguments(['--token', 'x']), /参数无效/)
})

test('the summary names the release and every dist that got maps', (t) => {
  const directory = downloaded(t, { windows: BOTH })
  const summary = renderSummary('xingmang-ai-manager@0.2.23', planSourceMapUploads(directory))
  assert.match(summary, /xingmang-ai-manager@0\.2\.23 已传，win32-x64/)
  assert.match(summary, /\| win32-x64 \| 2 \| 2 \|/)
})

test('release, dist and file addresses are the ones the client reports', () => {
  // The client side lives in TypeScript, so check its source rather than share a module.
  const crashReport = fs.readFileSync(path.join(root, 'electron', 'crash-report.ts'), 'utf8')
  assert.ok(crashReport.includes(`return \`${RELEASE_PREFIX}\${version}\``), 'crashReportRelease must use the same prefix')
  assert.ok(crashReport.includes('return `${platform}-${arch}`'), 'crashReportDist must be platform-arch')
  assert.ok(crashReport.includes("return `app:///dist/${location}`"))
  assert.ok(crashReport.includes('return `app:///${archived[1].replaceAll'))
  assert.deepEqual(TREES.map(([tree, prefix]) => [tree, prefix]), [['dist-electron', 'app:///dist-electron'], ['dist', 'app:///dist']])
  // What the installers are built for (electron-builder.config.cjs) is what gets maps.
  const config = require('../electron-builder.config.cjs')
  const archs = (target) => (Array.isArray(target) ? target : [target]).flatMap((entry) => entry.arch)
  assert.deepEqual([...new Set(archs(config.win.target))].map((arch) => `win32-${arch}`), BUILDS.get('windows'))
  assert.deepEqual([...new Set(archs(config.mac.target))].map((arch) => `darwin-${arch}`).sort(), [...BUILDS.get('macos')].sort())
  assert.deepEqual([...new Set(archs(config.linux.target))].map((arch) => `linux-${arch}`).sort(), [...BUILDS.get('linux-x64'), ...BUILDS.get('linux-arm64')].sort())
})
