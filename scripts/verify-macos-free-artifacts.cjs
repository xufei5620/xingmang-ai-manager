const { createHash } = require('node:crypto')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')
const asar = require('@electron/asar')
const YAML = require('yaml')
const { assertElectronFuseHardening } = require('./electron-fuse-hardening.cjs')
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
// Every signed macOS build gets build/entitlements.mac.plist for the app and
// build/entitlements.mac.inherit.plist for the nested helpers, and both grant
// exactly this one key. Library validation and the other hardened-runtime
// exceptions are deliberately withheld, so the verifier asserts set equality
// rather than a subset: a build that quietly gains an entitlement must fail
// here, not ship.
const ALLOWED_ENTITLEMENT_KEYS = ['com.apple.security.cs.allow-jit']

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

function assertSameRegularFile(actual, expected, label) {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino || actual.size !== expected.size) {
    throw new Error(`${label} 在验证期间已变更或被替换`)
  }
  return actual
}

// Mounting an image stamps it: `hdiutil attach` updates the DMG's own
// timestamps, so after a DMG inspection the private copy no longer matches the
// identity it was bound with and every later check reads that as "replaced".
// Dropping the timestamps from the comparison would also drop the only signal
// an in-place edit leaves, so the copy is re-hashed against the digest it was
// made with and the identity is re-baselined only once that digest and
// dev/ino/size both still hold. Re-baselining is therefore not a relaxation: it
// trades a stamp the verifier itself caused for a full content check.
async function rebaseInspectedPrivateCopy(artifact, label) {
  const held = artifact.privateIdentity
  // Checked before the read as well as after it, so a copy that was already
  // swapped is refused without first hashing several hundred megabytes.
  assertSameRegularFile(captureRegularFileIdentity(artifact.path, label), held, label)
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(artifact.path)) hash.update(chunk)
  if (hash.digest('hex') !== artifact.sha256) throw new Error(`${label} 在验证期间内容已变更`)
  artifact.privateIdentity = assertSameRegularFile(
    captureRegularFileIdentity(artifact.path, label),
    held,
    label,
  )
  return artifact.privateIdentity
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

// Every runner in this file signals failure by rejecting, so a real result
// never carries an exit code. Tests and callers inject their own runners
// though, and one that resolves with a non-zero `code` instead of rejecting
// would otherwise read as success. Asserting the contract by name keeps that
// from becoming a false green, where the bare `result?.code` conditionals it
// replaces only looked like a fallback.
function assertCommandSucceeded(result, label) {
  if (result && typeof result === 'object' && typeof result.code === 'number' && result.code !== 0) {
    throw new Error(`${label} 退出码为 ${result.code}`)
  }
  return result
}

// zipinfo prints one line per entry: permissions, zip version, source OS,
// uncompressed size, a two-character text/binary flag, the method, the date,
// the time, then the name. Only the leading permission character tells a
// symbolic-link entry from a regular one, and that is the field the extraction
// order below depends on; the rest of that field is 9 characters for a
// Unix-built archive and shorter for a DOS-built one, so it stays unread.
const ZIP_LISTING_ENTRY_PATTERN = /^([-dlbcps])\S{2,9}\s+\d+\.\d+\s+\S+\s+\d+\s+\S\S\s+\S+\s+\S+\s+\S+\s+(.+)$/

function normalizeZipEntryName(name) {
  return name.endsWith('/') ? name.slice(0, -1) : name
}

// Parsing fails closed on purpose. If zipinfo ever changes shape, an
// unparseable line or a count that disagrees with the archive's own header
// throws instead of leaving the symlink check silently inspecting nothing.
function parseZipEntryListing(text) {
  if (typeof text !== 'string') throw new Error('无法读取 ZIP 条目清单')
  const declared = /number of entries:\s*(\d+)/i.exec(text)
  if (!declared) throw new Error('ZIP 条目清单缺少条目总数，无法在解压前判定条目类型')
  const entries = text.split(/\r?\n/)
    .filter((line) => line.trim()
      && !/^Archive:\s/.test(line)
      && !/^Zip file size:/i.test(line)
      && !/^\d+ files?,/i.test(line))
    .map((line) => {
      const match = ZIP_LISTING_ENTRY_PATTERN.exec(line)
      if (!match) throw new Error(`无法解析 ZIP 条目清单行：${line}`)
      return { name: match[2], isSymbolicLink: match[1] === 'l' }
    })
  if (entries.length !== Number(declared[1])) {
    throw new Error('ZIP 条目清单与声明的条目数不一致，无法在解压前判定条目类型')
  }
  return entries
}

