const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const https = require('node:https')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { performance } = require('node:perf_hooks')
const { checkFailure, observedArchitectures, observedProcessFailure, safeSyncFailure } = require('./cos-sync-utils.cjs')

// Mac 上一键装 OpenCode 从 GitHub 下官方的 .app.tar.gz（electron/macos-desktop-app-installer.ts），国内时好时坏，
// 以前靠加速。yoyo 2026-10-14 定「做」：和 Codex、Claude 桌面端一样放进星芒的腾讯云存储桶，客户端先从桶里下
// （electron/desktop-package-bucket.ts），解开后照旧核 bundle id、Team ID 签名和 Gatekeeper；桶里没有或对不上，
// 照旧去 GitHub。每次同步问 OpenCode 最新一版的 latest.json（客户端问的就是它），版本变了才下两种芯片的包。
//
// Trust: the feed and the packages come only from github.com's release paths of
// anomalyco/opencode and GitHub's two release-asset hosts; every redirect hop is checked
// against that allow-list before it is followed, and the download itself never follows one.
// The feed may only name the package URL this script builds for that version itself (the
// client's selectOpenCodeRelease rule). A package is uploaded only after this macOS runner
// unpacks it to exactly OpenCode.app with bundle ai.opencode.desktop, codesign accepts the
// Developer ID requirement pinned to team 5NZ4Q7NXJ4 and Gatekeeper accepts it, so the
// client never downloads a package it would refuse. Nothing from the package is run.

