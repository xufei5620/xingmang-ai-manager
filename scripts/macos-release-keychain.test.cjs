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
// 真证书，不是占位串：信任设置该写 trustRoot 还是 trustAsRoot 是从 basicConstraints
// 读出来的，占位串测不出那个分支。两张都是一次性生成的自签证书，与发布身份无关。
const CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIDEjCCAfqgAwIBAgIUVQxKi1sb1YiEqWnfEDXjZim3ZnAwDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMRml4dHVyZSBSb290MB4XDTI2MDkyMDE4MzkzOVoXDTI3
MDkyMDE4MzkzOVowFzEVMBMGA1UEAwwMRml4dHVyZSBSb290MIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2dcnxhgJtBxZBfByZpPdkGe8eXUV5/+0vRDR
vPv8YLUny+/XW15Vy9Xf1SteEWYEtvbVzCCw07+3r6+uQA4udsDOA6HN811t3MRC
YGJE3iHtaB7BP1AwRAqjDen8FVywQKRPikq/ldRiN1s1/2YfHG8OThDaI/30Wdxr
xgekycqBDCTG9XaqSUBg/5C59Ybe+flU68+v6qUFr3GWqu7qdZLmkn6SFefAcdrf
dc6pm84csJTT2nhD76i8LGVCYcBYEbHpaMZtLdobc4djxJy3ZZclH614cymX0UMf
zSNPBQ8vd7HMRDT4y1ycVMcenKf8F4PtlZtLT0aTzFq3mrmdRQIDAQABo1YwVDAd
BgNVHQ4EFgQUvu/5r1FjLB1dEtA1oX1VK0E66wgwHwYDVR0jBBgwFoAUvu/5r1Fj
LB1dEtA1oX1VK0E66wgwEgYDVR0TAQH/BAgwBgEB/wIBADANBgkqhkiG9w0BAQsF
AAOCAQEARf3d21RLpWqrYjOmt+kh8mVsi4ukd2IeG3RUMqodEdnOnEiF5jDT1HMI
Dyj+0kAzyIHP36B6IAgrViFaXnlKQALcZri1AUJh1e+Tkzr1uAJKsHN+Q0IVwnM3
KFZ2rV+xnIjm9C3RpU6JaeNqYQpy1ZtIkmOlB8kjT8j59irreHBPhho+Bt4dc1ap
FsGcAOEmsgKyc+gOMVH1mgwL4RAm2fZoyFqaeKYBTtcfwfDN4wd0EpwsOkSqVt6W
YrL0xJLvU4x3VdlacPFnLSaoIP9Ufn1u4snppFhmCKJF9zoBYhygCA+7HdsMJ8sG
5sDDrlx+YC2COnooEYa+vAM/PaSWzA==
-----END CERTIFICATE-----
`
const LEAF_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIDDDCCAfSgAwIBAgIUNrFXEVOepaYIvb1kx4cKYiGurwowDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMRml4dHVyZSBMZWFmMB4XDTI2MDkyMDE4MzkzOVoXDTI3
MDkyMDE4MzkzOVowFzEVMBMGA1UEAwwMRml4dHVyZSBMZWFmMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAl0aKycKtgFu36upHIUAorkMactWcej59ROqD
MNrWwVzmF6lu616oT43m5SSrp+IxHHQ/+cd9NaJaKTBUPQGM1IzWd1a9rpQbF7SC
mA3rtSSSu0wQQwEGjNrlukbt38V6CzReux5KbJvxOaD+Iqabtesp2o4HkqshF49q
CfJ/gI5XfmiiZhqJwA1yFOumP59lAeAP5gZowPXum5jIQWucdH2jDxP7pUvlrMh2
YJ6hDbcSnSMPfSUPzz1FOA4e197xREwjzCDhNvqRcOJVbH1ZbFGMqPwgjQVorn9m
pak2rn57yZMXsA42YQDsQ5jCgq7S6P8k2KEvOVlsd5iJhrul+QIDAQABo1AwTjAd
BgNVHQ4EFgQU8yOYDb3qsjRp6pgrBKDQiGp2eQ0wHwYDVR0jBBgwFoAU8yOYDb3q
sjRp6pgrBKDQiGp2eQ0wDAYDVR0TAQH/BAIwADANBgkqhkiG9w0BAQsFAAOCAQEA
RYuBlpo81rOANcQ7qmihjDiUVRRiHGzr1ihAtc6UTJBRMy4ti9HkDWekXGqlXLyn
D1Wx0xgEqDC/aqFe/k4Zc4Hnv10PJgDprf1zGLwNVEq9JXhCSdvL+fANSvVY3vVu
ofVgeTSnHtiAKXDIhK9iaN21gZdr/6637LFw1/qraSjV2FJvTBecyS3kFzz+VFWD
N4DwueXfZa1sSMCB7tIztx9WrcEN/JmwKFuT89QLejc6ShqgoIQY2b7BBc1NwqEw
EfSBsl3S3ZrmZx7Xrl1yVh+x9nM2Tym/gdnYXM/yXfUZVSQjySMfzvrzGjMASMwL
qM9MnuJfKQFAmzsTFDPUaA==
-----END CERTIFICATE-----
`
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

