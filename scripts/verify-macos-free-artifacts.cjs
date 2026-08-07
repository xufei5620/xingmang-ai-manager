const { createHash } = require('node:crypto')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const asar = require('@electron/asar')
const YAML = require('yaml')
const {
  DEFAULT_UPDATE_URL,
  MAX_BLOCKMAP_BYTES,
  assertBlockmap,
  normalizeUpdateBaseUrl,
  parseLatestMetadata,
} = require('./update-release-utils.cjs')

const runFile = promisify(execFile)
const APP_IDENTIFIER = 'com.xingmang.ai.manager'
const ARCHITECTURES = ['arm64', 'x64']
const MACHO_ARCHITECTURES = {
  arm64: 'arm64',
  x64: 'x86_64',
}

function expectedFreeArtifactNames(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('版本号无效，无法验证 macOS 免费分发产物')
  }
  return ARCHITECTURES.flatMap((architecture) => [
    `XingMang-AI-Manager-${version}-${architecture}.dmg`,
    `XingMang-AI-Manager-${version}-${architecture}.zip`,
  ])
}

function expectedFreeBlockmapNames(version) {
  return ARCHITECTURES.map((architecture) => (
    `XingMang-AI-Manager-${version}-${architecture}.zip.blockmap`
  ))
}

function isOutside(root, candidate) {
  const relative = path.relative(root, candidate)
  return path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)
}

function resolveSafeOutputDirectory(projectRoot, requestedDirectory) {
  if (typeof projectRoot !== 'string' || !projectRoot.trim()) throw new Error('项目目录不能为空')
  if (typeof requestedDirectory !== 'string' || !requestedDirectory.trim()) throw new Error('输出目录不能为空')
  if (requestedDirectory.includes('\0')) throw new Error('输出目录不能包含 NUL 字符')

  const root = fs.realpathSync(path.resolve(projectRoot))
  const requested = path.isAbsolute(requestedDirectory.trim())
    ? path.resolve(requestedDirectory.trim())
    : path.resolve(root, requestedDirectory.trim())
  let ancestor = requested
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  const realAncestor = fs.realpathSync(ancestor)
  const output = path.resolve(realAncestor, path.relative(ancestor, requested))
  if (output === root || isOutside(root, output)) throw new Error('输出目录必须是项目内的独立目录，不能是项目根目录')
  if (isOutside(root, realAncestor)) throw new Error('输出目录的父目录链接指向项目目录外')

  if (fs.existsSync(output)) {
    const stat = fs.lstatSync(output)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('输出目录必须是普通目录，不能是链接或文件')
    if (isOutside(root, fs.realpathSync(output))) throw new Error('输出目录链接指向项目目录外')
  }
  return output
}

function assertArtifactFile(outputDirectory, name) {
  if (path.basename(name) !== name) throw new Error(`产物名称不安全：${name}`)
  const artifactPath = path.join(outputDirectory, name)
  let stat
  try {
    stat = fs.lstatSync(artifactPath)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`缺少 macOS 免费分发产物：${name}`)
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error(`macOS 免费分发产物为空、不是普通文件或是链接：${name}`)
  }
  return artifactPath
}

function identityFromStat(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

function captureRegularFileIdentity(filePath, label) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} 必须是非空普通文件，不能是链接`)
  if (stat.size === 0) throw new Error(`${label} 不能为空`)
  return identityFromStat(stat)
}

function assertFileIdentity(filePath, expected, label) {
  let actual
  try {
    actual = captureRegularFileIdentity(filePath, label)
  } catch (error) {
    throw new Error(`${label} 在验证期间已变更：${error.message}`)
  }
  if (!sameIdentity(actual, expected)) throw new Error(`${label} 在验证期间已变更或被替换`)
}

function captureDirectoryIdentity(directoryPath, label) {
  const stat = fs.lstatSync(directoryPath)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} 必须是非链接目录`)
  return identityFromStat(stat)
}

