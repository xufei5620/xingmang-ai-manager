const https = require('node:https')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { randomUUID } = require('node:crypto')

const SOURCE_MODE = 'official-mac-update-release-candidate'
const CHECKSUM_PROVENANCE = 'operator-official-browser-local-sha256'
const SEED_VERSION = '2.19675.0'
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024
const MAC_FORMATS = Object.freeze({ 'macos-dmg-universal': 'dmg', 'macos-pkg-universal': 'pkg' })
const RESOLUTION_FIELDS = Object.freeze(['mode', 'sourceVersion', 'releaseId', 'archiveSha256', 'archiveBytes', 'metadataArchitecture'])
const BROWSER_FIELDS = Object.freeze(['sourceSha256', 'checksumProvenance'])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isVersion(value) {
  return typeof value === 'string' && value.length <= 64 && /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(value)
    && value.split('.').every(function (part) { return Number.isSafeInteger(Number(part)) && Number(part) <= 65535 })
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isPackageSize(value) {
  return Number.isSafeInteger(value) && value >= 8 && value <= MAX_PACKAGE_BYTES
}

function assertBoundedMetadata(value) {
  const pending = [{ value, depth: 1 }]
  const seen = new Set()
  while (pending.length) {
    const item = pending.pop()
    if (!item.value || typeof item.value !== 'object') continue
    if (item.depth > 5 || seen.has(item.value) || seen.size >= 256
      || Array.isArray(item.value) && item.value.length > 16 || Reflect.ownKeys(item.value).length > 32) throw new Error('Claude Mac 官方更新元数据层级或数量超过上限')
    seen.add(item.value)
    for (const child of Object.values(item.value)) if (child && typeof child === 'object') pending.push({ value: child, depth: item.depth + 1 })
  }
}

function parseMacUpdateMetadata(text, architecture) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_METADATA_BYTES || !['arm64', 'x64'].includes(architecture)) throw new Error('Claude Mac 官方更新元数据大小或架构无效')
  let value
  try { value = JSON.parse(text) } catch { throw new Error('Claude Mac 官方更新元数据不是有效 JSON') }
  assertBoundedMetadata(value)
  if (!isRecord(value) || !isVersion(value.currentRelease) || !Array.isArray(value.releases) || !value.releases.length
    || value.releases.some(function (entry) { return !isRecord(entry) || !isVersion(entry.version) || !isRecord(entry.updateTo) })
    || new Set(value.releases.map(function (entry) { return entry.version })).size !== value.releases.length) throw new Error('Claude Mac 官方更新版本列表无效或重复')
  const matches = value.releases.filter(function (entry) { return entry.version === value.currentRelease })
  if (matches.length !== 1) throw new Error('Claude Mac 官方更新元数据没有唯一当前版本')
  const payload = matches[0].updateTo
  if (payload.version !== value.currentRelease || !isPackageSize(payload.size) || !isSha256(payload.sha256)
    || typeof payload.url !== 'string' || payload.url.length > 512) throw new Error('Claude Mac 官方完整 ZIP 版本、大小或声明摘要无效')
  // Since 2026-10-07 the feed lists a per-architecture update ZIP for each
  // architecture; the universal DMG/PKG we mirror still live under
  // darwin/universal with the same version and release ID (checked 2026-10-10).
  // Accept only universal or the architecture this feed was queried for, so a
  // feed answer for one architecture can never vouch for the other.
  const match = /^https:\/\/downloads\.claude\.ai\/releases\/darwin\/(universal|arm64|x64)\/([0-9]+\.[0-9]+\.[0-9]+)\/Claude-([a-f0-9]{40})\.zip$/.exec(payload.url)
  if (!match || match[1] !== 'universal' && match[1] !== architecture || match[2] !== value.currentRelease
    || payload.url !== `https://downloads.claude.ai/releases/darwin/${match[1]}/${match[2]}/Claude-${match[3]}.zip`) throw new Error('Claude Mac 官方来源不是固定无 query、架构匹配的完整 ZIP 地址')
  // SHA/size describe the archive declared by this official feed. They must
  // never become the expected checksum or length of a different DMG/PKG asset.
  return Object.freeze({ version: value.currentRelease, releaseId: match[3], archiveUrl: payload.url,
    archiveBytes: payload.size, archiveSha256: payload.sha256, metadataArchitecture: architecture })
}

