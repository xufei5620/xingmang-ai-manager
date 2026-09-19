const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const {
  COMPILE_TIMEOUT_MS,
  XCRUN_PATH,
  describeCompileFailure,
  main,
  swiftcArguments,
} = require('./build-macos-system-proxy.cjs')

const root = path.resolve(__dirname, '..')

function darwinOptions(overrides = {}) {
  return {
    platform: 'darwin',
    arch: 'arm64',
    ensureDirectory: () => {},
    stdio: 'ignore',
    spawnSync: () => ({ status: 0, signal: null }),
    ...overrides,
  }
}

test('swiftc arguments pin the deployment target and add the fixture backend only for the test build', () => {
  const release = swiftcArguments('x86_64', 'x64', false)
  assert.deepEqual(release, [
    'swiftc',
    '-target', 'x86_64-apple-macosx13.0',
    '-O',
    path.join(root, 'native/macos-system-proxy.swift'),
    '-o', path.join(root, 'dist-native/macos-system-proxy-x64'),
  ])

  const fixture = swiftcArguments('arm64', 'test', true)
  assert.equal(fixture.includes('-D'), true)
  assert.equal(fixture[fixture.indexOf('-D') + 1], 'PROXY_TEST_BACKEND')
  assert.equal(fixture.at(-1), path.join(root, 'dist-native/macos-system-proxy-test'))
})

test('P-36: a timeout, a failed spawn, a signal and a nonzero exit are reported apart', () => {
  const timeout = describeCompileFailure({
    error: Object.assign(new Error('spawnSync /usr/bin/xcrun ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    signal: 'SIGTERM',
    status: null,
  }, 'arm64')
  assert.match(timeout, /超过 600 秒未结束/)

  const unavailable = describeCompileFailure({
    error: Object.assign(new Error('spawnSync /usr/bin/xcrun ENOENT'), { code: 'ENOENT' }),
    status: null,
  }, 'arm64')
  assert.match(unavailable, /无法运行 \/usr\/bin\/xcrun/)
  assert.doesNotMatch(unavailable, /退出码/)

  assert.match(describeCompileFailure({ signal: 'SIGKILL', status: null }, 'x86_64'), /信号 SIGKILL/)
  assert.match(describeCompileFailure({ status: 1, signal: null }, 'x86_64'), /退出码 1/)
  assert.equal(describeCompileFailure({ status: 0, signal: null }, 'arm64'), null)
})

test('P-36: every compile is launched with a timeout and without a shell', () => {
  const calls = []
  main([process.execPath, 'build-macos-system-proxy.cjs'], darwinOptions({
    spawnSync: (executable, argv, options) => {
      calls.push({ executable, argv, options })
      return { status: 0, signal: null }
    },
  }))

  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((call) => call.argv[2]), [
    'arm64-apple-macosx13.0',
    'x86_64-apple-macosx13.0',
  ])
  for (const call of calls) {
    assert.equal(call.executable, XCRUN_PATH)
    assert.equal(call.options.timeout, COMPILE_TIMEOUT_MS)
    assert.equal(call.options.shell, false)
  }
})

test('P-36: a failing architecture stops the build and never reaches the next one', () => {
  let attempts = 0
  assert.throws(() => main([process.execPath, 'build-macos-system-proxy.cjs'], darwinOptions({
    spawnSync: () => {
      attempts += 1
      return {
        error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        signal: 'SIGTERM',
        status: null,
      }
    },
  })), /超过 600 秒未结束/)
  assert.equal(attempts, 1)
})

test('the fixture build compiles one host-matching architecture and refuses a non-macOS host', () => {
  const calls = []
  main([process.execPath, 'build-macos-system-proxy.cjs', '--test'], darwinOptions({
    arch: 'x64',
    spawnSync: (executable, argv) => {
      calls.push(argv)
      return { status: 0, signal: null }
    },
  }))
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2], 'x86_64-apple-macosx13.0')

  let ensured = 0
  assert.throws(() => main([], darwinOptions({
    platform: 'linux',
    ensureDirectory: () => { ensured += 1 },
  })), /macOS SDK/)
  assert.equal(ensured, 0)
})