function assertDirectoryIdentity(directoryPath, expected, label) {
  try {
    if (!sameIdentity(captureDirectoryIdentity(directoryPath, label), expected)) {
      throw new Error(`${label} 在验证期间已变更或被替换`)
    }
  } catch (error) {
    if (error.message.includes('已变更或被替换')) throw error
    throw new Error(`${label} 在验证期间已变更：${error.message}`)
  }
}

function assertOutputDirectoryIdentity(directoryPath, expected, projectRoot) {
  let actual
  try {
    actual = captureDirectoryIdentity(directoryPath, '输出目录')
    const realRoot = fs.realpathSync(projectRoot)
    const realOutput = fs.realpathSync(directoryPath)
    if (realOutput === realRoot || isOutside(realRoot, realOutput)) {
      throw new Error('输出目录在验证期间逃出了项目目录')
    }
  } catch (error) {
    if (error.message.includes('已变更') || error.message.includes('逃出了')) throw error
    throw new Error(`输出目录在验证期间已变更：${error.message}`)
  }
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error('输出目录在验证期间已变更或被替换')
  }
}

function assertPublicArtifactInventory(outputDirectory, expectedNames) {
  const expected = new Set(expectedNames)
  const found = new Set()
  for (const name of fs.readdirSync(outputDirectory)) {
    if (!/(?:\.zip|\.dmg|\.blockmap)$/i.test(name)) continue
    if (!expected.has(name)) throw new Error(`输出目录包含额外顶层 ZIP/DMG/blockmap：${name}`)
    const stat = fs.lstatSync(path.join(outputDirectory, name))
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
      throw new Error(`顶层 ZIP/DMG/blockmap 必须是非空普通文件且不能是链接：${name}`)
    }
    found.add(name)
  }
  if (found.size !== expected.size || expectedNames.some((name) => !found.has(name))) {
    throw new Error('输出目录必须精确包含预期顶层 ZIP、DMG 和 blockmap 文件')
  }
}

async function copyPrivateRegularFile(sourcePath, destinationPath, label) {
  const sourceIdentity = captureRegularFileIdentity(sourcePath, label)
  const input = await fs.promises.open(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  let output
  try {
    if (!sameIdentity(identityFromStat(await input.stat()), sourceIdentity)) {
      throw new Error(`${label} 在打开前已变更或被替换`)
    }
    output = await fs.promises.open(destinationPath, 'wx', 0o600)
    const sha512 = createHash('sha512')
    const sha256 = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (position < sourceIdentity.size) {
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, sourceIdentity.size - position), position)
      if (bytesRead === 0) throw new Error(`${label} 在复制期间意外结束`)
      const chunk = buffer.subarray(0, bytesRead)
      sha512.update(chunk)
      sha256.update(chunk)
      let written = 0
      while (written < bytesRead) {
        const result = await output.write(buffer, written, bytesRead - written, position + written)
        if (result.bytesWritten === 0) throw new Error(`${label} 无法写入私有验证副本`)
        written += result.bytesWritten
      }
      position += bytesRead
    }
    if (!sameIdentity(identityFromStat(await input.stat()), sourceIdentity)) {
      throw new Error(`${label} 在复制期间已变更`)
    }
    await output.close()
    output = null
    assertFileIdentity(sourcePath, sourceIdentity, label)
    return {
      path: destinationPath,
      sourceIdentity,
      privateIdentity: captureRegularFileIdentity(destinationPath, `${label} 私有副本`),
      size: position,
      sha512: sha512.digest('base64'),
      sha256: sha256.digest('hex'),
    }
  } finally {
    await output?.close()
    await input.close()
  }
}

async function hashArtifactFiles(outputDirectory, names) {
  if (!Array.isArray(names)) throw new Error('产物名称列表无效')
  const entries = []
  for (const name of names) {
    const artifactPath = assertArtifactFile(outputDirectory, name)
    const hash = createHash('sha256')
    for await (const chunk of fs.createReadStream(artifactPath)) hash.update(chunk)
    entries.push({ name, sha256: hash.digest('hex') })
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name))
}

