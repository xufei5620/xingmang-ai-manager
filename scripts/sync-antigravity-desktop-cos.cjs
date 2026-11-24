const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { performance } = require('node:perf_hooks')
const { checkFailure, observedArchitectures, observedProcessFailure, safeSyncFailure } = require('./cos-sync-utils.cjs')
const { WINDOWS_SIGNER } = require('./sync-antigravity-cli-cos.cjs')

// 一键装 Antigravity 桌面端要从谷歌下（electron/antigravity-desktop-release.ts 读的那份更新信息），国内连不上谷歌，
// 下载加速 10-30 又下线了（0.2.25 复查第 1 轮第 2 条）。照 agy 的做法（sync-antigravity-cli-cos.cjs）放桶：
// 谷歌签过名的安装包原样放进星芒的腾讯云存储桶，客户端先从桶里下（electron/desktop-package-bucket.ts），
// 桶里没有或对不上再回谷歌，核谷歌签名那几道一行不改。
// 每次同步问谷歌四份更新信息，版本或构建号变了才下。Windows 的在 Windows 机器上核 Authenticode，Mac 的在 Mac 机器上
// 解开 zip 核 Developer ID、公证和芯片，所以同一份脚本在两种机器上各跑一半，各写各的清单（windows.json、macos.json），
// 互不覆盖。Antigravity 是谷歌的闭源程序，跟 Claude 桌面端一样原件转发，不另带许可文件（D98 只管开源的那两家）。
//
// Trust: only Google's feed host and its artifact host are contacted, every URL is built from
// the constants below and the shared transport refuses redirects. A feed is accepted only when
// its one file URL is exactly the one this script builds from the version and build it names
// (the client's parseAntigravityDesktopFeed rule), and the download must be the size and SHA-512
// the feed declares. A Windows installer is uploaded only after this runner's
// Get-AuthenticodeSignature reports a valid signature from Google LLC issued by DigiCert's code
// signing CA (the same signer as agy, so WINDOWS_SIGNER is shared). A Mac archive is uploaded only
// after it unpacks to exactly Antigravity.app whose bundle id and version are the expected ones,
// whose signature satisfies Google's Developer ID requirement (com.google.antigravity, team
// EQHXZ8M8AV), which Gatekeeper accepts and whose main executable carries the platform's chip.
// Nothing downloaded is ever executed here: this job holds the bucket's upload credentials.
// Objects are stored under their own SHA-256 so a published object is never overwritten; the
// client checks the signature again before installing anything.

const FEED_ORIGIN = 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app'
const ARTIFACT_ORIGIN = 'https://storage.googleapis.com'
const ARTIFACT_PATH_PREFIX = '/antigravity-public/antigravity-hub/'
const OFFICIAL_HOSTS = Object.freeze([new URL(FEED_ORIGIN).hostname, new URL(ARTIFACT_ORIGIN).hostname])
// Keep the packages inside the already authorized manager prefix (docs/cos-sync-policy.json).
const PREFIX = 'xingmang/offline/antigravity-desktop'
const PRODUCT = 'antigravity-desktop'
// 同客户端 antigravity-desktop-release.ts 收谷歌那一份时的上下限（2.34.0：Windows 160、170 MB，Mac 212、223 MB）。
const MIN_ARTIFACT_BYTES = 16 * 1024 * 1024
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024
const MAX_FEED_BYTES = 16 * 1024
const VERSION_PATTERN = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/
const BUILD_PATTERN = /^[1-9]\d{0,24}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SHA512_PATTERN = /^[a-f0-9]{128}$/
const BASE64_SHA512_PATTERN = /^[A-Za-z0-9+/]{86}==$/
const APPLICATION = 'Antigravity.app'
const BUNDLE_IDENTIFIER = 'com.google.antigravity'
const TEAM_IDENTIFIER = 'EQHXZ8M8AV'
// 发给官方下载站的标识不带我们的名字和仓库名，对方从访问记录查不到我们（安全清单 安-1）。
const USER_AGENT = 'offline-package-sync/1'

