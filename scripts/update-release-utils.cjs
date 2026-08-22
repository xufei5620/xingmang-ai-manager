const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { gunzipSync } = require('node:zlib')
const YAML = require('yaml')

const LEGACY_UPDATE_URL = 'https://updates.shenfengwl.fun/xingmang-manager/'
const NEW_UPDATE_URL = 'https://updatesnew.shenfengwl.fun/xingmang-manager/'
const UPDATE_MIGRATION_VERSION = '0.1.3'
// Keep the old export name for callers that intentionally validate the legacy
// feed or build fixtures for pre-migration packages.
const DEFAULT_UPDATE_URL = LEGACY_UPDATE_URL
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024
const MAX_BLOCKMAP_BYTES = 16 * 1024 * 1024
const MAX_BLOCKMAP_DECOMPRESSED_BYTES = 64 * 1024 * 1024
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308])

class ReleaseValidationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ReleaseValidationError'
    this.code = code
  }
}

function validationError(code, message) {
  return new ReleaseValidationError(code, message)
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function normalizeUpdateBaseUrl(rawUrl, { allowLocalHttp = false } = {}) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw validationError('UPDATE_URL_MISSING', '更新地址不能为空')
  }

  let parsed
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw validationError('UPDATE_URL_INVALID', '更新地址不是有效 URL')
  }

  const loopback = isLoopback(parsed.hostname)
  const localHttp = allowLocalHttp && parsed.protocol === 'http:' && loopback
  if (loopback && !localHttp) {
    throw validationError('UPDATE_URL_LOOPBACK', '正式更新地址不得使用 loopback 主机')
  }
  if (parsed.protocol !== 'https:' && !localHttp) {
    throw validationError(
      'UPDATE_URL_INSECURE',
      '正式更新地址必须使用 HTTPS；仅开发测试允许 loopback HTTP',
    )
  }
  if (parsed.username || parsed.password) {
    throw validationError('UPDATE_URL_CREDENTIALS', '更新地址不得内嵌用户名或密码')
  }
  if (parsed.search || parsed.hash) {
    throw validationError('UPDATE_URL_SUFFIX', '更新地址不得包含查询参数或片段')
  }

  return parsed.href.endsWith('/') ? parsed.href : `${parsed.href}/`
}