function isMacUpdateSourceResolution(value) {
  if (!isRecord(value)) return false
  const hasBrowser = BROWSER_FIELDS.some(function (field) { return Object.hasOwn(value, field) })
  const fields = hasBrowser ? [...RESOLUTION_FIELDS, ...BROWSER_FIELDS] : RESOLUTION_FIELDS
  if (Reflect.ownKeys(value).length !== fields.length || Object.keys(value).length !== fields.length
    || !fields.every(function (field) { return Object.hasOwn(value, field) }) || value.mode !== SOURCE_MODE
    || !isVersion(value.sourceVersion) || typeof value.releaseId !== 'string' || !/^[a-f0-9]{40}$/.test(value.releaseId) || !isSha256(value.archiveSha256)
    || !isPackageSize(value.archiveBytes) || !['arm64', 'x64'].includes(value.metadataArchitecture)) return false
  return !hasBrowser || isSha256(value.sourceSha256) && value.checksumProvenance === CHECKSUM_PROVENANCE
}

function installerUrl(platformId, version, releaseId) {
  if (typeof platformId !== 'string' || !Object.hasOwn(MAC_FORMATS, platformId) || !isVersion(version) || typeof releaseId !== 'string' || !/^[a-f0-9]{40}$/.test(releaseId)) throw new Error('Claude Mac 官方候选参数无效')
  return `https://downloads.claude.ai/releases/darwin/universal/${version}/Claude-${releaseId}.${MAC_FORMATS[platformId]}`
}

function validateMacUpdateSourceRecord(record, platformId, fileVersion, fileSha256) {
  const resolution = record?.sourceResolution
  if (!isRecord(record) || !isMacUpdateSourceResolution(resolution) || !isVersion(fileVersion) || !isSha256(fileSha256)
    || resolution.sourceVersion !== fileVersion || record.requestUrl !== installerUrl(platformId, fileVersion, resolution.releaseId)
    || Object.hasOwn(resolution, 'sourceSha256') && resolution.sourceSha256 !== fileSha256) throw new Error('Claude Mac 官方更新来源记录、版本或浏览器摘要不匹配')
  return record
}

function sameMacUpdateSourceResolution(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return (left === null || left === undefined) && (right === null || right === undefined)
  if (!isMacUpdateSourceResolution(left) || !isMacUpdateSourceResolution(right)) return false
  return Reflect.ownKeys(left).length === Reflect.ownKeys(right).length
    && [...RESOLUTION_FIELDS, ...BROWSER_FIELDS].every(function (field) { return left[field] === right[field] })
}

function validateHead(value) {
  if (!value || value.status !== 200 || !isPackageSize(value.bytes) || typeof value.etag !== 'string' || !value.etag || value.etag.length > 256 || /[\r\n\0]/.test(value.etag)
    || value.lastModified !== undefined && value.lastModified !== null && (typeof value.lastModified !== 'string' || value.lastModified.length > 256 || /[\r\n\0]/.test(value.lastModified))) throw new Error('Claude Mac 官方候选 HEAD 状态、大小或指纹无效')
  return { bytes: value.bytes, etag: value.etag, lastModified: value.lastModified || null }
}

function validateResource(resource) {
  const resolution = resource?.sourceResolution
  const validResolution = isMacUpdateSourceResolution(resolution)
  const checksumMismatch = !validResolution || (Object.hasOwn(resolution, 'sourceSha256')
    ? resource?.expectedSha256 !== resolution.sourceSha256 : resource?.expectedSha256 !== undefined)
  if (!isRecord(resource) || typeof resource.platformId !== 'string' || !Object.hasOwn(MAC_FORMATS, resource.platformId) || !validResolution
    || resource.version !== resolution.sourceVersion || resource.url !== installerUrl(resource.platformId, resource.version, resolution.releaseId)
    || resource.requestUrl !== resource.url || !Array.isArray(resource.redirects) || resource.redirects.length !== 0
    || checksumMismatch) {
    throw new Error('Claude Mac 官方更新候选资源或来源记录无效')
  }
  return { platformId: resource.platformId, version: resource.version, url: resource.url,
    ...validateHead({ ...resource, status: 200 }), resolution: { ...resolution } }
}

function validateRelease(release) {
  if (!isRecord(release)) throw new Error('Claude Mac 官方更新 release 结构无效')
  const parsed = parseMacUpdateMetadata(JSON.stringify({ currentRelease: release.version, releases: [{ version: release.version,
    updateTo: { version: release.version, url: release.archiveUrl, size: release.archiveBytes, sha256: release.archiveSha256 } }] }), release.metadataArchitecture)
  if (parsed.releaseId !== release.releaseId) throw new Error('Claude Mac 官方更新 release ID 不一致')
  return parsed
}

function validateMacUpdatePackageVersion(resource, nativeVersion) {
  const snapshot = validateResource(resource)
  if (nativeVersion !== snapshot.version) throw new Error('Claude Mac 包内版本与官方更新候选版本不一致')
  return snapshot.version
}

