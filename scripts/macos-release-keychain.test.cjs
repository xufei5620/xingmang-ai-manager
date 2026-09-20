const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  describeImportFailure,
  importReleaseSigningIdentity,
  parseArguments,
  parseKeychainSearchList,
  releaseSigningKeychain,
} = require('./macos-release-keychain.cjs')

const P12_BASE64 = Buffer.from('not-a-real-p12-just-bytes').toString('base64')
const CERTIFICATE_PEM = '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n'
const ORIGINAL_SEARCH_LIST = '    "/Users/runner/Library/Keychains/login.keychain-db"\n'

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-release-keychain-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return fs.realpathSync(directory)
}

function healthyEnvironment(overrides = {}) {
  return {
    CSC_NAME: 'XingMang Free Update Identity',
    XINGMANG_MAC_SIGNING_P12_BASE64: P12_BASE64,
    XINGMANG_MAC_SIGNING_P12_PASSWORD: 'p12-password',
    XINGMANG_MAC_SIGNING_SHA256: 'ab'.repeat(32),
    RUNNER_ENVIRONMENT: 'github-hosted',
    ...overrides,
  }
}

function recordingRunner(calls, overrides = {}) {
  return (args, options = {}) => {
    calls.push({ args, options })
    if (overrides[args[0]]) return overrides[args[0]](args)
    if (args[0] === 'list-keychains' && args.length === 3) return ORIGINAL_SEARCH_LIST
    if (args[0] === 'find-certificate') return CERTIFICATE_PEM
    return ''
  }
}

function runImport(t, { env, overrides, extra } = {}) {
  const directory = temporaryDirectory(t)
  const statePath = path.join(directory, 'state.json')
  const calls = []
  const runSecurity = recordingRunner(calls, overrides)
  const result = importReleaseSigningIdentity({
    env: env || healthyEnvironment(),
    platform: 'darwin',
    statePath,
    runSecurity: (args, options) => {
      const output = runSecurity(args, options)
      // 真实的 create-keychain 会在磁盘上留下文件，导入流程会核对这一点。
      if (args[0] === 'create-keychain') fs.writeFileSync(path.join(directory, 'release-signing.keychain-db'), '')
      return output
    },
    ...extra,
  })
  return { calls, directory, result, statePath }
}

test('the release signing import never puts a password in argv', (t) => {
  const { calls } = runImport(t)
  const passwordCarrying = calls.filter((call) => (call.options.secrets || []).length > 0)
  assert.ok(passwordCarrying.length >= 3)
  for (const call of passwordCarrying) {
    // resolveMacosSecurityCommand 要求声明的机密确实出现在参数表里，它据此改走
    // `security -i` 的 stdin。这里钉住的是「声明了」，转译由那个封装自己的测试覆盖。
    for (const secret of call.options.secrets) {
      assert.ok(call.args.some((argument) => String(argument) === secret))
    }
  }
  const commandsWithSecrets = new Set(passwordCarrying.map((call) => call.args[0]))
  assert.deepEqual([...commandsWithSecrets].sort(), ['create-keychain', 'import', 'set-key-partition-list', 'unlock-keychain'])
})

test('the release signing import prepends the throwaway keychain and records the original list', (t) => {
  const { calls, result, statePath } = runImport(t)
  const searchListWrites = calls.filter((call) => call.args[0] === 'list-keychains' && call.args.includes('-s'))
  assert.equal(searchListWrites.length, 1)
  assert.deepEqual(searchListWrites[0].args, [
    'list-keychains', '-d', 'user', '-s',
    result.keychainPath,
    '/Users/runner/Library/Keychains/login.keychain-db',
  ])
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  assert.deepEqual(state.originalSearchList, ['/Users/runner/Library/Keychains/login.keychain-db'])
  assert.equal(state.trusted, true)
  assert.equal(state.keychainPath, result.keychainPath)
})

