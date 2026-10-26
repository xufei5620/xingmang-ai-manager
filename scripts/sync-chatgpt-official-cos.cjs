const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { performance } = require('node:perf_hooks')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { checkFailure, observedProcessFailure, safeSyncFailure } = require('./cos-sync-utils.cjs')

const OFFICIAL_HOST = 'persistent.oaistatic.com'
const OFFICIAL_ROOT = `https://${OFFICIAL_HOST}/codex-app-prod/`
const WINDOWS_METADATA_URL = `${OFFICIAL_ROOT}windows-store-update.json`
const WINDOWS_PUBLISHER = 'CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B'
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_LICENSE_BYTES = 1024 * 1024
const LATEST_KEY = 'chatgpt/latest.json'
const DEFAULT_PLATFORMS = Object.freeze(['windows-x64', 'windows-arm64', 'macos-arm64', 'macos-x64'])
const SOURCES = Object.freeze({
  'windows-x64': Object.freeze({ fileName: 'ChatGPT-x64.msix', url: `${OFFICIAL_ROOT}ChatGPT-x64.msix`, platform: 'windows', architecture: 'x64', format: 'msix', contentType: 'application/vnd.ms-appx' }),
  'windows-arm64': Object.freeze({ fileName: 'ChatGPT-arm64.msix', url: `${OFFICIAL_ROOT}ChatGPT-arm64.msix`, platform: 'windows', architecture: 'arm64', format: 'msix', contentType: 'application/vnd.ms-appx' }),
  'macos-arm64': Object.freeze({ metadataUrl: `${OFFICIAL_ROOT}appcast.xml`, platform: 'macos', architecture: 'arm64', format: 'zip', contentType: 'application/zip' }),
  'macos-x64': Object.freeze({ metadataUrl: `${OFFICIAL_ROOT}appcast-x64.xml`, platform: 'macos', architecture: 'x64', format: 'zip', contentType: 'application/zip' }),
  'linux-deb-x64': Object.freeze({ fileName: 'chatgpt_amd64.deb', url: `${OFFICIAL_ROOT}linux/deb/latest/chatgpt_amd64.deb`, platform: 'linux', architecture: 'x64', format: 'deb', contentType: 'application/vnd.debian.binary-package' }),
  'linux-deb-arm64': Object.freeze({ fileName: 'chatgpt_arm64.deb', url: `${OFFICIAL_ROOT}linux/deb/latest/chatgpt_arm64.deb`, platform: 'linux', architecture: 'arm64', format: 'deb', contentType: 'application/vnd.debian.binary-package' }),
  'linux-rpm-x64': Object.freeze({ fileName: 'chatgpt.x86_64.rpm', url: `${OFFICIAL_ROOT}linux/rpm/latest/chatgpt.x86_64.rpm`, platform: 'linux', architecture: 'x64', format: 'rpm', contentType: 'application/x-rpm' }),
  'linux-rpm-arm64': Object.freeze({ fileName: 'chatgpt.aarch64.rpm', url: `${OFFICIAL_ROOT}linux/rpm/latest/chatgpt.aarch64.rpm`, platform: 'linux', architecture: 'arm64', format: 'rpm', contentType: 'application/x-rpm' }),
})
const LICENSE_SOURCE = Object.freeze({ fileName: 'ChatGPT-License.xml', url: `${OFFICIAL_ROOT}ChatGPT-License.xml`, contentType: 'application/xml' })
// Windows ARM64 包约 1 GB，实测传到 COS 只有 190~290 KB/s，七十五分钟的默认期限
// 传到约 850 MB 就撞线中止，一出新版就失败（#1082）。工作流给这个作业 150 分钟，
// 余下的时间留给下载、Windows 校验和完整回读。
const MULTIPART_DEADLINE_MS = 120 * 60 * 1000
// OpenAI 有时先把更新清单换成新版，过十几个小时才换可下载的 MSIX（10-17 第 51 次、10-24 第 78 次运行：清单
// 写新版，包还是上一版，签名照常）。以前这时作业报 package-identity-mismatch，连着两次就开告警 issue，等 OpenAI 换好包
// 又自己关掉，什么也不用做。所以桶里这一架构还有一条这么久以内核过的上一版、客户照常从桶里装时，先等包：这次
// 不动桶、不写清单，作业不算失败。这个时长同客户端认桶的期限（desktop-package-bucket.ts 的
// desktopBucketIndexMaximumAgeMs），再等下去客户已经不从桶里装了，照旧报错。
const PACKAGE_PENDING_MAXIMUM_MS = 24 * 60 * 60 * 1000
// 同客户端读 checkedAt 的格式（desktop-package-bucket.ts 的 isDesktopBucketIndexStale）。
const CHECKED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
const officialFailures = new WeakMap()

function safeOfficialSyncFailure(error) {
  const failure = officialFailures.get(error)
  return failure ? { ...failure.context, failure: safeSyncFailure(failure.error) }
    : { stage: 'setup', latestState: 'not-written-by-this-run', failure: safeSyncFailure(error) }
}

function createStageRunner(progress, pointerState) {
  function emit(value) {
    if (typeof progress === 'function') {
      try { progress(value) } catch {}
    }
  }
  async function run(stage, input, operation) {
    const started = performance.now()
    const context = { stage, ...input }
    let lastTransfer = {}
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
      lastTransfer = safe
      report('transfer', safe)
    }
    report('stage-start')
    const heartbeat = typeof progress === 'function' ? setInterval(function () { report('stage-wait', lastTransfer) }, 30000) : null
    try {
      const result = await operation(transfer)
      report('stage-complete')
      return result
    } catch (error) {
      // Keep raw exceptions in memory only. The public diagnostics are built
      // from this private record and the transport's private failure records.
      const wrapped = new Error(error instanceof Error ? error.message : '官方同步阶段失败')
      officialFailures.set(wrapped, { error, context: { ...context, latestState: pointerState() } })
      report('stage-failed', { diagnostic: safeOfficialSyncFailure(wrapped) })
      throw wrapped
    } finally { if (heartbeat) clearInterval(heartbeat) }
  }
  // A decision taken inside a stage that is not a failure gets its own line;
  // the stage's start and end events do not say what it decided.
  run.notice = function (event, fields) { emit({ event, ...fields }) }
  return run
}