function formatSha256Manifest(entries) {
  if (!Array.isArray(entries)) throw new Error('SHA256SUMS 条目无效')
  return [...entries]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (!entry || path.basename(entry.name) !== entry.name || !/^[a-f\d]{64}$/i.test(entry.sha256)) {
        throw new Error('SHA256SUMS 条目无效')
      }
      return `${entry.sha256.toLowerCase()}  ${entry.name}`
    })
    .concat('')
    .join('\n')
}

function parseLatestMacMetadata(text, expectedVersion, expectedArtifactNames = []) {
  const metadata = parseLatestMetadata(text)
  if (expectedVersion && metadata.version !== expectedVersion) {
    throw new Error(`latest-mac.yml 版本 ${metadata.version} 与预期版本 ${expectedVersion} 不一致`)
  }
  if (expectedArtifactNames.length > 0) {
    const expectedZipNames = expectedArtifactNames.filter((name) => name.endsWith('.zip'))
    const expected = new Set(expectedZipNames)
    if (!expectedZipNames.includes(metadata.rawPrimaryPath)) {
      throw new Error('latest-mac.yml 主更新文件必须是预期架构 ZIP 精确引用')
    }
    if (metadata.files.length !== expectedZipNames.length
      || metadata.files.some((entry) => !expected.has(entry.rawUrl))) {
      throw new Error('latest-mac.yml 必须精确引用两个预期 ZIP 更新文件')
    }
  }
  return metadata
}

function normalizeSha256(value, label = '证书 SHA-256') {
  if (typeof value !== 'string') throw new Error(`${label} 不能为空`)
  const normalized = value.replace(/[\s:]/g, '').toLowerCase()
  if (!/^[a-f\d]{64}$/.test(normalized)) throw new Error(`${label} 必须是 64 位十六进制 SHA-256`)
  return normalized
}

function normalizeSha1(value, label = '证书 SHA-1') {
  if (typeof value !== 'string') throw new Error(`${label} 不能为空`)
  const normalized = value.replace(/[\s:]/g, '').toLowerCase()
  if (!/^[a-f\d]{40}$/.test(normalized)) throw new Error(`${label} 必须是 40 位十六进制 SHA-1`)
  return normalized
}

function assertExactArchitecture(text, expectedArchitecture) {
  const architectures = String(text || '').trim().split(/\s+/).filter(Boolean)
  const expectedMachOArchitecture = MACHO_ARCHITECTURES[expectedArchitecture]
  if (!expectedMachOArchitecture
    || architectures.length !== 1
    || architectures[0] !== expectedMachOArchitecture) {
    throw new Error(`应用必须是精确的 ${expectedArchitecture} 单一架构`)
  }
  return architectures[0]
}

function validateZipEntryPaths(text) {
  if (typeof text !== 'string') throw new Error('无法读取 ZIP 条目路径')
  const entries = text.split(/\r?\n/).filter(Boolean)
  if (entries.length === 0) throw new Error('ZIP 不包含可验证的条目路径')
  for (const entry of entries) {
    const normalized = entry.endsWith('/') ? entry.slice(0, -1) : entry
    if (!normalized || normalized.includes('\0') || normalized.includes('\\')
      || path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
      throw new Error(`ZIP 条目路径不安全：${entry}`)
    }
    const segments = normalized.split('/')
    if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
      throw new Error(`ZIP 条目路径不安全：${entry}`)
    }
  }
  return entries
}

function outputText(result) {
  if (typeof result === 'string') return result
  return `${result?.stdout || ''}\n${result?.stderr || ''}`
}

function stdoutText(result) {
  if (typeof result === 'string') return result
  return result?.stdout || ''
}

async function defaultCommandRunner(command, args, options = {}) {
  const { runFile: execute = runFile, ...commandOptions } = options
  return execute(command, args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    ...commandOptions,
    shell: false,
  })
}