test('the release signing import trusts the certificate for code signing only, in the user domain', (t) => {
  const { calls, result } = runImport(t)
  const trust = calls.filter((call) => call.args[0] === 'add-trusted-cert')
  assert.equal(trust.length, 1)
  assert.deepEqual(trust[0].args, [
    'add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', '-k', result.keychainPath, result.certificatePath,
  ])
  // -d 会写进管理员域，那需要 sudo，也会留在 runner 之外的地方。
  assert.equal(trust[0].args.includes('-d'), false)
})

test('the release signing import shreds the P12 whether it succeeds or fails', (t) => {
  const { directory } = runImport(t)
  assert.equal(fs.existsSync(path.join(directory, 'release-signing.p12')), false)

  const failing = temporaryDirectory(t)
  assert.throws(() => importReleaseSigningIdentity({
    env: healthyEnvironment(),
    platform: 'darwin',
    statePath: path.join(failing, 'state.json'),
    runSecurity: (args) => {
      if (args[0] === 'import') throw new Error('import boom')
      if (args[0] === 'list-keychains' && args.length === 3) return ORIGINAL_SEARCH_LIST
      if (args[0] === 'create-keychain') fs.writeFileSync(path.join(failing, 'release-signing.keychain-db'), '')
      return ''
    },
  }), /import boom/)
  assert.equal(fs.existsSync(path.join(failing, 'release-signing.p12')), false)
})

test('a failed import deletes the keychain it created', (t) => {
  const directory = temporaryDirectory(t)
  const calls = []
  assert.throws(() => importReleaseSigningIdentity({
    env: healthyEnvironment(),
    platform: 'darwin',
    statePath: path.join(directory, 'state.json'),
    runSecurity: (args) => {
      calls.push(args[0])
      if (args[0] === 'set-key-partition-list') throw new Error('partition boom')
      if (args[0] === 'create-keychain') fs.writeFileSync(path.join(directory, 'release-signing.keychain-db'), '')
      if (args[0] === 'list-keychains' && args.length === 3) return ORIGINAL_SEARCH_LIST
      return ''
    },
  }), /partition boom/)
  assert.ok(calls.includes('delete-keychain'))
  // 搜索列表还没被动过，就不能去「还原」它。
  assert.equal(calls.includes('find-certificate'), false)
})

test('a rejected passphrase is reported with the three things worth checking', (t) => {
  // security says the same sentence for a wrong password, a .p12 exported
  // without one, and a base64 blob that lost bytes. On 2026-09-20 that cost a
  // whole approval round to tell apart by hand.
  const directory = temporaryDirectory(t)
  assert.throws(() => importReleaseSigningIdentity({
    env: healthyEnvironment(),
    platform: 'darwin',
    statePath: path.join(directory, 'state.json'),
    runSecurity: (args) => {
      if (args[0] === 'import') {
        throw new Error('security import失败：security: SecKeychainItemImport: The user name or passphrase you entered is not correct.')
      }
      if (args[0] === 'create-keychain') fs.writeFileSync(path.join(directory, 'release-signing.keychain-db'), '')
      if (args[0] === 'list-keychains' && args.length === 3) return ORIGINAL_SEARCH_LIST
      return ''
    },
  }), (error) => {
    assert.match(error.message, /XINGMANG_MAC_SIGNING_P12_PASSWORD/)
    assert.match(error.message, /openssl pkcs12/)
    // 指引里绝不能把密码本身带出来。
    assert.doesNotMatch(error.message, /p12-password/)
    return true
  })
})

test('an unrelated import failure is passed through untouched', () => {
  // 只有提到口令的那一句才配得上这段指引；别的错误加上它只会把人带偏。
  assert.equal(describeImportFailure('security import失败：disk full'), 'security import失败：disk full')
})

test('the release signing import refuses anything but a throwaway hosted runner', (t) => {
  const directory = temporaryDirectory(t)
  assert.throws(() => importReleaseSigningIdentity({
    env: healthyEnvironment({ RUNNER_ENVIRONMENT: 'self-hosted' }),
    platform: 'darwin',
    statePath: path.join(directory, 'state.json'),
    runSecurity: () => '',
  }), /一次性托管 runner/)
  assert.throws(() => importReleaseSigningIdentity({
    env: healthyEnvironment(),
    platform: 'linux',
    statePath: path.join(directory, 'state.json'),
    runSecurity: () => '',
  }), /只能在 macOS/)
})