// feedName / directory / sourceFileName 是谷歌那边的名字（2.34.0 实测）；fileName 是桶里的名字，客户端
// desktop-package-bucket.ts 按它拼对象路径。谷歌两种芯片的 Mac 包都叫 Antigravity.zip，桶里按芯片分开叫。
// electron-builder 的 NSIS 安装程序本身是 32 位的外壳，PE 头说明不了它装哪种芯片，所以 Windows 不看芯片：
// 地址按平台的目录拼，内容由谷歌更新信息里的 SHA-512 绑住。
const PLATFORMS = Object.freeze({
  'windows-x64': Object.freeze({ family: 'windows', architecture: 'x64', feedName: 'latest-x64-win.yml', directory: 'windows-x64', sourceFileName: 'Antigravity-x64.exe',
    fileName: 'Antigravity-x64.exe', kind: 'installer', format: 'exe', contentType: 'application/octet-stream', verification: 'windows-authenticode-google' }),
  'windows-arm64': Object.freeze({ family: 'windows', architecture: 'arm64', feedName: 'latest-arm64-win.yml', directory: 'windows-arm', sourceFileName: 'Antigravity-arm64.exe',
    fileName: 'Antigravity-arm64.exe', kind: 'installer', format: 'exe', contentType: 'application/octet-stream', verification: 'windows-authenticode-google' }),
  'macos-arm64': Object.freeze({ family: 'macos', architecture: 'arm64', feedName: 'latest-arm64-mac.yml', directory: 'darwin-arm', sourceFileName: 'Antigravity.zip',
    fileName: 'Antigravity-darwin-arm64.zip', kind: 'app-archive', format: 'zip', contentType: 'application/zip', verification: 'macos-developer-id-notarized', machine: 'arm64' }),
  'macos-x64': Object.freeze({ family: 'macos', architecture: 'x64', feedName: 'latest-x64-mac.yml', directory: 'darwin-x64', sourceFileName: 'Antigravity.zip',
    fileName: 'Antigravity-darwin-x64.zip', kind: 'app-archive', format: 'zip', contentType: 'application/zip', verification: 'macos-developer-id-notarized', machine: 'x86_64' }),
})
const FAMILIES = Object.freeze({
  windows: Object.freeze({ runner: 'win32', indexKey: `${PREFIX}/windows.json`, platformIds: Object.freeze(['windows-x64', 'windows-arm64']) }),
  macos: Object.freeze({ runner: 'darwin', indexKey: `${PREFIX}/macos.json`, platformIds: Object.freeze(['macos-arm64', 'macos-x64']) }),
})
const stageFailures = new WeakMap()

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }
  return 0
}

/** Which half this runner does: the Windows installers on Windows, the Mac archives on a Mac. */
function familyForRunner(platform) {
  const family = Object.keys(FAMILIES).find(function (id) { return FAMILIES[id].runner === platform })
  if (!family) throw checkFailure('platform-invalid', 'Antigravity 桌面端同步只在 Windows 和 macOS 机器上跑')
  return family
}

function feedUrl(platformId) {
  return `${FEED_ORIGIN}/manifest/${PLATFORMS[platformId].feedName}`
}

function sourceUrl(platformId, version, build) {
  if (!VERSION_PATTERN.test(version) || !BUILD_PATTERN.test(build)) throw checkFailure('version-invalid', '谷歌返回的 Antigravity 桌面端版本号无效')
  const spec = PLATFORMS[platformId]
  return `${ARTIFACT_ORIGIN}${ARTIFACT_PATH_PREFIX}${version}-${build}/${spec.directory}/${spec.sourceFileName}`
}

function artifactKey(platformId, sha256) {
  return `${PREFIX}/${platformId}/sha256-${sha256}/${PLATFORMS[platformId].fileName}`
}