function safeRelativeArtifactPath(value, fieldName = 'files[].url') {
  if (typeof value !== 'string' || !value.trim()) {
    throw validationError('METADATA_FILE_MISSING', `${fieldName} 不能为空`)
  }
  const raw = value.trim()
  if (raw.includes('\\') || raw.startsWith('/') || /^[a-z][a-z\d+.-]*:/i.test(raw)) {
    throw validationError('METADATA_FILE_UNSAFE', `${fieldName} 必须是更新目录内的相对路径`)
  }

  let decoded
  try {
    const rawPath = decodeURIComponent(raw.split(/[?#]/, 1)[0])
    if (rawPath.split('/').some((segment) => segment === '.' || segment === '..')) {
      throw validationError('METADATA_FILE_TRAVERSAL', `${fieldName} 包含不安全的路径段`)
    }
    const artifactUrl = new URL(raw, 'https://updates.invalid/')
    if (artifactUrl.search || artifactUrl.hash) {
      throw validationError('METADATA_FILE_SUFFIX', `${fieldName} 不得包含查询参数或片段`)
    }
    decoded = decodeURIComponent(artifactUrl.pathname.slice(1))
  } catch (error) {
    if (error instanceof ReleaseValidationError) throw error
    throw validationError('METADATA_FILE_INVALID', `${fieldName} 包含无效的 URL 编码`)
  }

  const segments = decoded.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw validationError('METADATA_FILE_TRAVERSAL', `${fieldName} 包含不安全的路径段`)
  }
  if (decoded.includes('\\') || /[<>:"|?*\u0000-\u001F]/.test(decoded)) {
    throw validationError('METADATA_FILE_UNSAFE', `${fieldName} 解码后包含 Windows 不允许的文件名字符`)
  }
  return decoded
}

function assertBlockmap(buffer, label, code) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2 || buffer[0] !== 0x1f || buffer[1] !== 0x8b) {
    throw validationError(code, `${label} 不是有效的 gzip blockmap`)
  }
  let parsed
  try {
    const unpacked = gunzipSync(buffer, { maxOutputLength: MAX_BLOCKMAP_DECOMPRESSED_BYTES })
    parsed = JSON.parse(unpacked.toString('utf8'))
  } catch {
    throw validationError(code, `${label} 无法安全解压或解析`)
  }
  const valid = parsed
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && parsed.version === '2'
    && Array.isArray(parsed.files)
    && parsed.files.length > 0
    && parsed.files.every((file) => (
      file
      && typeof file === 'object'
      && !Array.isArray(file)
      && typeof file.name === 'string'
      && file.name.length > 0
      && Number.isSafeInteger(file.offset)
      && file.offset >= 0
      && Array.isArray(file.sizes)
      && file.sizes.length > 0
      && file.sizes.every((size) => Number.isSafeInteger(size) && size > 0)
      && Array.isArray(file.checksums)
      && file.checksums.length === file.sizes.length
      && file.checksums.every((checksum) => (
        typeof checksum === 'string'
        && /^[A-Za-z0-9+/]+={0,2}$/.test(checksum)
      ))
    ))
  if (!valid) throw validationError(code, `${label} 的结构无效`)
}

function parseReleaseVersion(value) {
  if (typeof value !== 'string') return null
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (!match) return null
  const numbers = match.slice(1, 4).map(Number)
  if (numbers.some((part) => !Number.isSafeInteger(part))) return null
  const prerelease = match[4]
    ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : null
  if (prerelease?.some((part) => typeof part === 'number' && !Number.isSafeInteger(part))) return null
  return { numbers, prerelease }
}

/** Compare the public release version without treating build metadata as precedence. */
function compareReleaseVersions(left, right) {
  const leftParsed = parseReleaseVersion(left)
  const rightParsed = parseReleaseVersion(right)
  if (!leftParsed || !rightParsed) {
    throw validationError('RELEASE_VERSION_INVALID', '发布版本号无效，无法比较')
  }
  for (let index = 0; index < leftParsed.numbers.length; index += 1) {
    if (leftParsed.numbers[index] !== rightParsed.numbers[index]) {
      return leftParsed.numbers[index] < rightParsed.numbers[index] ? -1 : 1
    }
  }
  const leftPre = leftParsed.prerelease
  const rightPre = rightParsed.prerelease
  if (!leftPre && !rightPre) return 0
  if (!leftPre) return 1
  if (!rightPre) return -1
  const length = Math.max(leftPre.length, rightPre.length)
  for (let index = 0; index < length; index += 1) {
    if (index >= leftPre.length) return -1
    if (index >= rightPre.length) return 1
    const leftPart = leftPre[index]
    const rightPart = rightPre[index]
    if (leftPart === rightPart) continue
    if (typeof leftPart === 'number' && typeof rightPart === 'number') {
      return leftPart < rightPart ? -1 : 1
    }
    if (typeof leftPart === 'number') return -1
    if (typeof rightPart === 'number') return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

/**
 * Resolve the feed that gets embedded into a package at build time.
 *
 * The updater URL is part of app-update.yml, so changing this at runtime would
 * strand already-installed clients or silently move them between buckets.
 * Versions before 0.1.3 stay on the legacy bucket; 0.1.3 and newer use the
 * new R2 route. Explicit XINGMANG_UPDATE_URL overrides this resolver.
 */
function resolveUpdateUrlForVersion(version) {
  const comparison = compareReleaseVersions(version, UPDATE_MIGRATION_VERSION)
  return comparison >= 0 ? NEW_UPDATE_URL : LEGACY_UPDATE_URL
}

function assertRemoteReleaseIsOlder(remoteVersion, localVersion) {
  const comparison = compareReleaseVersions(remoteVersion, localVersion)
  if (comparison >= 0) {
    throw validationError(
      comparison === 0 ? 'REMOTE_VERSION_ALREADY_PUBLISHED' : 'REMOTE_VERSION_NEWER_THAN_LOCAL',
      comparison === 0
        ? `远端已经发布 v${remoteVersion}，不能覆盖同版本；请先提升 package.json 版本`
        : `远端已经发布更高版本 v${remoteVersion}，当前本地版本 v${localVersion} 不能回退发布`,
    )
  }
}

function validSha512(value, fieldName) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(value)) {
    throw validationError('METADATA_SHA512_INVALID', `${fieldName} 不是有效的 SHA-512 Base64 摘要`)
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length !== 64 || decoded.toString('base64') !== value) {
    throw validationError('METADATA_SHA512_INVALID', `${fieldName} 不是有效的 SHA-512 Base64 摘要`)
  }
  return value
}

function parseLatestMetadata(text, metadataFile = 'latest.yml') {
  const label = metadataFile === 'latest-mac.yml' ? 'latest-mac.yml' : 'latest.yml'
  if (typeof text !== 'string' || !text.trim()) {
    throw validationError('METADATA_EMPTY', `${label} 为空`)
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_METADATA_BYTES) {
    throw validationError('METADATA_TOO_LARGE', `${label} 超过 1 MiB 限制`)
  }
  const prefix = text.trimStart().slice(0, 256).toLowerCase()
  if (prefix.startsWith('<!doctype html') || prefix.startsWith('<html') || prefix.includes('<head>')) {
    throw validationError(
      'METADATA_IS_HTML',
      `${label} 返回了 HTML 页面；请把更新目录配置为静态文件源，不能回退到官网 SPA`,
    )
  }

  let value
  try {
    value = YAML.parse(text, { maxAliasCount: 0, uniqueKeys: true })
  } catch {
    throw validationError('METADATA_YAML_INVALID', `${label} 不是有效且唯一键的 YAML`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError('METADATA_SHAPE_INVALID', `${label} 顶层必须是对象`)
  }
  if (typeof value.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value.version)) {
    throw validationError('METADATA_VERSION_INVALID', `${label}.version 必须是有效版本号`)
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw validationError('METADATA_FILES_INVALID', `${label}.files 必须包含至少一个更新文件`)
  }

  const seen = new Set()
  const files = value.files.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw validationError('METADATA_FILE_INVALID', `${label}.files[${index}] 必须是对象`)
    }
    const relativePath = safeRelativeArtifactPath(entry.url, `files[${index}].url`)
    if (seen.has(relativePath.toLowerCase())) {
      throw validationError('METADATA_FILE_DUPLICATE', `${label}.files 包含重复文件：${relativePath}`)
    }
    seen.add(relativePath.toLowerCase())
    const size = entry.size === undefined ? null : Number(entry.size)
    if (size !== null && (!Number.isSafeInteger(size) || size <= 0)) {
      throw validationError('METADATA_SIZE_INVALID', `files[${index}].size 必须是正整数`)
    }
    return {
      relativePath,
      rawUrl: entry.url,
      encodedPath: entry.url.trim(),
      sha512: validSha512(entry.sha512, `files[${index}].sha512`),
      size,
    }
  })

  const primaryPath = safeRelativeArtifactPath(value.path, 'path')
  const primary = files.find((entry) => entry.relativePath.toLowerCase() === primaryPath.toLowerCase())
  if (!primary) {
    throw validationError('METADATA_PRIMARY_MISSING', `${label}.path 必须对应 files 中的文件`)
  }
  const primarySha512 = validSha512(value.sha512, 'sha512')
  if (primary.sha512 !== primarySha512) {
    throw validationError('METADATA_PRIMARY_HASH_MISMATCH', `${label}.sha512 与主更新文件摘要不一致`)
  }

  return {
    version: value.version,
    rawPrimaryPath: value.path,
    primaryPath,
    files,
  }
}

