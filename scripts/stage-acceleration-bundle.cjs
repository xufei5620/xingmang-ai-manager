// Release-operator tool. Private nodes stay outside the repository and are only
// included when the packager explicitly supplies an external staging directory.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { stringify } = require('yaml')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const MAX_CORE_BYTES = 100 * 1024 * 1024
const BUNDLE_FILES = ['manifest.json', 'mihomo.exe', 'profile.yaml', 'LICENSE-mihomo.txt', 'THIRD-PARTY-NOTICES.txt']
const SOURCE_ROOT = 'https://github.com/MetaCubeX/mihomo'

function loadRuntime() {
  try {
    return {
      safe: require('../dist-electron/safe-local-data.js'),
      bounded: require('../dist-electron/bounded-file.js'),
      parser: require('../dist-electron/acceleration-clash-config.js'),
      binary: require('../dist-electron/acceleration-binary.js'),
    }
  } catch {
    throw new Error('请先编译主进程，再准备私有加速资源。')
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertAbsolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label}必须是绝对路径。`)
  }
  return path.resolve(value)
}

function assertExternalPath(value, projectRoot, label) {
  const resolved = assertAbsolutePath(value, label)
  const relative = path.relative(path.resolve(projectRoot), resolved)
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error(`${label}必须位于项目目录之外。`)
  }
  return resolved
}

function parseArguments(argv) {
  const options = {}
  const required = ['--config', '--output', '--core-version', '--source-ref', '--license']
  const flags = new Set([...required, '--platform', '--arch'])
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flags.has(flag) || options[flag] !== undefined || !value || value.startsWith('--')) {
      throw new Error('参数无效：需要 --config、--output、--core-version、--source-ref 和 --license。')
    }
    options[flag] = value
  }
  if (required.some(flag => !options[flag])) throw new Error('缺少私有加速资源准备参数。')
  const platform = options['--platform'] ?? 'win32'
  const arch = options['--arch']
  validateTarget(platform, arch)
  return {
    configPath: options['--config'], outputDirectory: options['--output'],
    coreVersion: options['--core-version'], sourceRef: options['--source-ref'], licensePath: options['--license'],
    ...(platform === 'darwin' ? { platform, arch } : {}),
  }
}

function validateTarget(platform, arch) {
  if (platform !== 'win32' && platform !== 'darwin') throw new Error('加速内核平台不受支持。')
  if (platform === 'darwin' && arch !== 'arm64' && arch !== 'x64') throw new Error('必须明确指定 Mac 内核架构 arm64 或 x64。')
  if (platform === 'win32' && arch !== undefined && arch !== 'x64') throw new Error('Windows 加速内核架构不受支持。')
}

function bundleFiles(manifest) {
  return BUNDLE_FILES.map(name => name === 'mihomo.exe' ? manifest.coreFile : name)
}

function validateSourceVersion(coreVersion, sourceRef) {
  if (typeof coreVersion !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,95}$/.test(coreVersion)
    || typeof sourceRef !== 'string' || !/^(?:v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?|[a-f\d]{40})$/.test(sourceRef)) {
    throw new Error('内核版本及对应源码版本必须是已核对的版本号或完整提交号。')
  }
}

function validateLicense(source) {
  if (typeof source !== 'string' || source.length < 25000
    || !source.includes('GNU GENERAL PUBLIC LICENSE') || !/Version 3, 29 June 2007/.test(source)
    || !source.includes('END OF TERMS AND CONDITIONS')) throw new Error('需要提供完整的 Mihomo GNU GPL v3 许可文本。')
}

function parseJson(source, label) {
  try { return JSON.parse(source) } catch { throw new Error(`${label}格式无效。`) }
}

function assertPlainRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式无效。`)
}

function validateManifest(value) {
  assertPlainRecord(value, '加速资源清单')
  const mac = value.version === 2
  if (mac) validateTarget(value.platform, value.arch)
  if ((mac ? value.platform !== 'darwin' || value.coreFile !== 'mihomo' : value.version !== 1 || value.coreFile !== 'mihomo.exe') || value.profileFile !== 'profile.yaml'
    || value.licenseFile !== 'LICENSE-mihomo.txt' || value.noticesFile !== 'THIRD-PARTY-NOTICES.txt'
    || typeof value.coreSha256 !== 'string' || !/^[a-f\d]{64}$/.test(value.coreSha256)
    || typeof value.profileSha256 !== 'string' || !/^[a-f\d]{64}$/.test(value.profileSha256)) {
    throw new Error('加速资源清单格式无效。')
  }
  validateSourceVersion(value.coreVersion, value.sourceRef)
  if (value.sourceUrl !== `${SOURCE_ROOT}/tree/${value.sourceRef}`) throw new Error('加速内核源码地址无效。')
  // Only these non-secret fields cross into integrity-protected app metadata.
  return {
    version: mac ? 2 : 1, ...(mac ? { platform: 'darwin', arch: value.arch } : {}), coreFile: value.coreFile, coreSha256: value.coreSha256,
    profileFile: value.profileFile, profileSha256: value.profileSha256,
    coreVersion: value.coreVersion, sourceRef: value.sourceRef, sourceUrl: value.sourceUrl,
    licenseFile: value.licenseFile, noticesFile: value.noticesFile,
  }
}