function yamlScalar(value) {
  const quoted = /^(['"])(.*)\1$/.exec(value)
  return quoted ? quoted[2] : value
}

function base64ToHex(value) {
  if (typeof value !== 'string' || !BASE64_SHA512_PATTERN.test(value)) return null
  const bytes = Buffer.from(value, 'base64')
  return bytes.length === 64 && bytes.toString('base64') === value ? bytes.toString('hex') : null
}

/**
 * Same rule as parseAntigravityDesktopFeed in electron/antigravity-desktop-release.ts: the small
 * fixed shape electron-updater writes, read line by line; exactly one file whose URL is the one
 * built from the feed's own version and build; the legacy top-level path and sha512, when present,
 * must agree with it. Anything else refuses the whole feed.
 */
function parseFeed(text, platformId) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > MAX_FEED_BYTES) throw checkFailure('metadata-invalid', '谷歌返回的 Antigravity 桌面端更新信息为空或过大')
  const top = new Map()
  const files = []
  let inFiles = false
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const topLevel = /^([A-Za-z][A-Za-z0-9]*):(?:[ \t]+(\S(?:.*\S)?))?[ \t]*$/.exec(line)
    if (topLevel) {
      const [, key, value] = topLevel
      if (top.has(key) || (key === 'files') !== (value === undefined)) throw checkFailure('metadata-invalid', '谷歌返回的 Antigravity 桌面端更新信息格式不对')
      top.set(key, value === undefined ? '' : yamlScalar(value))
      inFiles = key === 'files'
      continue
    }
    const item = /^[ \t]+(-[ \t]+)?([A-Za-z][A-Za-z0-9]*):[ \t]+(\S(?:.*\S)?)[ \t]*$/.exec(line)
    if (!item || !inFiles) throw checkFailure('metadata-invalid', '谷歌返回的 Antigravity 桌面端更新信息格式不对')
    const [, dash, key, value] = item
    if (dash) files.push(new Map())
    const entry = files[files.length - 1]
    if (!entry || entry.has(key)) throw checkFailure('metadata-invalid', '谷歌返回的 Antigravity 桌面端更新信息格式不对')
    entry.set(key, yamlScalar(value))
  }
  if (files.length !== 1 || !top.has('files')) throw checkFailure('metadata-invalid', '谷歌返回的 Antigravity 桌面端更新信息应当只列一个文件')
  const file = files[0]
  const version = top.get('version')
  if (!version || !VERSION_PATTERN.test(version)) throw checkFailure('version-invalid', '谷歌返回的 Antigravity 桌面端版本号无效')
  const sha512 = base64ToHex(file.get('sha512'))
  if (!sha512) throw checkFailure('metadata-invalid', '谷歌返回的 Antigravity 桌面端更新信息缺少 SHA-512')
  const size = file.get('size')
  const bytes = /^[1-9]\d{0,15}$/.test(size || '') ? Number(size) : NaN
  if (!Number.isSafeInteger(bytes) || bytes < MIN_ARTIFACT_BYTES || bytes > MAX_ARTIFACT_BYTES) throw checkFailure('metadata-invalid', '谷歌返回的 Antigravity 桌面端安装包大小无效')
  const url = file.get('url')
  const spec = PLATFORMS[platformId]
  const prefix = `${ARTIFACT_ORIGIN}${ARTIFACT_PATH_PREFIX}${version}-`
  const suffix = `/${spec.directory}/${spec.sourceFileName}`
  const build = typeof url === 'string' && url.startsWith(prefix) && url.endsWith(suffix) ? url.slice(prefix.length, url.length - suffix.length) : ''
  if (!BUILD_PATTERN.test(build) || sourceUrl(platformId, version, build) !== url) throw checkFailure('source-url-rejected', '谷歌返回的 Antigravity 桌面端下载地址不在官方目录')
  if (top.has('path') && top.get('path') !== spec.sourceFileName) throw checkFailure('metadata-invalid', '谷歌返回的 Antigravity 桌面端更新信息前后不一致')
  if (top.has('sha512') && base64ToHex(top.get('sha512')) !== sha512) throw checkFailure('metadata-invalid', '谷歌返回的 Antigravity 桌面端更新信息前后不一致')
  return { version, build, url, bytes, sha512 }
}

