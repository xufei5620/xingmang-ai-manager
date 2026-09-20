// 把发布签名身份（.p12 + 密码）导入 runner 上的一次性 keychain，构建结束后原样
// 撤销。只服务 .github/workflows/publish-release.yml 的 macOS 作业。
//
// 为什么不写成工作流里的一段 shell：
//   * 密码不能进 argv。任何本机用户 `ps -axww` 就能读到运行中进程的完整命令行，
//     那会同时交出 keychain 密码和 P12 密码，也就等于交出签名私钥。密码一律走
//     `security -i` 的 stdin（P-18 已经为本机构建做过这件事，这里复用同一个封装）。
//   * 用户 keychain 搜索列表是全局状态。构建失败、作业取消、runner 被回收都不能
//     让它停在指向一个已被删除的 keychain 上，所以原始列表写进状态文件，撤销那一
//     步照着它还原，而不是猜。
//
// The private key lands on the runner's disk for the length of the build, so
// this refuses to run anywhere but a single-tenant hosted runner that is
// destroyed afterwards: on a self-hosted or shared runner a later job could
// read it back out of the keychain file.
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { resolveMacosSecurityCommand } = require('./run-macos-free-build.cjs')

const SECURITY_COMMAND_TIMEOUT_MS = 30_000
// 6 小时：一次带加速线路的双架构构建要跑两遍 electron-builder，锁上就签不动了。
const KEYCHAIN_TIMEOUT_SECONDS = '21600'
const STATE_VERSION = 1

function fail(message) {
  throw new Error(message)
}

function redactSecrets(text, secrets) {
  let output = String(text || '')
  for (const secret of secrets) {
    if (secret) output = output.replaceAll(secret, '***')
  }
  return output
}

function defaultSecurityRunner(environment) {
  return (args, options = {}) => {
    const command = resolveMacosSecurityCommand(args, options)
    process.stdout.write(`[macOS 发布签名] ${command.label}\n`)
    const result = spawnSync(command.executable, command.argv, {
      encoding: 'utf8',
      env: environment,
      input: command.stdin,
      shell: false,
      // 用户域的 add-trusted-cert 在有图形会话的机器上会弹密码框。runner 上没有
      // 会话可弹，真弹了也没人点，所以宁可超时失败也不要把作业挂死到上限。
      timeout: SECURITY_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    })
    if (result.error) fail(`无法启动 ${command.label}：${result.error.message}`)
    if (result.status !== 0) {
      fail(`${command.label}失败：${redactSecrets(result.stderr?.trim(), command.redactions) || '未知错误'}`)
    }
    return result.stdout || ''
  }
}

function parseKeychainSearchList(output) {
  return String(output || '')
    .split('\n')
    .map((line) => line.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0)
}

function assertHostedRunner(environment) {
  const runnerEnvironment = String(environment.RUNNER_ENVIRONMENT || '').trim()
  if (runnerEnvironment && runnerEnvironment !== 'github-hosted') {
    fail('发布签名身份只能导入一次性托管 runner，私钥不能留在共享或自建 runner 上')
  }
}

function assertAbsolutePath(value, label) {
  const candidate = String(value || '').trim()
  if (!candidate || candidate.includes('\0') || !path.isAbsolute(candidate)) {
    fail(`${label}必须是绝对路径`)
  }
  return candidate
}

function readRequiredSecret(environment, name) {
  const value = String(environment[name] || '').trim()
  if (!value) fail(`release 环境缺少 secret：${name}（见 docs/RELEASING.md 的「CI 发布」一节）`)
  return value
}

function decodeP12(base64Text) {
  const compact = base64Text.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) fail('XINGMANG_MAC_SIGNING_P12_BASE64 不是有效的 base64')
  const bytes = Buffer.from(compact, 'base64')
  if (bytes.length === 0) fail('XINGMANG_MAC_SIGNING_P12_BASE64 解出来是空的')
  return bytes
}

/** `rm -P` 的等价物：先覆盖再删，免得删除后的块还留在 runner 磁盘上。 */
function shredFile(filePath) {
  try {
    const size = fs.statSync(filePath).size
    if (size > 0) fs.writeFileSync(filePath, randomBytes(size))
  } catch {
    // 覆盖失败不能挡住删除本身。
  }
  fs.rmSync(filePath, { force: true })
}