const FEED_URL = 'https://github.com/anomalyco/opencode/releases/latest/download/latest.json'
const RELEASE_PATH_PREFIX = '/anomalyco/opencode/releases/'
const ASSET_HOSTS = Object.freeze(['release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
// Keep the packages inside the already authorized manager prefix (docs/cos-sync-policy.json).
const PREFIX = 'xingmang/offline/opencode'
const LATEST_KEY = `${PREFIX}/latest.json`
const PRODUCT = 'opencode-desktop'
const CONTENT_TYPE = 'application/gzip'
const VERIFICATION = 'macos-developer-id-notarized'
const BUNDLE_IDENTIFIER = 'ai.opencode.desktop'
const TEAM_IDENTIFIER = '5NZ4Q7NXJ4'
const APPLICATION = 'OpenCode.app'
// 同客户端 desktop-package-bucket.ts 的下限、macos-desktop-app-installer.ts 给 OpenCode 的上限。v1.18.34 是 152 MB。
const MIN_PACKAGE_BYTES = 10 * 1024 * 1024
const MAX_PACKAGE_BYTES = 640 * 1024 * 1024
const MAX_FEED_BYTES = 512 * 1024
const MAX_REDIRECTS = 4
const HEAD_TIMEOUT_MS = 30000
const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const PLATFORMS = Object.freeze({
  'macos-arm64': Object.freeze({ architecture: 'arm64', feedKey: 'darwin-aarch64', machine: 'arm64' }),
  'macos-x64': Object.freeze({ architecture: 'x64', feedKey: 'darwin-x86_64', machine: 'x86_64' }),
})
const PLATFORM_IDS = Object.freeze(Object.keys(PLATFORMS))
const stageFailures = new WeakMap()

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function packageFileName(platformId) {
  return `opencode-desktop-mac-${PLATFORMS[platformId].architecture}.app.tar.gz`
}

function packageSourceUrl(version, platformId) {
  return `https://github.com${RELEASE_PATH_PREFIX}download/v${version}/${packageFileName(platformId)}`
}

function packageKey(platformId, sha256) {
  return `${PREFIX}/${platformId}/sha256-${sha256}/${packageFileName(platformId)}`
}

// Every hop must stay on github.com's release paths for this repository or land on one of
// GitHub's asset hosts, which serve the bytes behind a short-lived signed query.
function validateHop(value) {
  let url
  try { url = new URL(value) } catch { throw checkFailure('source-url-rejected', 'OpenCode 下载地址格式无效') }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) throw checkFailure('source-url-rejected', 'OpenCode 下载地址不是允许的 HTTPS 地址')
  if (url.hostname === 'github.com' && url.pathname.startsWith(RELEASE_PATH_PREFIX) && !url.search) return url
  if (ASSET_HOSTS.includes(url.hostname)) return url
  throw checkFailure('source-url-rejected', `OpenCode 下载被转到了不认识的地址（${url.hostname}）`)
}

/** Same rule as selectOpenCodeRelease in electron/macos-desktop-app-installer.ts. */
function parseFeed(value) {
  if (!isRecord(value) || !isRecord(value.platforms) || typeof value.version !== 'string' || !VERSION_PATTERN.test(value.version)) throw checkFailure('metadata-invalid', 'OpenCode 的 latest.json 格式无效')
  for (const platformId of PLATFORM_IDS) {
    const entry = value.platforms[PLATFORMS[platformId].feedKey]
    if (!isRecord(entry) || entry.url !== packageSourceUrl(value.version, platformId)) throw checkFailure('metadata-invalid', 'OpenCode 的 latest.json 没有写这一版的 Mac 安装包')
  }
  return value.version
}

function validateLatest(value, publicUrl) {
  if (value === null || value === undefined) return null
  if (!isRecord(value) || value.schemaVersion !== 1 || value.product !== PRODUCT || typeof value.generatedAt !== 'string'
    || typeof value.version !== 'string' || !VERSION_PATTERN.test(value.version) || !isRecord(value.source) || value.source.feedUrl !== FEED_URL
    || !Array.isArray(value.files) || value.files.length !== PLATFORM_IDS.length) throw checkFailure('cos-index-invalid', 'COS 现有 OpenCode 清单格式无效，已保留现有清单')
  const platforms = new Set()
  for (const file of value.files) {
    const spec = isRecord(file) ? PLATFORMS[file.platformId] : null
    if (!spec || platforms.has(file.platformId) || file.platform !== 'macos' || file.architecture !== spec.architecture
      || file.kind !== 'app-archive' || file.format !== 'tar.gz' || file.fileName !== packageFileName(file.platformId)
      || file.type !== CONTENT_TYPE || file.verification !== VERIFICATION || file.version !== value.version
      || !SHA256_PATTERN.test(file.sha256 || '') || file.key !== packageKey(file.platformId, file.sha256)
      || typeof file.url !== 'string' || (publicUrl && file.url !== publicUrl(file.key))
      || !Number.isSafeInteger(file.size) || file.size < MIN_PACKAGE_BYTES || file.size > MAX_PACKAGE_BYTES
      || file.sourceUrl !== packageSourceUrl(value.version, file.platformId)) throw checkFailure('cos-index-invalid', 'COS 现有 OpenCode 清单的文件记录无效')
    if (typeof file.cosEtag !== 'string' || !file.cosEtag || file.cosEtag.length > 256 || /[\r\n]/.test(file.cosEtag)) throw checkFailure('cos-index-invalid', 'COS 现有 OpenCode 清单缺少已核验对象指纹')
    platforms.add(file.platformId)
  }
  return value
}

function safeOpenCodeSyncFailure(error) {
  const failure = stageFailures.get(error)
  if (!failure) return { stage: 'setup', latestState: 'not-written-by-this-run', failure: { code: 'operation-failed' } }
  return { ...failure.context, failure: safeSyncFailure(failure.error) }
}

function createStageRunner(progress, pointerState) {
  function emit(value) {
    if (typeof progress === 'function') {
      try { progress(value) } catch {}
    }
  }
  return async function (stage, input, operation) {
    const started = performance.now()
    const context = { stage, ...input }
    function report(event, extra = {}) {
      emit({ event, ...context, elapsedMs: Math.round(performance.now() - started), ...extra })
    }
    function transfer(value) {
      const safe = {}
      if (['GET', 'HEAD', 'PUT'].includes(value.method)) safe.method = value.method
      if (['upload-body', 'response-headers', 'response-body', 'complete'].includes(value.phase)) safe.transferPhase = value.phase
      for (const name of ['transferredBytes', 'expectedBytes']) {
        if (Number.isSafeInteger(value[name]) && value[name] >= 0 && value[name] <= MAX_PACKAGE_BYTES) safe[name === 'expectedBytes' ? 'transferExpectedBytes' : name] = value[name]
      }
      report('transfer', safe)
    }
    report('stage-start')
    try {
      const result = await operation(transfer)
      report('stage-complete')
      return result
    } catch (error) {
      // Raw exceptions stay in memory; diagnostics are rebuilt from the private records.
      const wrapped = new Error(error instanceof Error ? error.message : 'OpenCode 同步阶段失败')
      stageFailures.set(wrapped, { error, context: { ...context, latestState: pointerState() } })
      report('stage-failed', { diagnostic: safeOpenCodeSyncFailure(wrapped) })
      throw wrapped
    }
  }
}

/** Walks github.com's redirects one HEAD at a time until GitHub names an asset host. */
async function resolveAssetUrl(url, dependencies) {
  let current = validateHop(url)
  const visited = new Set()
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (ASSET_HOSTS.includes(current.hostname)) return current.href
    if (visited.has(current.href)) throw checkFailure('source-url-rejected', 'OpenCode 下载发生了循环重定向')
    visited.add(current.href)
    const result = await dependencies.requestHead(current.href)
    if (![301, 302, 303, 307, 308].includes(result.status) || typeof result.location !== 'string' || result.location.length > 4096) throw checkFailure('source-url-rejected', `GitHub 没有给出 OpenCode 下载地址（HTTP ${Number.isInteger(result.status) ? result.status : 0}）`)
    current = validateHop(new URL(result.location, current).href)
  }
  throw checkFailure('source-url-rejected', 'OpenCode 下载重定向次数过多')
}

