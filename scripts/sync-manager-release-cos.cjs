#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const {
  MAX_ARTIFACT_BYTES,
  MAX_BLOCKMAP_BYTES,
  MAX_METADATA_BYTES,
  assertBlockmap,
  compareReleaseVersions,
  parseLatestMetadata,
} = require('./update-release-utils.cjs')
const { ARCHITECTURES: MAC_ARCHITECTURES, releaseArtifactNames } = require('./macos-artifact-names.cjs')
const { ARCHITECTURES: LINUX_ARCHITECTURES, debFileName, updateManifestName } = require('./linux-artifact-names.cjs')
const { createManagerSyncDiagnostics, safeManagerSyncFailure } = require('./cos-manager-sync-diagnostics.cjs')

const OBJECT_PREFIX = 'xingmang'
const LATEST_KEY = `${OBJECT_PREFIX}/latest.json`
const MAX_RELEASE_FILES = 24
const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
// Release files go up one after another in a job allowed 330 minutes, so one
// slow installer may use more than the 75 minutes that the 90-minute official
// package jobs keep as their default before cleanly aborting their session.
const MULTIPART_DEADLINE_MS = 120 * 60 * 1000

function validateManagerVersion(version) {
  if (typeof version !== 'string' || version.length > 64
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('星芒发布版本号无效')
  }
  compareReleaseVersions(version, version)
  return version
}

function buildAllowedArtifacts(version) {
  validateManagerVersion(version)
  const files = new Map()
  function add(fileName, platform, architecture, kind, type) {
    const maxBytes = kind === 'manifest' ? MAX_METADATA_BYTES
      : kind === 'blockmap' ? MAX_BLOCKMAP_BYTES : MAX_ARTIFACT_BYTES
    files.set(fileName, { fileName, platform, architecture, kind, type, maxBytes })
  }
  const windowsInstaller = `XingMang-AI-Manager-${version}-Setup.exe`
  add(windowsInstaller, 'windows', 'x64', 'installer', 'application/vnd.microsoft.portable-executable')
  add(`${windowsInstaller}.blockmap`, 'windows', 'x64', 'blockmap', 'application/octet-stream')
  add('latest.yml', 'windows', 'x64', 'manifest', 'text/yaml')
  for (const architecture of MAC_ARCHITECTURES) {
    const names = releaseArtifactNames(version, architecture)
    add(names.dmg, 'macos', architecture, 'installer', 'application/x-apple-diskimage')
    add(names.zip, 'macos', architecture, 'update', 'application/zip')
    add(names.blockmap, 'macos', architecture, 'blockmap', 'application/octet-stream')
  }
  add('latest-mac.yml', 'macos', 'universal', 'manifest', 'text/yaml')
  for (const architecture of LINUX_ARCHITECTURES) {
    add(debFileName(version, architecture), 'linux', architecture, 'installer', 'application/vnd.debian.binary-package')
    add(updateManifestName(architecture), 'linux', architecture, 'manifest', 'text/yaml')
  }
  return files
}

function expectedManifestFiles(version, name) {
  if (name === 'latest.yml') return [`XingMang-AI-Manager-${version}-Setup.exe`]
  if (name === 'latest-mac.yml') return MAC_ARCHITECTURES.map((arch) => releaseArtifactNames(version, arch).zip)
  return LINUX_ARCHITECTURES
    .filter((arch) => updateManifestName(arch) === name)
    .map((arch) => debFileName(version, arch))
}

function assertManifestMatchesFiles(text, name, version, files) {
  const metadata = parseLatestMetadata(text, name)
  if (metadata.version !== version) throw new Error(`${name} 的版本与本次星芒发布版本不一致`)
  const expected = new Set(expectedManifestFiles(version, name))
  if (metadata.files.length !== expected.size || !expected.has(metadata.primaryPath)
    || metadata.files.some((file) => !expected.has(file.relativePath) || file.rawUrl !== file.relativePath)) {
    throw new Error(`${name} 必须精确引用本次发布的对应平台安装包`)
  }
  for (const reference of metadata.files) {
    const file = files.get(reference.relativePath)
    if (!file || reference.size !== file.size || reference.sha512 !== file.sha512) {
      throw new Error(`${name} 引用的 ${reference.relativePath} 大小或 SHA-512 不匹配`)
    }
  }
}