test('the release signing import trusts the certificate for code signing only', (t) => {
  const { calls, result } = runImport(t)
  const trust = calls.filter((call) => call.args[0] === 'add-trusted-cert')
  assert.equal(trust.length, 1)
  assert.deepEqual(trust[0].args, [
    'add-trusted-cert', '-d', '-r', 'trustRoot', '-p', 'codeSign',
    '-k', result.keychainPath, result.certificatePath,
  ])
  // -k 指向 System.keychain 会把证书再装一份，同一个身份于是被 find-identity 列
  // 两次，预检那句「恰好一个」就判成歧义——2026-09-20 第四次正式发布红在这里。
  assert.equal(trust[0].args.includes('/Library/Keychains/System.keychain'), false)
  // 用户域那条授权在没有图形会话的 runner 上无人可确认，security 会一直挂着；
  // 管理员域以 root 执行即通过。这一条走 sudo 是这一步能跑完的前提。
  assert.equal(trust[0].options.privileged, true)
  // codeSign 以外的策略一概不碰。
  assert.equal(trust[0].args.includes('-p'), true)
  assert.equal(trust[0].args[trust[0].args.indexOf('-p') + 1], 'codeSign')
})

test('a certificate that is not a CA is trusted as a leaf, not as a root', (t) => {
  const { calls } = runImport(t, {
    overrides: { 'find-certificate': () => LEAF_CERTIFICATE_PEM },
  })
  const trust = calls.find((call) => call.args[0] === 'add-trusted-cert')
  // trustRoot 只能用在自签根上，对 CA:FALSE 的证书 security 会直接拒绝。轮换到
  // P-22 的新 profile（CA:FALSE）之后走的就是这一支。
  assert.equal(trust.args[trust.args.indexOf('-r') + 1], 'trustAsRoot')
})

