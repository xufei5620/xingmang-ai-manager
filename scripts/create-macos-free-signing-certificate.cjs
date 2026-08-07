const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const CERTIFICATE_BASENAME = 'xingmang-macos-free-signing'
const VALIDITY_DAYS = 7300
const OPENSSL_PATH = '/usr/bin/openssl'
const MAX_COMMON_NAME_LENGTH = 64
const MIN_P12_PASSWORD_LENGTH = 20
const MAX_P12_PASSWORD_LENGTH = 256

function fail(message) {
  throw new Error(message)
}

function lstatIfPresent(filePath) {
  try {
    return fs.lstatSync(filePath)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function assertNoSymlinkComponents(targetPath) {
  const parsed = path.parse(targetPath)
  let current = parsed.root
  for (const component of targetPath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    const stat = lstatIfPresent(current)
    if (!stat) break
    if (stat.isSymbolicLink()) fail('证书输出路径不能包含符号链接')
  }
}

function resolveDedicatedOutputDirectory(rawOutputDirectory) {
  if (typeof rawOutputDirectory !== 'string' || rawOutputDirectory.trim() === '') {
    fail('必须提供专用输出目录')
  }
  const trimmed = rawOutputDirectory.trim()
  const directory = path.resolve(trimmed)
  if (trimmed === '.' || trimmed === '..' || directory === path.parse(directory).root ||
    directory === process.cwd() || directory === os.homedir()) {
    fail('证书输出必须是专用输出目录，不能使用当前目录、主目录或文件系统根目录')
  }
  assertNoSymlinkComponents(directory)
  const stat = lstatIfPresent(directory)
  if (stat) {
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('证书输出必须是非链接的专用输出目录')
  }
  return directory
}

function normalizeCommonName(commonName) {
  if (typeof commonName !== 'string') fail('必须提供证书名称')
  const normalized = commonName.trim()
  if (normalized.length === 0 || [...normalized].length > MAX_COMMON_NAME_LENGTH ||
    !/^[\p{L}\p{N} ._()'&-]+$/u.test(normalized)) {
    fail('证书名称必须是 1 至 64 个安全字符，且不能包含 RDN 分隔符或控制字符')
  }
  return normalized
}

function validatePassword(password) {
  if (typeof password !== 'string') fail('必须提供 P12 密码')
  const characterClasses = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9\s]/]
    .filter((pattern) => pattern.test(password)).length
  if (password.length < MIN_P12_PASSWORD_LENGTH || password.length > MAX_P12_PASSWORD_LENGTH ||
    !/^[\x20-\x7E]+$/.test(password) || /^\s+$/.test(password) ||
    new Set(password).size === 1 || characterClasses < 3) {
    fail(`P12 密码必须是 ${MIN_P12_PASSWORD_LENGTH} 至 ${MAX_P12_PASSWORD_LENGTH} 个可打印 ASCII 字符，并至少包含小写字母、大写字母、数字、符号中的三类；不能全为空白或仅重复同一字符`)
  }
}

function defaultRunOpenSsl(args, options = {}) {
  const run = options.spawnSync || spawnSync
  const result = run(OPENSSL_PATH, args, {
    encoding: 'utf8',
    env: options.env || process.env,
    shell: false,
    windowsHide: true,
  })
  if (result.error) fail(`无法运行 OpenSSL：${result.error.message}`)
  if (result.status !== 0) fail(`OpenSSL 命令失败：${result.stderr?.trim() || '未知错误'}`)
  return result.stdout
}

function assertDirectoryIdentity(directory, expected) {
  assertNoSymlinkComponents(directory)
  const stat = lstatIfPresent(directory)
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() ||
    stat.dev !== expected.dev || stat.ino !== expected.ino) {
    fail('证书输出目录在生成期间发生变化，拒绝发布密钥材料')
  }
}

function publishFileExclusive(sourcePath, destinationPath, mode) {
  let descriptor
  let createdStat
  try {
    descriptor = fs.openSync(
      destinationPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      mode,
    )
    createdStat = fs.fstatSync(descriptor)
    fs.writeFileSync(descriptor, fs.readFileSync(sourcePath))
    fs.fchmodSync(descriptor, mode)
    return { dev: createdStat.dev, ino: createdStat.ino }
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor)
      descriptor = undefined
      const current = lstatIfPresent(destinationPath)
      if (current && createdStat && current.dev === createdStat.dev && current.ino === createdStat.ino) {
        fs.unlinkSync(destinationPath)
      }
    }
    if (error.code === 'EEXIST' || error.code === 'ELOOP') {
      fail('拒绝覆盖生成期间出现的 macOS 签名密钥材料')
    }
    throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
}

function removePublishedFile(filePath, expected) {
  const current = lstatIfPresent(filePath)
  if (current && current.dev === expected.dev && current.ino === expected.ino) fs.unlinkSync(filePath)
}