// A fixed script and argv prevent package paths from becoming PowerShell code.
// XML readers prohibit DTDs and have a separate manifest/license size limit.
const WINDOWS_INSPECTION_SCRIPT = String.raw`param([string]$PackagePath, [string]$LicensePath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Read-BoundedXml([IO.Stream]$Stream, [long]$Limit) {
  $settings = New-Object Xml.XmlReaderSettings
  $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver = $null
  $settings.MaxCharactersInDocument = $Limit
  $reader = [Xml.XmlReader]::Create($Stream, $settings)
  try {
    $document = New-Object Xml.XmlDocument
    $document.XmlResolver = $null
    $document.Load($reader)
    return ,$document
  } finally { $reader.Dispose() }
}
$result = [ordered]@{}
if ($PackagePath) {
  $zip = [IO.Compression.ZipFile]::OpenRead($PackagePath)
  try {
    $entries = @($zip.Entries | Where-Object { $_.FullName -eq 'AppxManifest.xml' })
    if ($entries.Count -ne 1 -or $entries[0].Length -gt 262144) { throw 'Package manifest missing, ambiguous, or oversized' }
    $stream = $entries[0].Open()
    try { $document = Read-BoundedXml $stream 262144 } finally { $stream.Dispose() }
    $identity = $document.SelectSingleNode('/*[local-name()="Package"]/*[local-name()="Identity"]')
    if (-not $identity) { throw 'Package Identity missing' }
    $result.manifest = [ordered]@{ name=$identity.GetAttribute('Name'); version=$identity.GetAttribute('Version'); architecture=$identity.GetAttribute('ProcessorArchitecture'); publisher=$identity.GetAttribute('Publisher'); containsPackageSignature=[bool]($zip.Entries | Where-Object { $_.FullName -eq 'AppxSignature.p7x' }) }
  } finally { $zip.Dispose() }
  $signature = Get-AuthenticodeSignature -LiteralPath $PackagePath
  $result.signature = [ordered]@{ status=$signature.Status.ToString(); signerSubject=if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { $null }; signerIssuer=if ($signature.SignerCertificate) { $signature.SignerCertificate.Issuer } else { $null } }
}
if ($LicensePath) {
  $stream = [IO.File]::OpenRead($LicensePath)
  try {
    if ($stream.Length -gt 1048576) { throw 'License oversized' }
    $document = Read-BoundedXml $stream 1048576
    $root = $document.DocumentElement
    $product = $document.SelectSingleNode('/*[local-name()="License"]/*[local-name()="Binding"]/*[local-name()="ProductID"]')
    $family = $document.SelectSingleNode('/*[local-name()="License"]/*[local-name()="Binding"]/*[local-name()="PFM"]')
    if (-not $product -or -not $family) { throw 'License product identity missing' }
    $result.license = [ordered]@{ rootName=$root.LocalName; namespace=$root.NamespaceURI; productId=$product.InnerText; packageFamily=$family.InnerText }
  } finally { $stream.Dispose() }
}
$result | ConvertTo-Json -Depth 5 -Compress
`

function parsePlatforms(value) {
  if (value === undefined || value === '' || value === 'all') return [...DEFAULT_PLATFORMS]
  if (value === 'windows' || value === 'macos' || value === 'linux') return Object.keys(SOURCES).filter(function (id) { return SOURCES[id].platform === value })
  const values = Array.isArray(value) ? value : String(value).split(',')
  const result = [...new Set(values.map(function (item) { return String(item).trim() }))]
  if (!result.length || result.some(function (item) { return !Object.hasOwn(SOURCES, item) })) {
    throw checkFailure('platform-invalid', '官方安装包平台无效，请使用 all、windows、macos、linux 或受支持的精确平台标识')
  }
  return result
}

function parseWindowsVersion(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw checkFailure('version-invalid', '官方 Windows 版本号必须为四段数字')
  const parts = version.split('.').map(Number)
  if (parts.some(function (part) { return !Number.isSafeInteger(part) || part > 65535 })) throw checkFailure('version-invalid', '官方 Windows 版本号超出 MSIX 范围')
  return parts
}

function compareWindowsVersions(left, right) {
  const leftParts = parseWindowsVersion(left)
  const rightParts = parseWindowsVersion(right)
  for (let index = 0; index < 4; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? -1 : 1
  }
  return 0
}

function validateWindowsMetadata(value) {
  if (!value || value.schemaVersion !== 1 || value.packageIdentity !== 'OpenAI.Codex' || value.storeProductId !== '9PLM9XGG6VKS') {
    throw checkFailure('metadata-invalid', '官方 Windows 更新清单身份不匹配')
  }
  parseWindowsVersion(value.buildVersion)
  return { schemaVersion: 1, buildVersion: value.buildVersion, packageIdentity: value.packageIdentity, storeProductId: value.storeProductId }
}

function validateHead(head, maxBytes) {
  if (!head || !Number.isSafeInteger(head.bytes) || head.bytes <= 0 || head.bytes > maxBytes) throw checkFailure('head-invalid', '官方安装包 HEAD 大小无效或超过限制')
  if (typeof head.etag !== 'string' || !head.etag || head.etag.length > 256 || /[\r\n]/.test(head.etag)) throw checkFailure('head-invalid', '官方安装包缺少安全的 ETag')
  return { bytes: head.bytes, etag: head.etag, lastModified: typeof head.lastModified === 'string' ? head.lastModified : null }
}