function assertDirectorySnapshot(directory, snapshot, safe) {
  safe.assertNoReparseComponents(directory, '私有加速资源目录')
  const current = fs.lstatSync(directory)
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== snapshot.dev || current.ino !== snapshot.ino) {
    throw new Error('私有加速资源目录在准备期间发生变化。')
  }
}

async function stageAccelerationBundle(options, dependencies = {}) {
  const projectRoot = dependencies.projectRoot || PROJECT_ROOT
  const { safe, bounded, parser, binary } = dependencies.runtime || loadRuntime()
  const platform = options.platform ?? 'win32'
  validateTarget(platform, options.arch)
  const configPath = assertExternalPath(options.configPath, projectRoot, '本机配置文件')
  const output = assertExternalPath(options.outputDirectory, projectRoot, '私有资源输出目录')
  const licensePath = assertAbsolutePath(options.licensePath, 'Mihomo 许可文件')
  validateSourceVersion(options.coreVersion, options.sourceRef)
  safe.assertNoReparseComponents(output, '私有资源输出目录')
  if (fs.existsSync(output) && (!fs.lstatSync(output).isDirectory() || fs.readdirSync(output).length)) {
    throw new Error('私有资源输出目录必须不存在或为空，不会覆盖已有文件。')
  }
  const configSource = await safe.readSafeUtf8File(configPath, '本机加速配置', 16 * 1024)
  if (!configSource) throw new Error('未找到本机加速配置。')
  const config = parseJson(configSource, '本机加速配置')
  assertPlainRecord(config, '本机加速配置')
  if (config.version !== 1 || typeof config.coreSha256 !== 'string' || !/^[a-f\d]{64}$/i.test(config.coreSha256)) {
    throw new Error('本机加速配置缺少有效的内核校验值。')
  }
  const corePath = assertExternalPath(config.corePath, projectRoot, '加速内核')
  const profilePath = assertExternalPath(config.profilePath, projectRoot, '加速节点配置')
  for (const input of [configPath, corePath, profilePath, licensePath]) {
    if (path.dirname(input) === output || input === output) throw new Error('输出目录不能覆盖输入文件。')
  }
  const core = await bounded.readBoundedFile(corePath, MAX_CORE_BYTES, '加速内核')
  if (platform === 'darwin') binary.assertMacosAccelerationBinary(core, options.arch)
  else if (core.length < 2 || core[0] !== 0x4d || core[1] !== 0x5a) throw new Error('需要 Windows Mihomo 可执行文件。')
  if (sha256(core) !== config.coreSha256.toLowerCase()) throw new Error('加速内核 SHA256 与已核对记录不一致。')
  const profileSource = await safe.readSafeUtf8File(profilePath, '加速节点配置', parser.MAX_ACCELERATION_CLASH_BYTES)
  if (!profileSource) throw new Error('未找到加速节点配置。')
  const profile = parser.parseClashAccelerationProfile(profileSource)
  // Re-use the runtime's allowlist: subscriptions, DNS/rules, UI names and
  // controller credentials from the original Clash profile never get copied.
  const projectedSource = stringify({ proxies: profile.nodes.map((node) => ({ name: node.label, ...node.connection })) }, { lineWidth: 0 })
  const license = await safe.readSafeUtf8File(licensePath, 'Mihomo 许可文件', 128 * 1024)
  validateLicense(license)
  const manifest = validateManifest({
    version: platform === 'darwin' ? 2 : 1,
    ...(platform === 'darwin' ? { platform, arch: options.arch } : {}),
    coreFile: platform === 'darwin' ? 'mihomo' : 'mihomo.exe', coreSha256: sha256(core),
    profileFile: 'profile.yaml', profileSha256: sha256(projectedSource),
    coreVersion: options.coreVersion, sourceRef: options.sourceRef,
    sourceUrl: `${SOURCE_ROOT}/tree/${options.sourceRef}`,
    licenseFile: 'LICENSE-mihomo.txt', noticesFile: 'THIRD-PARTY-NOTICES.txt',
  })
  const notices = [
    'Mihomo — Copyright MetaCubeX and contributors',
    `Version: ${manifest.coreVersion}`, `Source revision: ${manifest.sourceRef}`,
    'License: GNU General Public License v3.0 (see LICENSE-mihomo.txt)',
    `Corresponding source: ${manifest.sourceUrl}`,
    `Source archive: ${SOURCE_ROOT}/archive/${manifest.sourceRef}.tar.gz`,
    `Binary SHA256: ${manifest.coreSha256}`,
    'The supplied Mihomo binary is redistributed unmodified.', '',
  ].join('\n')
  safe.ensureSafeDataDirectory(output, '私有加速资源目录')
  if (fs.readdirSync(output).length) throw new Error('私有资源输出目录不再为空。')
  const snapshot = fs.lstatSync(output)
  const content = [
    [manifest.coreFile, core], ['profile.yaml', projectedSource],
    ['LICENSE-mihomo.txt', license], ['THIRD-PARTY-NOTICES.txt', notices],
    // The final manifest is the commit marker for a completely staged bundle.
    ['manifest.json', `${JSON.stringify(manifest, null, 2)}\n`],
  ]
  for (const [name, bytes] of content) {
    assertDirectorySnapshot(output, snapshot, safe)
    const target = path.join(output, name)
    if (safe.assertSafeDataFile(target, '私有加速资源')) throw new Error('私有资源输出目录出现重复文件。')
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: platform === 'darwin' && name === manifest.coreFile ? 0o700 : 0o600 })
    if (!safe.assertSafeDataFile(target, '私有加速资源')) throw new Error('私有加速资源写入失败。')
  }
  assertDirectorySnapshot(output, snapshot, safe)
  return { outputDirectory: output, nodeCount: profile.nodes.length, manifest }
}

