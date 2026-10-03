const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const https = require('node:https')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { performance } = require('node:perf_hooks')
const { createHash, randomUUID } = require('node:crypto')

const API_ROOT = 'https://claude.ai/api/desktop/'
const APT_ROOT = 'https://downloads.claude.ai/claude-desktop/apt/stable/'
// Final CDN hosts have not been independently observed in this session. An
// unknown redirect must fail closed, never expand this list from response data.
const OFFICIAL_HOSTS = Object.freeze(['claude.ai', 'downloads.claude.ai'])
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_METADATA_BYTES = 1024 * 1024
// Keep emergency packages within the previously authorized manager prefix,
// separate from formal manager releases and their latest pointer.
const OFFLINE_PREFIX = 'xingmang/offline/claude'
const LATEST_KEY = `${OFFLINE_PREFIX}/latest.json`
const SOURCES = Object.freeze({
  'windows-x64': Object.freeze({ platform: 'windows', architecture: 'x64', format: 'msix', fileName: 'Claude-x64.msix', type: 'application/vnd.ms-appx', requestUrl: `${API_ROOT}win32/x64/msix/latest/redirect`, verification: 'windows-authenticode-msix-identity' }),
  'windows-arm64': Object.freeze({ platform: 'windows', architecture: 'arm64', format: 'msix', fileName: 'Claude-arm64.msix', type: 'application/vnd.ms-appx', requestUrl: `${API_ROOT}win32/arm64/msix/latest/redirect`, verification: 'windows-authenticode-msix-identity' }),
  'macos-dmg-universal': Object.freeze({ platform: 'macos', architecture: 'universal', format: 'dmg', fileName: 'Claude-universal.dmg', type: 'application/x-apple-diskimage', requestUrl: `${API_ROOT}darwin/universal/dmg/latest/redirect`, verification: 'macos-codesign-universal' }),
  'macos-pkg-universal': Object.freeze({ platform: 'macos', architecture: 'universal', format: 'pkg', fileName: 'Claude-universal.pkg', type: 'application/vnd.apple.installer+xml', requestUrl: `${API_ROOT}darwin/universal/pkg/latest/redirect`, verification: 'macos-installer-signature' }),
  'linux-deb-x64': Object.freeze({ platform: 'linux', architecture: 'x64', packageArchitecture: 'amd64', format: 'deb', fileName: 'claude-desktop-amd64.deb', type: 'application/vnd.debian.binary-package', metadataUrl: `${APT_ROOT}dists/stable/main/binary-amd64/Packages`, verification: 'official-https-package-index-sha256' }),
  'linux-deb-arm64': Object.freeze({ platform: 'linux', architecture: 'arm64', packageArchitecture: 'arm64', format: 'deb', fileName: 'claude-desktop-arm64.deb', type: 'application/vnd.debian.binary-package', metadataUrl: `${APT_ROOT}dists/stable/main/binary-arm64/Packages`, verification: 'official-https-package-index-sha256' }),
})

function parsePlatforms(value = 'all') {
  const aliases = { all: Object.keys(SOURCES), windows: ['windows-x64', 'windows-arm64'], macos: ['macos-dmg-universal', 'macos-pkg-universal'], linux: ['linux-deb-x64', 'linux-deb-arm64'] }
  if (typeof value === 'string' && Object.hasOwn(aliases, value)) return [...aliases[value]]
  const values = Array.isArray(value) ? value : String(value).split(',')
  const ids = [...new Set(values.map(function (item) { return String(item).trim() }))]
  if (!ids.length || ids.some(function (id) { return !Object.hasOwn(SOURCES, id) })) throw new Error('Claude 官方包平台无效；支持 all/windows/macos/linux 或精确平台 ID')
  return ids
}

function validateOfficialUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('Claude 官方来源地址无效') }
  if (!OFFICIAL_HOSTS.includes(url.hostname)) {
    const error = new Error('Claude 下载重定向到了尚未核实的主机，已停止')
    error.code = 'CLAUDE_UNVERIFIED_SOURCE_HOST'
    error.hostname = url.hostname
    throw error
  }
  if (url.protocol !== 'https:' || !OFFICIAL_HOSTS.includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash
    || (url.hostname === 'claude.ai' ? !url.pathname.startsWith('/api/desktop/') : !/^\/(?:claude-desktop\/|releases\/)/.test(url.pathname))) {
    throw new Error('Claude 下载地址或重定向未通过固定官方 HTTPS 范围校验；未知 CDN 需要另行核实')
  }
  return url
}