async function verifyUnchangedArtifact(store, file) {
  const current = await store.inspect(file.key)
  const contentType = typeof current?.contentType === 'string' ? current.contentType.split(';')[0].trim().toLowerCase() : ''
  return Boolean(current && current.bytes === file.size && current.etag === file.cosEtag && contentType === file.type)
}

async function synchronizeOpenCode({ store, dependencies, progress, now = function () { return new Date().toISOString() } }) {
  let latestState = 'not-written-by-this-run'
  const stage = createStageRunner(progress, function () { return latestState })
  const old = await stage('cos-read-latest', {}, async function () {
    return validateLatest(await store.readJson(LATEST_KEY, { missingOk: true }), store.publicUrl)
  })
  const version = await stage('source-feed', {}, async function () {
    const feedUrl = await resolveAssetUrl(FEED_URL, dependencies)
    return parseFeed(await dependencies.fetchJson({ url: feedUrl, allowedHosts: ASSET_HOSTS, maxBytes: MAX_FEED_BYTES, headers: { accept: 'application/json', 'user-agent': 'xingmang-opencode-cos-sync/1' } }))
  })
  if (old && old.version === version) {
    let intact = true
    for (const file of old.files) {
      if (!await stage('cos-check-existing', { platformId: file.platformId }, function () { return verifyUnchangedArtifact(store, file) })) intact = false
    }
    if (intact) return { changed: false, manifest: old }
  }
  const workDirectory = await stage('prepare-temp', {}, function () { return dependencies.createWorkDirectory() })
  let primaryError
  try {
    const files = []
    for (const platformId of PLATFORM_IDS) {
      const context = { version, platformId }
      const filePath = path.join(workDirectory, packageFileName(platformId))
      const sourceUrl = packageSourceUrl(version, platformId)
      const downloaded = await stage('source-download', context, async function (onProgress) {
        const assetUrl = await resolveAssetUrl(sourceUrl, dependencies)
        const result = await dependencies.downloadResource({ url: assetUrl, filePath, allowedHosts: ASSET_HOSTS, maxBytes: MAX_PACKAGE_BYTES, headers: { accept: 'application/octet-stream', 'user-agent': 'xingmang-opencode-cos-sync/1' }, onProgress })
        if (!result || !Number.isSafeInteger(result.bytes) || result.bytes < MIN_PACKAGE_BYTES || result.bytes > MAX_PACKAGE_BYTES || !SHA256_PATTERN.test(result.sha256 || '')) throw checkFailure('download-mismatch', 'OpenCode 安装包大小或摘要无效')
        return { bytes: result.bytes, sha256: result.sha256 }
      })
      await stage('verify-package', { ...context, expectedBytes: downloaded.bytes }, async function () {
        const inspected = await dependencies.inspectPackage(filePath, workDirectory, PLATFORMS[platformId].machine)
        if (inspected.version !== version) throw checkFailure('package-identity-mismatch', 'OpenCode 应用里写的版本和 latest.json 不一致', { expectedVersion: version, packageVersion: inspected.version, bundleIdentifier: inspected.bundleIdentifier })
      })
      const key = packageKey(platformId, downloaded.sha256)
      const published = await stage('cos-publish-package', { ...context, expectedBytes: downloaded.bytes }, async function (onProgress) {
        const result = await store.publishFile(key, filePath, { expectedBytes: downloaded.bytes, expectedSha256: downloaded.sha256, contentType: CONTENT_TYPE, cacheControl: 'public, max-age=31536000, immutable', onProgress })
        if (result.bytes !== downloaded.bytes || result.sha256 !== downloaded.sha256) throw checkFailure('cos-object-mismatch', 'COS OpenCode 安装包公共下载校验结果不一致')
        return result
      })
      const head = await stage('cos-head-package', context, async function () {
        const result = await store.inspect(key)
        if (!result || result.bytes !== downloaded.bytes || typeof result.etag !== 'string' || result.etag !== published.etag) throw checkFailure('cos-object-mismatch', 'COS OpenCode 安装包发布后的 HEAD 与已核验正文不一致')
        return result
      })
      await dependencies.removeFile(filePath)
      files.push({
        platformId, platform: 'macos', architecture: PLATFORMS[platformId].architecture, kind: 'app-archive', format: 'tar.gz',
        fileName: packageFileName(platformId), type: CONTENT_TYPE, verification: VERIFICATION, version, key, url: store.publicUrl(key),
        size: downloaded.bytes, sha256: downloaded.sha256, sourceUrl, cosEtag: head.etag,
      })
    }
    const manifest = { schemaVersion: 1, product: PRODUCT, generatedAt: now(), version, source: { feedUrl: FEED_URL }, files }
    await stage('validate-latest', {}, async function () { validateLatest(manifest, store.publicUrl) })
    await stage('cos-recheck-latest', {}, async function () {
      const current = validateLatest(await store.readJson(LATEST_KEY, { missingOk: true }), store.publicUrl)
      if (JSON.stringify(current) !== JSON.stringify(old)) throw checkFailure('cos-index-changed', 'COS OpenCode 清单在同步期间发生变化，停止发布以保留现有状态')
    })
    latestState = 'write-unconfirmed'
    await stage('cos-publish-latest', {}, function (onProgress) { return store.publishJson(LATEST_KEY, manifest, { overwrite: true, cacheControl: 'no-cache, max-age=0, must-revalidate', onProgress }) })
    latestState = 'published-and-read-back'
    return { changed: true, manifest }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try { await stage('cleanup-temp', {}, function () { return dependencies.removeWorkDirectory(workDirectory) }) } catch (error) {
      if (!primaryError) throw error
    }
  }
}