function writeState(statePath, state) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}

function readState(statePath) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  } catch {
    fail(`无法读取签名状态文件：${statePath}`)
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== STATE_VERSION) {
    fail('签名状态文件格式不正确，拒绝据此还原 keychain 搜索列表')
  }
  if (!Array.isArray(parsed.originalSearchList) || parsed.originalSearchList.length === 0
    || !parsed.originalSearchList.every((entry) => typeof entry === 'string' && path.isAbsolute(entry))) {
    fail('签名状态文件里的原始 keychain 搜索列表无效，拒绝据此还原')
  }
  return parsed
}

function importReleaseSigningIdentity(options = {}) {
  const environment = options.env || process.env
  const platform = options.platform || process.platform
  if (platform !== 'darwin') fail('发布签名身份只能在 macOS 上导入')
  assertHostedRunner(environment)

  const statePath = assertAbsolutePath(options.statePath, '签名状态文件路径')
  const workingDirectory = assertAbsolutePath(
    options.workingDirectory || path.dirname(statePath),
    '签名临时目录',
  )
  const runSecurity = options.runSecurity || defaultSecurityRunner(environment)
  const nextEntropy = options.randomBytes || randomBytes

  const identityName = readRequiredSecret(environment, 'CSC_NAME')
  if (/[\0\r\n]/.test(identityName)) fail('CSC_NAME 不能包含控制字符')
  const p12Password = readRequiredSecret(environment, 'XINGMANG_MAC_SIGNING_P12_PASSWORD')
  const p12Bytes = decodeP12(readRequiredSecret(environment, 'XINGMANG_MAC_SIGNING_P12_BASE64'))
  // 指纹这里只要求存在：它的值由 dist:mac:free 的签名预检与产物校验去核对，
  // 并且还要跟 scripts/macos-published-signing-identity.cjs 的台账对上。
  readRequiredSecret(environment, 'XINGMANG_MAC_SIGNING_SHA256')

  const keychainPath = path.join(workingDirectory, 'release-signing.keychain-db')
  const certificatePath = path.join(workingDirectory, 'release-signing.pem')
  const p12Path = path.join(workingDirectory, 'release-signing.p12')
  const keychainPassword = `ReleaseKeychain!${nextEntropy(16).toString('hex')}Aa1`

  fs.writeFileSync(p12Path, p12Bytes, { mode: 0o600 })
  let keychainCreated = false
  try {
    runSecurity(['create-keychain', '-p', keychainPassword, keychainPath], { secrets: [keychainPassword] })
    keychainCreated = true
    // stdin 形式的失败同样反映在退出码上，但这一步一旦静默失败，报出来的会是
    // 很久以后一个看不懂的签名错误，所以确认文件真的落盘了。
    if (!fs.existsSync(keychainPath)) fail('创建发布签名 keychain 失败')
    runSecurity(['set-keychain-settings', '-lut', KEYCHAIN_TIMEOUT_SECONDS, keychainPath])
    runSecurity(['unlock-keychain', '-p', keychainPassword, keychainPath], { secrets: [keychainPassword] })
    runSecurity([
      'import', p12Path,
      '-k', keychainPath,
      '-f', 'pkcs12',
      '-P', p12Password,
      '-T', '/usr/bin/codesign',
    ], { secrets: [p12Password] })
    runSecurity([
      'set-key-partition-list',
      '-S', 'apple-tool:,apple:,codesign:',
      '-s', '-k', keychainPassword,
      keychainPath,
    ], { secrets: [keychainPassword] })

    // codesign 通过用户 keychain 搜索列表解析签名身份，只传 --keychain 不足以让
    // 它看见一个隔离 keychain。原始列表先记下来，撤销那一步照着还原。
    const originalSearchList = parseKeychainSearchList(runSecurity(['list-keychains', '-d', 'user']))
    if (originalSearchList.length === 0 || !originalSearchList.every((entry) => path.isAbsolute(entry))) {
      fail('无法解析当前用户 keychain 搜索列表，已放弃修改以免留下无法恢复的状态')
    }
    runSecurity(['list-keychains', '-d', 'user', '-s', keychainPath, ...originalSearchList])
    writeState(statePath, {
      version: STATE_VERSION,
      keychainPath,
      certificatePath,
      originalSearchList,
      trusted: false,
    })

    // 发布签名预检要求 `find-identity -v -p codesigning` 能列出这个身份，而 -v
    // 只保留通过代码签名策略评估的证书。发布 Mac 上这条成立是因为发布者手工把
    // 证书标成了代码签名可信（MACOS_FREE_DISTRIBUTION.md 第 1 步）；runner 上没有
    // 那份信任设置，所以这里在**用户域**、**只针对 codeSign 策略**补一条，撤销时
    // 删掉。不碰管理员域、不碰系统 keychain、不用 sudo。
    const certificatePem = runSecurity(['find-certificate', '-c', identityName, '-p', keychainPath])
    if (!certificatePem.includes('BEGIN CERTIFICATE')) fail('导入后在 keychain 里找不到 CSC_NAME 对应的证书')
    fs.writeFileSync(certificatePath, certificatePem, { mode: 0o600 })
    runSecurity(['add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', '-k', keychainPath, certificatePath])
    writeState(statePath, {
      version: STATE_VERSION,
      keychainPath,
      certificatePath,
      originalSearchList,
      trusted: true,
    })
    return { identityName, keychainPath, certificatePath, statePath }
  } catch (error) {
    if (keychainCreated) {
      try {
        runSecurity(['delete-keychain', keychainPath])
      } catch {
        // 原始失败更重要，收尾失败不覆盖它。
      }
    }
    throw error
  } finally {
    shredFile(p12Path)
  }
}