function validateHead(value) {
  if (!value || !Number.isSafeInteger(value.bytes) || value.bytes < 8 || value.bytes > MAX_PACKAGE_BYTES) throw new Error('Claude 安装包大小无效或超过上限')
  if (typeof value.etag !== 'string' || !value.etag || value.etag.length > 256 || /[\r\n]/.test(value.etag)) throw new Error('Claude 安装包缺少安全的 ETag')
  return { bytes: value.bytes, etag: value.etag, lastModified: typeof value.lastModified === 'string' ? value.lastModified : null }
}

function validateVersion(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^\d+\.\d+\.\d+(?:\.\d+)?(?:-\d+)?$/.test(value)
    || value.split(/[.-]/).some(function (part) { return !Number.isSafeInteger(Number(part)) })) throw new Error('Claude 包内或官方索引版本格式尚未支持，已停止发布')
  return value
}

function compareVersions(left, right) {
  const a = validateVersion(left).split(/[.-]/).map(Number)
  const b = validateVersion(right).split(/[.-]/).map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0)
    if (difference) return difference < 0 ? -1 : 1
  }
  return 0
}

async function requestHead(url, options = {}) {
  validateOfficialUrl(url)
  return new Promise(function (resolve, reject) {
    let request
    const timer = setTimeout(function () {
      if (request) request.destroy()
      reject(new Error('Claude 官方包响应头超时'))
    }, 30000)
    function fail() {
      clearTimeout(timer)
      reject(new Error('Claude 官方包网络请求失败；未记录正文或认证信息'))
    }
    try {
      request = (options.requestImpl || https.request)(new URL(url), { method: 'HEAD', headers: { 'accept-encoding': 'identity', 'user-agent': 'xingmang-official-offline-sync/1' }, agent: false, maxHeaderSize: 16 * 1024 }, function (response) {
        clearTimeout(timer)
        const headers = response.headers || {}
        response.destroy()
        resolve({ status: response.statusCode, headers })
      })
      request.on('error', fail)
      request.end()
    } catch { fail() }
  })
}

async function resolveOfficialPackage(requestUrl, options = {}) {
  const head = options.requestHead || requestHead
  let current = validateOfficialUrl(requestUrl).href
  const redirects = []
  const visited = new Set()
  const started = performance.now()
  for (let hop = 0; hop <= 3; hop += 1) {
    if (visited.has(current) || performance.now() - started > 120000) throw new Error('Claude 官方下载重定向循环或总超时')
    visited.add(current)
    const result = await head(current, options)
    if ([301, 302, 303, 307, 308].includes(result.status)) {
      if (hop === 3 || typeof result.headers.location !== 'string' || result.headers.location.length > 4096) throw new Error('Claude 官方下载重定向超过上限或无效')
      const next = validateOfficialUrl(new URL(result.headers.location, current).href).href
      redirects.push({ from: current, to: next, status: result.status })
      current = next
      continue
    }
    if (result.status !== 200 || result.headers['content-encoding'] && result.headers['content-encoding'] !== 'identity') throw new Error('Claude 官方完整包未返回 HTTP 200 未压缩正文')
    const length = result.headers['content-length']
    if (typeof length !== 'string' || !/^[1-9][0-9]*$/.test(length)) throw new Error('Claude 官方包 Content-Length 无效')
    return { requestUrl, url: current, redirects, ...validateHead({ bytes: Number(length), etag: result.headers.etag, lastModified: result.headers['last-modified'] }) }
  }
  throw new Error('Claude 官方下载地址无法安全解析')
}

function parseFields(text) {
  const fields = {}
  for (const line of text.split(/\r?\n/)) {
    if (!line || /^[ \t]/.test(line)) continue
    const match = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/.exec(line)
    if (!match || Object.hasOwn(fields, match[1])) throw new Error('Claude Linux 包元数据字段无效或重复')
    fields[match[1]] = match[2]
  }
  return fields
}