function sameFingerprint(left, right) {
  return Boolean(left && right && left.bytes === right.bytes && left.etag === right.etag && left.lastModified === right.lastModified)
}

function artifactKey(id, version, sha256, fileName = SOURCES[id].fileName) {
  const source = SOURCES[id]
  const directory = source.platform === 'windows' ? version : `sha256-${sha256}`
  return `chatgpt/${id}/${directory}/${fileName}`
}

function parseXmlAttributes(fragment) {
  const result = {}
  const expression = /\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/gy
  let position = 0
  while (position < fragment.length) {
    if (!fragment.slice(position).trim()) break
    expression.lastIndex = position
    const match = expression.exec(fragment)
    if (!match || Object.hasOwn(result, match[1])) throw checkFailure('metadata-invalid', '官方 Mac 更新清单 XML 属性无效或重复')
    const rawValue = match[2] ?? match[3]
    if (/&(?!amp;|quot;|apos;|lt;|gt;)/.test(rawValue)) throw checkFailure('metadata-invalid', '官方 Mac 更新清单 XML 实体无效')
    result[match[1]] = rawValue.replace(/&(amp|quot|apos|lt|gt);/g, function (_, name) { return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[name] })
    position = expression.lastIndex
  }
  return result
}

function validateMacPackageUrl(rawUrl, architecture, appVersion) {
  let url
  try { url = new URL(rawUrl) } catch { throw checkFailure('metadata-invalid', '官方 Mac 更新包地址无效') }
  const expectedFile = `ChatGPT-darwin-${architecture}-${appVersion}.zip`
  if (url.protocol !== 'https:' || url.hostname !== OFFICIAL_HOST || url.port || url.username || url.password || url.search || url.hash || url.pathname !== `/codex-app-prod/${expectedFile}`) throw checkFailure('metadata-invalid', '官方 Mac 更新包必须为固定官方主机上的完整 ZIP')
  return { url: url.href, fileName: expectedFile }
}

function parseMacAppcast(text, architecture) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 256 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text)) throw checkFailure('metadata-invalid', '官方 Mac 更新清单超限或包含不允许的 XML 结构')
  const cleanText = text.replace(/<!--[\s\S]*?-->/g, '')
  if (cleanText.includes('<!--')) throw checkFailure('metadata-invalid', '官方 Mac 更新清单注释未闭合')
  const items = [...cleanText.matchAll(/<item(?:\s[^<>]*)?>([\s\S]*?)<\/item>/g)]
  if (!items.length) throw checkFailure('metadata-invalid', '官方 Mac 更新清单缺少 item')
  const candidates = []
  for (const item of items) {
    const fullItem = item[1].replace(/<sparkle:deltas(?:\s[^<>]*)?>[\s\S]*?<\/sparkle:deltas>/g, '')
    const buildElements = [...fullItem.matchAll(/<sparkle:version>\s*(\d+)\s*<\/sparkle:version>/g)]
    const appElements = [...fullItem.matchAll(/<sparkle:shortVersionString>\s*(\d+\.\d+\.\d+)\s*<\/sparkle:shortVersionString>/g)]
    if (buildElements.length !== 1 || appElements.length !== 1) throw checkFailure('metadata-invalid', '官方 Mac item 缺少唯一的版本子元素')
    const buildVersion = buildElements[0][1]
    const appVersion = appElements[0][1]
    const enclosures = [...fullItem.matchAll(/<enclosure(\s[^<>]*?)\s*\/>/g)]
    for (const enclosure of enclosures) {
      const attributes = parseXmlAttributes(enclosure[1])
      if (attributes['sparkle:deltaFrom'] !== undefined) continue
      if (attributes['sparkle:version'] !== undefined && attributes['sparkle:version'] !== buildVersion || attributes['sparkle:shortVersionString'] !== undefined && attributes['sparkle:shortVersionString'] !== appVersion || !/^\d+$/.test(attributes.length || '')) throw checkFailure('metadata-invalid', '官方 Mac 完整更新包版本或大小无效')
      const bytes = Number(attributes.length)
      if (!Number.isSafeInteger(Number(buildVersion)) || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_PACKAGE_BYTES) throw checkFailure('metadata-invalid', '官方 Mac 完整更新包版本或大小超限')
      candidates.push({ ...validateMacPackageUrl(attributes.url, architecture, appVersion), buildVersion, appVersion, declaredBytes: bytes })
    }
  }
  if (!candidates.length) throw checkFailure('metadata-invalid', '官方 Mac 更新清单缺少完整 ZIP 包')
  candidates.sort(function (left, right) { return Number(right.buildVersion) - Number(left.buildVersion) })
  if (candidates[1]?.buildVersion === candidates[0].buildVersion) throw checkFailure('metadata-invalid', '官方 Mac 同版本完整包存在歧义')
  return candidates[0]
}