function validateFile(file, index, publicUrl) {
  const spec = isRecord(file) ? PLATFORMS[file.platformId] : null
  if (!spec || spec.family !== index.family || file.platform !== spec.family || file.architecture !== spec.architecture || file.kind !== spec.kind || file.format !== spec.format
    || file.fileName !== spec.fileName || file.type !== spec.contentType || file.verification !== spec.verification || file.version !== index.version
    || !SHA256_PATTERN.test(file.sha256 || '') || !SHA512_PATTERN.test(file.sha512 || '') || file.key !== artifactKey(file.platformId, file.sha256)
    || typeof file.url !== 'string' || (publicUrl && file.url !== publicUrl(file.key))
    || !Number.isSafeInteger(file.size) || file.size < MIN_ARTIFACT_BYTES || file.size > MAX_ARTIFACT_BYTES
    || file.sourceUrl !== sourceUrl(file.platformId, index.version, index.build)) throw checkFailure('cos-index-invalid', 'COS 现有 Antigravity 桌面端清单的文件记录无效')
  if (typeof file.cosEtag !== 'string' || !file.cosEtag || file.cosEtag.length > 256 || /[\r\n]/.test(file.cosEtag)) throw checkFailure('cos-index-invalid', 'COS 现有 Antigravity 桌面端清单缺少已核验对象指纹')
}

/**
 * The index the client reads (desktop-package-bucket.ts parseFilesEntry): one version, one file
 * per platform of this family, each file under its own SHA-256.
 */
function validateIndex(value, family, publicUrl) {
  if (value === null || value === undefined) return null
  const platformIds = FAMILIES[family].platformIds
  if (!isRecord(value) || value.schemaVersion !== 1 || value.product !== PRODUCT || value.family !== family || typeof value.generatedAt !== 'string'
    || typeof value.checkedAt !== 'string' || typeof value.version !== 'string' || !VERSION_PATTERN.test(value.version) || typeof value.build !== 'string'
    || !BUILD_PATTERN.test(value.build) || !Array.isArray(value.files) || value.files.length !== platformIds.length) throw checkFailure('cos-index-invalid', 'COS 现有 Antigravity 桌面端清单格式无效，已保留现有清单')
  const platforms = new Set()
  for (const file of value.files) {
    validateFile(file, value, publicUrl)
    if (platforms.has(file.platformId)) throw checkFailure('cos-index-invalid', 'COS 现有 Antigravity 桌面端清单的平台重复')
    platforms.add(file.platformId)
  }
  return value
}

function safeAntigravityDesktopSyncFailure(error) {
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
        if (Number.isSafeInteger(value[name]) && value[name] >= 0 && value[name] <= MAX_ARTIFACT_BYTES) safe[name === 'expectedBytes' ? 'transferExpectedBytes' : name] = value[name]
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
      const wrapped = new Error(error instanceof Error ? error.message : 'Antigravity 桌面端同步阶段失败')
      stageFailures.set(wrapped, { error, context: { ...context, latestState: pointerState() } })
      report('stage-failed', { diagnostic: safeAntigravityDesktopSyncFailure(wrapped) })
      throw wrapped
    }
  }
}

// The signer is public certificate data. Logging what was read tells a rotated certificate
// (a valid signature from a signer not on the list) apart from a damaged or foreign installer.
function observedSignature(signature) {
  return isRecord(signature) ? { signatureStatus: signature.status, signerSubject: signature.subject, signerIssuer: signature.issuer } : undefined
}

function validateWindowsSignature(signature) {
  if (!isRecord(signature) || typeof signature.status !== 'string' || signature.status.toLowerCase() !== 'valid') throw checkFailure('package-signature-invalid', 'Antigravity 安装包没有有效的 Authenticode 签名', observedSignature(signature))
  const subject = typeof signature.subject === 'string' ? signature.subject : ''
  const issuer = typeof signature.issuer === 'string' ? signature.issuer : ''
  if (!WINDOWS_SIGNER.subject.every(function (pattern) { return pattern.test(subject) }) || !WINDOWS_SIGNER.issuer.every(function (pattern) { return pattern.test(issuer) })) {
    throw checkFailure('package-signer-mismatch', 'Antigravity 安装包的签名发布者不是谷歌（Google LLC，DigiCert 签发）', observedSignature(signature))
  }
}