function parseDebianPackages(text, architecture) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_METADATA_BYTES || !['amd64', 'arm64'].includes(architecture)) throw new Error('Claude Linux 官方索引超限或架构无效')
  const selected = []
  for (const paragraph of text.trim().split(/\r?\n\s*\r?\n/)) {
    const fields = parseFields(paragraph)
    if (fields.Package !== 'claude-desktop') continue
    const version = validateVersion(fields.Version)
    if (fields.Architecture !== architecture || !/^[1-9][0-9]*$/.test(fields.Size || '') || Number(fields.Size) > MAX_PACKAGE_BYTES
      || !/^[a-f0-9]{64}$/.test(fields.SHA256 || '')
      || !new RegExp(`^pool/main/c/claude-desktop/claude-desktop_[0-9A-Za-z.+~-]+_${architecture}\\.deb$`).test(fields.Filename || '')) throw new Error('Claude Linux 官方包身份、摘要或固定目录无效')
    const url = validateOfficialUrl(new URL(fields.Filename, APT_ROOT).href).href
    selected.push({ version, url, bytes: Number(fields.Size), expectedSha256: fields.SHA256, packageArchitecture: architecture })
  }
  if (!selected.length || selected.length > 512) throw new Error('Claude Linux 官方索引缺少可验证包或数量超限')
  selected.sort(function (left, right) { return compareVersions(right.version, left.version) })
  if (selected[1] && compareVersions(selected[0].version, selected[1].version) === 0) throw new Error('Claude Linux 同版本官方包存在歧义')
  return selected[0]
}

function artifactKey(id, sha256) {
  if (!Object.hasOwn(SOURCES, id) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Claude 不可变对象参数无效')
  return `${OFFLINE_PREFIX}/${id}/sha256-${sha256}/${SOURCES[id].fileName}`
}

function sourceRecord(source, resource) {
  // Public indexes retain the documented stable entry point, never a resolved
  // CDN location or a redirect chain that could later acquire temporary tokens.
  return { requestUrl: source.requestUrl || source.metadataUrl, ...validateHead(resource), resolvedHost: validateOfficialUrl(resource.url).hostname,
    redirectCount: resource.redirects.length,
    ...(source.metadataUrl ? { metadataUrl: source.metadataUrl, version: resource.version, expectedSha256: resource.expectedSha256, packageArchitecture: source.packageArchitecture } : {}),
  }
}

function validateIndex(value, publicUrl) {
  if (value === null || value === undefined) return null
  if (!value || value.schemaVersion !== 1 || value.product !== 'claude-desktop' || !Array.isArray(value.files) || !value.files.length || value.files.length > Object.keys(SOURCES).length) throw new Error('COS Claude 版本索引格式无效')
  const seen = new Set()
  for (const file of value.files) {
    const id = file?.platformId
    const source = Object.hasOwn(SOURCES, id || '') ? SOURCES[id] : null
    if (!source || seen.has(id) || file.fileName !== source.fileName || file.platform !== source.platform || file.architecture !== source.architecture
      || file.kind !== 'installer' || file.format !== source.format || file.type !== source.type || file.verification !== source.verification
      || file.key !== artifactKey(id, file.sha256) || file.url !== publicUrl(file.key) || !file.source
      || !Number.isInteger(file.source.redirectCount) || file.source.redirectCount < 0 || file.source.redirectCount > 3
      || !OFFICIAL_HOSTS.includes(file.source.resolvedHost) || typeof file.cosEtag !== 'string' || !file.cosEtag || file.cosEtag.length > 256 || /[\r\n]/.test(file.cosEtag)) throw new Error('COS Claude 版本索引包含无效平台、对象或校验记录')
    validateVersion(file.version)
    validateHead(file.source)
    if (file.size !== file.source.bytes) throw new Error('COS Claude 版本索引大小不一致')
    const allowedSourceFields = new Set(['requestUrl', 'bytes', 'etag', 'lastModified', 'resolvedHost', 'redirectCount', 'metadataUrl', 'version', 'expectedSha256', 'packageArchitecture'])
    if (Object.keys(file.source).some(function (key) { return !allowedSourceFields.has(key) })
      || file.source.requestUrl !== (source.requestUrl || source.metadataUrl)
      || source.metadataUrl && file.source.metadataUrl !== source.metadataUrl) throw new Error('COS Claude 官方来源记录不匹配或包含非公开字段')
    if (source.metadataUrl && (file.source.version !== file.version || file.source.expectedSha256 !== file.sha256 || file.source.packageArchitecture !== source.packageArchitecture)) throw new Error('COS Claude Linux 官方摘要、版本或架构记录不匹配')
    seen.add(id)
  }
  return value
}

function validateWindowsInspection(report, architecture) {
  if (!report || report.identity?.name !== 'Claude' || report.identity.architecture !== architecture || report.signature?.status !== 'Valid'
    || report.signature.simpleName !== 'Anthropic, PBC' || report.identity.publisherCanonical !== report.signature.subjectCanonical
    || typeof report.identity.publisherCanonical !== 'string' || !report.identity.publisherCanonical || report.identity.containsPackageSignature !== true) throw new Error('Claude Windows 完整包身份或 Anthropic 签名不匹配')
  const version = validateVersion(report.identity.version)
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version) || version.split('.').some(function (part) { return Number(part) > 65535 })) throw new Error('Claude Windows MSIX 四段版本无效')
  return { version, verification: SOURCES[`windows-${architecture}`].verification, packageIdentity: 'Claude', signatureStatus: 'Valid' }
}

