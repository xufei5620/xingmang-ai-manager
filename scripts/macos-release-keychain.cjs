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
const { X509Certificate, randomBytes } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { resolveMacosSecurityCommand } = require('./run-macos-free-build.cjs')

const SUDO_PATH = '/usr/bin/sudo'
const SYSTEM_KEYCHAIN_PATH = '/Library/Keychains/System.keychain'
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
    // 提权只用在信任设置那两步，它们没有机密参数。真有机密时 argv 会换成
    // `security -i` 的 stdin 形式，套上 sudo 就不再是同一条命令了，所以直接拒绝。
    if (options.privileged && command.stdin) fail('提权执行的 security 子命令不能携带机密参数')
    const executable = options.privileged ? SUDO_PATH : command.executable
    const argv = options.privileged ? ['-n', command.executable, ...command.argv] : command.argv
    process.stdout.write(`[macOS 发布签名] ${options.privileged ? 'sudo ' : ''}${command.label}\n`)
    const result = spawnSync(executable, argv, {
      encoding: 'utf8',
      env: environment,
      input: command.stdin,
      shell: false,
      // 信任设置这两步要是还需要有人确认，runner 上没有会话可确认，就会一直挂着。
      // 宁可超时失败也不要把作业挂死到上限。
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

/**
 * `security` reports a wrong passphrase, a .p12 that was exported without one,
 * and a base64 blob that lost bytes in transit with the same one-line message,
 * and nobody on the runner can tell them apart without the secrets themselves.
 * Naming what to check turns that line into something the release operator can
 * act on — 2026-09-20 it cost a whole approval round to work out by hand.
 */
function describeImportFailure(message) {
  const text = String(message)
  if (!/passphrase|password/i.test(text)) return text
  return [
    text,
    '这一句几乎总是「.p12 与 XINGMANG_MAC_SIGNING_P12_PASSWORD 对不上」，而不是 .p12 本身坏了。按顺序查三件事：',
    '1. 填 secret 时是不是把密码连引号一起粘进去了，或者末尾多了空格；',
    '2. 导出 .p12 时设的密码与填进 secret 的是不是同一个（导出时密码留空，同样会报这一句）；',
    '3. 在发布 Mac 上跑 `openssl pkcs12 -in <你的.p12> -nokeys -noout`，它会提示输密码；能过就说明密码没错，问题出在 secret 存的值上。',
  ].join('\n')
}

/**
 * `trustRoot` 只能用在自签根证书上，`trustAsRoot` 用在别的证书上；用错那一个
 * security 会直接拒绝。当前发布的那张证书是 CA:TRUE 的自签根（台账见
 * scripts/macos-published-signing-identity.cjs），但轮换之后的证书按 P-22 是
 * CA:FALSE，所以这里按 basicConstraints 自己判，而不是写死一个。
 */
function resolveTrustSettingResult(certificatePem) {
  try {
    return new X509Certificate(certificatePem).ca ? 'trustRoot' : 'trustAsRoot'
  } catch {
    fail('无法解析导出的签名证书，拒绝据此写入信任设置')
  }
}

function trustCertificateForCodeSigning(runSecurity, certificatePath, certificatePem) {
  runSecurity([
    'add-trusted-cert',
    '-d',
    '-r', resolveTrustSettingResult(certificatePem),
    '-p', 'codeSign',
    '-k', SYSTEM_KEYCHAIN_PATH,
    certificatePath,
  ], { privileged: true })
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
  let restoreSearchList = null
  let trustApplied = false
  try {
    runSecurity(['create-keychain', '-p', keychainPassword, keychainPath], { secrets: [keychainPassword] })
    keychainCreated = true
    // stdin 形式的失败同样反映在退出码上，但这一步一旦静默失败，报出来的会是
    // 很久以后一个看不懂的签名错误，所以确认文件真的落盘了。
    if (!fs.existsSync(keychainPath)) fail('创建发布签名 keychain 失败')
    runSecurity(['set-keychain-settings', '-lut', KEYCHAIN_TIMEOUT_SECONDS, keychainPath])
    runSecurity(['unlock-keychain', '-p', keychainPassword, keychainPath], { secrets: [keychainPassword] })
    try {
      runSecurity([
        'import', p12Path,
        '-k', keychainPath,
        '-f', 'pkcs12',
        '-P', p12Password,
        '-T', '/usr/bin/codesign',
      ], { secrets: [p12Password] })
    } catch (error) {
      fail(describeImportFailure(error instanceof Error ? error.message : error))
    }
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
    restoreSearchList = originalSearchList
    writeState(statePath, {
      version: STATE_VERSION,
      keychainPath,
      certificatePath,
      originalSearchList,
      trusted: false,
    })

    // 发布签名预检和 electron-builder 都要求 `find-identity -v -p codesigning` 能
    // 列出这个身份，而 -v 只保留通过代码签名策略评估的证书。发布 Mac 上这条成立是
    // 因为发布者手工把证书标成了代码签名可信（MACOS_FREE_DISTRIBUTION.md 第 1 步）；
    // runner 上没有那份信任设置，所以这里补一条，只针对 codeSign 策略，撤销时删掉。
    //
    // 2026-09-20 第三次正式发布尝试红在这一步：写**用户域**的信任设置要过
    // com.apple.trust-settings.user 这条授权，规则是「本会话用户或管理员认证」，
    // runner 上没有图形会话可以弹框确认，security 就一直挂着，直到撞上 30 秒超时。
    // 管理员域走的是另一条授权，以 root 执行即通过，所以改成 sudo + 管理员域。
    // runner 是一次性托管机（上面 assertHostedRunner 已经拦死了别的情况），构建完
    // 随即销毁，私钥本来就落在它的磁盘上，这一条信任设置不扩大任何已有风险。
    const certificatePem = runSecurity(['find-certificate', '-c', identityName, '-p', keychainPath])
    if (!certificatePem.includes('BEGIN CERTIFICATE')) fail('导入后在 keychain 里找不到 CSC_NAME 对应的证书')
    fs.writeFileSync(certificatePath, certificatePem, { mode: 0o600 })
    trustCertificateForCodeSigning(runSecurity, certificatePath, certificatePem)
    trustApplied = true
    writeState(statePath, {
      version: STATE_VERSION,
      keychainPath,
      certificatePath,
      originalSearchList,
      trusted: true,
    })
    return { identityName, keychainPath, certificatePath, statePath }
  } catch (error) {
    // 这里把自己动过的东西全部放回去，而不是只删 keychain：搜索列表要是停在一个
    // 已被删掉的 keychain 上，这台机器后面每一次 codesign 与 find-identity 都会解析
    // 到不存在的东西。放回去之后状态文件也删掉，工作流那条 `if: always()` 的收尾
    // 就没有东西可做，不会再拿一条二次失败盖住真正的原因。
    const undo = (action) => {
      try {
        action()
      } catch {
        // 原始失败更重要，收尾失败不覆盖它。
      }
    }
    // 证书的公开部分留在系统 keychain 里不算残留（runner 随即销毁，里面本来就没有
    // 秘密），要撤掉的是那条信任设置。
    if (trustApplied) undo(() => runSecurity(['remove-trusted-cert', '-d', certificatePath], { privileged: true }))
    if (restoreSearchList) undo(() => runSecurity(['list-keychains', '-d', 'user', '-s', ...restoreSearchList]))
    if (keychainCreated) undo(() => deleteKeychainIfPresent(runSecurity, keychainPath))
    undo(() => fs.rmSync(certificatePath, { force: true }))
    undo(() => fs.rmSync(statePath, { force: true }))
    throw error
  } finally {
    shredFile(p12Path)
  }
}

/**
 * 导入那一步失败时会先自己删掉 keychain，收尾步骤在工作流里是 `if: always()`，
 * 于是对着一个已经不存在的 keychain 再删一次、报「could not be found」、把整个
 * 作业的退出码盖成 1——2026-09-20 的第三次发布尝试就同时红了这两步，真正的失败
 * 原因被第二条盖住了。删一个已经不在的东西就是这一步想要的结果，不是失败。
 */
function deleteKeychainIfPresent(runSecurity, keychainPath) {
  try {
    runSecurity(['delete-keychain', keychainPath])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/could not be found|SecKeychainDelete/i.test(message)) throw error
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
    attempt(() => runSecurity(['remove-trusted-cert', '-d', state.certificatePath], { privileged: true }))
  }
  attempt(() => runSecurity(['list-keychains', '-d', 'user', '-s', ...state.originalSearchList]))
  attempt(() => deleteKeychainIfPresent(runSecurity, state.keychainPath))
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
  describeImportFailure,
  importReleaseSigningIdentity,
  parseArguments,
  parseKeychainSearchList,
  releaseSigningKeychain,
}
