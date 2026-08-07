const { randomBytes } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const {
  DEFAULT_UPDATE_URL,
  normalizeUpdateBaseUrl,
  resolveEmptyReleaseOutputDirectory,
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

function defaultCapturedCommand(executable, args, env, label) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env,
    shell: false,
    timeout: SECURITY_COMMAND_TIMEOUT_MS,
    windowsHide: true,
  })
  if (result.error) throw new Error(`无法启动 ${label}：${result.error.message}`)
  if (result.status !== 0) throw new Error(`${label}失败：${result.stderr?.trim() || '未知错误'}`)
  return result.stdout || ''
}

/** Parses `security list-keychains` output into bare absolute paths. */
function parseKeychainSearchList(output) {
  return String(output || '')
    .split('\n')
    .map((line) => line.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0)
}

function resolveMacosSecurityCommand(args) {
  const command = args[0] || 'command'
  return {
    executable: SECURITY_PATH,
    argv: args,
    label: `security ${command}`,
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
    environment.XINGMANG_UPDATE_URL?.trim() || DEFAULT_UPDATE_URL,
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

async function runFreeMacBuild(options = {}) {
  const build = resolveFreeMacBuildOptions(options)
  await build.verifySigning({
    identityName: build.identityName,
    expectedFingerprint: build.signingCertificateSha256,
    env: build.baseEnvironment,
  })

  const run = async (label, argv, env) => {
    const result = await build.commandRunner({
      label,
      executable: process.execPath,
      argv,
      cwd: build.projectRoot,
      env,
      shell: false,
    })
    if (result && result.status !== undefined && result.status !== 0) {
      throw new Error(`${label} 失败`)
    }
  }

  if (!options.skipChecks) {
    await run('TypeScript 类型检查', [build.npmCliPath, 'run', 'typecheck'], build.baseEnvironment)
    await run('全部测试', [build.npmCliPath, 'test'], build.baseEnvironment)
    await run('编译应用', [build.npmCliPath, 'run', 'compile'], build.baseEnvironment)
  }
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
}

async function runCiFreeMacBuild(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || path.join(__dirname, '..'))
  if ((options.platform || process.platform) !== 'darwin') {
    throw new Error('CI 临时 macOS 免费签名只能在 macOS 上运行')
  }
  const environment = options.env || process.env
  const entropy = (options.randomBytes || randomBytes)(16).toString('hex')
  const identityName = 'XingMang CI Free Update Identity'
  const keychainPassword = `CiKeychain!${entropy}Aa1`
  const p12Password = `CiP12!${entropy}Aa1`
  const temporaryRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-free-ci-')))
  const certificateDirectory = path.join(temporaryRoot, 'certificate')
  const keychainPath = path.join(temporaryRoot, 'ci-signing.keychain-db')
  const outputRequest = `release-free-ci-${process.pid}-${entropy.slice(0, 12)}`
  const outputPath = path.join(projectRoot, outputRequest)
  const runSecurity = options.runSecurity || ((args, commandOptions = {}) => {
    const command = resolveMacosSecurityCommand(args, commandOptions)
    process.stdout.write(`[macOS CI signing] ${command.label}\n`)
    return defaultCapturedCommand(
      command.executable,
      command.argv,
      environment,
      command.label,
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
  const runBuild = options.runBuild || runFreeMacBuild
  const removeDirectory = options.removeDirectory || ((directory) => fs.rmSync(directory, {
    recursive: true,
    force: true,
  }))
  let keychainCreated = false
  let originalSearchList = null
  let result
  let failure
  const cleanupErrors = []

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
    runSecurity(['create-keychain', '-p', keychainPassword, keychainPath])
    keychainCreated = true
    runSecurity(['set-keychain-settings', '-lut', '21600', keychainPath])
    runSecurity(['unlock-keychain', '-p', keychainPassword, keychainPath])
    runSecurity([
      'import', certificate.p12Path,
      '-k', keychainPath,
      '-f', 'pkcs12',
      '-P', p12Password,
      '-T', '/usr/bin/codesign',
    ])
    runSecurity([
      'set-key-partition-list',
      '-S', 'apple-tool:,apple:,codesign:',
      '-s', '-k', keychainPassword,
      keychainPath,
    ])
    // codesign resolves a signing identity through the user keychain search
    // list; passing --keychain does not by itself make an isolated keychain
    // visible to it. The original list is captured first and restored during
    // cleanup, so the change never outlives this build. Nothing is written to
    // the admin domain, the system keychain, or Trust Settings.
    originalSearchList = parseKeychainSearchList(runSecurity(['list-keychains', '-d', 'user']))
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
      verifySigning: () => ({ identityName, fingerprint }),
    })
  } catch (error) {
    failure = error
  } finally {
    const attemptCleanup = (cleanup) => {
      try {
        cleanup()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (originalSearchList) {
      attemptCleanup(() => runSecurity(['list-keychains', '-d', 'user', '-s', ...originalSearchList]))
    }
    if (keychainCreated) attemptCleanup(() => runSecurity(['delete-keychain', keychainPath]))
    attemptCleanup(() => removeDirectory(outputPath))
    attemptCleanup(() => removeDirectory(temporaryRoot))
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