function validateInspection(report, source, expectedVersion) {
  if (source.platform === 'windows') return validateWindowsInspection(report, source.architecture)
  if (source.platform === 'linux') {
    if (report?.package !== 'claude-desktop' || report.architecture !== source.packageArchitecture || report.version !== expectedVersion) throw new Error('Claude DEB 包头与官方索引身份或架构不匹配')
    return { version: validateVersion(report.version), verification: source.verification, aptSignatureVerified: false }
  }
  if (report?.signatureStatus !== 'Valid' || report.signerOrganization !== 'Anthropic, PBC') throw new Error('Claude Mac 安装包 Anthropic 签名不匹配')
  if (source.format === 'dmg' && (report.bundleIdentifier !== 'com.anthropic.claudefordesktop' || !Array.isArray(report.architectures)
    || !report.architectures.includes('arm64') || !report.architectures.includes('x86_64'))) throw new Error('Claude Mac 应用身份或 Universal 架构不匹配')
  if (source.format === 'pkg' && report.architectureProof !== 'official-universal-endpoint') throw new Error('Claude Mac 企业 PKG 架构来源记录无效')
  return { version: validateVersion(report.version), verification: source.verification, signatureStatus: 'Valid', ...(source.format === 'pkg' ? { architectureProof: report.architectureProof } : { architectures: ['arm64', 'x86_64'] }) }
}