function requestHead(url, requestImpl = https.request) {
  const target = validateHop(url)
  return new Promise(function (resolve, reject) {
    let settled = false
    let request
    const timer = setTimeout(function () { fail(new Error('GitHub 响应头超时')) }, HEAD_TIMEOUT_MS)
    function fail(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
      if (request) request.destroy()
    }
    try {
      request = requestImpl(target, { method: 'HEAD', headers: { 'accept-encoding': 'identity', 'user-agent': 'xingmang-opencode-cos-sync/1' }, agent: false, maxHeaderSize: 16 * 1024 }, function (response) {
        if (settled) { response.destroy(); return }
        settled = true
        clearTimeout(timer)
        resolve({ status: response.statusCode, location: response.headers.location })
        response.destroy()
      })
      request.on('error', function () { fail(new Error('GitHub 网络请求失败')) })
      request.end()
    } catch { fail(new Error('GitHub 网络请求失败')) }
  })
}

function darwinOpenCodeRequirement() {
  // Same clauses as darwinDeveloperIdRequirement in electron/macos-code-signing.ts.
  return [`identifier "${BUNDLE_IDENTIFIER}"`, 'anchor apple generic',
    'certificate 1[field.1.2.840.113635.100.6.2.6] exists',
    'certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
    `certificate leaf[subject.OU] = "${TEAM_IDENTIFIER}"`,
  ].join(' and ')
}

function safeChildEnvironment(directory) {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: directory, TMPDIR: directory, LANG: 'C', LC_ALL: 'C' }
}

/**
 * Unpacks with the same bsdtar the client uses and checks the bundle the way the client's
 * verifyExtractedBundle does: exactly OpenCode.app, the pinned bundle id, the Developer ID
 * requirement and Gatekeeper. The bundle's version and its main executable's architecture
 * are read too, so a package cannot be filed under the wrong version or chip.
 */