function assertInside(root, candidate, label) {
  const realRoot = fs.realpathSync(root)
  const resolved = path.resolve(candidate)
  if (isOutside(realRoot, fs.realpathSync(path.dirname(resolved)))) throw new Error(`${label} 路径逃出了临时目录`)
  const real = fs.realpathSync(resolved)
  if (isOutside(realRoot, real)) throw new Error(`${label} 通过链接逃出了临时目录`)
  return real
}

function findExtractedApplication(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
  const applications = entries.filter((entry) => entry.name.endsWith('.app'))
  if (applications.length !== 1) throw new Error('ZIP 必须且只能解压出一个顶层 .app')
  const application = path.join(directory, applications[0].name)
  const stat = fs.lstatSync(application)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('顶层 .app 不能是链接或非目录')
  return assertInside(directory, application, '.app')
}

function assertExtractedTreeSafe(directory, current = directory) {
  const realRoot = fs.realpathSync(directory)
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const entryPath = path.join(current, entry.name)
    const stat = fs.lstatSync(entryPath)
    if (stat.isSymbolicLink()) {
      const target = fs.realpathSync(entryPath)
      if (isOutside(realRoot, target)) throw new Error(`ZIP 解压链接逃出了临时目录：${entry.name}`)
      continue
    }
    if (stat.isDirectory()) assertExtractedTreeSafe(directory, entryPath)
  }
}

function safeRegularFile(appPath, relativePath, label) {
  const filePath = path.resolve(appPath, relativePath)
  if (isOutside(appPath, filePath)) throw new Error(`${label} 路径不安全`)
  const segments = path.relative(appPath, filePath).split(path.sep)
  let current = appPath
  for (const segment of segments) {
    current = path.join(current, segment)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`${label} 不能通过符号链接访问`)
  }
  const stat = fs.statSync(filePath)
  if (!stat.isFile() || stat.size === 0) throw new Error(`${label} 必须是非空普通文件`)
  return filePath
}

function verifyPackagedUpdateConfig(appPath, expectedUpdateUrl) {
  const normalizedExpectedUrl = normalizeUpdateBaseUrl(expectedUpdateUrl)
  const configPath = safeRegularFile(
    appPath,
    path.join('Contents', 'Resources', 'app-update.yml'),
    'app-update.yml',
  )
  const configIdentity = captureRegularFileIdentity(configPath, 'app-update.yml')
  let config
  try {
    config = YAML.parse(fs.readFileSync(configPath, 'utf8'), { maxAliasCount: 0, uniqueKeys: true })
  } catch {
    throw new Error('app-update.yml 必须是有效且唯一键的 YAML')
  }
  assertFileIdentity(configPath, configIdentity, 'app-update.yml')
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('app-update.yml 顶层必须是对象')
  }
  if (config.provider !== 'generic') throw new Error('app-update.yml.provider 必须是 generic')
  if (typeof config.url !== 'string') throw new Error('app-update.yml.url 必须是字符串')
  const normalizedPackagedUrl = normalizeUpdateBaseUrl(config.url)
  if (config.url !== normalizedPackagedUrl || normalizedPackagedUrl !== normalizedExpectedUrl) {
    throw new Error('app-update.yml.url 必须精确匹配预期的 HTTPS 更新地址')
  }
  return { configPath, configIdentity }
}

function parseDesignatedRequirement(text) {
  if (typeof text !== 'string') throw new Error('指定要求必须使用固定 grammar')
  const designatedRequirement = text.trim()
  if (/\bcdhash\b/i.test(designatedRequirement)) throw new Error('指定要求不能依赖 cdhash 身份')
  const match = /^(?:designated => )?identifier "com\.xingmang\.ai\.manager" and certificate (root|leaf) = H"([a-fA-F\d]{40})"$/.exec(designatedRequirement)
  if (!match) {
    throw new Error('指定要求必须精确使用 identifier 与单一 certificate root 或 leaf 固定 SHA-1 grammar')
  }
  return {
    designatedRequirement,
    certificateSlot: match[1].toLowerCase(),
    certificateRequirementHash: match[2].toLowerCase(),
  }
}