async function verifyUnchangedArtifact(store, file) {
  const current = await store.inspect(file.key)
  const contentType = typeof current?.contentType === 'string' ? current.contentType.split(';')[0].trim().toLowerCase() : ''
  return Boolean(current && current.bytes === file.size && current.etag === file.cosEtag && contentType === file.type)
}

async function readFeed(dependencies, platformId) {
  const url = feedUrl(platformId)
  const text = await dependencies.fetchText({ url, allowedHosts: [new URL(url).hostname], maxBytes: MAX_FEED_BYTES, headers: { accept: '*/*', 'user-agent': USER_AGENT } })
  return parseFeed(text, platformId)
}

async function downloadOfficial(dependencies, release, filePath, onProgress) {
  const url = release.url
  try {
    const result = await dependencies.downloadResource({ url, filePath, allowedHosts: [new URL(url).hostname], maxBytes: release.bytes, expectedBytes: release.bytes, headers: { accept: 'application/octet-stream', 'user-agent': USER_AGENT }, onProgress })
    const sha512 = typeof result?.sha512 === 'string' ? Buffer.from(result.sha512, 'base64').toString('hex') : ''
    if (!result || result.bytes !== release.bytes || !SHA256_PATTERN.test(result.sha256 || '')) throw checkFailure('download-mismatch', 'Antigravity 桌面端安装包大小和谷歌更新信息不一致')
    if (sha512 !== release.sha512) throw checkFailure('download-mismatch', 'Antigravity 桌面端安装包和谷歌更新信息的 SHA-512 不一致')
    return { bytes: result.bytes, sha256: result.sha256, sha512 }
  } catch (error) {
    await dependencies.removeFile(filePath)
    throw error
  }
}

function contentOf(index) {
  return index ? JSON.stringify({ ...index, generatedAt: null, checkedAt: null }) : null
}