function assertMacosUpdateArchitectureInventory(metadata) {
  const expectedPaths = []
  for (const architecture of ['arm64', 'x64']) {
    const expectedPath = `XingMang-AI-Manager-${metadata.version}-${architecture}.zip`
    expectedPaths.push(expectedPath)
    if (!metadata.files.some((file) => file.relativePath === expectedPath)) {
      throw validationError(
        'MACOS_UPDATE_ARCHITECTURE_INCOMPLETE',
        `latest-mac.yml 缺少 ${architecture} 架构更新文件：${expectedPath}`,
      )
    }
  }
  const expected = new Set(expectedPaths)
  if (!expected.has(metadata.primaryPath)) {
    throw validationError(
      'MACOS_UPDATE_PRIMARY_INVALID',
      'latest-mac.yml 主更新文件必须是当前版本的 arm64 或 x64 ZIP',
    )
  }
  const zipPaths = metadata.files
    .map((file) => file.relativePath)
    .filter((filePath) => filePath.toLowerCase().endsWith('.zip'))
  if (zipPaths.length !== expected.size || zipPaths.some((filePath) => !expected.has(filePath))) {
    throw validationError(
      'MACOS_UPDATE_ZIP_INVENTORY_INVALID',
      'latest-mac.yml 必须且只能包含当前版本的 arm64 与 x64 ZIP 更新文件',
    )
  }
}