function createFreeMacSigningCertificate(options = {}) {
  const directory = resolveDedicatedOutputDirectory(options.outputDirectory)
  const commonName = normalizeCommonName(options.commonName)
  validatePassword(options.password)
  const password = options.password
  const environment = options.env || process.env
  const runOpenSsl = options.runOpenSsl || ((args, commandOptions) => defaultRunOpenSsl(args, {
    ...commandOptions,
    spawnSync: options.spawnSync,
  }))

  const existingDirectory = lstatIfPresent(directory)
  if (existingDirectory) {
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : existingDirectory.uid
    if (existingDirectory.uid !== currentUid || (existingDirectory.mode & 0o022) !== 0) {
      fail('已存在的证书输出目录权限不安全：必须由当前用户所有，且不能允许组或其他用户写入')
    }
  }
  const certificatePath = path.join(directory, `${CERTIFICATE_BASENAME}.cer`)
  const p12Path = path.join(directory, `${CERTIFICATE_BASENAME}.p12`)
  const keyMaterialNames = [certificatePath, p12Path, path.join(directory, `${CERTIFICATE_BASENAME}.key`)]
  if (keyMaterialNames.some((filePath) => lstatIfPresent(filePath))) {
    fail('拒绝覆盖已存在的 macOS 签名密钥材料')
  }
  if (existingDirectory && fs.readdirSync(directory).length !== 0) {
    fail('证书输出必须是空的专用输出目录')
  }

  if (!existingDirectory) {
    const parent = path.dirname(directory)
    const parentStat = lstatIfPresent(parent)
    if (!parentStat || !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      fail('证书输出目录的直接父目录必须已存在且不能是符号链接')
    }
    fs.mkdirSync(directory, { mode: 0o700 })
  }
  const directoryIdentity = fs.lstatSync(directory)
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-free-signing-'), { encoding: 'utf8' })
  const temporaryKeyPath = path.join(temporaryDirectory, 'signing-key.pem')
  const temporaryCertificatePath = path.join(temporaryDirectory, 'signing-certificate.pem')
  const temporaryP12Path = path.join(temporaryDirectory, 'signing-identity.p12')
  const passwordEnvironment = { ...environment, XINGMANG_MAC_SIGNING_P12_PASSWORD: password }
  const publishedFiles = []

  try {
    runOpenSsl([
      'req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', String(VALIDITY_DAYS),
      '-utf8', '-subj', `/CN=${commonName}`,
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext', 'keyUsage=critical,digitalSignature,keyCertSign',
      '-addext', 'extendedKeyUsage=critical,codeSigning',
      '-keyout', temporaryKeyPath,
      '-out', temporaryCertificatePath,
      '-passout', 'env:XINGMANG_MAC_SIGNING_P12_PASSWORD',
    ], { env: passwordEnvironment })
    runOpenSsl([
      'pkcs12', '-export', '-inkey', temporaryKeyPath, '-in', temporaryCertificatePath,
      '-out', temporaryP12Path, '-name', commonName, '-descert',
      '-passin', 'env:XINGMANG_MAC_SIGNING_P12_PASSWORD',
      '-passout', 'env:XINGMANG_MAC_SIGNING_P12_PASSWORD',
    ], { env: passwordEnvironment })
    assertDirectoryIdentity(directory, directoryIdentity)
    publishedFiles.push([certificatePath, publishFileExclusive(temporaryCertificatePath, certificatePath, 0o644)])
    assertDirectoryIdentity(directory, directoryIdentity)
    publishedFiles.push([p12Path, publishFileExclusive(temporaryP12Path, p12Path, 0o600)])
  } catch (error) {
    for (const [filePath, stat] of publishedFiles.reverse()) removePublishedFile(filePath, stat)
    throw error
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }

  return { certificatePath, p12Path }
}

function main() {
  const result = createFreeMacSigningCertificate({
    outputDirectory: process.env.XINGMANG_MAC_SIGNING_OUTPUT_DIR,
    commonName: process.env.CSC_NAME,
    password: process.env.XINGMANG_MAC_SIGNING_P12_PASSWORD,
  })
  console.log(`已创建加密 P12：${result.p12Path}`)
  console.log(`已创建公开证书：${result.certificatePath}`)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`创建 macOS 免费签名证书失败：${error.message}`)
    process.exitCode = 1
  }
}

module.exports = {
  CERTIFICATE_BASENAME,
  MAX_COMMON_NAME_LENGTH,
  MAX_P12_PASSWORD_LENGTH,
  MIN_P12_PASSWORD_LENGTH,
  OPENSSL_PATH,
  VALIDITY_DAYS,
  createFreeMacSigningCertificate,
  resolveDedicatedOutputDirectory,
}