async function synchronizeAntigravityDesktop({ store, dependencies, family, progress, now = function () { return new Date().toISOString() } }) {
  if (!Object.hasOwn(FAMILIES, family)) throw checkFailure('platform-invalid', 'Antigravity 桌面端同步的平台无效')
  const { indexKey, platformIds } = FAMILIES[family]
  let latestState = 'not-written-by-this-run'
  const stage = createStageRunner(progress, function () { return latestState })
  const old = await stage('cos-read-latest', { family }, async function () {
    return validateIndex(await store.readJson(indexKey, { missingOk: true }), family, store.publicUrl)
  })
  const feeds = {}
  for (const platformId of platformIds) {
    feeds[platformId] = await stage('source-manifest', { platformId }, function () { return readFeed(dependencies, platformId) })
  }
  // checkedAt is when Google told us its version, not when the uploads finished.
  const checkedAt = now()
  const { version, build } = await stage('source-compare', {}, async function () {
    const [first, ...others] = platformIds.map(function (id) { return feeds[id] })
    // 两种芯片应当同时换版；一前一后时这一轮不发，等下一轮两份对上了再发，免得清单里一种芯片新、一种旧。
    if (others.some(function (feed) { return feed.version !== first.version || feed.build !== first.build })) {
      throw checkFailure('source-changed', '谷歌两种芯片的 Antigravity 桌面端版本不一致，这一轮不发布')
    }
    if (old && compareVersions(first.version, old.version) < 0) throw checkFailure('version-regressed', '谷歌返回的 Antigravity 桌面端版本比桶里的旧，这一轮不发布')
    return first
  })
  const workDirectory = await stage('prepare-temp', {}, function () { return dependencies.createWorkDirectory() })
  let primaryError
  try {
    async function synchronizeFile(platformId) {
      const context = { version, platformId }
      const release = feeds[platformId]
      const existing = old && old.version === version && old.build === build ? old.files.find(function (file) { return file.platformId === platformId }) : undefined
      if (existing && existing.sha512 === release.sha512 && await stage('cos-check-existing', context, function () { return verifyUnchangedArtifact(store, existing) })) return existing
      const spec = PLATFORMS[platformId]
      const filePath = path.join(workDirectory, `${platformId}-${spec.sourceFileName}`)
      try {
        const downloaded = await stage('source-download', { ...context, expectedBytes: release.bytes }, function (onProgress) { return downloadOfficial(dependencies, release, filePath, onProgress) })
        await stage('verify-artifact', { ...context, expectedBytes: downloaded.bytes }, async function () {
          if (spec.family === 'windows') {
            await dependencies.assertPeImage(filePath)
            validateWindowsSignature(await dependencies.inspectWindowsSignature(filePath, workDirectory))
          } else {
            await dependencies.inspectMacArchive(filePath, workDirectory, { machine: spec.machine, version })
          }
        })
        const key = artifactKey(platformId, downloaded.sha256)
        const published = await stage('cos-publish-binary', { ...context, expectedBytes: downloaded.bytes }, async function (onProgress) {
          const result = await store.publishFile(key, filePath, { expectedBytes: downloaded.bytes, expectedSha256: downloaded.sha256, contentType: spec.contentType, cacheControl: 'public, max-age=31536000, immutable', onProgress })
          if (result.bytes !== downloaded.bytes || result.sha256 !== downloaded.sha256) throw checkFailure('cos-object-mismatch', 'COS Antigravity 桌面端安装包公共下载校验结果不一致')
          return result
        })
        const head = await stage('cos-head-binary', context, async function () {
          const result = await store.inspect(key)
          if (!result || result.bytes !== downloaded.bytes || typeof result.etag !== 'string' || result.etag !== published.etag) throw checkFailure('cos-object-mismatch', 'COS Antigravity 桌面端安装包发布后的 HEAD 与已核验正文不一致')
          return result
        })
        return {
          platformId, platform: spec.family, architecture: spec.architecture, kind: spec.kind, format: spec.format, fileName: spec.fileName,
          type: spec.contentType, verification: spec.verification, version, key, url: store.publicUrl(key),
          size: downloaded.bytes, sha256: downloaded.sha256, sha512: downloaded.sha512, sourceUrl: release.url, cosEtag: head.etag,
        }
      } finally {
        await dependencies.removeFile(filePath)
      }
    }
    const files = []
    for (const platformId of platformIds) files.push(await synchronizeFile(platformId))
    const index = { schemaVersion: 1, product: PRODUCT, family, generatedAt: now(), checkedAt, version, build, files }
    await stage('validate-latest', {}, async function () { validateIndex(index, family, store.publicUrl) })
    // 没变也照样写一遍，只换 checkedAt：客户端靠它判断桶还跟不跟得上谷歌。
    const changed = contentOf(index) !== contentOf(old)
    const published = changed ? index : { ...old, checkedAt }
    await stage('cos-recheck-latest', {}, async function () {
      const latest = validateIndex(await store.readJson(indexKey, { missingOk: true }), family, store.publicUrl)
      if (JSON.stringify(latest) !== JSON.stringify(old)) throw checkFailure('cos-index-changed', 'COS Antigravity 桌面端清单在同步期间发生变化，停止发布以保留现有状态')
    })
    latestState = 'write-unconfirmed'
    await stage('cos-publish-latest', {}, function (onProgress) { return store.publishJson(indexKey, published, { overwrite: true, cacheControl: 'no-cache, max-age=0, must-revalidate', onProgress }) })
    latestState = 'published-and-read-back'
    return { changed, index: published }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try { await stage('cleanup-temp', {}, function () { return dependencies.removeWorkDirectory(workDirectory) }) } catch (error) {
      if (!primaryError) throw error
    }
  }
}

/** Only checks that the file is a PE image (MZ header pointing at a PE signature); never runs it. */
async function assertPeImage(filePath) {
  const handle = await fs.open(filePath, 'r')
  try {
    const dos = Buffer.alloc(64)
    if ((await handle.read(dos, 0, 64, 0)).bytesRead !== 64 || dos.readUInt16LE(0) !== 0x5a4d) throw checkFailure('package-format-invalid', 'Antigravity 安装包不是 Windows 可执行文件')
    const offset = dos.readUInt32LE(0x3c)
    if (offset < 64 || offset > 64 * 1024) throw checkFailure('package-format-invalid', 'Antigravity 安装包的 PE 头位置无效')
    const header = Buffer.alloc(4)
    if ((await handle.read(header, 0, 4, offset)).bytesRead !== 4 || header.readUInt32LE(0) !== 0x00004550) throw checkFailure('package-format-invalid', 'Antigravity 安装包缺少 PE 头')
  } finally {
    await handle.close()
  }
}