async function synchronizeOfficialClaude({ store, platforms = 'all', dependencies, now = function () { return new Date().toISOString() } }) {
  const ids = parsePlatforms(platforms)
  const old = validateIndex(await store.readJson(LATEST_KEY), store.publicUrl)
  const existing = new Map((old?.files || []).map(function (entry) { return [entry.platformId, entry] }))
  const resolved = new Map()
  for (const id of ids) {
    const source = SOURCES[id]
    let resource
    if (source.metadataUrl) {
      const metadata = parseDebianPackages(await dependencies.fetchText({ url: source.metadataUrl, allowedHosts: OFFICIAL_HOSTS, maxBytes: MAX_METADATA_BYTES }), source.packageArchitecture)
      const head = validateHead(await dependencies.inspectResource({ url: metadata.url, allowedHosts: OFFICIAL_HOSTS, maxBytes: MAX_PACKAGE_BYTES }))
      if (head.bytes !== metadata.bytes) throw new Error('Claude Linux 索引与 HEAD 大小不一致')
      resource = { ...metadata, ...head, metadataUrl: source.metadataUrl, redirects: [] }
    } else resource = await dependencies.resolveOfficialPackage(source.requestUrl)
    validateOfficialUrl(resource.url)
    validateHead(resource)
    if (resource.version && existing.has(id) && compareVersions(resource.version, existing.get(id).version) < 0) throw new Error('Claude 官方版本倒退，已拒绝同步')
    resolved.set(id, resource)
  }
  const reusable = new Map()
  for (const id of ids) {
    const previous = existing.get(id)
    const resource = resolved.get(id)
    const record = sourceRecord(SOURCES[id], resource)
    if (!previous || previous.source.requestUrl !== record.requestUrl || previous.source.resolvedHost !== record.resolvedHost || previous.source.bytes !== resource.bytes || previous.source.etag !== resource.etag
      || previous.source.lastModified !== resource.lastModified || resource.version && resource.version !== previous.version
      || resource.expectedSha256 && previous.sha256 !== resource.expectedSha256) continue
    const remote = await store.inspect(previous.key)
    if (remote && remote.bytes === previous.size && remote.etag === previous.cosEtag && remote.sha256 === previous.sha256 && remote.contentType?.split(';')[0] === previous.type) reusable.set(id, previous)
  }
  if (ids.every(function (id) { return reusable.has(id) })) return { changed: false, manifest: old, platforms: ids }
  const directory = await dependencies.createWorkDirectory()
  let preserveDirectory = false
  try {
    const prepared = []
    for (const id of ids) {
      if (reusable.has(id)) continue
      const source = SOURCES[id]
      const resource = resolved.get(id)
      const filePath = path.join(directory, source.fileName)
      const downloaded = await dependencies.downloadResource({ url: resource.url, filePath, allowedHosts: OFFICIAL_HOSTS, maxBytes: MAX_PACKAGE_BYTES, expectedBytes: resource.bytes, expectedEtag: resource.etag, ...(resource.expectedSha256 ? { expectedSha256: resource.expectedSha256 } : {}) })
      if (downloaded.bytes !== resource.bytes || downloaded.etag !== resource.etag || !/^[a-f0-9]{64}$/.test(downloaded.sha256)
        || resource.expectedSha256 && resource.expectedSha256 !== downloaded.sha256) throw new Error('Claude 官方完整下载大小、ETag 或 SHA256 不一致')
      await dependencies.validatePackageMagic(filePath, source.format, downloaded.bytes)
      const inspection = validateInspection(await dependencies.inspectPackage({ filePath, source, resource, workDirectory: directory }), source, resource.version)
      if (existing.has(id) && compareVersions(inspection.version, existing.get(id).version) < 0) throw new Error('Claude 包内版本倒退，已拒绝同步')
      prepared.push({ id, source, resource, filePath, downloaded, inspection })
    }
    const files = new Map(existing)
    for (const [id, entry] of reusable) files.set(id, entry)
    for (const item of prepared) {
      const key = artifactKey(item.id, item.downloaded.sha256)
      const published = await store.publishFile(key, item.filePath, { expectedBytes: item.downloaded.bytes, expectedSha256: item.downloaded.sha256, contentType: item.source.type, cacheControl: 'public, max-age=31536000, immutable' })
      if (published.bytes !== item.downloaded.bytes || published.sha256 !== item.downloaded.sha256 || published.url !== store.publicUrl(key) || published.contentType?.split(';')[0] !== item.source.type) throw new Error('Claude COS 全匿名字节回读与已验完整包不一致')
      const head = await store.inspect(key)
      if (!head || head.bytes !== item.downloaded.bytes || head.etag !== published.etag || head.sha256 !== item.downloaded.sha256 || typeof head.etag !== 'string' || !head.etag) throw new Error('Claude COS 上传回读后的对象指纹发生变化')
      files.set(item.id, { platformId: item.id, fileName: item.source.fileName, version: item.inspection.version, platform: item.source.platform, architecture: item.source.architecture,
        kind: 'installer', format: item.source.format, key, url: store.publicUrl(key), size: item.downloaded.bytes, sha256: item.downloaded.sha256, type: item.source.type,
        verification: item.inspection.verification, cosEtag: head.etag, source: sourceRecord(item.source, item.resource), inspection: item.inspection,
      })
    }
    const manifest = { schemaVersion: 1, product: 'claude-desktop', generatedAt: now(), files: [...files.values()].sort(function (left, right) { return left.platformId.localeCompare(right.platformId, 'en') }) }
    validateIndex(manifest, store.publicUrl)
    const candidateDigest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
    await store.publishJson(`${OFFLINE_PREFIX}/indexes/${candidateDigest}.json`, manifest, { cacheControl: 'public, max-age=31536000, immutable' })
    const current = validateIndex(await store.readJson(LATEST_KEY), store.publicUrl)
    if (JSON.stringify(current) !== JSON.stringify(old)) throw new Error('Claude COS 最新索引在同步期间变化，已保留现有指针')
    try {
      await store.publishJson(LATEST_KEY, manifest, { overwrite: true, cacheControl: 'no-cache, max-age=0, must-revalidate' })
    } catch {
      const actual = validateIndex(await store.readJson(LATEST_KEY), store.publicUrl)
      if (JSON.stringify(actual) !== JSON.stringify(manifest)) throw new Error('Claude COS 最新指针写入未确认；已回读，未重复写入或盲目回滚')
    }
    return { changed: true, manifest, platforms: ids }
  } catch (error) {
    preserveDirectory = error?.preserveWorkDirectory === true
    throw error
  } finally {
    if (!preserveDirectory) await dependencies.removeWorkDirectory(directory)
  }
}