function validatePreviousManifest(value) {
  if (value === null || value === undefined) return null
  if (!value || value.schemaVersion !== 1 || value.product !== 'chatgpt' || !value.platforms || typeof value.platforms !== 'object' || Array.isArray(value.platforms)) throw checkFailure('cos-index-invalid', 'COS 现有官方包清单格式无效，已保留现有清单')
  if (value.windows) validateWindowsMetadata(value.windows)
  for (const [id, entry] of Object.entries(value.platforms)) {
    const source = SOURCES[id]
    if (!source || !entry || !entry.artifact || !/^[a-f0-9]{64}$/.test(entry.artifact.sha256)) throw checkFailure('cos-index-invalid', 'COS 现有官方包清单包含无效产物')
    let fileName = source.fileName
    if (source.platform === 'macos') {
      if (entry.source?.metadataUrl !== source.metadataUrl || !/^\d+\.\d+\.\d+$/.test(entry.appVersion || '') || !/^\d+$/.test(entry.buildVersion || '')) throw checkFailure('cos-index-invalid', 'COS 现有 Mac 来源或版本无效')
      fileName = validateMacPackageUrl(entry.source.url, source.architecture, entry.appVersion).fileName
    } else if (entry.source?.url !== source.url) throw checkFailure('cos-index-invalid', 'COS 现有官方包来源无效')
    if (source.platform !== 'windows' && entry.artifact.verification !== 'official-https-sha256') throw checkFailure('cos-index-invalid', 'COS 非 Windows 包来源校验记录无效')
    validateHead(entry.source, MAX_PACKAGE_BYTES)
    if (source.platform === 'windows') {
      parseWindowsVersion(entry.packageVersion)
      if (!value.windows || compareWindowsVersions(entry.packageVersion, value.windows.buildVersion) !== 0 || entry.artifact.verification !== 'windows-authenticode') throw checkFailure('cos-index-invalid', 'COS 现有 Windows 包版本或验签记录无效')
      const expectedLicenseKey = `chatgpt/${id}/${entry.packageVersion}/ChatGPT-License.xml`
      if (!entry.license || entry.license.key !== expectedLicenseKey || !/^[a-f0-9]{64}$/.test(entry.license.sha256) || entry.license.source?.url !== LICENSE_SOURCE.url) throw checkFailure('cos-index-invalid', 'COS 现有离线许可记录无效')
      validateHead(entry.license.source, MAX_LICENSE_BYTES)
      if (entry.license.bytes !== entry.license.source.bytes || entry.license.contentType !== LICENSE_SOURCE.contentType || entry.license.verification !== 'official-https-sha256-and-product-identity') throw checkFailure('cos-index-invalid', 'COS 现有离线许可校验记录无效')
    }
    if (entry.artifact.key !== artifactKey(id, entry.packageVersion, entry.artifact.sha256, fileName) || entry.artifact.bytes !== entry.source.bytes || entry.artifact.contentType !== source.contentType) throw checkFailure('cos-index-invalid', 'COS 现有官方包路径或大小无效')
    if (typeof entry.artifact.cosEtag !== 'string' || !entry.artifact.cosEtag || entry.artifact.cosEtag.length > 256 || /[\r\n]/.test(entry.artifact.cosEtag)) throw checkFailure('cos-index-invalid', 'COS 现有包缺少已核验对象指纹')
    if (entry.license && (typeof entry.license.cosEtag !== 'string' || !entry.license.cosEtag || entry.license.cosEtag.length > 256 || /[\r\n]/.test(entry.license.cosEtag))) throw checkFailure('cos-index-invalid', 'COS 现有许可缺少已核验对象指纹')
  }
  return value
}

// The package's identity and signer are public, so a mismatch logs what was
// actually read: a version the official metadata names before the package is
// replaced, and a new signer, call for different actions.
function observedWindowsInspection(report, metadata) {
  return { expectedVersion: metadata?.buildVersion, packageName: report?.manifest?.name, packageVersion: report?.manifest?.version,
    packageArchitecture: report?.manifest?.architecture, packagePublisher: report?.manifest?.publisher,
    containsPackageSignature: report?.manifest?.containsPackageSignature, signatureStatus: report?.signature?.status,
    signerSubject: report?.signature?.signerSubject, signerIssuer: report?.signature?.signerIssuer }
}

function validateWindowsInspection(report, metadata, architecture) {
  if (!report || report.manifest?.name !== metadata.packageIdentity || report.manifest?.architecture !== architecture || report.manifest?.publisher !== WINDOWS_PUBLISHER || report.manifest?.containsPackageSignature !== true) throw checkFailure('package-identity-mismatch', 'Windows 安装包身份、架构或发布者校验失败', observedWindowsInspection(report, metadata))
  if (report.signature?.status !== 'Valid' || report.signature?.signerSubject !== WINDOWS_PUBLISHER || typeof report.signature?.signerIssuer !== 'string' || !report.signature.signerIssuer.includes('O=Microsoft Corporation')) throw checkFailure('package-signature-invalid', 'Windows 安装包可信签名校验失败', observedWindowsInspection(report, metadata))
  // 版本放在签名后面核：包还是上一版、签名又坏了时，报的是签名。
  if (report.manifest.version !== metadata.buildVersion) throw checkFailure('package-identity-mismatch', 'Windows 安装包版本与官方更新清单不一致', observedWindowsInspection(report, metadata))
  return 'windows-authenticode'
}

// 身份、架构、发布者、签名都对，只是版本比官方更新清单写的旧：OpenAI 清单先换了版，安装包还没换上来。
function isOlderOfficialWindowsPackage(report, metadata, architecture) {
  const version = report?.manifest?.version
  try {
    validateWindowsInspection(report, { ...metadata, buildVersion: version }, architecture)
    return compareWindowsVersions(version, metadata.buildVersion) < 0
  } catch { return false }
}

// 桶里这一架构还有一条 PACKAGE_PENDING_MAXIMUM_MS 以内和官网核过的上一版。等包的那几次不刷 checkedAt，
// 所以这也就是从上一次同步成功算起等了多久。
function canWaitForOfficialPackage(entry, now) {
  if (typeof entry?.checkedAt !== 'string' || !CHECKED_AT_PATTERN.test(entry.checkedAt)) return false
  const elapsed = Date.parse(now) - Date.parse(entry.checkedAt)
  return Number.isFinite(elapsed) && elapsed <= PACKAGE_PENDING_MAXIMUM_MS
}

