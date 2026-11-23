const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { performance } = require('node:perf_hooks')
const { checkFailure, observedArchitectures, observedProcessFailure, safeSyncFailure } = require('./cos-sync-utils.cjs')

// 一键装 Antigravity 命令行（agy）要从谷歌下（electron/antigravity-cli-release.ts 读的那份官方清单），国内连不上
// 谷歌。照 Grok 的做法放桶（方案见项目文件 Antigravity-接入/方案.md 第三节第 4 条）：谷歌签过名的原件原样放进
// 星芒的腾讯云存储桶，客户端先从桶里下，桶里没有或对不上再回谷歌，那道「谷歌签名」核对一行不改。
// 每次同步问谷歌四个平台的清单，版本变了才下。Windows 的在 Windows 机器上核 Authenticode，Mac 的在 Mac 机器上
// 解开 tar.gz 核 codesign，所以同一份脚本在两种机器上各跑一半，各写各的清单（windows.json、macos.json），
// 互不覆盖。agy 是谷歌的闭源程序，跟 Claude、ChatGPT 桌面端一样原件转发，不另带许可文件（D98 只管开源的那两家）。
//
// Trust: only Google's manifest host and its artifact host are contacted, every URL is built
// from the constants below and the shared transport refuses redirects. A manifest is accepted
// only when its URL is exactly the one this script builds from the version and build it names
// (the client's parseAntigravityCliManifest rule), and the download must match the manifest's
// SHA-512. A Windows binary is uploaded only after this runner's Get-AuthenticodeSignature
// reports a valid signature from Google LLC issued by DigiCert's code signing CA (the subject
// and issuer the 11-23 probe read), and its PE header names the processor its platform claims.
// A Mac archive is uploaded only after it unpacks to exactly one regular file whose code
// signature satisfies Google's Developer ID requirement (identifier cli, team EQHXZ8M8AV) and
// whose Mach-O slices include the platform's chip. Nothing downloaded is ever executed here:
// this job holds the bucket's upload credentials. Objects are stored under their own SHA-256
// so a published object is never overwritten; the client checks the signature again before
// installing anything.

const MANIFEST_ORIGIN = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app'
const ARTIFACT_ORIGIN = 'https://storage.googleapis.com'
const ARTIFACT_PATH_PREFIX = '/antigravity-public/antigravity-cli/'
const OFFICIAL_HOSTS = Object.freeze([new URL(MANIFEST_ORIGIN).hostname, new URL(ARTIFACT_ORIGIN).hostname])
// Keep the binaries inside the already authorized manager prefix (docs/cos-sync-policy.json).
const PREFIX = 'xingmang/offline/antigravity-cli'
const PRODUCT = 'antigravity-cli'
// 11-23 真机试跑：1.5.15 的 agy.exe 两百三四十 MB，Mac 的 tar.gz 九十 MB 上下；再小就不是程序，再大就不是这个程序。
const MIN_ARTIFACT_BYTES = 1024 * 1024
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
const MAX_MANIFEST_BYTES = 16 * 1024
// 清单里留几版：最新的一定在，其余按版本从新到旧补满。agy 自己会在后台更新，留几版只为桶跟不上时还有一版能装。
const MAX_RELEASES = 4
const VERSION_PATTERN = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/
const BUILD_PATTERN = /^[1-9]\d{0,24}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const SHA512_PATTERN = /^[a-f0-9]{128}$/
const MAC_EXECUTABLE = 'antigravity'
const TEAM_IDENTIFIER = 'EQHXZ8M8AV'
const CODE_IDENTIFIER = 'cli'
const USER_AGENT = 'xingmang-antigravity-cli-cos-sync/1'

function nameComponent(attribute, value) {
  return new RegExp(`(?:^|,\\s*)(?:${attribute})="?${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?(?:,|$)`, 'i')
}
// 11-23 第十一轮在 Windows 机器上读到的 agy.exe 签名（桌面端安装包也是这一张）。客户端装 agy 时核的是
// electron/trusted-native-cli.ts 里 antigravity 那一条，同一份名单，改一处要改两处。
const WINDOWS_SIGNER = Object.freeze({
  subject: Object.freeze([nameComponent('CN', 'Google LLC'), nameComponent('O', 'Google LLC'), nameComponent('L', 'Mountain View'), nameComponent('S|ST', 'California'), nameComponent('C', 'US')]),
  issuer: Object.freeze([nameComponent('CN', 'DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1'), nameComponent('O', 'DigiCert, Inc.')]),
})

