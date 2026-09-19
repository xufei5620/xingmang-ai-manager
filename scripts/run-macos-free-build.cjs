const { randomBytes } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  normalizeUpdateBaseUrl,
  resolveEmptyReleaseOutputDirectory,
  resolveUpdateUrlForVersion,
} = require('./update-release-utils.cjs')
const { verifyFreeMacSigningIdentity } = require('./verify-macos-free-signing.cjs')
const { verifyMacosFreeArtifacts } = require('./verify-macos-free-artifacts.cjs')
const { createFreeMacSigningCertificate } = require('./create-macos-free-signing-certificate.cjs')
const { verifyEphemeralMacSigningIdentity } = require('./macos-ephemeral-signing.cjs')

const SECURITY_PATH = '/usr/bin/security'
const SECURITY_COMMAND_TIMEOUT_MS = 30_000

const BUILD_MODE_ENVIRONMENT_NAMES = new Set([
  'XINGMANG_RELEASE',
  'XINGMANG_MAC_FREE_RELEASE',
  'XINGMANG_LOCAL_BUILD',
  'XINGMANG_OUTPUT_DIR',
  'XINGMANG_MAC_CI_EPHEMERAL_SIGNING',
  'XINGMANG_MAC_SIGNING_SHA1',
  'XINGMANG_MAC_SIGNING_P12_PASSWORD',
  'XINGMANG_UPDATE_DEV',
  'XINGMANG_UPDATE_URL',
  // XINGMANG_UNSIGNED_RELEASE 残留会被 electron-builder.config.cjs 的互斥断言
  // 拦下，但那是下游偶然存在的兜底；XINGMANG_ACCELERATION_BUNDLE_DIR 残留没有
  // 任何断言拦，会让免费分发包悄悄带上私有加速资源。
  'XINGMANG_UNSIGNED_RELEASE',
  'XINGMANG_ACCELERATION_BUNDLE_DIR',
  'XINGMANG_SIGNING_PUBLISHER',
])

function normalizeFingerprint(value, byteLength = 32) {
  const input = String(value || '').trim()
  const plain = new RegExp(`^[A-Fa-f0-9]{${byteLength * 2}}$`)
  const colonSeparated = new RegExp(`^(?:[A-Fa-f0-9]{2}:){${byteLength - 1}}[A-Fa-f0-9]{2}$`)
  if (!plain.test(input) && !colonSeparated.test(input)) {
    const algorithm = byteLength === 32 ? 'SHA-256' : byteLength === 20 ? 'SHA-1' : `${byteLength * 8} 位`
    throw new Error(`签名证书必须提供有效的 ${algorithm} 指纹`)
  }
  return input.replaceAll(':', '').toUpperCase()
}

function defaultCommandRunner(spec) {
  const result = spawnSync(spec.executable, spec.argv, {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw new Error(`无法启动 ${spec.label}：${result.error.message}`)
  if (result.status !== 0) throw new Error(`${spec.label} 失败`)
}

function redactSecrets(text, secrets) {
  let redacted = String(text || '')
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, '***')
  }
  return redacted
}

function defaultCapturedCommand(executable, args, env, label, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env,
    input: options.stdin,
    shell: false,
    timeout: SECURITY_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  })
  const secrets = options.redactions || []
  if (result.error) throw new Error(`无法启动 ${label}：${result.error.message}`)
  if (result.status !== 0) {
    const reason = redactSecrets(result.stderr?.trim(), secrets) || '未知错误'
    throw new Error(`${label}失败：${reason}`)
  }
  return result.stdout || ''
}

/** Parses `security list-keychains` output into bare absolute paths. */
function parseKeychainSearchList(output) {
  return String(output || '')
    .split('\n')
    .map((line) => line.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0)
}

/**
 * Quotes one token for the `security -i` line parser, which understands double
 * quotes and backslash escapes. Control characters would split the line into a
 * second, unintended subcommand, so they are refused rather than escaped.
 */