async function inspectPackage(filePath, workDirectory, machine, run = promisify(execFile), platform = process.platform) {
  if (platform !== 'darwin') throw checkFailure('inspector-unavailable', 'OpenCode 签名检查必须在 macOS runner 运行')
  const extractDirectory = path.join(workDirectory, `extract-${machine}`)
  await fs.mkdir(extractDirectory, { mode: 0o700 })
  async function inspect(executable, args, code, failure) {
    try { return await run(executable, args, { env: safeChildEnvironment(workDirectory), timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 }) } catch (error) { throw checkFailure(code, failure, observedProcessFailure(error)) }
  }
  try {
    await inspect('/usr/bin/tar', ['-xzf', filePath, '-C', extractDirectory], 'package-format-invalid', 'OpenCode 安装包解不开')
    const entries = await fs.readdir(extractDirectory)
    if (entries.length !== 1 || entries[0] !== APPLICATION) throw checkFailure('package-format-invalid', `OpenCode 安装包里应当只有 ${APPLICATION}`)
    const application = path.join(extractDirectory, APPLICATION)
    const stats = await fs.lstat(application)
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw checkFailure('package-format-invalid', `${APPLICATION} 不是普通目录`)
    const metadata = await inspect('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(application, 'Contents', 'Info.plist')], 'inspection-unparsable', 'OpenCode 的 Info.plist 读不出来')
    let info
    try { info = JSON.parse(metadata.stdout) } catch { throw checkFailure('inspection-unparsable', 'OpenCode 的 Info.plist 读不出来') }
    if (!isRecord(info) || info.CFBundleIdentifier !== BUNDLE_IDENTIFIER) throw checkFailure('package-identity-mismatch', `OpenCode 的 bundle id 不是 ${BUNDLE_IDENTIFIER}`, { bundleIdentifier: isRecord(info) ? info.CFBundleIdentifier : undefined })
    if (typeof info.CFBundleExecutable !== 'string' || !/^[A-Za-z0-9._ -]{1,128}$/.test(info.CFBundleExecutable)) throw checkFailure('package-identity-mismatch', 'OpenCode 的可执行文件名无效')
    await inspect('/usr/bin/codesign', ['--verify', '--strict', '--deep', `-R=${darwinOpenCodeRequirement()}`, application], 'package-signature-invalid', `OpenCode 的签名不是 ${TEAM_IDENTIFIER} 团队的 Developer ID`)
    await inspect('/usr/sbin/spctl', ['--assess', '--type', 'execute', application], 'package-signature-invalid', 'Gatekeeper 没有放行 OpenCode')
    const architectures = await inspect('/usr/bin/lipo', ['-archs', path.join(application, 'Contents', 'MacOS', info.CFBundleExecutable)], 'inspection-unparsable', 'OpenCode 主程序的芯片读不出来')
    const archs = architectures.stdout.trim().split(/\s+/)
    if (!archs.includes(machine)) throw checkFailure('package-identity-mismatch', 'OpenCode 主程序的芯片和文件名不一致', { packageArchitecture: observedArchitectures(archs) })
    return { version: info.CFBundleShortVersionString, bundleIdentifier: info.CFBundleIdentifier, minimumSystemVersion: info.LSMinimumSystemVersion ?? null }
  } finally {
    await fs.rm(extractDirectory, { recursive: true, force: true })
  }
}

function createRuntimeDependencies(common) {
  return {
    fetchJson: common.fetchJson,
    downloadResource: common.downloadResource,
    requestHead: function (url) { return requestHead(url) },
    inspectPackage: function (filePath, workDirectory, machine) { return inspectPackage(filePath, workDirectory, machine) },
    removeFile: function (filePath) { return fs.rm(filePath, { force: true }) },
    createWorkDirectory: async function () { return fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'xingmang-opencode-cos-')) },
    removeWorkDirectory: async function (directory) {
      const resolved = path.resolve(directory)
      const temporaryRoot = await fs.realpath(os.tmpdir())
      if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('xingmang-opencode-cos-')) throw checkFailure('temp-path-rejected', '拒绝删除临时同步目录以外的路径')
      await fs.rm(resolved, { recursive: true, force: true })
    },
  }
}

async function main() {
  const common = require('./cos-sync-utils.cjs')
  if (process.argv.length > 2) throw checkFailure('platform-invalid', 'OpenCode 同步不接受命令行参数')
  const config = common.readCosConfiguration(process.env)
  const result = await synchronizeOpenCode({ store: common.createCosStore(config), dependencies: createRuntimeDependencies(common),
    progress: function (event) { console.log(`[opencode-sync] ${JSON.stringify(event)}`) } })
  console.log(JSON.stringify({ changed: result.changed, version: result.manifest.version, files: result.manifest.files.map(function (file) { return { platformId: file.platformId, size: file.size } }) }))
}

if (require.main === module) {
  main().catch(function (error) {
    console.error(`OpenCode 同步失败；安全诊断：${JSON.stringify(safeOpenCodeSyncFailure(error))}`)
    process.exitCode = 1
  })
}

module.exports = { FEED_URL, ASSET_HOSTS, LATEST_KEY, PRODUCT, CONTENT_TYPE, VERIFICATION, BUNDLE_IDENTIFIER, TEAM_IDENTIFIER, MIN_PACKAGE_BYTES, MAX_PACKAGE_BYTES, PLATFORMS,
  packageFileName, packageSourceUrl, packageKey, validateHop, parseFeed, validateLatest, resolveAssetUrl, darwinOpenCodeRequirement, requestHead, inspectPackage,
  synchronizeOpenCode, createRuntimeDependencies, safeOpenCodeSyncFailure }