async function buildManagerReleasePlan(directory, version, options = {}) {
  validateManagerVersion(version)
  if (options.installersOnly !== undefined && typeof options.installersOnly !== 'boolean') {
    throw new Error('星芒安装包导入模式无效')
  }
  if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) {
    throw new Error('星芒发布产物目录无效')
  }
  const utilities = options.utilities || require('./cos-sync-utils.cjs')
  const root = path.resolve(directory)
  const rootStat = await fs.promises.lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('星芒发布产物目录必须是普通目录')
  const names = await fs.promises.readdir(root)
  if (names.length === 0 || names.length > MAX_RELEASE_FILES) throw new Error('星芒发布产物数量无效')
  const allowed = buildAllowedArtifacts(version)
  const platforms = new Set()
  const files = new Map()
  for (const name of names.sort()) {
    const descriptor = allowed.get(name)
    if (!descriptor || (options.installersOnly === true && descriptor.kind !== 'installer')) {
      throw new Error(`星芒发布目录包含不允许同步的文件：${name}`)
    }
    platforms.add(descriptor.platform)
  }
  for (const descriptor of allowed.values()) {
    // GitHub Releases carry installers only. Importing those published bytes
    // must not invent updater manifests or weaken the full publish hook.
    if (options.installersOnly !== true && platforms.has(descriptor.platform) && !names.includes(descriptor.fileName)) {
      throw new Error(`星芒发布产物不完整，缺少 ${descriptor.fileName}`)
    }
  }
  for (const name of names) {
    const descriptor = allowed.get(name)
    const filePath = path.join(root, name)
    const digest = await utilities.hashFile(filePath, { maxBytes: descriptor.maxBytes })
    files.set(name, {
      ...descriptor,
      path: filePath,
      version,
      key: `${OBJECT_PREFIX}/releases/${version}/${name}`,
      size: digest.bytes,
      sha256: digest.sha256,
      sha512: digest.sha512,
    })
  }
  for (const file of files.values()) {
    if (file.kind !== 'manifest' && file.kind !== 'blockmap') continue
    const buffer = await utilities.readBoundedRegularFile(file.path, { maxBytes: file.maxBytes })
    if (createHash('sha256').update(buffer).digest('hex') !== file.sha256) {
      throw new Error(`星芒产物在校验期间发生变更：${file.fileName}`)
    }
    if (file.kind === 'blockmap') assertBlockmap(buffer, file.fileName, 'COS_BLOCKMAP_INVALID')
    else assertManifestMatchesFiles(buffer.toString('utf8'), file.fileName, version, files)
  }
  return { version, platforms: [...platforms].sort(), files: [...files.values()] }
}

function publicObjectUrl(publicBaseUrl, key) {
  const base = new URL(publicBaseUrl)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('COS 公开下载地址必须是无凭据的 HTTPS 地址')
  }
  const prefix = base.href.endsWith('/') ? base.href : `${base.href}/`
  return new URL(key.split('/').map(encodeURIComponent).join('/'), prefix).href
}

function publicEntry(file, publicBaseUrl) {
  return {
    fileName: file.fileName,
    version: file.version,
    platform: file.platform,
    architecture: file.architecture,
    kind: file.kind,
    key: file.key,
    url: publicObjectUrl(publicBaseUrl, file.key),
    size: file.size,
    sha256: file.sha256,
    type: file.type,
  }
}

function validateManagerIndex(value, publicBaseUrl) {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== 1 || value.product !== 'xingmang-ai-manager'
    || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_RELEASE_FILES) {
    throw new Error('COS 星芒版本索引格式无效，未更新最新指针')
  }
  validateManagerVersion(value.version)
  const seen = new Set()
  const files = value.files.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('COS 星芒索引文件条目无效')
    validateManagerVersion(entry.version)
    const descriptor = buildAllowedArtifacts(entry.version).get(entry.fileName)
    const key = `${OBJECT_PREFIX}/releases/${entry.version}/${entry.fileName}`
    if (!descriptor || entry.key !== key || entry.url !== publicObjectUrl(publicBaseUrl, key)
      || entry.type !== descriptor.type || entry.platform !== descriptor.platform
      || entry.architecture !== descriptor.architecture || entry.kind !== descriptor.kind
      || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > descriptor.maxBytes
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || compareReleaseVersions(entry.version, value.version) > 0 || seen.has(entry.fileName)) {
      throw new Error('COS 星芒索引包含无效文件地址、版本或摘要，未更新最新指针')
    }
    seen.add(entry.fileName)
    return publicEntry(entry, publicBaseUrl)
  })
  return { schemaVersion: 1, product: 'xingmang-ai-manager', version: value.version, files }
}

function buildManagerIndex(plan, previous, publicBaseUrl) {
  const existing = validateManagerIndex(previous, publicBaseUrl)
  if (existing && compareReleaseVersions(plan.version, existing.version) < 0) {
    throw new Error(`COS 已同步更高版本 ${existing.version}，不能回退到 ${plan.version}`)
  }
  const incoming = plan.files.map((file) => publicEntry(file, publicBaseUrl))
  const incomingPlatforms = new Set(incoming.map((file) => file.platform))
  const kept = (existing?.files || []).filter((file) => (
    file.version === plan.version || !incomingPlatforms.has(file.platform)
  ))
  const files = new Map(kept.map((file) => [file.fileName, file]))
  for (const entry of incoming) {
    const old = files.get(entry.fileName)
    if (old && (old.size !== entry.size || old.sha256 !== entry.sha256 || old.type !== entry.type)) {
      throw new Error(`COS 已发布同版本文件 ${entry.fileName}，不能替换内容`)
    }
    files.set(entry.fileName, entry)
  }
  return {
    schemaVersion: 1,
    product: 'xingmang-ai-manager',
    version: plan.version,
    files: [...files.values()].sort((left, right) => left.fileName.localeCompare(right.fileName, 'en')),
  }
}