function browserChecksum(platformId, release, url, dependencies) {
  const confirmed = dependencies.getConfirmedMacSource?.(platformId)
  if (!confirmed || confirmed.url !== url || confirmed.version !== release.version) return null
  const resolution = confirmed.sourceResolution
  if (!isPackageSize(confirmed.bytes) || !isSha256(confirmed.expectedSha256) || !isRecord(resolution)
    || Reflect.ownKeys(resolution).length !== 4 || Object.keys(resolution).length !== 4
    || !['mode', 'sourceVersion', 'sourceSha256', 'checksumProvenance'].every(function (field) { return Object.hasOwn(resolution, field) })
    || resolution.mode !== 'operator-confirmed-direct-source'
    || resolution.sourceVersion !== release.version || resolution.sourceSha256 !== confirmed.expectedSha256
    || resolution.checksumProvenance !== CHECKSUM_PROVENANCE) throw new Error('Claude Mac 匹配的浏览器来源校验依据无效')
  return { bytes: confirmed.bytes, sha256: confirmed.expectedSha256 }
}

async function resolveMacUpdateReleaseCandidates(ids, dependencies) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 2 || new Set(ids).size !== ids.length || ids.some(function (id) { return typeof id !== 'string' || !Object.hasOwn(MAC_FORMATS, id) })) throw new Error('Claude Mac 官方更新候选平台无效或重复')
  const selectedIds = [...ids]
  // Validate injected releases with the same format as real upstream data.
  const parsed = validateRelease(await dependencies.readRelease())
  const resources = []
  for (const id of selectedIds) {
    const url = installerUrl(id, parsed.version, parsed.releaseId)
    const checksum = browserChecksum(id, parsed, url, dependencies)
    const head = validateHead(await dependencies.inspectResource({ url, allowedHosts: ['downloads.claude.ai'], maxBytes: MAX_PACKAGE_BYTES,
      ...(checksum ? { expectedBytes: checksum.bytes } : {}) }))
    if (checksum && head.bytes !== checksum.bytes) throw new Error('Claude Mac 候选大小与同版本浏览器来源不一致')
    const sourceResolution = Object.freeze({ mode: SOURCE_MODE, sourceVersion: parsed.version, releaseId: parsed.releaseId,
      archiveSha256: parsed.archiveSha256, archiveBytes: parsed.archiveBytes, metadataArchitecture: parsed.metadataArchitecture,
      ...(checksum ? { sourceSha256: checksum.sha256, checksumProvenance: CHECKSUM_PROVENANCE } : {}),
    })
    // The two installer templates were observed in official browser downloads;
    // a future mismatch/404 stops this single candidate, with no path trials.
    resources.push(Object.freeze({ platformId: id, requestUrl: url, url, redirects: Object.freeze([]), version: parsed.version,
      ...head, ...(checksum ? { expectedSha256: checksum.sha256 } : {}), sourceResolution }))
  }
  return Object.freeze(resources)
}

async function revalidateMacUpdateReleaseCandidates(resources, dependencies) {
  if (!Array.isArray(resources) || !resources.length || resources.length > 2) throw new Error('Claude Mac 官方更新候选复核数量无效')
  const snapshots = resources.map(validateResource)
  if (new Set(snapshots.map(function (item) { return item.platformId })).size !== snapshots.length) throw new Error('Claude Mac 官方更新候选复核平台重复')
  const current = validateRelease(await dependencies.readRelease())
  for (const item of snapshots) {
    const resolution = item.resolution
    if (current.version !== item.version || current.releaseId !== resolution.releaseId || current.archiveSha256 !== resolution.archiveSha256
      || current.archiveBytes !== resolution.archiveBytes || current.metadataArchitecture !== resolution.metadataArchitecture) throw new Error('Claude Mac 官方更新来源在同步期间变化，拒绝发布')
  }
  for (const item of snapshots) {
    const head = validateHead(await dependencies.inspectResource({ url: item.url, allowedHosts: ['downloads.claude.ai'], maxBytes: MAX_PACKAGE_BYTES,
      expectedBytes: item.bytes, expectedEtag: item.etag }))
    if (head.bytes !== item.bytes || head.etag !== item.etag || head.lastModified !== item.lastModified) throw new Error('Claude Mac 候选 HEAD 在同步期间变化，拒绝发布')
  }
}