function assertExactCodesignIdentifier(text) {
  const lines = String(text || '').split(/\r?\n/)
  const identifierLines = lines.filter((line) => line.startsWith('Identifier='))
  if (identifierLines.length !== 1 || identifierLines[0] !== `Identifier=${APP_IDENTIFIER}`) {
    throw new Error(`应用 bundle identifier 不是唯一精确的 ${APP_IDENTIFIER} Identifier 行`)
  }
  return APP_IDENTIFIER
}

function assertExactPackagedInfoPlist(infoPlist, expectedVersion) {
  if (!infoPlist || typeof infoPlist !== 'object' || Array.isArray(infoPlist)) {
    throw new Error('Info.plist 顶层必须是对象')
  }
  if (infoPlist.CFBundleIdentifier !== APP_IDENTIFIER) {
    throw new Error(`Info.plist CFBundleIdentifier 必须精确为 ${APP_IDENTIFIER}`)
  }
  if (infoPlist.CFBundleShortVersionString !== expectedVersion) {
    throw new Error(`Info.plist CFBundleShortVersionString 必须精确为预期版本 ${expectedVersion}`)
  }
  if (infoPlist.CFBundleVersion !== expectedVersion) {
    throw new Error(`Info.plist CFBundleVersion 必须精确为预期版本 ${expectedVersion}`)
  }
}

async function verifyPackagedInfoPlist(appPath, expectedVersion, commandRunner) {
  const infoPlistPath = safeRegularFile(appPath, path.join('Contents', 'Info.plist'), 'Info.plist')
  const infoPlistIdentity = captureRegularFileIdentity(infoPlistPath, 'Info.plist')
  let infoPlist
  try {
    const result = await commandRunner('/usr/bin/plutil', ['-convert', 'json', '-o', '-', infoPlistPath])
    if (result?.code && result.code !== 0) throw new Error('plutil 转换失败')
    infoPlist = JSON.parse(stdoutText(result))
  } catch {
    throw new Error('Info.plist 必须可由 plutil 转换为 JSON')
  }
  assertFileIdentity(infoPlistPath, infoPlistIdentity, 'Info.plist')
  assertExactPackagedInfoPlist(infoPlist, expectedVersion)
  return { infoPlistPath, infoPlistIdentity }
}