const SIGNATURE_SCRIPT = String.raw`param([string]$FilePath)
$ErrorActionPreference='Stop'
$signature=Get-AuthenticodeSignature -LiteralPath $FilePath
@{status=$signature.Status.ToString();subject=if($signature.SignerCertificate){[string]$signature.SignerCertificate.Subject}else{$null};issuer=if($signature.SignerCertificate){[string]$signature.SignerCertificate.Issuer}else{$null}} | ConvertTo-Json -Compress
`

async function inspectWindowsSignature(filePath, workDirectory, run = promisify(execFile), platform = process.platform) {
  if (platform !== 'win32') throw checkFailure('inspector-unavailable', 'Antigravity 安装包的 Windows 签名检查必须在 Windows runner 运行')
  const script = path.join(workDirectory, 'inspect-antigravity-desktop-signature.ps1')
  try { await fs.writeFile(script, SIGNATURE_SCRIPT, { flag: 'wx', mode: 0o600 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  let result
  try {
    result = await run('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-FilePath', filePath], {
      env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: workDirectory, TMP: workDirectory, PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules' },
      windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024,
    })
  } catch (error) { throw checkFailure('inspector-failed', 'Antigravity 安装包签名检查失败', observedProcessFailure(error)) }
  try { return JSON.parse(result.stdout.replace(/^\uFEFF/, '')) } catch { throw checkFailure('inspection-unparsable', 'Antigravity 安装包签名检查结果无法解析') }
}

/** Google's Developer ID requirement for the app; same clauses as darwinDeveloperIdRequirement in electron/macos-code-signing.ts. */
function darwinAntigravityDesktopRequirement() {
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
 * verifyExtractedBundle does: exactly Antigravity.app, the pinned bundle id, the Developer ID
 * requirement and Gatekeeper. The bundle's version and its main executable's chip are read too,
 * so a package cannot be filed under the wrong version or chip.
 */
async function inspectMacArchive(filePath, workDirectory, expected, run = promisify(execFile), platform = process.platform) {
  if (platform !== 'darwin') throw checkFailure('inspector-unavailable', 'Antigravity 桌面端的 Mac 签名检查必须在 macOS runner 运行')
  const extractDirectory = path.join(workDirectory, `extract-${expected.machine}`)
  await fs.mkdir(extractDirectory, { mode: 0o700 })
  async function inspect(executable, args, code, failure) {
    try { return await run(executable, args, { env: safeChildEnvironment(workDirectory), timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 }) } catch (error) { throw checkFailure(code, failure, observedProcessFailure(error)) }
  }
  try {
    await inspect('/usr/bin/tar', ['-xf', filePath, '-C', extractDirectory], 'package-format-invalid', 'Antigravity 桌面端安装包解不开')
    const entries = await fs.readdir(extractDirectory)
    if (entries.length !== 1 || entries[0] !== APPLICATION) throw checkFailure('package-format-invalid', `Antigravity 桌面端安装包里应当只有 ${APPLICATION}`)
    const application = path.join(extractDirectory, APPLICATION)
    const stats = await fs.lstat(application)
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw checkFailure('package-format-invalid', `${APPLICATION} 不是普通目录`)
    const metadata = await inspect('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(application, 'Contents', 'Info.plist')], 'inspection-unparsable', 'Antigravity 的 Info.plist 读不出来')
    let info
    try { info = JSON.parse(metadata.stdout) } catch { throw checkFailure('inspection-unparsable', 'Antigravity 的 Info.plist 读不出来') }
    if (!isRecord(info) || info.CFBundleIdentifier !== BUNDLE_IDENTIFIER) throw checkFailure('package-identity-mismatch', `Antigravity 的 bundle id 不是 ${BUNDLE_IDENTIFIER}`, { bundleIdentifier: isRecord(info) && typeof info.CFBundleIdentifier === 'string' ? info.CFBundleIdentifier : undefined })
    if (info.CFBundleShortVersionString !== expected.version) throw checkFailure('package-identity-mismatch', 'Antigravity 应用里写的版本和谷歌更新信息不一致', { expectedVersion: expected.version, packageVersion: typeof info.CFBundleShortVersionString === 'string' ? info.CFBundleShortVersionString : undefined })
    if (typeof info.CFBundleExecutable !== 'string' || !/^[A-Za-z0-9._ -]{1,128}$/.test(info.CFBundleExecutable) || info.CFBundleExecutable.startsWith('.')) throw checkFailure('package-identity-mismatch', 'Antigravity 的可执行文件名无效')
    await inspect('/usr/bin/codesign', ['--verify', '--strict', '--deep', `-R=${darwinAntigravityDesktopRequirement()}`, application], 'package-signature-invalid', `Antigravity 的签名不是谷歌（${TEAM_IDENTIFIER}）的 Developer ID`)
    await inspect('/usr/sbin/spctl', ['--assess', '--type', 'execute', application], 'package-signature-invalid', 'Gatekeeper 没有放行 Antigravity')
    const architectures = await inspect('/usr/bin/lipo', ['-archs', path.join(application, 'Contents', 'MacOS', info.CFBundleExecutable)], 'inspection-unparsable', 'Antigravity 主程序的芯片读不出来')
    const archs = architectures.stdout.trim().split(/\s+/)
    if (!archs.includes(expected.machine)) throw checkFailure('package-identity-mismatch', 'Antigravity 主程序的芯片和平台不一致', { packageArchitecture: observedArchitectures(archs) })
  } finally {
    await fs.rm(extractDirectory, { recursive: true, force: true })
  }
}

function createRuntimeDependencies(common) {
  return {
    fetchText: common.fetchText,
    downloadResource: common.downloadResource,
    assertPeImage,
    inspectWindowsSignature: function (filePath, workDirectory) { return inspectWindowsSignature(filePath, workDirectory) },
    inspectMacArchive: function (filePath, workDirectory, expected) { return inspectMacArchive(filePath, workDirectory, expected) },
    removeFile: function (filePath) { return fs.rm(filePath, { force: true }) },
    createWorkDirectory: async function () { return fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'xingmang-antigravity-desktop-cos-')) },
    removeWorkDirectory: async function (directory) {
      const resolved = path.resolve(directory)
      const temporaryRoot = await fs.realpath(os.tmpdir())
      if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('xingmang-antigravity-desktop-cos-')) throw checkFailure('temp-path-rejected', '拒绝删除临时同步目录以外的路径')
      await fs.rm(resolved, { recursive: true, force: true })
    },
  }
}

async function main() {
  const common = require('./cos-sync-utils.cjs')
  if (process.argv.length > 2) throw checkFailure('platform-invalid', 'Antigravity 桌面端同步不接受命令行参数')
  const family = familyForRunner(process.platform)
  const config = common.readCosConfiguration(process.env)
  const result = await synchronizeAntigravityDesktop({ store: common.createCosStore(config), dependencies: createRuntimeDependencies(common), family,
    progress: function (event) { console.log(`[antigravity-desktop-sync] ${JSON.stringify(event)}`) } })
  console.log(JSON.stringify({ changed: result.changed, family, version: result.index.version }))
}

if (require.main === module) {
  main().catch(function (error) {
    console.error(`Antigravity 桌面端同步失败；安全诊断：${JSON.stringify(safeAntigravityDesktopSyncFailure(error))}`)
    process.exitCode = 1
  })
}

module.exports = { FEED_ORIGIN, ARTIFACT_ORIGIN, OFFICIAL_HOSTS, PREFIX, PRODUCT, MIN_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES, PLATFORMS, FAMILIES,
  compareVersions, familyForRunner, feedUrl, sourceUrl, artifactKey, parseFeed, validateIndex, validateWindowsSignature, darwinAntigravityDesktopRequirement,
  assertPeImage, inspectWindowsSignature, inspectMacArchive, synchronizeAntigravityDesktop, createRuntimeDependencies, safeAntigravityDesktopSyncFailure }