function validateLicenseInspection(report) {
  if (report?.license?.rootName !== 'License' || report.license.namespace !== 'urn:schemas-microsoft-com:windows:store:licensing:ls' || report.license.productId !== '9PLM9XGG6VKS' || report.license.packageFamily !== 'openai.codex_2p2nqsd0c76g0') throw checkFailure('license-identity-mismatch', 'Windows 离线许可产品身份校验失败')
}

function sanitizedWindowsEnvironment(directory) {
  const result = { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: directory, TMP: directory, PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules' }
  for (const name of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    if (process.env[name]) result[name] = process.env[name]
  }
  return result
}

// The inspection script's own fixed throw texts. stderr itself is never logged.
const INSPECTOR_REASONS = Object.freeze([
  ['Package manifest missing, ambiguous, or oversized', 'manifest-missing'],
  ['Package Identity missing', 'identity-missing'],
  ['License oversized', 'license-oversized'],
  ['License product identity missing', 'license-identity-missing'],
])

function observedInspectorFailure(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : ''
  const reason = INSPECTOR_REASONS.find(function ([text]) { return stderr.includes(text) })
  return { ...observedProcessFailure(error), inspectorReason: reason?.[1] }
}

async function inspectWindowsFile({ filePath, license = false, workDirectory, run = promisify(execFile) }) {
  if (process.platform !== 'win32') throw checkFailure('inspector-unavailable', 'Windows 官方包同步必须在 Windows 上完成可信签名校验')
  const executable = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  const scriptPath = path.join(workDirectory, 'inspect-official-package.ps1')
  try { await fs.writeFile(scriptPath, WINDOWS_INSPECTION_SCRIPT, { flag: 'wx', mode: 0o600 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, license ? '-LicensePath' : '-PackagePath', filePath]
  let stdout
  try {
    const result = await run(executable, args, { windowsHide: true, timeout: 120000, maxBuffer: 128 * 1024, env: sanitizedWindowsEnvironment(workDirectory) })
    stdout = result.stdout
  } catch (error) { throw checkFailure('inspector-failed', 'Windows 安装包或离线许可检查程序失败', observedInspectorFailure(error)) }
  try { return JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) } catch { throw checkFailure('inspection-unparsable', 'Windows 安装包检查结果无法解析') }
}

async function validatePackageMagic(filePath, format, bytes) {
  const handle = await fs.open(filePath, 'r')
  try {
    const magic = Buffer.alloc(8)
    if (format === 'dmg') {
      if (bytes < 512) throw checkFailure('package-format-invalid', '官方 DMG 文件过小')
      await handle.read(magic, 0, 4, bytes - 512)
      if (magic.subarray(0, 4).toString('ascii') !== 'koly') throw checkFailure('package-format-invalid', '官方 DMG 文件格式无效')
    } else {
      await handle.read(magic, 0, 8, 0)
      if (format === 'zip' && magic.readUInt32LE(0) !== 0x04034b50) throw checkFailure('package-format-invalid', '官方 Mac ZIP 文件格式无效')
      if (format === 'deb' && magic.toString('ascii') !== '!<arch>\n') throw checkFailure('package-format-invalid', '官方 DEB 文件格式无效')
      if (format === 'rpm' && magic.readUInt32BE(0) !== 0xedabeedb) throw checkFailure('package-format-invalid', '官方 RPM 文件格式无效')
    }
  } finally { await handle.close() }
}

function validateDownloaded(result, head) {
  if (!result || result.bytes !== head.bytes || result.etag !== head.etag || !/^[a-f0-9]{64}$/.test(result.sha256)) throw checkFailure('download-mismatch', '官方安装包 HEAD 与下载结果不一致')
}

async function verifyUnchangedArtifact(store, artifact) {
  const current = await store.inspect(artifact.key)
  const contentType = typeof current?.contentType === 'string' ? current.contentType.split(';')[0].trim().toLowerCase() : ''
  return Boolean(current && current.bytes === artifact.bytes && current.etag === artifact.cosEtag && (contentType === artifact.contentType || artifact.contentType === 'application/xml' && contentType === 'text/xml'))
}

async function synchronizeOfficialChatgpt({ store, platforms = DEFAULT_PLATFORMS, dependencies, progress, now = function () { return new Date().toISOString() } }) {
  const ids = parsePlatforms(platforms)
  let latestState = 'not-written-by-this-run'
  const stage = createStageRunner(progress, function () { return latestState })
  const old = await stage('cos-read-latest', {}, async function () {
    const manifest = validatePreviousManifest(await store.readJson(LATEST_KEY, { missingOk: true }))
    for (const entry of Object.values(manifest?.platforms || {})) {
      if (entry.artifact.url !== store.publicUrl(entry.artifact.key) || entry.license && entry.license.url !== store.publicUrl(entry.license.key)) throw checkFailure('cos-index-invalid', 'COS 现有包清单下载地址与当前存储桶不一致')
    }
    return manifest
  })
  const windowsNeeded = ids.some(function (id) { return SOURCES[id].platform === 'windows' })
  const metadata = windowsNeeded ? await stage('source-windows-metadata', {}, async function () {
    const current = validateWindowsMetadata(await dependencies.fetchJson({ url: WINDOWS_METADATA_URL, allowedHosts: [OFFICIAL_HOST], maxBytes: 65536 }))
    if (old?.windows && compareWindowsVersions(current.buildVersion, old.windows.buildVersion) < 0) throw checkFailure('version-regressed', '官方 Windows 版本低于已发布版本，拒绝倒退')
    return current
  }) : old?.windows
  const sources = {}
  for (const id of ids) {
    const source = SOURCES[id]
    if (source.platform === 'macos') {
      sources[id] = await stage('source-mac-metadata', { platform: id }, async function () {
        const text = await dependencies.fetchText({ url: source.metadataUrl, allowedHosts: [OFFICIAL_HOST], maxBytes: 256 * 1024 })
        const resolved = { ...source, ...parseMacAppcast(text, source.architecture) }
        const previousVersion = old?.platforms[id]?.buildVersion
        if (previousVersion && Number(resolved.buildVersion) < Number(previousVersion)) throw checkFailure('version-regressed', '官方 Mac 版本低于已发布版本，拒绝倒退')
        return resolved
      })
    } else sources[id] = source
  }
  const heads = {}
  for (const id of ids) {
    heads[id] = await stage('source-head-package', { platform: id }, async function () {
      const head = validateHead(await dependencies.inspectResource({ url: sources[id].url, allowedHosts: [OFFICIAL_HOST], maxBytes: MAX_PACKAGE_BYTES }), MAX_PACKAGE_BYTES)
      if (sources[id].declaredBytes !== undefined && sources[id].declaredBytes !== head.bytes) throw checkFailure('head-invalid', '官方 Mac 清单与完整包 HEAD 大小不一致')
      return head
    })
  }
  const licenseHead = windowsNeeded ? await stage('source-head-license', {}, async function () { return validateHead(await dependencies.inspectResource({ url: LICENSE_SOURCE.url, allowedHosts: [OFFICIAL_HOST], maxBytes: MAX_LICENSE_BYTES }), MAX_LICENSE_BYTES) }) : null
  const reusable = {}
  for (const id of ids) {
    const existing = old?.platforms[id]
    if (existing && existing.source.url === sources[id].url && sameFingerprint(existing.source, heads[id]) && (SOURCES[id].platform !== 'windows' || existing.packageVersion === metadata.buildVersion && sameFingerprint(existing.license?.source, licenseHead))) {
      const intact = await stage('cos-check-existing-package', { platform: id }, function () { return verifyUnchangedArtifact(store, existing.artifact) })
      const licenseIntact = SOURCES[id].platform !== 'windows' || await stage('cos-check-existing-license', { platform: id }, function () { return verifyUnchangedArtifact(store, existing.license) })
      if (intact && licenseIntact) reusable[id] = existing
    }
  }
  // 包都没变也照样把清单写一遍，刷新这次核过的那几条的 checkedAt：客户端靠它判断桶还跟不跟得上官网，
  // 太久没核过就不从桶里装（#1061 第 7 条）。这时大文件一个都不用下，临时目录也不用建。
  const unchanged = ids.every(function (id) { return reusable[id] })
  const workDirectory = unchanged ? null : await stage('prepare-temp', {}, function () { return dependencies.createWorkDirectory() })
  let primaryError
  try {
    const prepared = []
    const pending = []
    let preparedLicense = null
    for (const id of ids) {
      if (reusable[id]) continue
      const source = sources[id]
      const filePath = path.join(workDirectory, `${id}-${source.fileName}`)
      // With no verified index, even a signed same-version manual upload needs
      // an official full download before exact-byte COS reuse can be proven.
      const result = await stage('source-download-package', { platform: id, expectedBytes: heads[id].bytes }, async function (onProgress) {
        const downloaded = await dependencies.downloadResource({ url: source.url, filePath, allowedHosts: [OFFICIAL_HOST], maxBytes: MAX_PACKAGE_BYTES, expectedBytes: heads[id].bytes, expectedEtag: heads[id].etag, onProgress })
        validateDownloaded(downloaded, heads[id])
        return downloaded
      })
      let verification = 'official-https-sha256'
      if (source.platform === 'windows') {
        const inspected = await stage('verify-windows-package', { platform: id }, async function () {
          const report = await dependencies.inspectWindowsFile({ filePath, workDirectory })
          if (!isOlderOfficialWindowsPackage(report, metadata, source.architecture)) return { verification: validateWindowsInspection(report, metadata, source.architecture) }
          if (!canWaitForOfficialPackage(old?.platforms[id], now())) throw checkFailure('package-version-behind', '官方更新清单已换新版，可下载的 Windows 安装包还是上一版，桶里也没有一天内核过的上一版可用', observedWindowsInspection(report, metadata))
          return { pendingVersion: report.manifest.version }
        })
        if (inspected.pendingVersion) {
          pending.push(id)
          stage.notice('package-pending', { platform: id, expectedVersion: metadata.buildVersion, packageVersion: inspected.pendingVersion,
            bucketVersion: old.platforms[id].packageVersion, bucketCheckedAt: old.platforms[id].checkedAt })
          continue
        }
        verification = inspected.verification
      } else {
        await stage('verify-package-format', { platform: id }, function () { return dependencies.validatePackageMagic(filePath, source.format, result.bytes) })
      }
      const key = artifactKey(id, metadata?.buildVersion, result.sha256, source.fileName)
      prepared.push({ id, filePath, bytes: result.bytes, sha256: result.sha256, key, verification })
    }
    if (prepared.some(function (item) { return SOURCES[item.id].platform === 'windows' })) {
      const filePath = path.join(workDirectory, LICENSE_SOURCE.fileName)
      const result = await stage('source-download-license', { expectedBytes: licenseHead.bytes }, async function (onProgress) {
        const downloaded = await dependencies.downloadResource({ url: LICENSE_SOURCE.url, filePath, allowedHosts: [OFFICIAL_HOST], maxBytes: MAX_LICENSE_BYTES, expectedBytes: licenseHead.bytes, expectedEtag: licenseHead.etag, onProgress })
        validateDownloaded(downloaded, licenseHead)
        return downloaded
      })
      await stage('verify-windows-license', {}, async function () { return validateLicenseInspection(await dependencies.inspectWindowsFile({ filePath, license: true, workDirectory })) })
      preparedLicense = { filePath, bytes: result.bytes, sha256: result.sha256 }
    }
    // 等包的平台这次当没来过：桶里那条和它的 checkedAt 原样留着，等得太久就照旧报错。
    const checkedIds = ids.filter(function (id) { return !pending.includes(id) })
    if (!checkedIds.length) return { changed: false, manifest: old, platforms: ids, pending }
    const windowsChecked = checkedIds.some(function (id) { return SOURCES[id].platform === 'windows' })
    const windowsMetadata = windowsChecked ? metadata : old?.windows
    // A failed package or license must leave the prior pointer untouched. All
    // packages are locally validated before the first remote publication.
    const entries = { ...(old?.platforms || {}), ...reusable }
    if (old?.windows && windowsMetadata && compareWindowsVersions(windowsMetadata.buildVersion, old.windows.buildVersion) > 0) {
      // Do not advertise old Windows packages under the new shared metadata.
      for (const id of Object.keys(entries)) if (SOURCES[id].platform === 'windows' && !checkedIds.includes(id)) delete entries[id]
    }
    for (const item of prepared) {
      const source = sources[item.id]
      const published = await stage('cos-publish-package', { platform: item.id, expectedBytes: item.bytes }, async function (onProgress) {
        const result = await store.publishFile(item.key, item.filePath, { expectedBytes: item.bytes, expectedSha256: item.sha256, contentType: source.contentType, cacheControl: 'public, max-age=31536000, immutable', onProgress })
        if (result.bytes !== item.bytes || result.sha256 !== item.sha256) throw checkFailure('cos-object-mismatch', 'COS 安装包公共下载校验结果不一致')
        return result
      })
      const cosHead = await stage('cos-head-package', { platform: item.id }, async function () {
        const head = validateHead(await store.inspect(item.key), MAX_PACKAGE_BYTES)
        if (head.bytes !== item.bytes || head.etag !== published.etag) throw checkFailure('cos-object-mismatch', 'COS 安装包发布后的 HEAD 与已核验正文不一致')
        return head
      })
      const entry = { platform: source.platform, architecture: source.architecture, format: source.format, source: { url: source.url, ...(source.metadataUrl ? { metadataUrl: source.metadataUrl } : {}), ...heads[item.id] }, artifact: { key: item.key, url: store.publicUrl(item.key), bytes: item.bytes, sha256: item.sha256, contentType: source.contentType, verification: item.verification, cosEtag: cosHead.etag } }
      if (source.platform === 'macos') {
        entry.appVersion = source.appVersion
        entry.buildVersion = source.buildVersion
      }
      if (source.platform === 'windows') {
        const licenseKey = `chatgpt/${item.id}/${metadata.buildVersion}/ChatGPT-License.xml`
        const licensePublished = await stage('cos-publish-license', { platform: item.id, expectedBytes: preparedLicense.bytes }, async function (onProgress) {
          const result = await store.publishFile(licenseKey, preparedLicense.filePath, { expectedBytes: preparedLicense.bytes, expectedSha256: preparedLicense.sha256, contentType: LICENSE_SOURCE.contentType, cacheControl: 'public, max-age=31536000, immutable', onProgress })
          if (result.bytes !== preparedLicense.bytes || result.sha256 !== preparedLicense.sha256) throw checkFailure('cos-object-mismatch', 'COS 离线许可公共下载校验结果不一致')
          return result
        })
        const licenseCosHead = await stage('cos-head-license', { platform: item.id }, async function () {
          const head = validateHead(await store.inspect(licenseKey), MAX_LICENSE_BYTES)
          if (head.bytes !== preparedLicense.bytes || head.etag !== licensePublished.etag) throw checkFailure('cos-object-mismatch', 'COS 离线许可发布后的 HEAD 与已核验正文不一致')
          return head
        })
        entry.packageVersion = metadata.buildVersion
        entry.license = { key: licenseKey, url: store.publicUrl(licenseKey), bytes: preparedLicense.bytes, sha256: preparedLicense.sha256, contentType: LICENSE_SOURCE.contentType, verification: 'official-https-sha256-and-product-identity', cosEtag: licenseCosHead.etag, source: { url: LICENSE_SOURCE.url, ...licenseHead } }
      }
      entries[item.id] = entry
    }
    // Each job vouches only for the platforms it checked against the official
    // source just now; the other entries keep the time their own job last did.
    const checkedAt = now()
    for (const id of checkedIds) entries[id] = { ...entries[id], checkedAt }
    const manifest = { schemaVersion: 1, product: 'chatgpt', generatedAt: now(), ...(windowsMetadata ? { windows: windowsMetadata } : {}), platforms: entries }
    await stage('validate-latest', {}, async function () { validatePreviousManifest(manifest) })
    // Linux's public "latest" URLs are mutable. A long upload must not turn a
    // superseded source snapshot into today's advertised latest pointer.
    for (const id of checkedIds) {
      await stage('source-recheck-package', { platform: id }, async function () {
        const head = validateHead(await dependencies.inspectResource({ url: sources[id].url, allowedHosts: [OFFICIAL_HOST], maxBytes: MAX_PACKAGE_BYTES }), MAX_PACKAGE_BYTES)
        if (!sameFingerprint(head, heads[id])) throw checkFailure('source-changed', '官方包来源在同步期间发生变化，未发布最新索引，请重新同步')
      })
      if (sources[id].platform === 'macos') {
        await stage('source-recheck-metadata', { platform: id }, async function () {
          const current = parseMacAppcast(await dependencies.fetchText({ url: sources[id].metadataUrl, allowedHosts: [OFFICIAL_HOST], maxBytes: 256 * 1024 }), sources[id].architecture)
          if (current.url !== sources[id].url || current.buildVersion !== sources[id].buildVersion) throw checkFailure('source-changed', '官方 Mac 当前版本在同步期间变化，未发布最新索引')
        })
      }
    }
    if (windowsChecked) {
      await stage('source-recheck-windows', {}, async function () {
        const current = validateWindowsMetadata(await dependencies.fetchJson({ url: WINDOWS_METADATA_URL, allowedHosts: [OFFICIAL_HOST], maxBytes: 65536 }))
        const currentLicense = validateHead(await dependencies.inspectResource({ url: LICENSE_SOURCE.url, allowedHosts: [OFFICIAL_HOST], maxBytes: MAX_LICENSE_BYTES }), MAX_LICENSE_BYTES)
        if (current.buildVersion !== metadata.buildVersion || !sameFingerprint(currentLicense, licenseHead)) throw checkFailure('source-changed', '官方 Windows 当前版本或许可在同步期间变化，未发布最新索引')
      })
    }
    await stage('cos-recheck-latest', {}, async function () {
      const current = validatePreviousManifest(await store.readJson(LATEST_KEY, { missingOk: true }))
      if (windowsMetadata && current?.windows && compareWindowsVersions(windowsMetadata.buildVersion, current.windows.buildVersion) < 0) throw checkFailure('cos-index-changed', 'COS 最新 Windows 版本已更新，拒绝发布较旧清单')
      if (JSON.stringify(current) !== JSON.stringify(old)) throw checkFailure('cos-index-changed', 'COS 最新清单在同步期间发生变化，停止发布以保留现有状态')
    })
    latestState = 'write-unconfirmed'
    await stage('cos-publish-latest', {}, function (onProgress) { return store.publishJson(LATEST_KEY, manifest, { overwrite: true, cacheControl: 'no-cache, max-age=0, must-revalidate', onProgress }) })
    latestState = 'published-and-read-back'
    return { changed: prepared.length > 0, manifest, platforms: ids, pending }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    if (workDirectory) try { await stage('cleanup-temp', {}, function () { return dependencies.removeWorkDirectory(workDirectory) }) } catch (error) {
      // A cleanup failure is secondary if synchronization already failed.
      // Its safe stage event remains visible without replacing the real cause.
      if (!primaryError) throw error
    }
  }
}

function createRuntimeDependencies(common) {
  return {
    fetchJson: common.fetchJson,
    fetchText: common.fetchText,
    inspectResource: common.inspectResource,
    downloadResource: common.downloadResource,
    inspectWindowsFile,
    validatePackageMagic,
    createWorkDirectory: async function () { return fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'xingmang-official-cos-')) },
    removeWorkDirectory: async function (directory) {
      const resolved = path.resolve(directory)
      const temporaryRoot = await fs.realpath(os.tmpdir())
      if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('xingmang-official-cos-')) throw checkFailure('temp-path-rejected', '拒绝删除临时同步目录以外的路径')
      await fs.rm(resolved, { recursive: true, force: true })
    },
  }
}