async function inspectPackagedApplication(
  appPath,
  architecture,
  expectedCertificateSha256,
  expectedUpdateUrl,
  expectedVersion,
  commandRunner,
) {
  const applicationIdentity = captureDirectoryIdentity(appPath, '应用目录')
  const updateConfig = verifyPackagedUpdateConfig(appPath, expectedUpdateUrl)
  const infoPlist = await verifyPackagedInfoPlist(appPath, expectedVersion, commandRunner)
  const macosDirectory = path.join(appPath, 'Contents', 'MacOS')
  const executableNames = fs.readdirSync(macosDirectory).filter((name) => {
    const candidate = path.join(macosDirectory, name)
    return fs.lstatSync(candidate).isFile() && !fs.lstatSync(candidate).isSymbolicLink()
  })
  if (executableNames.length !== 1) throw new Error('应用必须包含唯一的主可执行文件')
  const executable = safeRegularFile(appPath, path.join('Contents', 'MacOS', executableNames[0]), '主可执行文件')
  const executableIdentity = captureRegularFileIdentity(executable, '主可执行文件')
  const asarPath = safeRegularFile(appPath, path.join('Contents', 'Resources', 'app.asar'), 'app.asar')
  const asarIdentity = captureRegularFileIdentity(asarPath, 'app.asar')
  const assertBundleIdentity = () => {
    assertDirectoryIdentity(appPath, applicationIdentity, '应用目录')
    assertFileIdentity(executable, executableIdentity, '主可执行文件')
    assertFileIdentity(asarPath, asarIdentity, 'app.asar')
    assertFileIdentity(updateConfig.configPath, updateConfig.configIdentity, 'app-update.yml')
    assertFileIdentity(infoPlist.infoPlistPath, infoPlist.infoPlistIdentity, 'Info.plist')
  }
  const verifyResult = await commandRunner('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', appPath])
  if (verifyResult?.code && verifyResult.code !== 0) throw new Error('codesign 完整性验证失败')
  assertBundleIdentity()

  const details = outputText(await commandRunner('/usr/bin/codesign', ['-d', '--verbose=4', appPath]))
  assertBundleIdentity()
  assertExactCodesignIdentifier(details)

  const architectures = outputText(await commandRunner('/usr/bin/lipo', ['-archs', executable]))
  assertBundleIdentity()
  assertExactArchitecture(architectures, architecture)

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-codesign-cert-'))
  try {
    const prefix = path.join(temporaryDirectory, 'certificate')
    await commandRunner('/usr/bin/codesign', ['-d', `--extract-certificates=${prefix}`, appPath])
    assertBundleIdentity()
    const leafCertificate = `${prefix}0`
    const certificate = fs.readFileSync(leafCertificate)
    const certificateSha256 = createHash('sha256').update(certificate).digest('hex')
    const certificateSha1 = createHash('sha1').update(certificate).digest('hex')
    if (certificateSha256 !== expectedCertificateSha256) throw new Error('应用叶证书 SHA-256 与预期签名证书不匹配')

    const requirement = parseDesignatedRequirement(stdoutText(
      await commandRunner('/usr/bin/codesign', ['-d', '-r-', appPath]),
    ))
    assertBundleIdentity()
    if (requirement.certificateRequirementHash !== certificateSha1) {
      throw new Error('指定要求证书 slot 哈希与提取的叶证书 SHA-1 不一致')
    }
    let packagedPackage
    try {
      packagedPackage = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
    } catch {
      throw new Error('无法从 app.asar 读取 packaged package.json')
    }
    assertBundleIdentity()
    if (packagedPackage.version !== expectedVersion) {
      throw new Error(`packaged package.json version 必须精确匹配预期版本 ${expectedVersion}`)
    }
    if (packagedPackage.xingmangLocalBuild !== false) throw new Error('packaged package.json 必须显式设置 xingmangLocalBuild 为 false')
    return { architecture, certificateSha256, certificateSha1, ...requirement }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

async function verifyZipApplication(zipPath, architecture, options) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-zip-'))
  const env = options.env || process.env
  const commandRunner = options.commandRunner || ((command, args) => defaultCommandRunner(command, args, {
    env,
    runFile: options.runFile,
  }))
  try {
    fs.chmodSync(temporaryDirectory, 0o700)
    const privateZip = await copyPrivateRegularFile(zipPath, path.join(temporaryDirectory, 'artifact.zip'), 'ZIP 产物')
    const listing = outputText(await commandRunner('/usr/bin/unzip', ['-Z1', privateZip.path]))
    validateZipEntryPaths(listing)
    await commandRunner('/usr/bin/ditto', ['-x', '-k', privateZip.path, temporaryDirectory])
    assertFileIdentity(privateZip.path, privateZip.privateIdentity, 'ZIP 私有副本')
    assertExtractedTreeSafe(temporaryDirectory)
    const appPath = findExtractedApplication(temporaryDirectory)
    return await inspectPackagedApplication(
      appPath,
      architecture,
      options.expectedCertificateSha256,
      options.expectedUpdateUrl || DEFAULT_UPDATE_URL,
      options.expectedVersion,
      commandRunner,
    )
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

async function writeSha256Manifest(outputDirectory, entries) {
  const manifestPath = path.join(outputDirectory, 'SHA256SUMS')
  const temporaryPath = path.join(outputDirectory, `.SHA256SUMS.${process.pid}.${Date.now()}.tmp`)
  try {
    await fs.promises.writeFile(temporaryPath, formatSha256Manifest(entries), { mode: 0o644, flag: 'wx' })
    await fs.promises.rename(temporaryPath, manifestPath)
  } finally {
    await fs.promises.rm(temporaryPath, { force: true })
  }
  return manifestPath
}

async function verifyMacosFreeArtifacts(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || process.cwd())
  const version = options.version
  const outputDirectory = resolveSafeOutputDirectory(projectRoot, options.outputDirectory)
  const names = expectedFreeArtifactNames(version)
  const blockmapNames = expectedFreeBlockmapNames(version)
  const publicNames = [...names, ...blockmapNames]
  const env = options.env || process.env
  const expectedCertificateSha256 = normalizeSha256(options.signingCertificateSha256 || env.XINGMANG_MAC_SIGNING_SHA256)
  const expectedUpdateUrl = normalizeUpdateBaseUrl(options.expectedUpdateUrl || DEFAULT_UPDATE_URL)
  const outputDirectoryIdentity = captureDirectoryIdentity(outputDirectory, '输出目录')
  assertPublicArtifactInventory(outputDirectory, publicNames)
  for (const name of publicNames) assertArtifactFile(outputDirectory, name)

  const verifier = options.verifyZipApplication || verifyZipApplication
  const commandRunner = options.commandRunner || ((command, args) => defaultCommandRunner(command, args, {
    env,
    runFile: options.runFile,
  }))
  const results = []
  const metadataPath = path.join(outputDirectory, 'latest-mac.yml')
  const privateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-artifacts-'))
  try {
    fs.chmodSync(privateDirectory, 0o700)
    const privateMetadata = await copyPrivateRegularFile(
      metadataPath,
      path.join(privateDirectory, 'latest-mac.yml'),
      'latest-mac.yml',
    )
    const metadataText = await fs.promises.readFile(privateMetadata.path, 'utf8')
    assertFileIdentity(privateMetadata.path, privateMetadata.privateIdentity, 'latest-mac.yml 私有副本')
    const metadata = parseLatestMacMetadata(metadataText, version, names)
    const privateArtifacts = new Map()
    for (const name of publicNames) {
      const privateArtifact = await copyPrivateRegularFile(
        path.join(outputDirectory, name),
        path.join(privateDirectory, name),
        `发行产物 ${name}`,
      )
      if (blockmapNames.includes(name)) {
        if (privateArtifact.size > MAX_BLOCKMAP_BYTES) {
          throw new Error(`ZIP blockmap 超过 ${MAX_BLOCKMAP_BYTES} 字节上限：${name}`)
        }
        assertBlockmap(
          await fs.promises.readFile(privateArtifact.path),
          `ZIP blockmap ${name}`,
          'MACOS_BLOCKMAP_INVALID',
        )
      } else if (name.endsWith('.zip')) {
        const metadataEntry = metadata.files.find((entry) => entry.rawUrl === name)
        if (!metadataEntry) throw new Error(`latest-mac.yml 缺少精确发行文件引用：${name}`)
        if (metadataEntry.size === null) {
          throw new Error(`latest-mac.yml 必须声明发行文件大小：${name}`)
        }
        if (metadataEntry.size !== privateArtifact.size) {
          throw new Error(`发行文件大小与 latest-mac.yml 不一致：${name}`)
        }
        if (metadataEntry.sha512 !== privateArtifact.sha512) {
          throw new Error(`发行文件 SHA-512 与 latest-mac.yml 不一致：${name}`)
        }
      }
      assertFileIdentity(privateArtifact.path, privateArtifact.privateIdentity, `发行文件私有副本 ${name}`)
      privateArtifacts.set(name, privateArtifact)
    }
    const assertBoundReleaseSources = () => {
      assertOutputDirectoryIdentity(outputDirectory, outputDirectoryIdentity, projectRoot)
      assertFileIdentity(metadataPath, privateMetadata.sourceIdentity, 'latest-mac.yml')
      assertFileIdentity(privateMetadata.path, privateMetadata.privateIdentity, 'latest-mac.yml 私有副本')
      assertPublicArtifactInventory(outputDirectory, publicNames)
      for (const name of publicNames) {
        const privateArtifact = privateArtifacts.get(name)
        assertFileIdentity(path.join(outputDirectory, name), privateArtifact.sourceIdentity, `发行产物 ${name}`)
        assertFileIdentity(privateArtifact.path, privateArtifact.privateIdentity, `发行文件私有副本 ${name}`)
      }
    }
    assertBoundReleaseSources()
    for (const architecture of ARCHITECTURES) {
      const zipName = `XingMang-AI-Manager-${version}-${architecture}.zip`
      const privateZip = privateArtifacts.get(zipName)
      if (!privateZip) throw new Error(`ZIP 私有副本缺失：${zipName}`)
      const result = await verifier(privateZip.path, architecture, {
        expectedCertificateSha256,
        expectedUpdateUrl,
        expectedVersion: version,
        commandRunner,
        env,
      })
      assertBoundReleaseSources()
      if (!result || result.architecture !== architecture) throw new Error(`ZIP 应用验证没有确认预期架构：${architecture}`)
      if (normalizeSha256(result.certificateSha256) !== expectedCertificateSha256) throw new Error('ZIP 应用叶证书 SHA-256 与预期签名证书不匹配')
      const certificateSha1 = normalizeSha1(result.certificateSha1)
      const requirement = parseDesignatedRequirement(result.designatedRequirement)
      if (requirement.certificateRequirementHash !== certificateSha1) {
        throw new Error('ZIP 应用指定要求的证书 slot 哈希必须等于提取的叶证书 SHA-1')
      }
      results.push({ ...result, certificateSha1, ...requirement })
    }
    if (results[0].designatedRequirement !== results[1].designatedRequirement
      || results[0].certificateSlot !== results[1].certificateSlot
      || results[0].certificateRequirementHash !== results[1].certificateRequirementHash) {
      throw new Error('两个 ZIP 应用的指定要求、证书 slot 或证书哈希连续性不一致')
    }

    const entries = publicNames
      .map((name) => ({ name, sha256: privateArtifacts.get(name).sha256 }))
      .sort((left, right) => left.name.localeCompare(right.name))
    assertBoundReleaseSources()
    const sha256ManifestPath = await writeSha256Manifest(outputDirectory, entries)
    assertBoundReleaseSources()
    return { outputDirectory, metadata, entries, sha256ManifestPath, applications: results }
  } finally {
    fs.rmSync(privateDirectory, { recursive: true, force: true })
  }
}

async function main() {
  const projectRoot = path.resolve(__dirname, '..')
  const packageJson = JSON.parse(await fs.promises.readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  const requestedDirectory = process.argv[2] || process.env.XINGMANG_OUTPUT_DIR || `release-free-${packageJson.version}`
  const result = await verifyMacosFreeArtifacts({
    projectRoot,
    outputDirectory: requestedDirectory,
    version: packageJson.version,
  })
  process.stdout.write(`已验证 macOS 免费分发产物：${result.outputDirectory}\nSHA256SUMS：${result.sha256ManifestPath}\n`)
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`macOS 免费分发产物验证失败：${error.message}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  assertExactCodesignIdentifier,
  assertExactArchitecture,
  expectedFreeArtifactNames,
  formatSha256Manifest,
  hashArtifactFiles,
  parseDesignatedRequirement,
  parseLatestMacMetadata,
  resolveSafeOutputDirectory,
  validateZipEntryPaths,
  verifyPackagedUpdateConfig,
  verifyMacosFreeArtifacts,
  verifyZipApplication,
}