function quoteSecurityArgument(value) {
  const token = String(value)
  if (/[\0\r\n]/.test(token)) throw new Error('security 子命令参数不能包含控制字符')
  return `"${token.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * Builds one `security` invocation. Passwords must never reach argv: any local
 * user can read a running process's full command line with `ps -axww`, which
 * on this path would hand them the temporary keychain password and the P12
 * password, and with them the signing private key. `options.secrets` marks the
 * argument values that carry one; such a subcommand is fed to `security -i` on
 * stdin instead, where only this process and the child can see it.
 */
function resolveMacosSecurityCommand(args, options = {}) {
  const command = args[0] || 'command'
  const secrets = (options.secrets || []).map((secret) => String(secret)).filter((secret) => secret.length > 0)
  const label = `security ${command}`
  if (secrets.length === 0) {
    return { executable: SECURITY_PATH, argv: args, label, stdin: undefined, redactions: [] }
  }
  for (const secret of secrets) {
    if (!args.some((argument) => String(argument) === secret)) {
      throw new Error('security 子命令声明的机密参数不在参数表中')
    }
  }
  return {
    executable: SECURITY_PATH,
    argv: ['-i'],
    label,
    stdin: `${args.map(quoteSecurityArgument).join(' ')}\n`,
    redactions: secrets,
  }
}

function createSanitizedEnvironment(environment, identityName, signingCertificateSha256) {
  const sanitized = { ...environment }
  for (const name of Object.keys(sanitized)) {
    if (BUILD_MODE_ENVIRONMENT_NAMES.has(name)
      || /^(?:APPLE|AZURE|CSC)_/.test(name)
      || /^WIN_CSC_/.test(name)) {
      delete sanitized[name]
    }
  }
  sanitized.CSC_NAME = identityName
  sanitized.XINGMANG_MAC_SIGNING_SHA256 = signingCertificateSha256
  return sanitized
}

function resolveFreeMacBuildOptions(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '..'))
  const packageVersion = options.packageVersion || require(path.join(projectRoot, 'package.json')).version
  const environment = options.env || process.env
  const platform = options.platform || process.platform

  if (platform !== 'darwin') throw new Error('macOS 免费分发只能在 macOS 上构建')
  if (environment.XINGMANG_RELEASE === '1') {
    throw new Error('XINGMANG_RELEASE=1 与 macOS 免费分发模式不能同时启用')
  }

  const identityName = String(environment.CSC_NAME || '').trim()
  if (!identityName) throw new Error('缺少 CSC_NAME：必须指定 macOS 免费发布签名身份')
  const signingCertificateSha256 = normalizeFingerprint(environment.XINGMANG_MAC_SIGNING_SHA256)
  let ephemeralSigning
  if (options.ephemeralSigning !== undefined) {
    if (!options.skipChecks) {
      throw new Error('CI 临时签名只能复用已完成的检查')
    }
    const identitySha1 = normalizeFingerprint(options.ephemeralSigning?.identitySha1, 20)
    const rawKeychainPath = String(options.ephemeralSigning?.keychainPath || '').trim()
    if (!rawKeychainPath || rawKeychainPath.includes('\0') || !path.isAbsolute(rawKeychainPath)) {
      throw new Error('CI 临时签名 keychain 必须是绝对路径')
    }
    ephemeralSigning = {
      identitySha1,
      keychainPath: path.resolve(rawKeychainPath),
    }
  }
  const expectedUpdateUrl = normalizeUpdateBaseUrl(
    environment.XINGMANG_UPDATE_URL?.trim() || resolveUpdateUrlForVersion(packageVersion),
  )
  const outputRequest = options.outputDirectory ?? environment.XINGMANG_OUTPUT_DIR ?? `release-free-${packageVersion}`
  const outputDirectory = resolveEmptyReleaseOutputDirectory(projectRoot, packageVersion, outputRequest)

  const npmCliPath = options.npmCliPath || environment.npm_execpath
  if (!npmCliPath && !options.skipChecks) {
    throw new Error('无法定位当前 npm CLI，请通过 npm run dist:mac:free 启动构建')
  }

  const electronBuilderCliPath = options.electronBuilderCliPath
    || path.join(projectRoot, 'node_modules', 'electron-builder', 'cli.js')
  if (!options.electronBuilderCliPath && !fs.existsSync(electronBuilderCliPath)) {
    throw new Error('无法定位已安装的 electron-builder CLI')
  }

  const baseEnvironment = createSanitizedEnvironment(
    environment,
    identityName,
    signingCertificateSha256,
  )
  const builderEnvironment = {
    ...baseEnvironment,
    XINGMANG_MAC_FREE_RELEASE: '1',
    XINGMANG_OUTPUT_DIR: outputDirectory,
    XINGMANG_UPDATE_URL: expectedUpdateUrl,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    ...(ephemeralSigning ? {
      XINGMANG_MAC_CI_EPHEMERAL_SIGNING: '1',
      XINGMANG_MAC_SIGNING_SHA1: ephemeralSigning.identitySha1,
      CSC_KEYCHAIN: ephemeralSigning.keychainPath,
      CSC_FOR_PULL_REQUEST: 'true',
    } : {}),
  }

  return {
    projectRoot,
    packageVersion,
    outputDirectory,
    identityName,
    signingCertificateSha256,
    ephemeralSigning,
    expectedUpdateUrl,
    npmCliPath,
    electronBuilderCliPath,
    baseEnvironment,
    builderEnvironment,
    childEnvironment: builderEnvironment,
    commandRunner: options.commandRunner || defaultCommandRunner,
    verifySigning: options.verifySigning || verifyFreeMacSigningIdentity,
    verifyArtifacts: options.verifyArtifacts || verifyMacosFreeArtifacts,
  }
}

/**
 * Takes ownership of the build output directory so a failed build can take its
 * own half-written artifacts with it. The recorded identity is re-checked
 * before anything is deleted: a build runs for minutes, and whatever sits at
 * that path when it ends may no longer be the directory this build created.
 * A caller that wants the failed output preserved creates an empty directory
 * itself and points XINGMANG_OUTPUT_DIR at it — this only ever removes a
 * directory it created.
 */
function claimReleaseOutputDirectory(outputDirectory) {
  let created = false
  try {
    fs.mkdirSync(outputDirectory)
    created = true
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const stats = fs.lstatSync(outputDirectory)
  return { created, dev: stats.dev, ino: stats.ino }
}

function discardClaimedOutputDirectory(outputDirectory, claim) {
  if (!claim.created) return false
  let stats
  try {
    stats = fs.lstatSync(outputDirectory)
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    return false
  }
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.dev !== claim.dev || stats.ino !== claim.ino) {
    return false
  }
  fs.rmSync(outputDirectory, { recursive: true, force: true })
  return true
}

async function runFreeMacBuild(options = {}) {
  const build = resolveFreeMacBuildOptions(options)
  await build.verifySigning({
    identityName: build.identityName,
    expectedFingerprint: build.signingCertificateSha256,
    env: build.baseEnvironment,
  })

  // The runner contract is "resolve on success, throw on failure": the default
  // runner turns a nonzero exit into an Error, so there is no return value to
  // inspect here.
  const run = async (label, argv, env) => {
    await build.commandRunner({
      label,
      executable: process.execPath,
      argv,
      cwd: build.projectRoot,
      env,
      shell: false,
    })
  }

  if (!options.skipChecks) {
    await run('TypeScript 类型检查', [build.npmCliPath, 'run', 'typecheck'], build.baseEnvironment)
    await run('全部测试', [build.npmCliPath, 'test'], build.baseEnvironment)
    await run('编译应用', [build.npmCliPath, 'run', 'compile'], build.baseEnvironment)
  }
  const outputClaim = claimReleaseOutputDirectory(build.outputDirectory)
  try {
    await run('构建 macOS 免费分发包', [
      build.electronBuilderCliPath,
      '--config', 'electron-builder.config.cjs',
      '--mac', 'dmg', 'zip',
      '--arm64', '--x64',
      '--publish', 'never',
    ], build.builderEnvironment)

    const artifacts = await build.verifyArtifacts({
      projectRoot: build.projectRoot,
      outputDirectory: build.outputDirectory,
      version: build.packageVersion,
      identityName: build.identityName,
      signingCertificateSha256: build.signingCertificateSha256,
      expectedUpdateUrl: build.expectedUpdateUrl,
      env: build.baseEnvironment,
    })
    return { ...artifacts, outputDirectory: build.outputDirectory }
  } catch (error) {
    // 下一次构建会被「输出目录不是空目录」直接拒掉，而在发布压力下手工
    // rm -rf 一个发布目录正是误删的高发场景，所以失败路径自己收尾。
    if (discardClaimedOutputDirectory(build.outputDirectory, outputClaim)) {
      throw new Error(
        `${error.message}；失败的构建输出已删除：${build.outputDirectory}`,
        { cause: error },
      )
    }
    throw new Error(
      `${error.message}；请确认其中没有需要保留的产物后删除该目录再重试：${build.outputDirectory}`,
      { cause: error },
    )
  }
}

async function runCiFreeMacBuild(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '..'))
  if ((options.platform || process.platform) !== 'darwin') {
    throw new Error('CI 临时 macOS 免费签名只能在 macOS 上运行')
  }
  const environment = options.env || process.env
  // The signing identity's private key sits in a keychain on the runner's
  // disk for the length of this build. That is only acceptable on a
  // single-tenant runner that is destroyed afterwards; a self-hosted or shared
  // runner lets a later job read it.
  const runnerEnvironment = String(environment.RUNNER_ENVIRONMENT || '').trim()
  if (runnerEnvironment && runnerEnvironment !== 'github-hosted') {
    throw new Error('CI 临时 macOS 免费签名只能在一次性托管 runner 上运行')
  }
  const nextEntropy = options.randomBytes || randomBytes
  const identityName = 'XingMang CI Free Update Identity'
  // Separate draws: deriving both passwords from one value collapses the
  // keychain password and the P12 password into a single secret, and the
  // output directory name is visible to anyone who can list the project root.
  const keychainPassword = `CiKeychain!${nextEntropy(16).toString('hex')}Aa1`
  const p12Password = `CiP12!${nextEntropy(16).toString('hex')}Aa1`
  const outputEntropy = nextEntropy(16).toString('hex')
  const temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-free-ci-')))
  const certificateDirectory = path.join(temporaryRoot, 'certificate')
  const keychainPath = path.join(temporaryRoot, 'ci-signing.keychain-db')
  const outputRequest = `release-free-ci-${process.pid}-${outputEntropy.slice(0, 12)}`
  const outputPath = path.join(projectRoot, outputRequest)
  const runSecurity = options.runSecurity || ((args, commandOptions = {}) => {
    const command = resolveMacosSecurityCommand(args, commandOptions)
    process.stdout.write(`[macOS CI signing] ${command.label}\n`)
    return defaultCapturedCommand(
      command.executable,
      command.argv,
      environment,
      command.label,
      { stdin: command.stdin, redactions: command.redactions },
    )
  })
  const createCertificate = options.createCertificate || createFreeMacSigningCertificate
  const certificateFingerprint = options.certificateFingerprint || ((certificatePath) => {
    const output = defaultCapturedCommand('/usr/bin/openssl', [
      'x509', '-in', certificatePath, '-noout', '-fingerprint', '-sha256',
    ], environment, 'OpenSSL 证书指纹读取')
    return normalizeFingerprint(output.split('=', 2)[1] || '')
  })
  const certificateSha1 = options.certificateSha1 || ((certificatePath) => {
    const output = defaultCapturedCommand('/usr/bin/openssl', [
      'x509', '-in', certificatePath, '-noout', '-fingerprint', '-sha1',
    ], environment, 'OpenSSL 证书 SHA-1 指纹读取')
    return normalizeFingerprint(output.split('=', 2)[1] || '', 20)
  })
  const verifyEphemeralSigning = options.verifyEphemeralSigning || verifyEphemeralMacSigningIdentity
  // P-20: this rehearsal used to hand the build a preflight that returned a
  // constant, which left the certificate policy checks — self-signature,
  // validity window, exclusive critical codeSigning EKU, private-key identity
  // agreeing with the certificate — as the one part of a release that CI never
  // executed. They run here against a real certificate and real security and
  // openssl output; only the trust filter is relaxed, for the reason given in
  // buildCodeSigningIdentityQuery.
  const verifySigningIdentity = options.verifySigning || verifyFreeMacSigningIdentity
  const runBuild = options.runBuild || runFreeMacBuild
  const removeDirectory = options.removeDirectory || ((directory) => fs.rmSync(directory, {
    recursive: true,
    force: true,
  }))
  let keychainCreated = false
  let originalSearchList = null
  let result
  let failure
  let released = false
  const cleanupErrors = []
  const attemptCleanup = (cleanup) => {
    try {
      cleanup()
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  const releaseResources = () => {
    if (released) return
    released = true
    if (originalSearchList && originalSearchList.length > 0) {
      attemptCleanup(() => runSecurity(['list-keychains', '-d', 'user', '-s', ...originalSearchList]))
    }
    if (keychainCreated) attemptCleanup(() => runSecurity(['delete-keychain', keychainPath]))
    attemptCleanup(() => removeDirectory(outputPath))
    attemptCleanup(() => removeDirectory(temporaryRoot))
  }
  // Without this, a cancelled CI job or a local Ctrl-C skips the `finally`
  // below and leaves the user-domain search list pointing at a keychain under
  // /var/folders that the system will reap. Every later `codesign` and
  // `security find-identity` on that machine then resolves against a keychain
  // that no longer exists.
  const signalHandle = options.signalHandle || process
  const terminationSignals = ['SIGINT', 'SIGTERM']
  const handleTerminationSignal = (signal) => {
    releaseResources()
    for (const name of terminationSignals) signalHandle.removeListener(name, handleTerminationSignal)
    signalHandle.kill(signalHandle.pid, signal)
  }
  for (const name of terminationSignals) signalHandle.on(name, handleTerminationSignal)

  try {
    const certificate = createCertificate({
      outputDirectory: certificateDirectory,
      commonName: identityName,
      password: p12Password,
      env: environment,
    })
    const certificatePath = certificate.certificatePath
    const fingerprint = normalizeFingerprint(certificateFingerprint(certificatePath))
    const identitySha1 = normalizeFingerprint(certificateSha1(certificatePath), 20)
    runSecurity(['create-keychain', '-p', keychainPassword, keychainPath], { secrets: [keychainPassword] })
    keychainCreated = true
    // The stdin-fed form reports failure through the same exit status, but this
    // is the one step whose silent failure would surface only much later, as a
    // confusing signing error. Confirm the keychain reached disk.
    if (!fs.existsSync(keychainPath)) throw new Error('创建临时签名 keychain 失败')
    runSecurity(['set-keychain-settings', '-lut', '21600', keychainPath])
    runSecurity(['unlock-keychain', '-p', keychainPassword, keychainPath], { secrets: [keychainPassword] })
    runSecurity([
      'import', certificate.p12Path,
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
    // codesign resolves a signing identity through the user keychain search
    // list; passing --keychain does not by itself make an isolated keychain
    // visible to it. The original list is captured first and restored during
    // cleanup, so the change never outlives this build. Nothing is written to
    // the admin domain, the system keychain, or Trust Settings.
    const currentSearchList = parseKeychainSearchList(runSecurity(['list-keychains', '-d', 'user']))
    // An unparseable or empty answer would turn the restore below into a bare
    // `list-keychains -d user -s`, which empties the search list and drops the
    // login keychain out of it for good. Refuse to touch what cannot be put back.
    if (currentSearchList.length === 0 || !currentSearchList.every((entry) => path.isAbsolute(entry))) {
      throw new Error('无法解析当前用户 keychain 搜索列表，已放弃修改以免留下无法恢复的状态')
    }
    originalSearchList = currentSearchList
    runSecurity(['list-keychains', '-d', 'user', '-s', keychainPath, ...originalSearchList])
    await verifyEphemeralSigning({
      platform: 'darwin',
      identitySha1,
      keychainPath,
      probePath: path.join(temporaryRoot, 'private-key-probe'),
      env: environment,
    })

    result = await runBuild({
      projectRoot,
      platform: 'darwin',
      env: {
        ...environment,
        CSC_NAME: identityName,
        XINGMANG_MAC_SIGNING_SHA256: fingerprint,
      },
      outputDirectory: outputRequest,
      skipChecks: true,
      ephemeralSigning: { identitySha1, keychainPath },
      verifySigning: (verifyOptions) => verifySigningIdentity({
        ...verifyOptions,
        trustedIdentitiesOnly: false,
      }),
    })
  } catch (error) {
    failure = error
  } finally {
    for (const name of terminationSignals) signalHandle.removeListener(name, handleTerminationSignal)
    releaseResources()
  }
  if (failure || cleanupErrors.length > 0) {
    const errors = [...(failure ? [failure] : []), ...cleanupErrors]
    if (errors.length === 1) throw errors[0]
    throw new AggregateError(errors, errors.map((error) => error.message).join('; '))
  }
  return { ...result, cleaned: true }
}

async function main() {
  try {
    if (process.argv.slice(2).includes('--ci-temporary-signing')) {
      await runCiFreeMacBuild()
      process.stdout.write('macOS 免费分发真实构建已通过临时签名验证，临时产物和签名材料已清理\n')
    } else {
      const result = await runFreeMacBuild()
      process.stdout.write(`macOS 免费分发产物已通过本地验证：${result.outputDirectory}\n`)
    }
  } catch (error) {
    process.stderr.write(`macOS 免费分发构建失败：${error.message}\n`)
    process.exitCode = 1
  }
}

if (require.main === module) main()

module.exports = {
  resolveMacosSecurityCommand,
  resolveFreeMacBuildOptions,
  runCiFreeMacBuild,
  runFreeMacBuild,
}