function createOfficialCosStore(common, config) {
  return common.createCosStore(config, { multipartDeadlineMs: MULTIPART_DEADLINE_MS })
}

async function main() {
  const common = require('./cos-sync-utils.cjs')
  const args = process.argv.slice(2)
  if (args.some(function (arg) { return !arg.startsWith('--platforms=') }) || args.length > 1) throw checkFailure('platform-invalid', '仅支持 --platforms=windows-x64,windows-arm64 或 --platforms=all')
  const platforms = parsePlatforms(args[0]?.slice('--platforms='.length) ?? process.env.CHATGPT_SYNC_PLATFORMS)
  const config = common.readCosConfiguration(process.env)
  const result = await synchronizeOfficialChatgpt({ store: createOfficialCosStore(common, config), platforms, dependencies: createRuntimeDependencies(common), progress: function (event) { console.log(`[chatgpt-sync] ${JSON.stringify(event)}`) } })
  // 作业是绿的，在运行页上标一句它是在等包，不是同步好了。
  for (const id of result.pending) console.log(`::notice title=等官方换包::${id} 的官方更新清单已换新版，可下载的安装包还是上一版，桶里留着上一版，下次同步再看`)
  console.log(JSON.stringify({ changed: result.changed, platforms: result.platforms, pending: result.pending, windowsVersion: result.manifest.windows?.buildVersion ?? null }))
}

if (require.main === module) {
  main().catch(function (error) {
    console.error(`官方 ChatGPT 包同步失败；安全诊断：${JSON.stringify(safeOfficialSyncFailure(error))}`)
    process.exitCode = 1
  })
}

module.exports = { OFFICIAL_HOST, WINDOWS_METADATA_URL, WINDOWS_PUBLISHER, SOURCES, LICENSE_SOURCE, DEFAULT_PLATFORMS, MAX_PACKAGE_BYTES, MAX_LICENSE_BYTES, LATEST_KEY, MULTIPART_DEADLINE_MS, PACKAGE_PENDING_MAXIMUM_MS, WINDOWS_INSPECTION_SCRIPT, parsePlatforms, parseWindowsVersion, compareWindowsVersions, validateWindowsMetadata, validateHead, sameFingerprint, artifactKey, parseMacAppcast, validatePreviousManifest, validateWindowsInspection, isOlderOfficialWindowsPackage, canWaitForOfficialPackage, validateLicenseInspection, sanitizedWindowsEnvironment, inspectWindowsFile, validatePackageMagic, validateDownloaded, synchronizeOfficialChatgpt, createRuntimeDependencies, createOfficialCosStore, safeOfficialSyncFailure }