async function sha512File(filePath) {
  const hash = createHash('sha512')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
  return hash.digest('base64')
}

async function validateLocalRelease(directory, { expectedVersion = null } = {}) {
  const releaseDirectory = path.resolve(directory)
  const metadataPath = path.join(releaseDirectory, 'latest.yml')
  let text
  try {
    text = await fs.promises.readFile(metadataPath, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw validationError('LOCAL_METADATA_MISSING', `未找到 ${metadataPath}`)
    }
    throw error
  }
  const metadata = parseLatestMetadata(text)
  if (expectedVersion !== null && metadata.version !== expectedVersion) {
    throw validationError(
      'LOCAL_VERSION_MISMATCH',
      `latest.yml 版本 ${metadata.version} 与当前 package.json 版本 ${expectedVersion} 不一致`,
    )
  }

  for (const file of metadata.files) {
    const artifactPath = path.resolve(releaseDirectory, file.relativePath)
    const relative = path.relative(releaseDirectory, artifactPath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw validationError('LOCAL_ARTIFACT_TRAVERSAL', `更新文件超出 release 目录：${file.relativePath}`)
    }
    let stat
    try {
      stat = await fs.promises.stat(artifactPath)
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        throw validationError('LOCAL_ARTIFACT_MISSING', `更新文件不存在：${file.relativePath}`)
      }
      throw error
    }
    if (!stat.isFile() || stat.size === 0) {
      throw validationError('LOCAL_ARTIFACT_EMPTY', `更新文件为空或不是文件：${file.relativePath}`)
    }
    if (file.size !== null && file.size !== stat.size) {
      throw validationError('LOCAL_ARTIFACT_SIZE_MISMATCH', `更新文件大小不匹配：${file.relativePath}`)
    }
    const versionInName = /(?:^|[-_])v?(\d+\.\d+\.\d+)(?:[-_.]|$)/.exec(path.basename(file.relativePath))?.[1]
    // The pattern only captures x.y.z, so a prerelease like 1.2.4-beta.1 needs
    // the filename to carry the full metadata version to pass.
    if (
      versionInName
      && versionInName !== metadata.version
      && !(metadata.version.startsWith(`${versionInName}-`)
        && path.basename(file.relativePath).includes(metadata.version))
    ) {
      throw validationError(
        'LOCAL_ARTIFACT_VERSION_MISMATCH',
        `更新文件 ${file.relativePath} 的版本 ${versionInName} 与 latest.yml ${metadata.version} 不一致`,
      )
    }
    if (await sha512File(artifactPath) !== file.sha512) {
      throw validationError('LOCAL_ARTIFACT_HASH_MISMATCH', `更新文件 SHA-512 不匹配：${file.relativePath}`)
    }
  }

  const blockmapPath = path.join(releaseDirectory, `${metadata.primaryPath}.blockmap`)
  const blockmap = await fs.promises.stat(blockmapPath).catch(() => null)
  if (!blockmap?.isFile() || blockmap.size === 0) {
    throw validationError('LOCAL_BLOCKMAP_MISSING', `缺少主安装程序 blockmap：${metadata.primaryPath}.blockmap`)
  }
  if (blockmap.size > MAX_BLOCKMAP_BYTES) {
    throw validationError('LOCAL_BLOCKMAP_TOO_LARGE', `主安装程序 blockmap 超过 ${MAX_BLOCKMAP_BYTES} 字节上限`)
  }
  assertBlockmap(
    await fs.promises.readFile(blockmapPath),
    `主安装程序 blockmap ${metadata.primaryPath}.blockmap`,
    'LOCAL_BLOCKMAP_INVALID',
  )

  return { releaseDirectory, metadata, metadataPath, blockmapPath }
}

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel()
  } catch {
    // The connection may already be closed by the remote server.
  }
}