const PLATFORMS = Object.freeze({
  'windows-x64': Object.freeze({ family: 'windows', architecture: 'x64', manifest: 'windows_amd64', directory: 'windows-x64', fileName: 'cli_windows_x64.exe', machine: 0x8664,
    contentType: 'application/octet-stream', verification: 'windows-authenticode-google' }),
  'windows-arm64': Object.freeze({ family: 'windows', architecture: 'arm64', manifest: 'windows_arm64', directory: 'windows-arm', fileName: 'cli_windows_arm64.exe', machine: 0xaa64,
    contentType: 'application/octet-stream', verification: 'windows-authenticode-google' }),
  'macos-arm64': Object.freeze({ family: 'macos', architecture: 'arm64', manifest: 'darwin_arm64', directory: 'darwin-arm', fileName: 'cli_mac_arm64.tar.gz', machine: 'arm64',
    contentType: 'application/gzip', verification: 'macos-developer-id-google' }),
  'macos-x64': Object.freeze({ family: 'macos', architecture: 'x64', manifest: 'darwin_amd64', directory: 'darwin-x64', fileName: 'cli_mac_x64.tar.gz', machine: 'x86_64',
    contentType: 'application/gzip', verification: 'macos-developer-id-google' }),
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

/** Which half this runner does: the Windows binaries on Windows, the Mac archives on a Mac. */
function familyForRunner(platform) {
  const family = Object.keys(FAMILIES).find(function (id) { return FAMILIES[id].runner === platform })
  if (!family) throw checkFailure('platform-invalid', 'Antigravity 命令行同步只在 Windows 和 macOS 机器上跑')
  return family
}

function manifestUrl(platformId) {
  return `${MANIFEST_ORIGIN}/manifests/${PLATFORMS[platformId].manifest}.json`
}

function sourceUrl(platformId, version, build) {
  if (!VERSION_PATTERN.test(version) || !BUILD_PATTERN.test(build)) throw checkFailure('version-invalid', '谷歌返回的 Antigravity 命令行版本号无效')
  const spec = PLATFORMS[platformId]
  return `${ARTIFACT_ORIGIN}${ARTIFACT_PATH_PREFIX}${version}-${build}/${spec.directory}/${spec.fileName}`
}

function artifactKey(platformId, sha256, version) {
  const spec = PLATFORMS[platformId]
  const extension = spec.fileName.endsWith('.tar.gz') ? '.tar.gz' : '.exe'
  return `${PREFIX}/${platformId}/sha256-${sha256}/agy-${version}-${platformId}${extension}`
}

/** Same rule as parseAntigravityCliManifest in electron/antigravity-cli-release.ts. */
function parseManifest(text, platformId) {
  let root
  try { root = JSON.parse(text) } catch { throw checkFailure('metadata-invalid', '谷歌返回的 Antigravity 命令行清单不是 JSON') }
  if (!isRecord(root) || typeof root.version !== 'string' || !VERSION_PATTERN.test(root.version)) throw checkFailure('version-invalid', '谷歌返回的 Antigravity 命令行版本号无效')
  if (typeof root.sha512 !== 'string' || !/^[0-9a-f]{128}$/i.test(root.sha512)) throw checkFailure('metadata-invalid', '谷歌返回的 Antigravity 命令行清单缺少 SHA-512')
  if (typeof root.url !== 'string') throw checkFailure('source-url-rejected', '谷歌返回的 Antigravity 命令行下载地址无效')
  const spec = PLATFORMS[platformId]
  const prefix = `${ARTIFACT_ORIGIN}${ARTIFACT_PATH_PREFIX}${root.version}-`
  const suffix = `/${spec.directory}/${spec.fileName}`
  const build = root.url.startsWith(prefix) && root.url.endsWith(suffix) ? root.url.slice(prefix.length, root.url.length - suffix.length) : ''
  if (!BUILD_PATTERN.test(build) || sourceUrl(platformId, root.version, build) !== root.url) throw checkFailure('source-url-rejected', '谷歌返回的 Antigravity 命令行下载地址不在官方目录')
  return { version: root.version, build, url: root.url, sha512: root.sha512.toLowerCase() }
}

function validateFile(file, release, publicUrl) {
  const spec = isRecord(file) ? PLATFORMS[file.platformId] : null
  if (!spec || file.platform !== spec.family || file.architecture !== spec.architecture || file.manifest !== spec.manifest
    || !SHA256_PATTERN.test(file.sha256 || '') || !SHA512_PATTERN.test(file.sha512 || '') || file.key !== artifactKey(file.platformId, file.sha256, release.version)
    || typeof file.url !== 'string' || (publicUrl && file.url !== publicUrl(file.key))
    || file.contentType !== spec.contentType || file.verification !== spec.verification
    || !Number.isSafeInteger(file.bytes) || file.bytes < MIN_ARTIFACT_BYTES || file.bytes > MAX_ARTIFACT_BYTES
    || file.sourceUrl !== sourceUrl(file.platformId, release.version, release.build)) throw checkFailure('cos-index-invalid', 'COS 现有 Antigravity 命令行清单的文件记录无效')
  if (typeof file.cosEtag !== 'string' || !file.cosEtag || file.cosEtag.length > 256 || /[\r\n]/.test(file.cosEtag)) throw checkFailure('cos-index-invalid', 'COS 现有 Antigravity 命令行清单缺少已核验对象指纹')
}

function validateIndex(value, family, publicUrl) {
  if (value === null || value === undefined) return null
  const platformIds = FAMILIES[family].platformIds
  if (!isRecord(value) || value.schemaVersion !== 1 || value.product !== PRODUCT || value.family !== family || typeof value.generatedAt !== 'string'
    || typeof value.checkedAt !== 'string' || !Array.isArray(value.releases) || !value.releases.length || value.releases.length > MAX_RELEASES) throw checkFailure('cos-index-invalid', 'COS 现有 Antigravity 命令行清单格式无效，已保留现有清单')
  const seen = new Set()
  let previous = null
  for (const release of value.releases) {
    if (!isRecord(release) || typeof release.version !== 'string' || !VERSION_PATTERN.test(release.version) || typeof release.build !== 'string' || !BUILD_PATTERN.test(release.build)
      || seen.has(release.version) || (previous && compareVersions(previous, release.version) <= 0)
      || !Array.isArray(release.files) || release.files.length !== platformIds.length) throw checkFailure('cos-index-invalid', 'COS 现有 Antigravity 命令行清单的版本记录无效')
    seen.add(release.version)
    previous = release.version
    const platforms = new Set()
    for (const file of release.files) {
      validateFile(file, release, publicUrl)
      platforms.add(file.platformId)
    }
    if (platformIds.some(function (id) { return !platforms.has(id) })) throw checkFailure('cos-index-invalid', 'COS 现有 Antigravity 命令行清单的版本缺少平台')
  }
  return value
}

function safeAntigravitySyncFailure(error) {
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
      const wrapped = new Error(error instanceof Error ? error.message : 'Antigravity 命令行同步阶段失败')
      stageFailures.set(wrapped, { error, context: { ...context, latestState: pointerState() } })
      report('stage-failed', { diagnostic: safeAntigravitySyncFailure(wrapped) })
      throw wrapped
    }
  }
}