function releaseSigningKeychain(options = {}) {
  const environment = options.env || process.env
  const runSecurity = options.runSecurity || defaultSecurityRunner(environment)
  const statePath = assertAbsolutePath(options.statePath, '签名状态文件路径')
  const state = readState(statePath)
  const failures = []
  const attempt = (action) => {
    try {
      action()
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  // 顺序要紧：先撤信任，再还原搜索列表，最后才删 keychain。反过来的话
  // remove-trusted-cert 会对着一个已经不存在的 keychain 报错。
  if (state.trusted && state.certificatePath) {
    attempt(() => runSecurity(['remove-trusted-cert', state.certificatePath]))
  }
  attempt(() => runSecurity(['list-keychains', '-d', 'user', '-s', ...state.originalSearchList]))
  attempt(() => runSecurity(['delete-keychain', state.keychainPath]))
  if (state.certificatePath) attempt(() => fs.rmSync(state.certificatePath, { force: true }))
  attempt(() => fs.rmSync(statePath, { force: true }))
  if (failures.length > 0) {
    throw new Error(`撤销发布签名 keychain 时有步骤失败：${failures.join('；')}`)
  }
  return { keychainPath: state.keychainPath }
}

function parseArguments(argv = []) {
  let mode
  let statePath
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--import' || token === '--release') {
      if (mode) fail('--import 与 --release 只能选一个')
      mode = token.slice(2)
      continue
    }
    if (token === '--state') {
      statePath = argv[index + 1]
      index += 1
      continue
    }
    fail(`无法识别的参数：${token}`)
  }
  if (!mode) fail('必须指定 --import 或 --release')
  if (!statePath) fail('必须用 --state 指定签名状态文件路径')
  return { mode, statePath }
}

function main() {
  const args = parseArguments(process.argv.slice(2))
  if (args.mode === 'import') {
    const result = importReleaseSigningIdentity({ statePath: path.resolve(args.statePath) })
    process.stdout.write(`发布签名身份已导入一次性 keychain：${result.identityName}\n`)
    return
  }
  releaseSigningKeychain({ statePath: path.resolve(args.statePath) })
  process.stdout.write('发布签名 keychain 与信任设置已撤销\n')
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`macOS 发布签名 keychain 处理失败：${error.message}`)
    process.exitCode = 1
  }
}

module.exports = {
  importReleaseSigningIdentity,
  parseArguments,
  parseKeychainSearchList,
  releaseSigningKeychain,
}