function resolveAccelerationBundleResources(directory, projectRoot = PROJECT_ROOT, runtime) {
  if (directory === undefined || directory === '') return { resources: [], metadata: undefined }
  const output = assertExternalPath(directory, projectRoot, '私有加速资源目录')
  const { safe } = runtime || loadRuntime()
  safe.assertNoReparseComponents(output, '私有加速资源目录')
  if (!fs.lstatSync(output).isDirectory()) throw new Error('私有加速资源必须是目录。')
  const manifest = validateManifest(parseJson(safe.readSafeUtf8FileSync(path.join(output, 'manifest.json'), '加速资源清单', 16 * 1024), '加速资源清单'))
  const expectedFiles = bundleFiles(manifest)
  const files = fs.readdirSync(output).sort()
  if (JSON.stringify(files) !== JSON.stringify([...expectedFiles].sort())) throw new Error('私有加速资源目录包含缺失或非预期文件。')
  for (const file of expectedFiles) {
    if (!safe.assertSafeDataFile(path.join(output, file), '私有加速资源')) throw new Error('私有加速资源文件缺失。')
  }
  const profileSource = safe.readSafeUtf8FileSync(path.join(output, manifest.profileFile), '加速节点配置', 2 * 1024 * 1024)
  if (!profileSource || sha256(profileSource) !== manifest.profileSha256) throw new Error('加速节点配置与资源清单不一致。')
  validateLicense(safe.readSafeUtf8FileSync(path.join(output, manifest.licenseFile), 'Mihomo 许可文件', 128 * 1024))
  const size = fs.lstatSync(path.join(output, manifest.coreFile)).size
  if (size < 2 || size > MAX_CORE_BYTES) throw new Error('加速内核大小无效。')
  return {
    resources: [{ from: output, to: 'acceleration', filter: expectedFiles }],
    metadata: manifest,
  }
}

async function verifyAccelerationBundleCore(directory, expected, runtime, target) {
  if (!expected) return
  const { bounded, safe, binary } = runtime || loadRuntime()
  if (target) {
    if ((expected.version === 2 ? expected.platform : 'win32') !== target.platform) throw new Error('加速资源与目标平台不一致。')
    if (expected.version === 2 && expected.arch !== target.arch) throw new Error('加速资源与目标架构不一致。')
  }
  safe.assertNoReparseComponents(directory, '私有加速资源目录')
  const resolved = resolveAccelerationBundleResources(directory, PROJECT_ROOT, runtime)
  if (JSON.stringify(resolved.metadata) !== JSON.stringify(expected)) throw new Error('私有资源清单在打包前发生变化。')
  for (const [file, digest, limit] of [
    [expected.coreFile, expected.coreSha256, MAX_CORE_BYTES],
    [expected.profileFile, expected.profileSha256, 2 * 1024 * 1024],
  ]) {
    const bytes = await bounded.readBoundedFile(path.join(directory, file), limit, '私有加速资源')
    if (sha256(bytes) !== digest) throw new Error('私有加速资源与已固定的校验值不一致。')
    if (expected.version === 2 && file === expected.coreFile) binary.assertMacosAccelerationBinary(bytes, expected.arch)
  }
}

async function main(argv = process.argv.slice(2)) {
  const result = await stageAccelerationBundle(parseArguments(argv))
  process.stdout.write(`私有加速资源已准备：${result.nodeCount} 条线路；节点凭据未写入源码。\n`)
}

module.exports = { BUNDLE_FILES, parseArguments, validateManifest, stageAccelerationBundle, resolveAccelerationBundleResources, verifyAccelerationBundleCore, main }

if (require.main === module) {
  main().catch(() => {
    // Node filesystem errors can include private paths, and YAML errors may
    // contain source text. Never serialize those error objects from this tool.
    process.stderr.write('私有加速资源准备失败：请核对绝对路径、空输出目录、内核校验值、源码版本和完整 GPL v3 许可。\n')
    process.exitCode = 1
  })
}