// Validating names alone cannot stop the classic pair "entry A is a symlink to
// /etc" plus "entry A/b is a regular file": both names are well-formed, and the
// extractor creates the link first and then writes straight through it, so
// assertExtractedTreeSafe only ever sees the aftermath. A bundle's own links
// (Frameworks/.../Versions/Current and friends) are always leaves, so rejecting
// exactly the links that stand in for a directory costs nothing legitimate.
function assertZipSymlinkEntriesAreLeaves(entries) {
  const directories = new Set()
  for (const entry of entries) {
    const normalized = normalizeZipEntryName(entry.name)
    for (let index = normalized.indexOf('/'); index !== -1; index = normalized.indexOf('/', index + 1)) {
      directories.add(normalized.slice(0, index))
    }
  }
  for (const entry of entries) {
    if (!entry.isSymbolicLink) continue
    const normalized = normalizeZipEntryName(entry.name)
    if (directories.has(normalized)) {
      throw new Error(`ZIP 条目以符号链接充当目录，解压会穿过它写出：${entry.name}`)
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

function findExtractedApplication(directory, label = 'ZIP') {
  const entries = fs.readdirSync(directory, { withFileTypes: true })
  const applications = entries.filter((entry) => entry.name.endsWith('.app'))
  if (applications.length !== 1) throw new Error(`${label} 必须且只能包含一个顶层 .app`)
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

function safeBundleDirectory(appPath, relativePath, label) {
  const directoryPath = path.resolve(appPath, relativePath)
  if (isOutside(appPath, directoryPath)) throw new Error(`${label} 路径不安全`)
  const segments = path.relative(appPath, directoryPath).split(path.sep)
  let current = appPath
  for (const segment of segments) {
    current = path.join(current, segment)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error(`${label} 不能通过符号链接访问`)
  }
  if (!fs.lstatSync(directoryPath).isDirectory()) throw new Error(`${label} 必须是目录`)
  return directoryPath
}

function findNestedHelperApplications(appPath) {
  const frameworks = safeBundleDirectory(appPath, path.join('Contents', 'Frameworks'), 'Contents/Frameworks')
  const helpers = fs.readdirSync(frameworks, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.app'))
    .map((entry) => ({
      name: entry.name,
      path: safeBundleDirectory(appPath, path.join('Contents', 'Frameworks', entry.name), `helper ${entry.name}`),
    }))
  // Electron always nests at least the renderer helper. Zero helpers means the
  // bundle layout changed underneath this verifier, and silently checking
  // nothing is exactly the false green this assertion exists to prevent.
  if (helpers.length === 0) throw new Error('应用必须在 Contents/Frameworks 下包含至少一个 helper 应用')
  return helpers
}

// On macOS the fuse wire lives in the Electron Framework, not in the app's own
// executable, and @electron/fuses reaches it through Versions/Current — a
// symlink this verifier refuses to follow. Resolving the single real version
// directory keeps the read on a path no tampered bundle can redirect.
function resolveFrameworkFuseBinary(appPath) {
  const frameworkRelativePath = path.join('Contents', 'Frameworks', 'Electron Framework.framework')
  const versionsRoot = safeBundleDirectory(
    appPath,
    path.join(frameworkRelativePath, 'Versions'),
    'Electron Framework Versions',
  )
  // Dirent.isDirectory() is false for a symlink, so Versions/Current drops out
  // here and only the real version directory remains.
  const versions = fs.readdirSync(versionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  if (versions.length !== 1) {
    throw new Error('Electron Framework 必须只包含一个非链接版本目录，无法确定 fuse 加固状态')
  }
  return safeRegularFile(
    appPath,
    path.join(frameworkRelativePath, 'Versions', versions[0].name, 'Electron Framework'),
    'Electron Framework',
  )
}

function assertHardenedRuntime(details, label) {
  // Only the CodeDirectory line carries the signature flags. The neighbouring
  // "Executable Segment ... flags=0x1" line codesign prints for some binaries
  // has no symbolic form and must not be read as the runtime flag.
  const flagLines = String(details || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^CodeDirectory\b/.test(line))
  if (flagLines.length === 0) throw new Error(`${label} 的 codesign 输出没有 CodeDirectory 行，无法确认强化运行时`)
  for (const line of flagLines) {
    const match = /(?:^|\s)flags=0x[\da-fA-F]+\(([^)]*)\)/.exec(line)
    if (!match) throw new Error(`${label} 的 codesign flags= 行无法解析：${line}`)
    const flags = match[1].split(',').map((flag) => flag.trim()).filter(Boolean)
    if (!flags.includes('runtime')) throw new Error(`${label} 未启用强化运行时（hardened runtime）`)
  }
  return flagLines.length
}

function assertAllowedEntitlements(keys, label) {
  const allowed = [...ALLOWED_ENTITLEMENT_KEYS].sort()
  const actual = [...keys].sort()
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`${label} 的 entitlements 必须精确等于允许清单（${allowed.join('、')}），实际为：${actual.join('、') || '（空）'}`)
  }
  return actual
}

async function readEntitlementKeys(targetPath, commandRunner, label) {
  const snapshot = stdoutText(await commandRunner(
    '/usr/bin/codesign',
    ['-d', '--entitlements', ':-', '--xml', targetPath],
  ))
  if (!snapshot.trim()) throw new Error(`${label} 没有任何 entitlements，无法确认允许清单`)
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-entitlements-'))
  try {
    fs.chmodSync(temporaryDirectory, 0o700)
    const snapshotPath = path.join(temporaryDirectory, 'entitlements.plist')
    fs.writeFileSync(snapshotPath, snapshot, { mode: 0o600, flag: 'wx' })
    let entitlements
    try {
      const result = await commandRunner('/usr/bin/plutil', ['-convert', 'json', '-o', '-', snapshotPath])
      assertCommandSucceeded(result, `${label} 的 entitlements plutil 转换`)
      entitlements = JSON.parse(stdoutText(result))
    } catch {
      throw new Error(`${label} 的 entitlements 快照必须可由 plutil 转换为 JSON`)
    }
    if (!entitlements || typeof entitlements !== 'object' || Array.isArray(entitlements)) {
      throw new Error(`${label} 的 entitlements 顶层必须是对象`)
    }
    return Object.keys(entitlements)
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

async function verifySignatureHardening(targetPath, label, commandRunner, assertBundleIdentity) {
  const details = outputText(await commandRunner('/usr/bin/codesign', ['-d', '--verbose=4', targetPath]))
  assertBundleIdentity()
  assertHardenedRuntime(details, label)
  const keys = await readEntitlementKeys(targetPath, commandRunner, label)
  assertBundleIdentity()
  return { label, entitlementKeys: assertAllowedEntitlements(keys, label) }
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
    assertCommandSucceeded(result, 'Info.plist 的 plutil 转换')
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
  const fuseBinary = resolveFrameworkFuseBinary(appPath)
  const fuseBinaryIdentity = captureRegularFileIdentity(fuseBinary, 'Electron Framework')
  const assertBundleIdentity = () => {
    assertDirectoryIdentity(appPath, applicationIdentity, '应用目录')
    assertFileIdentity(executable, executableIdentity, '主可执行文件')
    assertFileIdentity(asarPath, asarIdentity, 'app.asar')
    assertFileIdentity(fuseBinary, fuseBinaryIdentity, 'Electron Framework')
    assertFileIdentity(updateConfig.configPath, updateConfig.configIdentity, 'app-update.yml')
    assertFileIdentity(infoPlist.infoPlistPath, infoPlist.infoPlistIdentity, 'Info.plist')
  }
  const verifyResult = await commandRunner('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--all-architectures', appPath])
  assertCommandSucceeded(verifyResult, 'codesign 完整性验证')
  assertBundleIdentity()

  const details = outputText(await commandRunner('/usr/bin/codesign', ['-d', '--verbose=4', appPath]))
  assertBundleIdentity()
  assertExactCodesignIdentifier(details)
  // codesign resolves a bundle path to the signature of its main executable,
  // so these two cover Contents/MacOS. The nested helpers carry their own
  // signatures and their own entitlements file, and are checked separately.
  assertHardenedRuntime(details, '主可执行文件')
  const mainEntitlements = await readEntitlementKeys(appPath, commandRunner, '主可执行文件')
  assertBundleIdentity()
  assertAllowedEntitlements(mainEntitlements, '主可执行文件')
  const helperEntitlements = []
  for (const helper of findNestedHelperApplications(appPath)) {
    helperEntitlements.push(await verifySignatureHardening(
      helper.path,
      `helper ${helper.name}`,
      commandRunner,
      assertBundleIdentity,
    ))
  }

  const architectures = outputText(await commandRunner('/usr/bin/lipo', ['-archs', executable]))
  assertBundleIdentity()
  assertExactArchitecture(architectures, architecture)

  // Until now nothing checked these on a Mac package at all, so a build that
  // lost electronFuses would have shipped a binary usable as a bare Node
  // runtime and open to a debugger, with the release gate none the wiser.
  const fuseCount = await assertElectronFuseHardening(fuseBinary, `${architecture} 应用`)
  assertBundleIdentity()

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
    return {
      architecture,
      certificateSha256,
      certificateSha1,
      fuseCount,
      entitlementKeys: mainEntitlements,
      helperEntitlements,
      ...requirement,
    }
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
    // The release verifier already streams every artifact into its own 0700
    // directory and holds that copy bound by identity, so copying a
    // several-hundred-megabyte ZIP again here only doubled peak disk use.
    // Standalone callers still get the private copy.
    const privateZip = options.privateSource
      ? { path: zipPath, privateIdentity: captureRegularFileIdentity(zipPath, 'ZIP 私有副本') }
      : await copyPrivateRegularFile(zipPath, path.join(temporaryDirectory, 'artifact.zip'), 'ZIP 产物')
    const listing = parseZipEntryListing(outputText(await commandRunner('/usr/bin/unzip', ['-Z', privateZip.path])))
    validateZipEntryPaths(listing.map((entry) => entry.name).join('\n'))
    assertZipSymlinkEntriesAreLeaves(listing)
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

function parseHdiutilMountPoints(text, mountRoot) {
  const realRoot = fs.realpathSync(mountRoot)
  const mountPoints = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const columns = line.split('\t').map((column) => column.trim()).filter(Boolean)
    const candidate = columns.at(-1)
    if (!candidate || !path.isAbsolute(candidate)) continue
    const resolved = path.resolve(candidate)
    if (resolved === realRoot || isOutside(realRoot, resolved)) continue
    if (!mountPoints.includes(resolved)) mountPoints.push(resolved)
  }
  return mountPoints
}

function listMountedVolumes(mountRoot) {
  const realRoot = fs.realpathSync(mountRoot)
  return fs.readdirSync(realRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(realRoot, entry.name))
    .sort()
}

function resolveSingleMountPoint(mountRoot, reportedMountPoints) {
  const mounted = listMountedVolumes(mountRoot)
  if (mounted.length !== 1 || reportedMountPoints.length !== 1 || reportedMountPoints[0] !== mounted[0]) {
    throw new Error('DMG 必须恰好挂载出一个位于随机挂载目录下的卷')
  }
  return mounted[0]
}

async function detachMountPoints(mountPoints, commandRunner) {
  const failures = []
  for (const mountPoint of mountPoints) {
    try {
      await commandRunner('/usr/bin/hdiutil', ['detach', mountPoint, '-force'])
    } catch (error) {
      failures.push(`${mountPoint}：${error.message}`)
    }
  }
  return failures
}

async function verifyDmgApplication(dmgPath, architecture, options) {
  const mountRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-macos-dmg-'))
  const env = options.env || process.env
  const commandRunner = options.commandRunner || ((command, args) => defaultCommandRunner(command, args, {
    env,
    runFile: options.runFile,
  }))
  fs.chmodSync(mountRoot, 0o700)
  let result
  let inspectionError
  try {
    const attached = outputText(await commandRunner('/usr/bin/hdiutil', [
      'attach', '-nobrowse', '-readonly', '-noautoopen', '-mountrandom', mountRoot, dmgPath,
    ]))
    const mountPoint = resolveSingleMountPoint(mountRoot, parseHdiutilMountPoints(attached, mountRoot))
    const appPath = findExtractedApplication(mountPoint, 'DMG')
    // The mount root itself cannot be the containment boundary: electron-builder
    // puts a /Applications symlink next to the .app by design. Inside the bundle
    // every link must still stay within it.
    assertExtractedTreeSafe(appPath)
    result = await inspectPackagedApplication(
      appPath,
      architecture,
      options.expectedCertificateSha256,
      options.expectedUpdateUrl || DEFAULT_UPDATE_URL,
      options.expectedVersion,
      commandRunner,
    )
  } catch (error) {
    inspectionError = error
  }
  // Detach whatever actually mounted, not what hdiutil reported, so a failed
  // inspection never leaves an image attached to the build machine.
  let mounted = []
  try {
    mounted = listMountedVolumes(mountRoot)
  } catch (error) {
    if (!inspectionError) inspectionError = error
  }
  const detachFailures = await detachMountPoints(mounted, commandRunner)
  // Clear the mount root only once nothing is attached under it: deleting it
  // while a read-only volume is still mounted fails on that volume's own files
  // and would replace the detach error with a misleading one.
  if (detachFailures.length === 0) fs.rmSync(mountRoot, { recursive: true, force: true })
  if (inspectionError) throw inspectionError
  if (detachFailures.length > 0) {
    throw new Error(`DMG 卸载失败，挂载目录 ${mountRoot} 需人工清理：${detachFailures.join('；')}`)
  }
  return result
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

  const verifiers = {
    zip: options.verifyZipApplication || verifyZipApplication,
    dmg: options.verifyDmgApplication || verifyDmgApplication,
  }
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
    // The DMG is the package users install by hand, so it goes through the same
    // packaged inspection as the update ZIP instead of only being hashed.
    for (const architecture of ARCHITECTURES) {
      for (const kind of ['zip', 'dmg']) {
        const artifactName = `XingMang-AI-Manager-${version}-${architecture}.${kind}`
        const privateArtifact = privateArtifacts.get(artifactName)
        if (!privateArtifact) throw new Error(`${kind.toUpperCase()} 私有副本缺失：${artifactName}`)
        const result = await verifiers[kind](privateArtifact.path, architecture, {
          expectedCertificateSha256,
          expectedUpdateUrl,
          expectedVersion: version,
          commandRunner,
          env,
          privateSource: true,
        })
        // Only the DMG path hands the private copy to a mounter; ZIP extraction
        // reads its source without stamping it, so it keeps the strict check.
        if (kind === 'dmg') {
          await rebaseInspectedPrivateCopy(privateArtifact, `发行文件私有副本 ${artifactName}`)
        }
        assertBoundReleaseSources()
        if (!result || result.architecture !== architecture) {
          throw new Error(`${kind.toUpperCase()} 应用验证没有确认预期架构：${architecture}`)
        }
        if (normalizeSha256(result.certificateSha256) !== expectedCertificateSha256) {
          throw new Error(`${kind.toUpperCase()} 应用叶证书 SHA-256 与预期签名证书不匹配：${artifactName}`)
        }
        const certificateSha1 = normalizeSha1(result.certificateSha1)
        const requirement = parseDesignatedRequirement(result.designatedRequirement)
        if (requirement.certificateRequirementHash !== certificateSha1) {
          throw new Error(`${kind.toUpperCase()} 应用指定要求的证书 slot 哈希必须等于提取的叶证书 SHA-1：${artifactName}`)
        }
        results.push({ kind, artifactName, ...result, certificateSha1, ...requirement })
      }
    }
    // Continuity now spans all four artifacts: a DMG signed by a different
    // certificate than the ZIPs is exactly the split this check must catch.
    const [reference, ...others] = results
    for (const result of others) {
      if (result.designatedRequirement !== reference.designatedRequirement
        || result.certificateSlot !== reference.certificateSlot
        || result.certificateRequirementHash !== reference.certificateRequirementHash) {
        throw new Error(`四个产物的指定要求、证书 slot 或证书哈希连续性不一致：${result.artifactName}`)
      }
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
  ALLOWED_ENTITLEMENT_KEYS,
  assertAllowedEntitlements,
  assertExactCodesignIdentifier,
  assertExactArchitecture,
  assertHardenedRuntime,
  assertZipSymlinkEntriesAreLeaves,
  expectedFreeArtifactNames,
  formatSha256Manifest,
  hashArtifactFiles,
  parseDesignatedRequirement,
  parseHdiutilMountPoints,
  parseLatestMacMetadata,
  parseZipEntryListing,
  resolveFrameworkFuseBinary,
  resolveSafeOutputDirectory,
  validateZipEntryPaths,
  verifyPackagedUpdateConfig,
  verifyDmgApplication,
  verifyMacosFreeArtifacts,
  verifyZipApplication,
}