function declaredResponseSize(response, label) {
  const raw = response.headers.get('content-length')
  if (raw === null) return null
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw validationError('REMOTE_CONTENT_LENGTH_INVALID', `${label} 的 Content-Length 无效`)
  }
  const size = Number(trimmed)
  if (!Number.isSafeInteger(size)) {
    throw validationError('REMOTE_CONTENT_LENGTH_INVALID', `${label} 的 Content-Length 超出安全整数范围`)
  }
  return size
}

async function readBoundedResponse(response, {
  label,
  absoluteLimit,
  expectedSize = null,
  collect = false,
  hashAlgorithm = null,
  tooLargeCode = 'REMOTE_BODY_TOO_LARGE',
  sizeMismatchCode = 'REMOTE_BODY_SIZE_MISMATCH',
  emptyCode = null,
}) {
  const failBeforeRead = async (code, message) => {
    await cancelResponseBody(response)
    throw validationError(code, message)
  }
  const contentEncoding = response.headers.get('content-encoding')?.trim().toLowerCase()
  if (contentEncoding && contentEncoding !== 'identity') {
    await failBeforeRead(
      'REMOTE_CONTENT_ENCODING_UNSUPPORTED',
      `${label} 未遵守 Accept-Encoding: identity（实际为 ${contentEncoding}）`,
    )
  }
  if (expectedSize !== null && expectedSize > absoluteLimit) {
    await failBeforeRead(tooLargeCode, `${label} 的声明大小超过允许上限`)
  }

  let declaredSize
  try {
    declaredSize = declaredResponseSize(response, label)
  } catch (error) {
    await cancelResponseBody(response)
    throw error
  }
  if (declaredSize !== null && declaredSize > absoluteLimit) {
    await failBeforeRead(tooLargeCode, `${label} 的 Content-Length 超过允许上限`)
  }
  if (expectedSize !== null && declaredSize !== null && declaredSize !== expectedSize) {
    await failBeforeRead(sizeMismatchCode, `${label} 的 Content-Length 与声明大小不一致`)
  }
  if (emptyCode && declaredSize === 0) {
    await failBeforeRead(emptyCode, `${label} 为空`)
  }
  if (!response.body) {
    throw validationError('REMOTE_BODY_MISSING', `${label} 响应没有正文`)
  }

  const reader = response.body.getReader()
  const chunks = collect ? [] : null
  const hash = hashAlgorithm ? createHash(hashAlgorithm) : null
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      total += chunk.length
      if (total > absoluteLimit) {
        await reader.cancel()
        throw validationError(tooLargeCode, `${label} 正文超过允许上限`)
      }
      if (expectedSize !== null && total > expectedSize) {
        await reader.cancel()
        throw validationError(sizeMismatchCode, `${label} 正文超过声明大小`)
      }
      if (chunks) chunks.push(chunk)
      hash?.update(chunk)
    }
  } catch (error) {
    if (error instanceof ReleaseValidationError) throw error
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw validationError('REMOTE_TIMEOUT', `读取 ${label} 超时`)
    }
    throw validationError('REMOTE_BODY_READ_FAILED', `读取 ${label} 失败：${error?.message || 'unknown error'}`)
  } finally {
    reader.releaseLock()
  }

  if (expectedSize !== null && total !== expectedSize) {
    throw validationError(sizeMismatchCode, `${label} 正文大小与声明不一致`)
  }
  if (declaredSize !== null && total !== declaredSize) {
    throw validationError('REMOTE_CONTENT_LENGTH_MISMATCH', `${label} 正文大小与 Content-Length 不一致`)
  }
  if (emptyCode && total === 0) {
    throw validationError(emptyCode, `${label} 为空`)
  }
  return {
    buffer: chunks ? Buffer.concat(chunks, total) : null,
    digest: hash ? hash.digest('base64') : null,
    size: total,
  }
}