// The signer is public certificate data. Logging what was read tells a rotated certificate
// (a valid signature from a signer not on the list) apart from a damaged or foreign binary.
function observedSignature(signature) {
  return isRecord(signature) ? { signatureStatus: signature.status, signerSubject: signature.subject, signerIssuer: signature.issuer } : undefined
}

function validateWindowsSignature(signature) {
  if (!isRecord(signature) || typeof signature.status !== 'string' || signature.status.toLowerCase() !== 'valid') throw checkFailure('package-signature-invalid', 'Antigravity 命令行没有有效的 Authenticode 签名', observedSignature(signature))
  const subject = typeof signature.subject === 'string' ? signature.subject : ''
  const issuer = typeof signature.issuer === 'string' ? signature.issuer : ''
  if (!WINDOWS_SIGNER.subject.every(function (pattern) { return pattern.test(subject) }) || !WINDOWS_SIGNER.issuer.every(function (pattern) { return pattern.test(issuer) })) {
    throw checkFailure('package-signer-mismatch', 'Antigravity 命令行的签名发布者不是谷歌（Google LLC，DigiCert 签发）', observedSignature(signature))
  }
}

async function verifyUnchangedArtifact(store, file) {
  const current = await store.inspect(file.key)
  const contentType = typeof current?.contentType === 'string' ? current.contentType.split(';')[0].trim().toLowerCase() : ''
  return Boolean(current && current.bytes === file.bytes && current.etag === file.cosEtag && contentType === file.contentType)
}