async function syncManagerRelease(options) {
  const utilities = options.utilities || require('./cos-sync-utils.cjs')
  let latestState = 'not-written-by-this-run'
  const stage = createManagerSyncDiagnostics(options.onDiagnostic, function () { return latestState })
  const { config, plan, store } = await stage('prepare-manager-plan', { version: options.version }, async function () {
    const config = options.config || utilities.readCosConfiguration(options.env || process.env)
    const plan = await buildManagerReleasePlan(options.directory, options.version, { utilities, installersOnly: options.installersOnly })
    return { config, plan, store: options.store || utilities.createCosStore(config, { multipartDeadlineMs: MULTIPART_DEADLINE_MS }) }
  })
  const previous = await stage('cos-read-latest', { version: plan.version }, function (report) { return store.readJson(LATEST_KEY, { onRetry: report.retry }) })
  await stage('cos-validate-index', { version: plan.version }, function () { return buildManagerIndex(plan, previous, config.publicBaseUrl) })
  // The updater manifests belong beside their relative payloads. The root
  // pointer is an independent JSON index with absolute URLs and is touched
  // only after every immutable object has passed a full public readback.
  const ordered = [...plan.files].sort((left, right) => Number(left.kind === 'manifest') - Number(right.kind === 'manifest'))
  for (const file of ordered) {
    await stage('cos-publish-file', { version: plan.version, platform: file.platform, architecture: file.architecture }, async function (report) {
      const published = await store.publishFile(file.key, file.path, {
        contentType: file.type,
        cacheControl: IMMUTABLE_CACHE_CONTROL,
        expectedBytes: file.size,
        expectedSha256: file.sha256,
        onProgress: report.transfer,
        onRetry: report.retry,
      })
      if (published.bytes !== file.size || published.sha256 !== file.sha256 || published.contentType !== file.type
        || published.url !== publicObjectUrl(config.publicBaseUrl, file.key)) {
        throw new Error(`COS 上传回读与已验证产物不一致：${file.fileName}，未更新最新指针`)
      }
    })
  }
  // Re-read before the mutable write so a CLI run or a platform supplement
  // cannot silently discard another successfully published platform.
  const index = await stage('cos-recheck-latest', { version: plan.version }, async function (report) {
    const current = await store.readJson(LATEST_KEY, { onRetry: report.retry })
    return buildManagerIndex(plan, current, config.publicBaseUrl)
  })
  const candidateDigest = createHash('sha256').update(JSON.stringify(index)).digest('hex')
  const candidateKey = `${OBJECT_PREFIX}/releases/${plan.version}/indexes/${candidateDigest}.json`
  await stage('cos-publish-candidate', { version: plan.version }, function (report) { return store.publishJson(candidateKey, index, { cacheControl: IMMUTABLE_CACHE_CONTROL, onRetry: report.retry }) })
  await stage('cos-recheck-candidate-state', { version: plan.version }, async function (report) {
    const beforeSwitch = await store.readJson(LATEST_KEY, { onRetry: report.retry })
    if (JSON.stringify(buildManagerIndex(plan, beforeSwitch, config.publicBaseUrl)) !== JSON.stringify(index)) {
      throw new Error('COS 平台索引在候选清单核验期间发生变更，请重跑同步；未覆盖最新指针')
    }
  })
  latestState = 'write-unconfirmed'
  await stage('cos-publish-latest', { version: plan.version }, async function (report) {
    const result = await store.publishJson(LATEST_KEY, index, { overwrite: true, cacheControl: 'no-cache', onRetry: report.retry })
    latestState = 'published-and-read-back'
    return result
  })
  return index
}

function parseArguments(argv) {
  const options = {}
  const accepted = new Set(['--directory', '--version'])
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    if (!accepted.has(flag) || argv[index + 1] === undefined || options[flag.slice(2)] !== undefined) {
      throw new Error('用法：sync-manager-release-cos.cjs --directory <发布目录> --version <版本号>')
    }
    options[flag.slice(2)] = argv[index + 1]
  }
  if (!options.directory || !options.version) throw new Error('星芒 COS 同步必须指定发布目录和版本号')
  return options
}

async function main(argv) {
  const result = await syncManagerRelease({ ...parseArguments(argv), onDiagnostic: function (event) { console.log(`[manager-sync] ${JSON.stringify(event)}`) } })
  console.log(`星芒 ${result.version} 已同步 COS，共 ${result.files.length} 个文件；现有客户端更新源保持不变`)
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    // COS errors can carry signed request details. The Actions log must never
    // include an upstream exception or credentials when publication fails.
    console.error(`::error::星芒 COS 同步失败；安全诊断：${JSON.stringify(safeManagerSyncFailure(error))}`)
    process.exitCode = 1
  })
}

module.exports = {
  LATEST_KEY,
  buildAllowedArtifacts,
  buildManagerIndex,
  buildManagerReleasePlan,
  parseArguments,
  syncManagerRelease,
  validateManagerIndex,
}