const WINDOWS_INSPECTION_SCRIPT = String.raw`param([string]$PackagePath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($PackagePath)
try {
  $entries=@($zip.Entries | Where-Object {$_.FullName -eq 'AppxManifest.xml'})
  if($entries.Count -ne 1 -or $entries[0].Length -gt 262144){throw 'manifest invalid'}
  $settings=[Xml.XmlReaderSettings]::new();$settings.DtdProcessing=[Xml.DtdProcessing]::Prohibit;$settings.XmlResolver=$null;$settings.MaxCharactersInDocument=262144
  $stream=$entries[0].Open();$reader=[Xml.XmlReader]::Create($stream,$settings)
  try {$xml=[Xml.XmlDocument]::new();$xml.XmlResolver=$null;$xml.Load($reader)} finally {$reader.Dispose();$stream.Dispose()}
  $identity=$xml.SelectSingleNode('/*[local-name()="Package"]/*[local-name()="Identity"]')
  if(-not $identity){throw 'identity missing'}
  $publisher=[Security.Cryptography.X509Certificates.X500DistinguishedName]::new($identity.GetAttribute('Publisher'))
  $manifest=@{name=$identity.GetAttribute('Name');version=$identity.GetAttribute('Version');architecture=$identity.GetAttribute('ProcessorArchitecture');publisherCanonical=$publisher.Decode([Security.Cryptography.X509Certificates.X500DistinguishedNameFlags]::UseCommas);containsPackageSignature=[bool]($zip.Entries | Where-Object {$_.FullName -eq 'AppxSignature.p7x'})}
} finally {$zip.Dispose()}
$signature=Get-AuthenticodeSignature -LiteralPath $PackagePath
$signer=$signature.SignerCertificate
@{identity=$manifest;signature=@{status=$signature.Status.ToString();simpleName=if($signer){$signer.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)}else{$null};subjectCanonical=if($signer){$signer.SubjectName.Decode([Security.Cryptography.X509Certificates.X500DistinguishedNameFlags]::UseCommas)}else{$null}}} | ConvertTo-Json -Depth 5 -Compress
`

function safeChildEnvironment(directory) {
  if (process.platform === 'win32') return { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: directory, TMP: directory, PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules' }
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: directory, TMPDIR: directory, LANG: 'C', LC_ALL: 'C' }
}

async function runInspection(executable, args, directory, run = promisify(execFile)) {
  try { return await run(executable, args, { env: safeChildEnvironment(directory), windowsHide: true, timeout: 120000, maxBuffer: MAX_METADATA_BYTES }) } catch { throw new Error('Claude 原生只读包检查失败，未执行安装或包内脚本') }
}

async function validatePackageMagic(filePath, format, bytes) {
  const handle = await fs.open(filePath, 'r')
  try {
    const magic = Buffer.alloc(8)
    await handle.read(magic, 0, 8, format === 'dmg' ? bytes - 512 : 0)
    if (format === 'dmg' && (bytes < 512 || magic.subarray(0, 4).toString('ascii') !== 'koly')
      || format === 'pkg' && magic.subarray(0, 4).toString('ascii') !== 'xar!'
      || format === 'deb' && magic.toString('ascii') !== '!<arch>\n'
      || format === 'msix' && magic.readUInt32LE(0) !== 0x04034b50) throw new Error('Claude 完整包格式无效')
  } finally { await handle.close() }
}

function darwinClaudeRequirement(teamIdentifier) {
  if (!/^[A-Z0-9]{10}$/.test(teamIdentifier)) throw new Error('Claude Mac 签名 Team 候选无效')
  return ['identifier "com.anthropic.claudefordesktop"', 'anchor apple generic',
    'certificate 1[field.1.2.840.113635.100.6.2.6] exists',
    'certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
    `certificate leaf[subject.OU] = "${teamIdentifier}"`,
    `certificate leaf[subject.O] = "Anthropic, PBC"`,
    `certificate leaf[subject.CN] = "Developer ID Application: Anthropic, PBC (${teamIdentifier})"`,
  ].join(' and ')
}

async function inspectDmgMount(mountPoint, workDirectory, run) {
  const state = await runInspection('/usr/bin/hdiutil', ['info', '-plist'], workDirectory, run)
  const statePath = path.join(workDirectory, `dmg-state-${randomUUID()}.plist`)
  try {
    await fs.writeFile(statePath, state.stdout, { flag: 'wx', mode: 0o600 })
    const converted = await runInspection('/usr/bin/plutil', ['-convert', 'json', '-o', '-', statePath], workDirectory, run)
    const parsed = JSON.parse(converted.stdout)
    if (!Array.isArray(parsed.images) || parsed.images.length > 256) throw new Error('Claude DMG 挂载状态结构无效')
    // A successful native unmount may remove its mount directory. Resolve the
    // still-owned parent so absence of that directory is not mistaken for an
    // unknown mount state, while /var and /private/var aliases still compare.
    const canonical = path.join(await fs.realpath(path.dirname(mountPoint)), path.basename(mountPoint))
    for (const image of parsed.images) {
      const entities = image?.['system-entities']
      if (!Array.isArray(entities) || entities.length > 1024) throw new Error('Claude DMG 挂载项结构无效')
      for (const entity of entities) {
        const mounted = entity?.['mount-point']
        if (mounted === undefined) continue
        if (typeof mounted !== 'string' || mounted.length > 4096 || mounted.includes('\0')) throw new Error('Claude DMG 挂载路径无效')
        if (path.normalize(mounted) === path.normalize(mountPoint) || path.normalize(mounted) === path.normalize(canonical)
          || await fs.realpath(mounted) === canonical) return true
      }
    }
    return false
  } finally { await fs.unlink(statePath).catch(function () {}) }
}