async function readManifest(dependencies, platformId) {
  const url = manifestUrl(platformId)
  const text = await dependencies.fetchText({ url, allowedHosts: [new URL(url).hostname], maxBytes: MAX_MANIFEST_BYTES, headers: { accept: 'application/json', 'user-agent': USER_AGENT } })
  return parseManifest(text, platformId)
}

async function downloadOfficial(dependencies, release, filePath, onProgress) {
  const url = release.url
  try {
    const result = await dependencies.downloadResource({ url, filePath, allowedHosts: [new URL(url).hostname], maxBytes: MAX_ARTIFACT_BYTES, headers: { accept: 'application/octet-stream', 'user-agent': USER_AGENT }, onProgress })
    const sha512 = typeof result?.sha512 === 'string' ? Buffer.from(result.sha512, 'base64').toString('hex') : ''
    if (!result || !Number.isSafeInteger(result.bytes) || result.bytes < MIN_ARTIFACT_BYTES || result.bytes > MAX_ARTIFACT_BYTES || !SHA256_PATTERN.test(result.sha256 || '')) throw checkFailure('download-mismatch', 'Antigravity 命令行安装包大小或摘要无效')
    if (sha512 !== release.sha512) throw checkFailure('download-mismatch', 'Antigravity 命令行安装包和谷歌清单的 SHA-512 不一致')
    return { bytes: result.bytes, sha256: result.sha256, sha512 }
  } catch (error) {
    await dependencies.removeFile(filePath)
    throw error
  }
}

/** The release just read stays first; older ones fill up to MAX_RELEASES, newest first. */
function mergeReleases(current, old) {
  const kept = [current]
  const previous = old ? [...old.releases].sort(function (left, right) { return compareVersions(right.version, left.version) }) : []
  for (const release of previous) {
    if (kept.length >= MAX_RELEASES) break
    if (release.version !== current.version && compareVersions(release.version, current.version) < 0) kept.push(release)
  }
  return kept
}

function contentOf(index) {
  return index ? JSON.stringify({ ...index, generatedAt: null, checkedAt: null }) : null
}