function requestMetadata(url, requestImpl, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let request
    let response
    let bodyTimer
    let settled = false
    let bytes = 0
    const chunks = []
    function finish(error, text) {
      if (settled) return
      settled = true
      clearTimeout(headerTimer)
      clearTimeout(bodyTimer)
      if (response) response.destroy()
      if (request) request.destroy()
      if (error) reject(error)
      else resolve(text)
    }
    function fail(message) { finish(new Error(message)) }
    const headerTimer = setTimeout(function () { fail('Claude Mac 官方更新响应头超时') }, timeoutMs)
    try {
      request = requestImpl(url, { method: 'GET', headers: { accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': 'xingmang-official-offline-sync/1' }, agent: false, maxHeaderSize: 16384 }, function (incoming) {
        response = incoming
        clearTimeout(headerTimer)
        const headers = Object.fromEntries(Object.entries(response.headers || {}).map(function ([key, value]) { return [key.toLowerCase(), value] }))
        if (response.statusCode !== 200 || ['location', 'www-authenticate', 'proxy-authenticate', 'refresh', 'cf-mitigated'].some(function (key) { return Object.hasOwn(headers, key) })) return fail('Claude Mac 官方更新元数据不可用或含认证、挑战、重定向；未读取正文')
        if (headers['content-encoding'] && headers['content-encoding'] !== 'identity'
          || headers['content-length'] !== undefined && (typeof headers['content-length'] !== 'string' || !/^[0-9]+$/.test(headers['content-length']) || Number(headers['content-length']) > MAX_METADATA_BYTES)) return fail('Claude Mac 官方更新元数据编码或声明大小无效')
        bodyTimer = setTimeout(function () { fail('Claude Mac 官方更新正文超时') }, timeoutMs)
        response.on('data', function (chunk) {
          if (settled) return
          bytes += chunk.length
          if (bytes > MAX_METADATA_BYTES) return fail('Claude Mac 官方更新元数据超过大小上限')
          chunks.push(chunk)
        })
        response.on('error', function () { fail('Claude Mac 官方更新网络响应失败') })
        response.on('aborted', function () { fail('Claude Mac 官方更新网络响应中断') })
        response.on('end', function () {
          if (response.complete !== true) return fail('Claude Mac 官方更新响应不完整')
          if (headers['content-length'] !== undefined && Number(headers['content-length']) !== bytes) return fail('Claude Mac 官方更新正文大小不一致')
          finish(null, Buffer.concat(chunks).toString('utf8'))
        })
      })
      request.on('error', function () { fail('Claude Mac 官方更新网络请求失败；未记录地址参数或身份') })
      if (settled) request.destroy()
      else request.end()
    } catch { fail('Claude Mac 官方更新网络请求失败；未记录地址参数或身份') }
  })
}

function createMacUpdateSourceDependencies({ inspectResource, getConfirmedMacSource } = {}, options = {}) {
  const platform = options.platform || process.platform
  const architecture = options.architecture || process.arch
  const timeoutMs = options.timeoutMs === undefined ? 30000 : options.timeoutMs
  if (platform !== 'darwin' || !['arm64', 'x64'].includes(architecture) || typeof inspectResource !== 'function' || getConfirmedMacSource !== undefined && typeof getConfirmedMacSource !== 'function'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Claude Mac 官方更新来源必须在原生 macOS 和有限超时下检查')
  const installId = (options.createId || randomUUID)()
  if (typeof installId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(installId)) throw new Error('Claude Mac 匿名测试安装身份无效')
  let osVersionPromise
  const requestImpl = options.requestImpl || https.request
  const runNative = options.run || promisify(execFile)
  async function readRelease() {
    // Cache only native OS discovery, never the feed: final publication needs
    // another real request using the same private installation cohort.
    osVersionPromise ||= (async function () {
      let result
      try { result = await runNative('/usr/bin/sw_vers', ['-productVersion'], {
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' }, timeout: 5000, maxBuffer: 256,
      }) } catch { throw new Error('Claude Mac 系统产品版本读取失败') }
      const version = result.stdout.trim()
      if (!/^\d+\.\d+(?:\.\d+)?$/.test(version) || version.length > 32) throw new Error('Claude Mac 系统产品版本格式无效')
      return version
    })()
    const osVersion = await osVersionPromise
    const url = new URL(`https://api.anthropic.com/api/desktop/darwin/${architecture}/squirrel/update`)
    url.search = `device_id=${encodeURIComponent(installId)}&version=${encodeURIComponent(SEED_VERSION)}&os_version=${encodeURIComponent(osVersion)}`
    return parseMacUpdateMetadata(await requestMetadata(url, requestImpl, timeoutMs), architecture)
  }
  return Object.freeze({ readRelease, inspectResource, ...(getConfirmedMacSource ? { getConfirmedMacSource } : {}) })
}

module.exports = { SOURCE_MODE, CHECKSUM_PROVENANCE, SEED_VERSION, MAX_METADATA_BYTES, MAX_PACKAGE_BYTES,
  parseMacUpdateMetadata, isMacUpdateSourceResolution, validateMacUpdateSourceRecord, sameMacUpdateSourceResolution,
  validateMacUpdatePackageVersion, resolveMacUpdateReleaseCandidates, revalidateMacUpdateReleaseCandidates, createMacUpdateSourceDependencies }