test('an unparseable certificate stops before any trust setting is written', (t) => {
  const directory = temporaryDirectory(t)
  const calls = []
  assert.throws(() => importReleaseSigningIdentity({
    env: healthyEnvironment(),
    platform: 'darwin',
    statePath: path.join(directory, 'state.json'),
    runSecurity: (args) => {
      calls.push(args[0])
      if (args[0] === 'create-keychain') fs.writeFileSync(path.join(directory, 'release-signing.keychain-db'), '')
      if (args[0] === 'list-keychains' && args.length === 3) return ORIGINAL_SEARCH_LIST
      if (args[0] === 'find-certificate') return '-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n'
      return ''
    },
  }), /无法解析导出的签名证书/)
  assert.equal(calls.includes('add-trusted-cert'), false)
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

test('a failure after the search list was changed puts the search list back and drops the state file', (t) => {
  // 搜索列表停在一个已被删掉的 keychain 上，这台机器后面每一次 codesign 和
  // find-identity 都会解析到不存在的东西；状态文件留着，收尾步骤还会再失败一次。
  const directory = temporaryDirectory(t)
  const statePath = path.join(directory, 'state.json')
  const calls = []
  assert.throws(() => importReleaseSigningIdentity({
    env: healthyEnvironment(),
    platform: 'darwin',
    statePath,
    runSecurity: (args) => {
      calls.push(args)
      if (args[0] === 'add-trusted-cert') throw new Error('trust boom')
      if (args[0] === 'create-keychain') fs.writeFileSync(path.join(directory, 'release-signing.keychain-db'), '')
      if (args[0] === 'list-keychains' && args.length === 3) return ORIGINAL_SEARCH_LIST
      if (args[0] === 'find-certificate') return CERTIFICATE_PEM
      return ''
    },
  }), /trust boom/)
  const searchListWrites = calls.filter((args) => args[0] === 'list-keychains' && args.includes('-s'))
  assert.equal(searchListWrites.length, 2)
  assert.equal(calls.some((args) => args[0] === 'remove-trusted-cert'), false)
  assert.deepEqual(searchListWrites[1], [
    'list-keychains', '-d', 'user', '-s', '/Users/runner/Library/Keychains/login.keychain-db',
  ])
  assert.ok(calls.some((args) => args[0] === 'delete-keychain'))
  assert.equal(fs.existsSync(statePath), false)
  assert.equal(fs.existsSync(path.join(directory, 'release-signing.pem')), false)
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

test('the teardown restores the search list and deletes the keychain, and never waits on remove-trusted-cert', (t) => {
  const { result, statePath } = runImport(t)
  const calls = []
  releaseSigningKeychain({
    statePath,
    runSecurity: (args, options = {}) => {
      calls.push({ args, options })
      return ''
    },
  })
  // remove-trusted-cert 在 runner 上根本回不来（实测给 60 秒也挂着），而删掉
  // keychain 之后信任设置就没有作用对象了。删 keychain 本身就是撤销。
  assert.deepEqual(calls.map((call) => call.args[0]), ['list-keychains', 'delete-keychain'])
  assert.deepEqual(calls[0].args, [
    'list-keychains', '-d', 'user', '-s', '/Users/runner/Library/Keychains/login.keychain-db',
  ])
  assert.deepEqual(calls[1].args, ['delete-keychain', result.keychainPath])
  assert.equal(fs.existsSync(statePath), false)
})

test('the teardown treats an already-deleted keychain as done, not as a failure', (t) => {
  // 导入失败时自己就把 keychain 删了，而工作流里的收尾步骤是 if: always()。
  // 2026-09-20 第三次发布尝试就是这样让收尾也红了一条，把真正的失败原因盖住。
  const { statePath } = runImport(t)
  releaseSigningKeychain({
    statePath,
    runSecurity: (args) => {
      if (args[0] === 'delete-keychain') {
        throw new Error('security delete-keychain失败：security: SecKeychainDelete: The specified keychain could not be found.')
      }
      return ''
    },
  })
  assert.equal(fs.existsSync(statePath), false)
})

test('the teardown still reports a delete failure that is not a missing keychain', (t) => {
  const { statePath } = runImport(t)
  assert.throws(() => releaseSigningKeychain({
    statePath,
    runSecurity: (args) => {
      // 真实的失败同样带着 SecKeychainDelete 前缀，按前缀放过会把这一类一起咽掉。
      if (args[0] === 'delete-keychain') {
        throw new Error('security delete-keychain失败：security: SecKeychainDelete: A required authorization was denied.')
      }
      return ''
    },
  }), /authorization was denied/)
})

test('the teardown keeps going after one step fails and reports every failure', (t) => {
  const { statePath } = runImport(t)
  assert.throws(() => releaseSigningKeychain({
    statePath,
    runSecurity: (args) => {
      if (args[0] === 'list-keychains') throw new Error('list boom')
      if (args[0] === 'delete-keychain') throw new Error('delete boom')
      return ''
    },
  }), /list boom.*delete boom/s)
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