function unconfirmedDmgUnmount() {
  const error = new Error('Claude DMG 未能确认卸载，已保留工作目录并禁止递归清理；请核实原生挂载状态')
  error.preserveWorkDirectory = true
  return error
}

async function inspectPackage({ filePath, source, workDirectory, run = promisify(execFile), platform = process.platform }) {
  if (source.platform === 'windows') {
    if (platform !== 'win32') throw new Error('Claude Windows 签名检查必须在 Windows runner 运行')
    const script = path.join(workDirectory, 'inspect-claude-msix.ps1')
    try { await fs.writeFile(script, WINDOWS_INSPECTION_SCRIPT, { flag: 'wx', mode: 0o600 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    const result = await runInspection('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-PackagePath', filePath], workDirectory, run)
    return JSON.parse(result.stdout.replace(/^\uFEFF/, ''))
  }
  if (source.platform === 'linux') {
    if (platform !== 'linux') throw new Error('Claude Linux DEB 元数据检查必须在 Linux runner 运行')
    const result = await runInspection('/usr/bin/dpkg-deb', ['--field', filePath, 'Package', 'Version', 'Architecture'], workDirectory, run)
    const fields = parseFields(result.stdout)
    return { package: fields.Package, version: fields.Version, architecture: fields.Architecture }
  }
  if (platform !== 'darwin') throw new Error('Claude Mac 签名和版本检查必须在 macOS runner 运行')
  if (source.format === 'pkg') {
    const signature = await runInspection('/usr/sbin/pkgutil', ['--check-signature', filePath], workDirectory, run)
    if (!/^\s*Status: signed by a certificate trusted by macOS\s*$/m.test(signature.stdout)
      || !/^\s*1\. Developer ID Installer: Anthropic, PBC \([A-Z0-9]{10}\)/m.test(signature.stdout)) throw new Error('Claude Mac PKG 官方安装者签名或可信链无效')
    const expanded = path.join(workDirectory, 'claude-pkg-metadata')
    await runInspection('/usr/sbin/pkgutil', ['--expand', filePath, expanded], workDirectory, run)
    const common = require('./cos-sync-utils.cjs')
    const candidates = []
    async function collect(directory, depth = 0) {
      if (depth > 4) throw new Error('Claude PKG 元数据目录超过限制')
      const entries = await fs.readdir(directory, { withFileTypes: true })
      if (entries.length > 64) throw new Error('Claude PKG 元数据文件过多')
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new Error('Claude PKG 元数据包含链接')
        const child = path.join(directory, entry.name)
        if (entry.isDirectory()) await collect(child, depth + 1)
        else if (entry.name === 'PackageInfo') {
          const text = (await common.readBoundedRegularFile(child, { maxBytes: 256 * 1024 })).toString('utf8')
          if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('Claude PKG 元数据包含不允许 XML')
          const version = /<pkg-info\b[^>]*\bversion="([^"]+)"/.exec(text)?.[1]
          const identifier = /<pkg-info\b[^>]*\bidentifier="([^"]+)"/.exec(text)?.[1]
          if (identifier?.startsWith('com.anthropic.')) candidates.push(validateVersion(version))
        }
      }
    }
    await collect(expanded)
    if (!candidates.length || new Set(candidates).size !== 1) throw new Error('Claude PKG 包内版本缺失或存在歧义')
    return { version: candidates[0], signerOrganization: 'Anthropic, PBC', signatureStatus: 'Valid', architectureProof: 'official-universal-endpoint' }
  }
  const mountPoint = path.join(workDirectory, 'claude-dmg-readonly')
  await fs.mkdir(mountPoint)
  let attachAttempted = false
  try {
    attachAttempted = true
    await runInspection('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint, filePath], workDirectory, run)
    const application = path.join(mountPoint, 'Claude.app')
    const metadata = await runInspection('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(application, 'Contents', 'Info.plist')], workDirectory, run)
    const info = JSON.parse(metadata.stdout)
    if (typeof info.CFBundleExecutable !== 'string' || !/^[A-Za-z0-9._-]+$/.test(info.CFBundleExecutable)) throw new Error('Claude Mac 可执行文件名称无效')
    const identity = await runInspection('/usr/bin/codesign', ['--display', '--verbose=4', application], workDirectory, run)
    const matches = [...identity.stderr.matchAll(/^Authority=Developer ID Application: Anthropic, PBC \(([A-Z0-9]{10})\)$/gm)]
    if (matches.length !== 1) throw new Error('Claude Mac 签名 Team 候选缺失或存在歧义')
    // Display prose is untrusted. Only codesign's exit status evaluating the
    // Apple chain, Developer ID OIDs, certificate subjects and fixed identifier
    // establishes trust; a forged Authority line cannot satisfy this requirement.
    await runInspection('/usr/bin/codesign', ['--verify', '--strict', '--deep', `-R=${darwinClaudeRequirement(matches[0][1])}`, application], workDirectory, run)
    const architecture = await runInspection('/usr/bin/lipo', ['-archs', path.join(application, 'Contents', 'MacOS', info.CFBundleExecutable)], workDirectory, run)
    return { version: info.CFBundleShortVersionString, bundleIdentifier: info.CFBundleIdentifier, signerOrganization: 'Anthropic, PBC', signatureStatus: 'Valid', architectures: architecture.stdout.trim().split(/\s+/) }
  } finally {
    if (attachAttempted) {
      // Attach can have mounted the volume before its reply is lost. Always
      // attempt detach, then independently prove the mount is gone. Uncertainty
      // must reach the outer cleanup guard, never a recursive remove operation.
      try { await runInspection('/usr/bin/hdiutil', ['detach', mountPoint], workDirectory, run) } catch {}
      let remains
      try { remains = await inspectDmgMount(mountPoint, workDirectory, run) } catch { throw unconfirmedDmgUnmount() }
      if (remains) throw unconfirmedDmgUnmount()
    }
  }
}

function createRuntimeDependencies(common) {
  return { fetchText: common.fetchText, inspectResource: common.inspectResource, downloadResource: common.downloadResource, resolveOfficialPackage, inspectPackage, validatePackageMagic,
    createWorkDirectory: async function () { return fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'xingmang-claude-cos-')) },
    removeWorkDirectory: async function (directory) {
      const resolved = path.resolve(directory)
      if (path.dirname(resolved) !== await fs.realpath(os.tmpdir()) || !path.basename(resolved).startsWith('xingmang-claude-cos-')) throw new Error('拒绝删除 Claude 同步临时目录以外的路径')
      await fs.rm(resolved, { recursive: true, force: true })
    },
  }
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length > 1 || argv.some(function (arg) { return !arg.startsWith('--platforms=') })) throw new Error('用法：sync-claude-official-cos.cjs --platforms=windows|macos|linux|all')
  const common = require('./cos-sync-utils.cjs')
  const platforms = parsePlatforms(argv[0]?.slice('--platforms='.length) || process.env.CLAUDE_SYNC_PLATFORMS || 'all')
  const config = common.readCosConfiguration(process.env)
  const result = await synchronizeOfficialClaude({ store: common.createCosStore(config), platforms, dependencies: createRuntimeDependencies(common) })
  console.log(JSON.stringify({ changed: result.changed, platforms: result.platforms, product: 'claude-desktop' }))
}

if (require.main === module) main().catch(function (error) {
  console.error('Claude 官方备用包同步失败；请核对受保护的 COS 配置、已核实下载域名与原生验签环境，未提前发布最新索引')
  if (error?.code === 'CLAUDE_UNVERIFIED_SOURCE_HOST') console.error(`待核实官方重定向主机：${error.hostname}`)
  process.exitCode = 1
})

module.exports = { SOURCES, OFFICIAL_HOSTS, API_ROOT, APT_ROOT, MAX_PACKAGE_BYTES, LATEST_KEY, WINDOWS_INSPECTION_SCRIPT, parsePlatforms, validateOfficialUrl, validateHead, validateVersion, compareVersions, requestHead, resolveOfficialPackage, parseDebianPackages, artifactKey, sourceRecord, validateIndex, validateWindowsInspection, validateInspection, synchronizeOfficialClaude, safeChildEnvironment, validatePackageMagic, darwinClaudeRequirement, inspectDmgMount, inspectPackage, createRuntimeDependencies, main }