test('the release signing import names the secret that is missing', (t) => {
  const directory = temporaryDirectory(t)
  for (const name of [
    'CSC_NAME',
    'XINGMANG_MAC_SIGNING_P12_BASE64',
    'XINGMANG_MAC_SIGNING_P12_PASSWORD',
    'XINGMANG_MAC_SIGNING_SHA256',
  ]) {
    assert.throws(() => importReleaseSigningIdentity({
      env: healthyEnvironment({ [name]: '' }),
      platform: 'darwin',
      statePath: path.join(directory, 'state.json'),
      runSecurity: () => '',
    }), new RegExp(name))
  }
  assert.throws(() => importReleaseSigningIdentity({
    env: healthyEnvironment({ XINGMANG_MAC_SIGNING_P12_BASE64: 'not base64!!' }),
    platform: 'darwin',
    statePath: path.join(directory, 'state.json'),
    runSecurity: () => '',
  }), /base64/)
})

test('the teardown undoes trust, search list and keychain in that order', (t) => {
  const { result, statePath } = runImport(t)
  const calls = []
  releaseSigningKeychain({
    statePath,
    runSecurity: (args) => {
      calls.push(args)
      return ''
    },
  })
  assert.deepEqual(calls.map((args) => args[0]), ['remove-trusted-cert', 'list-keychains', 'delete-keychain'])
  assert.deepEqual(calls[1], [
    'list-keychains', '-d', 'user', '-s', '/Users/runner/Library/Keychains/login.keychain-db',
  ])
  assert.deepEqual(calls[2], ['delete-keychain', result.keychainPath])
  assert.equal(fs.existsSync(statePath), false)
})

test('the teardown keeps going after one step fails and reports every failure', (t) => {
  const { statePath } = runImport(t)
  assert.throws(() => releaseSigningKeychain({
    statePath,
    runSecurity: (args) => {
      if (args[0] === 'remove-trusted-cert') throw new Error('trust boom')
      if (args[0] === 'delete-keychain') throw new Error('delete boom')
      return ''
    },
  }), /trust boom.*delete boom/s)
  // 搜索列表那一步仍然跑过了：它是三步里唯一会影响后续构建的全局状态。
  assert.equal(fs.existsSync(statePath), false)
})

test('the teardown refuses a state file it cannot trust', (t) => {
  const directory = temporaryDirectory(t)
  const statePath = path.join(directory, 'state.json')
  fs.writeFileSync(statePath, JSON.stringify({ version: 99, originalSearchList: ['/a'] }))
  assert.throws(() => releaseSigningKeychain({ statePath, runSecurity: () => '' }), /格式不正确/)
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, originalSearchList: [] }))
  assert.throws(() => releaseSigningKeychain({ statePath, runSecurity: () => '' }), /搜索列表无效/)
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, originalSearchList: ['relative/path'] }))
  assert.throws(() => releaseSigningKeychain({ statePath, runSecurity: () => '' }), /搜索列表无效/)
})

test('the command line accepts exactly one mode and requires a state path', () => {
  assert.deepEqual(parseArguments(['--import', '--state', '/tmp/state.json']), {
    mode: 'import',
    statePath: '/tmp/state.json',
  })
  assert.deepEqual(parseArguments(['--release', '--state', '/tmp/state.json']), {
    mode: 'release',
    statePath: '/tmp/state.json',
  })
  assert.throws(() => parseArguments(['--import', '--release', '--state', '/tmp/s']), /只能选一个/)
  assert.throws(() => parseArguments(['--import']), /--state/)
  assert.throws(() => parseArguments(['--state', '/tmp/s']), /--import 或 --release/)
  assert.throws(() => parseArguments(['--wat']), /无法识别/)
})

test('keychain search list output parses into bare absolute paths', () => {
  assert.deepEqual(parseKeychainSearchList('    "/a/login.keychain-db"\n    "/b/other.keychain-db"\n'), [
    '/a/login.keychain-db',
    '/b/other.keychain-db',
  ])
  assert.deepEqual(parseKeychainSearchList(''), [])
})