async function synchronizeAntigravityCli({ store, dependencies, family, progress, now = function () { return new Date().toISOString() } }) {
  if (!Object.hasOwn(FAMILIES, family)) throw checkFailure('platform-invalid', 'Antigravity 命令行同步的平台无效')
  const { indexKey, platformIds } = FAMILIES[family]
  let latestState = 'not-written-by-this-run'
  const stage = createStageRunner(progress, function () { return latestState })
  const old = await stage('cos-read-latest', { family }, async function () {
    return validateIndex(await store.readJson(indexKey, { missingOk: true }), family, store.publicUrl)
  })
  const manifests = {}
  for (const platformId of platformIds) {
    manifests[platformId] = await stage('source-manifest', { platformId }, function () { return readManifest(dependencies, platformId) })
  }
  // checkedAt is when Google told us its version, not when the uploads finished.
  const checkedAt = now()
  const { version, build } = await stage('source-compare', {}, async function () {
    const [first, ...others] = platformIds.map(function (id) { return manifests[id] })
    // 两种芯片的清单应当同时换版；一前一后时这一轮不发，等下一轮两份对上了再发，免得清单里一版只有半套。
    if (others.some(function (manifest) { return manifest.version !== first.version || manifest.build !== first.build })) {
      throw checkFailure('source-changed', '谷歌两种芯片的 Antigravity 命令行清单版本不一致，这一轮不发布')
    }
    if (old && compareVersions(first.version, old.releases[0].version) < 0) throw checkFailure('version-regressed', '谷歌返回的 Antigravity 命令行版本比桶里的旧，这一轮不发布')
    return first
  })
  const workDirectory = await stage('prepare-temp', {}, function () { return dependencies.createWorkDirectory() })
  let primaryError
  try {
    async function synchronizeFile(platformId) {
      const context = { version, platformId }
      const release = manifests[platformId]
      const existing = old?.releases.find(function (entry) { return entry.version === version && entry.build === build })?.files.find(function (file) { return file.platformId === platformId })
      if (existing && existing.sha512 === release.sha512 && await stage('cos-check-existing', context, function () { return verifyUnchangedArtifact(store, existing) })) return existing
      const spec = PLATFORMS[platformId]
      const filePath = path.join(workDirectory, spec.fileName)
      try {
        const downloaded = await stage('source-download', context, function (onProgress) { return downloadOfficial(dependencies, release, filePath, onProgress) })
        await stage('verify-artifact', { ...context, expectedBytes: downloaded.bytes }, async function () {
          if (spec.family === 'windows') {
            const machine = await dependencies.readPeMachine(filePath)
            if (machine !== spec.machine) throw checkFailure('package-identity-mismatch', 'Antigravity 命令行的处理器架构和平台不一致', { packageArchitecture: machineName(machine) })
            validateWindowsSignature(await dependencies.inspectWindowsSignature(filePath, workDirectory))
          } else {
            await dependencies.inspectMacArchive(filePath, workDirectory, spec.machine)
          }
        })
        const key = artifactKey(platformId, downloaded.sha256, version)
        const published = await stage('cos-publish-binary', { ...context, expectedBytes: downloaded.bytes }, async function (onProgress) {
          const result = await store.publishFile(key, filePath, { expectedBytes: downloaded.bytes, expectedSha256: downloaded.sha256, contentType: spec.contentType, cacheControl: 'public, max-age=31536000, immutable', onProgress })
          if (result.bytes !== downloaded.bytes || result.sha256 !== downloaded.sha256) throw checkFailure('cos-object-mismatch', 'COS Antigravity 命令行安装包公共下载校验结果不一致')
          return result
        })
        const head = await stage('cos-head-binary', context, async function () {
          const result = await store.inspect(key)
          if (!result || result.bytes !== downloaded.bytes || typeof result.etag !== 'string' || result.etag !== published.etag) throw checkFailure('cos-object-mismatch', 'COS Antigravity 命令行安装包发布后的 HEAD 与已核验正文不一致')
          return result
        })
        return {
          platformId, platform: spec.family, architecture: spec.architecture, manifest: spec.manifest, key, url: store.publicUrl(key),
          bytes: downloaded.bytes, sha256: downloaded.sha256, sha512: downloaded.sha512, contentType: spec.contentType, verification: spec.verification,
          sourceUrl: release.url, cosEtag: head.etag,
        }
      } finally {
        await dependencies.removeFile(filePath)
      }
    }
    const files = []
    for (const platformId of platformIds) files.push(await synchronizeFile(platformId))
    const index = { schemaVersion: 1, product: PRODUCT, family, generatedAt: now(), checkedAt, releases: mergeReleases({ version, build, files }, old) }
    await stage('validate-latest', {}, async function () { validateIndex(index, family, store.publicUrl) })
    // 没变也照样写一遍，只换 checkedAt：客户端靠它判断桶还跟不跟得上谷歌。
    const changed = contentOf(index) !== contentOf(old)
    const published = changed ? index : { ...old, checkedAt }
    await stage('cos-recheck-latest', {}, async function () {
      const latest = validateIndex(await store.readJson(indexKey, { missingOk: true }), family, store.publicUrl)
      if (JSON.stringify(latest) !== JSON.stringify(old)) throw checkFailure('cos-index-changed', 'COS Antigravity 命令行清单在同步期间发生变化，停止发布以保留现有状态')
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

// The PE machine field as an architecture name, or as hex for one neither platform uses.
function machineName(machine) {
  if (!Number.isSafeInteger(machine) || machine < 0 || machine > 0xffff) return undefined
  const platform = Object.values(PLATFORMS).find(function (spec) { return spec.machine === machine })
  return platform ? platform.architecture : `0x${machine.toString(16).padStart(4, '0')}`
}

/** Reads the COFF machine field from the PE header; never runs the file. */
async function readPeMachine(filePath) {
  const handle = await fs.open(filePath, 'r')
  try {
    const dos = Buffer.alloc(64)
    if ((await handle.read(dos, 0, 64, 0)).bytesRead !== 64 || dos.readUInt16LE(0) !== 0x5a4d) throw checkFailure('package-format-invalid', 'Antigravity 命令行不是 Windows 可执行文件')
    const offset = dos.readUInt32LE(0x3c)
    if (offset < 64 || offset > 64 * 1024) throw checkFailure('package-format-invalid', 'Antigravity 命令行的 PE 头位置无效')
    const header = Buffer.alloc(6)
    if ((await handle.read(header, 0, 6, offset)).bytesRead !== 6 || header.readUInt32LE(0) !== 0x00004550) throw checkFailure('package-format-invalid', 'Antigravity 命令行缺少 PE 头')
    return header.readUInt16LE(4)
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
  if (platform !== 'win32') throw checkFailure('inspector-unavailable', 'Antigravity 命令行的 Windows 签名检查必须在 Windows runner 运行')
  const script = path.join(workDirectory, 'inspect-antigravity-signature.ps1')
  try { await fs.writeFile(script, SIGNATURE_SCRIPT, { flag: 'wx', mode: 0o600 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  let result
  try {
    result = await run('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-FilePath', filePath], {
      env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: workDirectory, TMP: workDirectory, PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules' },
      windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024,
    })
  } catch (error) { throw checkFailure('inspector-failed', 'Antigravity 命令行签名检查失败', observedProcessFailure(error)) }
  try { return JSON.parse(result.stdout.replace(/^\uFEFF/, '')) } catch { throw checkFailure('inspection-unparsable', 'Antigravity 命令行签名检查结果无法解析') }
}

/** Google's Developer ID requirement for agy; same clauses as darwinDeveloperIdRequirement in electron/macos-code-signing.ts. */
function darwinAntigravityRequirement() {
  return [`identifier "${CODE_IDENTIFIER}"`, 'anchor apple generic',
    'certificate 1[field.1.2.840.113635.100.6.2.6] exists',
    'certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
    `certificate leaf[subject.OU] = "${TEAM_IDENTIFIER}"`,
  ].join(' and ')
}

function safeChildEnvironment(directory) {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: directory, TMPDIR: directory, LANG: 'C', LC_ALL: 'C' }
}

/**
 * Unpacks with the system bsdtar into an empty folder and checks what came out: exactly one
 * regular file named antigravity, signed with Google's Developer ID for agy, carrying the
 * platform's chip. A bare Mach-O has no bundle for Gatekeeper to assess (spctl answers "not an
 * app"), so the pinned requirement is the check, as the client does it.
 */
async function inspectMacArchive(filePath, workDirectory, machine, run = promisify(execFile), platform = process.platform) {
  if (platform !== 'darwin') throw checkFailure('inspector-unavailable', 'Antigravity 命令行的 Mac 签名检查必须在 macOS runner 运行')
  const extractDirectory = path.join(workDirectory, `extract-${machine}`)
  await fs.mkdir(extractDirectory, { mode: 0o700 })
  async function inspect(executable, args, code, failure) {
    try { return await run(executable, args, { env: safeChildEnvironment(workDirectory), timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 }) } catch (error) { throw checkFailure(code, failure, observedProcessFailure(error)) }
  }
  try {
    await inspect('/usr/bin/tar', ['-xzf', filePath, '-C', extractDirectory], 'package-format-invalid', 'Antigravity 命令行安装包解不开')
    const entries = await fs.readdir(extractDirectory)
    if (entries.length !== 1 || entries[0] !== MAC_EXECUTABLE) throw checkFailure('package-format-invalid', `Antigravity 命令行安装包里应当只有 ${MAC_EXECUTABLE}`)
    const executable = path.join(extractDirectory, MAC_EXECUTABLE)
    const stats = await fs.lstat(executable)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) throw checkFailure('package-format-invalid', `${MAC_EXECUTABLE} 不是普通文件`)
    await inspect('/usr/bin/codesign', ['--verify', '--strict', `-R=${darwinAntigravityRequirement()}`, executable], 'package-signature-invalid', `Antigravity 命令行的签名不是谷歌（${TEAM_IDENTIFIER}）的 Developer ID`)
    const architectures = await inspect('/usr/bin/lipo', ['-archs', executable], 'inspection-unparsable', 'Antigravity 命令行的芯片读不出来')
    const archs = architectures.stdout.trim().split(/\s+/)
    if (!archs.includes(machine)) throw checkFailure('package-identity-mismatch', 'Antigravity 命令行的芯片和平台不一致', { packageArchitecture: observedArchitectures(archs) })
  } finally {
    await fs.rm(extractDirectory, { recursive: true, force: true })
  }
}

function createRuntimeDependencies(common) {
  return {
    fetchText: common.fetchText,
    downloadResource: common.downloadResource,
    readPeMachine,
    inspectWindowsSignature: function (filePath, workDirectory) { return inspectWindowsSignature(filePath, workDirectory) },
    inspectMacArchive: function (filePath, workDirectory, machine) { return inspectMacArchive(filePath, workDirectory, machine) },
    removeFile: function (filePath) { return fs.rm(filePath, { force: true }) },
    createWorkDirectory: async function () { return fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'xingmang-antigravity-cli-cos-')) },
    removeWorkDirectory: async function (directory) {
      const resolved = path.resolve(directory)
      const temporaryRoot = await fs.realpath(os.tmpdir())
      if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('xingmang-antigravity-cli-cos-')) throw checkFailure('temp-path-rejected', '拒绝删除临时同步目录以外的路径')
      await fs.rm(resolved, { recursive: true, force: true })
    },
  }
}

async function main() {
  const common = require('./cos-sync-utils.cjs')
  if (process.argv.length > 2) throw checkFailure('platform-invalid', 'Antigravity 命令行同步不接受命令行参数')
  const family = familyForRunner(process.platform)
  const config = common.readCosConfiguration(process.env)
  const result = await synchronizeAntigravityCli({ store: common.createCosStore(config), dependencies: createRuntimeDependencies(common), family,
    progress: function (event) { console.log(`[antigravity-cli-sync] ${JSON.stringify(event)}`) } })
  console.log(JSON.stringify({ changed: result.changed, family, versions: result.index.releases.map(function (release) { return release.version }) }))
}

if (require.main === module) {
  main().catch(function (error) {
    console.error(`Antigravity 命令行同步失败；安全诊断：${JSON.stringify(safeAntigravitySyncFailure(error))}`)
    process.exitCode = 1
  })
}

module.exports = { MANIFEST_ORIGIN, ARTIFACT_ORIGIN, OFFICIAL_HOSTS, PREFIX, PRODUCT, MIN_ARTIFACT_BYTES, MAX_ARTIFACT_BYTES, MAX_RELEASES, PLATFORMS, FAMILIES, WINDOWS_SIGNER,
  compareVersions, familyForRunner, manifestUrl, sourceUrl, artifactKey, parseManifest, validateIndex, validateWindowsSignature, mergeReleases, darwinAntigravityRequirement,
  readPeMachine, inspectWindowsSignature, inspectMacArchive, synchronizeAntigravityCli, createRuntimeDependencies, safeAntigravitySyncFailure }