async function responseBuffer(response, byteLimit, label = '更新服务器响应') {
  const result = await readBoundedResponse(response, {
    label,
    absoluteLimit: byteLimit,
    collect: true,
  })
  return result.buffer
}

function assertUrlWithinUpdateBase(url, normalizedBaseUrl) {
  const target = new URL(url)
  const base = new URL(normalizedBaseUrl)
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
    throw validationError('REMOTE_URL_OUTSIDE_BASE', '更新资源 URL 超出配置的更新目录')
  }
}

function assertSafeResponseUrl(response, requestedUrl, normalizedBaseUrl) {
  assertUrlWithinUpdateBase(requestedUrl, normalizedBaseUrl)
  let responseUrl
  try {
    responseUrl = new URL(response.url).href
  } catch {
    throw validationError('REMOTE_RESPONSE_URL_INVALID', '更新服务器返回了无效响应 URL')
  }
  if (responseUrl !== new URL(requestedUrl).href) {
    throw validationError('REMOTE_REDIRECT_FORBIDDEN', '更新服务器响应 URL 与请求地址不一致')
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  try {
    const headers = new Headers(options.headers)
    headers.set('Accept-Encoding', 'identity')
    const response = await fetch(url, {
      ...options,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (REDIRECT_STATUS_CODES.has(response.status)) {
      await cancelResponseBody(response)
      throw validationError(
        'REMOTE_REDIRECT_FORBIDDEN',
        `更新服务器返回 HTTP ${response.status} 重定向；发布源验证不允许重定向`,
      )
    }
    return response
  } catch (error) {
    if (error instanceof ReleaseValidationError) throw error
    if (error?.name === 'TimeoutError') {
      throw validationError('REMOTE_TIMEOUT', '连接更新服务器超时')
    }
    throw validationError('REMOTE_UNREACHABLE', `无法连接更新服务器：${error?.message || 'unknown error'}`)
  }
}

async function verifyRemoteChannel({
  normalizedBaseUrl,
  metadataFile,
  allowMissing = false,
  verifyAssets = true,
  requireBlockmap = false,
  timeoutMs = 30_000,
}) {
  const metadataUrl = new URL(metadataFile, normalizedBaseUrl).href
  const metadataResponse = await fetchWithTimeout(metadataUrl, {
    headers: { Accept: 'application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.1' },
  }, timeoutMs)
  assertSafeResponseUrl(metadataResponse, metadataUrl, normalizedBaseUrl)
  if (metadataResponse.status === 404 && allowMissing) {
    await cancelResponseBody(metadataResponse)
    return { missing: true, metadata: null }
  }
  if (!metadataResponse.ok) {
    await cancelResponseBody(metadataResponse)
    throw validationError('REMOTE_METADATA_STATUS', `${metadataFile} 返回 HTTP ${metadataResponse.status}`)
  }
  const contentType = metadataResponse.headers.get('content-type')?.toLowerCase() || ''
  if (contentType.includes('text/html')) {
    await cancelResponseBody(metadataResponse)
    throw validationError(
      'REMOTE_METADATA_HTML',
      `${metadataFile} 返回了 text/html；更新路径仍被官网 SPA 接管`,
    )
  }
  const metadataText = (await responseBuffer(
    metadataResponse,
    MAX_METADATA_BYTES,
    metadataFile,
  )).toString('utf8')
  const metadata = parseLatestMetadata(metadataText, metadataFile)
  if (metadataFile === 'latest-mac.yml') assertMacosUpdateArchitectureInventory(metadata)

  if (verifyAssets) {
    for (const file of metadata.files) {
      if (file.size !== null && file.size > MAX_ARTIFACT_BYTES) {
        throw validationError(
          'REMOTE_ARTIFACT_TOO_LARGE',
          `${file.relativePath} 的声明大小超过安装包允许上限`,
        )
      }
      const assetUrl = new URL(file.encodedPath, normalizedBaseUrl).href
      const response = await fetchWithTimeout(assetUrl, {}, timeoutMs)
      assertSafeResponseUrl(response, assetUrl, normalizedBaseUrl)
      if (!response.ok) {
        await cancelResponseBody(response)
        throw validationError('REMOTE_ARTIFACT_STATUS', `${file.relativePath} 返回 HTTP ${response.status}`)
      }
      const artifact = await readBoundedResponse(response, {
        label: file.relativePath,
        absoluteLimit: MAX_ARTIFACT_BYTES,
        expectedSize: file.size,
        hashAlgorithm: 'sha512',
        tooLargeCode: 'REMOTE_ARTIFACT_TOO_LARGE',
        sizeMismatchCode: 'REMOTE_ARTIFACT_SIZE_MISMATCH',
      })
      if (artifact.digest !== file.sha512) {
        throw validationError('REMOTE_ARTIFACT_HASH_MISMATCH', `${file.relativePath} 远端 SHA-512 不匹配`)
      }
    }

    if (requireBlockmap) {
      const primary = metadata.files.find((file) => (
        file.relativePath.toLowerCase() === metadata.primaryPath.toLowerCase()
      ))
      if (!primary) throw validationError('METADATA_PRIMARY_MISSING', `${metadataFile} 主更新文件缺失`)
      const blockmapFiles = requireBlockmap === 'all-zips'
        ? metadata.files.filter((file) => file.relativePath.toLowerCase().endsWith('.zip'))
        : [primary]
      for (const file of blockmapFiles) {
        const blockmapPath = `${file.relativePath}.blockmap`
        const blockmapUrl = new URL(`${file.encodedPath}.blockmap`, normalizedBaseUrl).href
        const blockmapResponse = await fetchWithTimeout(blockmapUrl, {}, timeoutMs)
        assertSafeResponseUrl(blockmapResponse, blockmapUrl, normalizedBaseUrl)
        if (!blockmapResponse.ok) {
          await cancelResponseBody(blockmapResponse)
          throw validationError('REMOTE_BLOCKMAP_STATUS', `${blockmapPath} 返回 HTTP ${blockmapResponse.status}`)
        }
        const blockmapContentType = blockmapResponse.headers.get('content-type')?.toLowerCase() || ''
        if (blockmapContentType.includes('text/html')) {
          await cancelResponseBody(blockmapResponse)
          throw validationError('REMOTE_BLOCKMAP_INVALID', `${blockmapPath} 返回了 HTML 页面`)
        }
        const blockmap = await readBoundedResponse(blockmapResponse, {
          label: blockmapPath,
          absoluteLimit: MAX_BLOCKMAP_BYTES,
          collect: true,
          tooLargeCode: 'REMOTE_BLOCKMAP_TOO_LARGE',
          emptyCode: 'REMOTE_BLOCKMAP_EMPTY',
        })
        assertBlockmap(blockmap.buffer, `ZIP blockmap ${blockmapPath}`, 'REMOTE_BLOCKMAP_INVALID')
      }
    }
  }

  return { missing: false, metadata }
}

async function verifyRemoteFeed({
  baseUrl,
  allowLocalHttp = false,
  allowMissing = false,
  verifyAssets = true,
  timeoutMs = 30_000,
  platform = 'all',
}) {
  if (!['all', 'windows', 'macos'].includes(platform)) {
    throw validationError('VERIFY_PLATFORM_INVALID', `不支持的更新通道：${platform}`)
  }
  const normalizedBaseUrl = normalizeUpdateBaseUrl(baseUrl, { allowLocalHttp })
  const windows = platform === 'macos'
    ? { skipped: true, missing: true, metadata: null }
    : await verifyRemoteChannel({
        normalizedBaseUrl,
        metadataFile: 'latest.yml',
        allowMissing,
        verifyAssets,
        requireBlockmap: true,
        timeoutMs,
      })
  const mac = platform === 'windows'
    ? { skipped: true, missing: true, metadata: null }
    : await verifyRemoteChannel({
        normalizedBaseUrl,
        metadataFile: 'latest-mac.yml',
        allowMissing,
        verifyAssets,
        requireBlockmap: 'all-zips',
        timeoutMs,
      })
  return { baseUrl: normalizedBaseUrl, ...windows, mac }
}

function validateReleaseEnvironment(env = process.env, packageVersion = null) {
  const defaultUrl = packageVersion
    ? resolveUpdateUrlForVersion(packageVersion)
    : DEFAULT_UPDATE_URL
  const updateUrl = normalizeUpdateBaseUrl(env.XINGMANG_UPDATE_URL?.trim() || defaultUrl)
  const releaseMode = env.XINGMANG_RELEASE === '1'
  const allowUnsigned = env.XINGMANG_ALLOW_UNSIGNED_RELEASE === '1'
  const certificate = env.WIN_CSC_LINK?.trim() || env.CSC_LINK?.trim() || null
  const expectedPublisher = env.XINGMANG_SIGNING_PUBLISHER?.trim() || null
  if (releaseMode && allowUnsigned) {
    throw validationError(
      'UNSIGNED_RELEASE_OVERRIDE_FORBIDDEN',
      '正式发布不能使用未签名覆盖；仅允许在未设置 XINGMANG_RELEASE 时进行本地调试构建',
    )
  }
  if (releaseMode && !certificate) {
    throw validationError(
      'SIGNING_CERTIFICATE_MISSING',
      '正式发布缺少 Windows 代码签名证书，请配置 WIN_CSC_LINK 或 CSC_LINK',
    )
  }
  if (releaseMode && !expectedPublisher) {
    throw validationError(
      'SIGNING_PUBLISHER_MISSING',
      '正式发布缺少固定签名发布者，请配置 XINGMANG_SIGNING_PUBLISHER',
    )
  }
  return {
    updateUrl,
    signing: {
      releaseMode,
      allowUnsigned,
      certificateConfigured: Boolean(certificate),
      expectedPublisher,
    },
  }
}

function resolveEmptyReleaseOutputDirectory(rootDirectory, version, configuredPath = '') {
  const root = path.resolve(rootDirectory)
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw validationError('RELEASE_VERSION_INVALID', '发布版本号无效，无法创建隔离输出目录')
  }
  const requested = typeof configuredPath === 'string' && configuredPath.trim()
    ? configuredPath.trim()
    : `release-${version}`
  const outputDirectory = path.resolve(root, requested)
  const relative = path.relative(root, outputDirectory)
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw validationError('RELEASE_OUTPUT_UNSAFE', '正式发布输出目录必须位于项目目录内且不能是项目根目录')
  }

  const realRoot = fs.realpathSync(root)
  let existingAncestor = outputDirectory
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor)
    if (parent === existingAncestor) break
    existingAncestor = parent
  }
  const realAncestor = fs.realpathSync(existingAncestor)
  const realRelative = path.relative(realRoot, realAncestor)
  if (path.isAbsolute(realRelative) || realRelative === '..' || realRelative.startsWith(`..${path.sep}`)) {
    throw validationError('RELEASE_OUTPUT_UNSAFE', '正式发布输出目录的父目录链接指向项目目录外')
  }

  let stats
  try {
    stats = fs.lstatSync(outputDirectory)
  } catch (error) {
    if (error?.code === 'ENOENT') return outputDirectory
    throw error
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw validationError('RELEASE_OUTPUT_UNSAFE', '正式发布输出路径必须是普通目录，不能是文件或链接')
  }
  const entries = fs.readdirSync(outputDirectory)
  if (entries.length > 0) {
    throw validationError(
      'RELEASE_OUTPUT_NOT_EMPTY',
      `正式发布输出目录不是空目录：${outputDirectory}；请保留现有产物并指定新的空目录`,
    )
  }
  return outputDirectory
}

module.exports = {
  DEFAULT_UPDATE_URL,
  LEGACY_UPDATE_URL,
  NEW_UPDATE_URL,
  UPDATE_MIGRATION_VERSION,
  MAX_ARTIFACT_BYTES,
  MAX_BLOCKMAP_BYTES,
  MAX_METADATA_BYTES,
  ReleaseValidationError,
  assertBlockmap,
  assertRemoteReleaseIsOlder,
  compareReleaseVersions,
  normalizeUpdateBaseUrl,
  parseLatestMetadata,
  safeRelativeArtifactPath,
  resolveEmptyReleaseOutputDirectory,
  resolveUpdateUrlForVersion,
  sha512File,
  validateLocalRelease,
  validateReleaseEnvironment,
  verifyRemoteFeed,
}
