const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { performance } = require('node:perf_hooks')
const { safeSyncFailure } = require('./cos-sync-utils.cjs')

// Windows 上一键装 Grok 从 xAI 官方下 grok.exe（electron/grok-installer.ts），国内多半连不上，以前靠加速。
// yoyo 2026-10-14 定「放桶」：xAI 签过名的原件原样放进星芒的腾讯云存储桶，客户端先从桶里下
// （electron/grok-bucket.ts），那道「xAI 签名」核对一行不改；桶里没有或对不上，照旧去 xAI。
// 每次同步问 xAI 现在的 stable 是哪一版，再读本仓 electron/cli-verified-versions.ts 里 Grok 的推荐
// 版本（星芒默认装它），两版的 x64、ARM64 都要在桶里；已经传过、对象还在的不再下。清单留最近几版，
// 「退回更新前的版本」也多半能从桶里下。
//
// Trust: only xAI's two documented hosts are contacted, every URL is built from the
// constants below and the shared transport refuses redirects. A binary is uploaded only
// after this Windows runner's Get-AuthenticodeSignature reports a valid signature from one
// of xAI's two signers, each pinned to the CA that issued it (the same list
// electron/trusted-native-cli.ts applies), and its PE header names the processor its file
// name claims. The binary is never executed here:
// this job holds the bucket's upload credentials. Objects are stored under their own
// SHA-256 so a published object is never overwritten; the client still verifies the
// signature again before installing anything.

const STABLE_URLS = Object.freeze([
  'https://x.ai/cli/stable',
  'https://storage.googleapis.com/grok-build-public-artifacts/cli/stable',
])
const ARTIFACT_ROOTS = Object.freeze([
  'https://x.ai/cli',
  'https://storage.googleapis.com/grok-build-public-artifacts/cli',
])
const OFFICIAL_HOSTS = Object.freeze(['x.ai', 'storage.googleapis.com'])
// Keep the binaries inside the already authorized manager prefix (docs/cos-sync-policy.json).
const PREFIX = 'xingmang/offline/grok'
const LATEST_KEY = `${PREFIX}/latest.json`
const PRODUCT = 'grok-cli'
const CONTENT_TYPE = 'application/octet-stream'
const VERIFICATION = 'windows-authenticode-xai'
// 同 electron/grok-installer.ts 收 xAI 那一份时的上下限。1.0.52 的 x64 是 169 MB、ARM64 是 144 MB。
const MIN_BINARY_BYTES = 1024 * 1024
const MAX_BINARY_BYTES = 512 * 1024 * 1024
const MAX_STABLE_BYTES = 1024
// 清单里留几版：stable 与推荐版本一定在，其余按版本从新到旧补满。
const MAX_RELEASES = 12
const MAX_SOURCE_BYTES = 256 * 1024
const SHA256_PATTERN = /^[a-f0-9]{64}$/
// xAI 从 Grok 1.0.54（2026-10-12）起改用 X Corp. 的证书签名，1.0.53 及更早（含推荐版本 1.0.52）是
// X.AI LLC 的（#1051）。两张各钉住签发机构；和 electron/trusted-native-cli.ts 的 grok 名单是同一份，改一处要改两处。
function nameComponent(attribute, value) {
  return new RegExp(`(?:^|,\\s*)(?:${attribute})="?${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?(?:,|$)`, 'i')
}
const SIGNERS = Object.freeze([
  Object.freeze({
    subject: Object.freeze([/(?:^|,\s*)(?:CN|O)=X\.AI LLC(?:,|$)/i]),
    issuer: Object.freeze([nameComponent('CN', 'SSL.com EV Code Signing Intermediate CA RSA R3'), nameComponent('O', 'SSL Corp')]),
  }),
  Object.freeze({
    subject: Object.freeze([nameComponent('CN', 'X Corp.'), nameComponent('O', 'X Corp.'), nameComponent('L', 'Bastrop'), nameComponent('S|ST', 'Texas'), nameComponent('C', 'US')]),
    issuer: Object.freeze([nameComponent('CN', 'GlobalSign GCC R45 CodeSigning CA 2020'), nameComponent('O', 'GlobalSign nv-sa')]),
  }),
])
const PLATFORMS = Object.freeze({
  'windows-x64': Object.freeze({ architecture: 'x64', artifact: 'windows-x86_64', machine: 0x8664 }),
  'windows-arm64': Object.freeze({ architecture: 'arm64', artifact: 'windows-aarch64', machine: 0xaa64 }),
})
const PLATFORM_IDS = Object.freeze(Object.keys(PLATFORMS))
const stageFailures = new WeakMap()

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// Same shape as parseGrokStableVersion in electron/grok-update.ts.
function parseVersion(value) {
  const version = typeof value === 'string' ? value.trim() : ''
  return version.length <= 80 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z](?:[0-9A-Za-z.-]{0,62})?)?$/.test(version) ? version : null
}

function compareVersions(left, right) {
  const [leftCore, leftPre = null] = left.split(/-(.*)/s)
  const [rightCore, rightPre = null] = right.split(/-(.*)/s)
  const leftParts = leftCore.split('.').map(Number)
  const rightParts = rightCore.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index]
  }
  if (leftPre === rightPre) return 0
  if (leftPre === null) return 1
  if (rightPre === null) return -1
  return leftPre < rightPre ? -1 : 1
}

function artifactFileName(version, platformId) {
  return `grok-${version}-${PLATFORMS[platformId].artifact}.exe`
}

function artifactKey(version, platformId, sha256) {
  return `${PREFIX}/${platformId}/sha256-${sha256}/${artifactFileName(version, platformId)}`
}

function sourceUrls(version, platformId) {
  return ARTIFACT_ROOTS.map(function (root) { return `${root}/${artifactFileName(version, platformId)}` })
}

/**
 * 读 electron/cli-verified-versions.ts 里 Grok 的推荐版本。那份文件是 TypeScript，同步在 Node 里跑，
 * 所以只认它现在的写法；认不出就返回 null，这次只同步 stable（客户端点名的版本桶里没有就照旧去 xAI）。
 */
function readRecommendedGrokVersion(source) {
  if (typeof source !== 'string') return null
  const match = /\n {2}grok: \{\n {4}recommended: \{\n {6}version: '([^'\n]{1,80})',/.exec(source)
  return match ? parseVersion(match[1]) : null
}

/** stable 一定要；推荐版本不比 stable 新才要（客户端点名的版本比 stable 新时装的就是 stable）。 */
function targetVersions(stableVersion, recommendedVersion) {
  const versions = [stableVersion]
  if (recommendedVersion && recommendedVersion !== stableVersion && compareVersions(recommendedVersion, stableVersion) < 0) versions.push(recommendedVersion)
  return versions
}

function validateFile(file, version, publicUrl) {
  const spec = isRecord(file) ? PLATFORMS[file.platformId] : null
  if (!spec || file.platform !== 'windows' || file.architecture !== spec.architecture
    || !SHA256_PATTERN.test(file.sha256 || '') || file.key !== artifactKey(version, file.platformId, file.sha256)
    || typeof file.url !== 'string' || (publicUrl && file.url !== publicUrl(file.key))
    || file.contentType !== CONTENT_TYPE || file.verification !== VERIFICATION
    || !Number.isSafeInteger(file.bytes) || file.bytes < MIN_BINARY_BYTES || file.bytes > MAX_BINARY_BYTES
    || !sourceUrls(version, file.platformId).includes(file.sourceUrl)) throw new Error('COS 现有 Grok 清单的文件记录无效')
  if (typeof file.cosEtag !== 'string' || !file.cosEtag || file.cosEtag.length > 256 || /[\r\n]/.test(file.cosEtag)) throw new Error('COS 现有 Grok 清单缺少已核验对象指纹')
}

function validateLatest(value, publicUrl) {
  if (value === null || value === undefined) return null
  if (!isRecord(value) || value.schemaVersion !== 1 || value.product !== PRODUCT || typeof value.generatedAt !== 'string'
    || !isRecord(value.stable) || !parseVersion(value.stable.version) || !STABLE_URLS.includes(value.stable.url)
    || !Array.isArray(value.releases) || !value.releases.length || value.releases.length > MAX_RELEASES) throw new Error('COS 现有 Grok 清单格式无效，已保留现有清单')
  const seen = new Set()
  for (const release of value.releases) {
    if (!isRecord(release) || !parseVersion(release.version) || seen.has(release.version)
      || !Array.isArray(release.files) || release.files.length !== PLATFORM_IDS.length) throw new Error('COS 现有 Grok 清单的版本记录无效')
    seen.add(release.version)
    const platforms = new Set()
    for (const file of release.files) {
      validateFile(file, release.version, publicUrl)
      platforms.add(file.platformId)
    }
    if (platforms.size !== PLATFORM_IDS.length) throw new Error('COS 现有 Grok 清单的版本缺少平台')
  }
  if (!seen.has(value.stable.version)) throw new Error('COS 现有 Grok 清单里没有 stable 那一版')
  return value
}

function safeGrokSyncFailure(error) {
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
        if (Number.isSafeInteger(value[name]) && value[name] >= 0 && value[name] <= MAX_BINARY_BYTES) safe[name === 'expectedBytes' ? 'transferExpectedBytes' : name] = value[name]
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
      const wrapped = new Error(error instanceof Error ? error.message : 'Grok 同步阶段失败')
      stageFailures.set(wrapped, { error, context: { ...context, latestState: pointerState() } })
      report('stage-failed', { diagnostic: safeGrokSyncFailure(wrapped) })
      throw wrapped
    }
  }
}

function validateSignature(signature) {
  if (!isRecord(signature) || typeof signature.status !== 'string' || signature.status.toLowerCase() !== 'valid') throw new Error('Grok 安装包没有有效的 Authenticode 签名')
  const subject = typeof signature.subject === 'string' ? signature.subject : ''
  const issuer = typeof signature.issuer === 'string' ? signature.issuer : ''
  const trusted = SIGNERS.some(function (signer) {
    return signer.subject.every(function (pattern) { return pattern.test(subject) }) && signer.issuer.every(function (pattern) { return pattern.test(issuer) })
  })
  if (!trusted) throw new Error('Grok 安装包的签名发布者不是 xAI 官方的 X.AI LLC 或 X Corp.')
}

async function verifyUnchangedArtifact(store, file) {
  const current = await store.inspect(file.key)
  const contentType = typeof current?.contentType === 'string' ? current.contentType.split(';')[0].trim().toLowerCase() : ''
  return Boolean(current && current.bytes === file.bytes && current.etag === file.cosEtag && contentType === file.contentType)
}

async function resolveStable(dependencies) {
  let lastError
  for (const url of STABLE_URLS) {
    try {
      const version = parseVersion(await dependencies.fetchText({ url, allowedHosts: [new URL(url).hostname], maxBytes: MAX_STABLE_BYTES, headers: { accept: 'text/plain', 'user-agent': 'xingmang-grok-cos-sync/1' } }))
      if (!version) throw new Error('xAI 返回的 Grok stable 版本格式无效')
      return { version, url }
    } catch (error) { lastError = error }
  }
  throw lastError
}

async function downloadOfficial(dependencies, version, platformId, filePath, onProgress) {
  let lastError
  for (const url of sourceUrls(version, platformId)) {
    try {
      const result = await dependencies.downloadResource({ url, filePath, allowedHosts: [new URL(url).hostname], maxBytes: MAX_BINARY_BYTES, headers: { accept: 'application/octet-stream', 'user-agent': 'xingmang-grok-cos-sync/1' }, onProgress })
      if (!result || !Number.isSafeInteger(result.bytes) || result.bytes < MIN_BINARY_BYTES || result.bytes > MAX_BINARY_BYTES || !SHA256_PATTERN.test(result.sha256 || '')) throw new Error('Grok 安装包大小或摘要无效')
      return { url, bytes: result.bytes, sha256: result.sha256 }
    } catch (error) {
      lastError = error
      await dependencies.removeFile(filePath)
    }
  }
  throw lastError
}

/** stable 和推荐版本放最前，其余旧版按版本从新到旧补满 MAX_RELEASES，最后整体从新到旧排。 */
function mergeReleases(current, old) {
  const kept = [...current]
  const versions = new Set(current.map(function (release) { return release.version }))
  const previous = old ? [...old.releases].sort(function (left, right) { return compareVersions(right.version, left.version) }) : []
  for (const release of previous) {
    if (kept.length >= MAX_RELEASES) break
    if (!versions.has(release.version)) {
      kept.push(release)
      versions.add(release.version)
    }
  }
  return kept.sort(function (left, right) { return compareVersions(right.version, left.version) })
}

function contentOf(manifest) {
  return manifest ? JSON.stringify({ ...manifest, generatedAt: null, checkedAt: null }) : null
}

async function synchronizeGrok({ store, dependencies, recommendedVersion, progress, now = function () { return new Date().toISOString() } }) {
  let latestState = 'not-written-by-this-run'
  const stage = createStageRunner(progress, function () { return latestState })
  const old = await stage('cos-read-latest', {}, async function () {
    return validateLatest(await store.readJson(LATEST_KEY, { missingOk: true }), store.publicUrl)
  })
  const stable = await stage('source-stable', {}, function () { return resolveStable(dependencies) })
  const versions = targetVersions(stable.version, parseVersion(recommendedVersion))
  const workDirectory = await stage('prepare-temp', {}, function () { return dependencies.createWorkDirectory() })
  let primaryError
  try {
    async function synchronizeFile(version, platformId) {
      const context = { version, platformId }
      const existing = old?.releases.find(function (release) { return release.version === version })?.files.find(function (file) { return file.platformId === platformId })
      if (existing && await stage('cos-check-existing', context, function () { return verifyUnchangedArtifact(store, existing) })) return existing
      const filePath = path.join(workDirectory, artifactFileName(version, platformId))
      try {
        const downloaded = await stage('source-download', context, function (onProgress) { return downloadOfficial(dependencies, version, platformId, filePath, onProgress) })
        await stage('verify-binary', { ...context, expectedBytes: downloaded.bytes }, async function () {
          if (await dependencies.readPeMachine(filePath) !== PLATFORMS[platformId].machine) throw new Error('Grok 安装包的处理器架构和文件名不一致')
          validateSignature(await dependencies.inspectSignature(filePath, workDirectory))
        })
        const key = artifactKey(version, platformId, downloaded.sha256)
        const published = await stage('cos-publish-binary', { ...context, expectedBytes: downloaded.bytes }, async function (onProgress) {
          const result = await store.publishFile(key, filePath, { expectedBytes: downloaded.bytes, expectedSha256: downloaded.sha256, contentType: CONTENT_TYPE, cacheControl: 'public, max-age=31536000, immutable', onProgress })
          if (result.bytes !== downloaded.bytes || result.sha256 !== downloaded.sha256) throw new Error('COS Grok 安装包公共下载校验结果不一致')
          return result
        })
        const head = await stage('cos-head-binary', context, async function () {
          const result = await store.inspect(key)
          if (!result || result.bytes !== downloaded.bytes || typeof result.etag !== 'string' || result.etag !== published.etag) throw new Error('COS Grok 安装包发布后的 HEAD 与已核验正文不一致')
          return result
        })
        return {
          platformId, platform: 'windows', architecture: PLATFORMS[platformId].architecture, key, url: store.publicUrl(key),
          bytes: downloaded.bytes, sha256: downloaded.sha256, contentType: CONTENT_TYPE, verification: VERIFICATION, sourceUrl: downloaded.url, cosEtag: head.etag,
        }
      } finally {
        // Two versions of two ~150 MB binaries do not need to sit on the runner's disk at once.
        await dependencies.removeFile(filePath)
      }
    }
    const current = []
    for (const version of versions) {
      const files = []
      for (const platformId of PLATFORM_IDS) files.push(await synchronizeFile(version, platformId))
      current.push({ version, files })
    }
    const checkedAt = now()
    const manifest = { schemaVersion: 1, product: PRODUCT, generatedAt: checkedAt, stable, releases: mergeReleases(current, old), checkedAt }
    await stage('validate-latest', {}, async function () { validateLatest(manifest, store.publicUrl) })
    // 没变也照样写一遍，只换 checkedAt：客户端靠它判断桶还跟不跟得上 xAI 的 stable，太久没核过就不从桶里
    // 装最新的（#1061 第 7 条）。
    const changed = contentOf(manifest) !== contentOf(old)
    const published = changed ? manifest : { ...old, checkedAt }
    await stage('cos-recheck-latest', {}, async function () {
      const latest = validateLatest(await store.readJson(LATEST_KEY, { missingOk: true }), store.publicUrl)
      if (JSON.stringify(latest) !== JSON.stringify(old)) throw new Error('COS Grok 清单在同步期间发生变化，停止发布以保留现有状态')
    })
    latestState = 'write-unconfirmed'
    await stage('cos-publish-latest', {}, function (onProgress) { return store.publishJson(LATEST_KEY, published, { overwrite: true, cacheControl: 'no-cache, max-age=0, must-revalidate', onProgress }) })
    latestState = 'published-and-read-back'
    return { changed, manifest: published, versions }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try { await stage('cleanup-temp', {}, function () { return dependencies.removeWorkDirectory(workDirectory) }) } catch (error) {
      if (!primaryError) throw error
    }
  }
}

/** Reads the COFF machine field from the PE header; never runs the file. */
async function readPeMachine(filePath) {
  const handle = await fs.open(filePath, 'r')
  try {
    const dos = Buffer.alloc(64)
    if ((await handle.read(dos, 0, 64, 0)).bytesRead !== 64 || dos.readUInt16LE(0) !== 0x5a4d) throw new Error('Grok 安装包不是 Windows 可执行文件')
    const offset = dos.readUInt32LE(0x3c)
    if (offset < 64 || offset > 64 * 1024) throw new Error('Grok 安装包的 PE 头位置无效')
    const header = Buffer.alloc(6)
    if ((await handle.read(header, 0, 6, offset)).bytesRead !== 6 || header.readUInt32LE(0) !== 0x00004550) throw new Error('Grok 安装包缺少 PE 头')
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

async function inspectSignature(filePath, workDirectory, run = promisify(execFile), platform = process.platform) {
  if (platform !== 'win32') throw new Error('Grok 签名检查必须在 Windows runner 运行')
  const script = path.join(workDirectory, 'inspect-grok-signature.ps1')
  try { await fs.writeFile(script, SIGNATURE_SCRIPT, { flag: 'wx', mode: 0o600 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  let result
  try {
    result = await run('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-FilePath', filePath], {
      env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: workDirectory, TMP: workDirectory, PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules' },
      windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024,
    })
  } catch { throw new Error('Grok 安装包签名检查失败') }
  try { return JSON.parse(result.stdout.replace(/^\uFEFF/, '')) } catch { throw new Error('Grok 安装包签名检查结果无法解析') }
}

function createRuntimeDependencies(common) {
  return {
    fetchText: common.fetchText,
    downloadResource: common.downloadResource,
    readPeMachine,
    inspectSignature: function (filePath, workDirectory) { return inspectSignature(filePath, workDirectory) },
    removeFile: function (filePath) { return fs.rm(filePath, { force: true }) },
    createWorkDirectory: async function () { return fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'xingmang-grok-cos-')) },
    removeWorkDirectory: async function (directory) {
      const resolved = path.resolve(directory)
      const temporaryRoot = await fs.realpath(os.tmpdir())
      if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('xingmang-grok-cos-')) throw new Error('拒绝删除临时同步目录以外的路径')
      await fs.rm(resolved, { recursive: true, force: true })
    },
  }
}

async function main() {
  const common = require('./cos-sync-utils.cjs')
  if (process.argv.length > 2) throw new Error('Grok 同步不接受命令行参数')
  const config = common.readCosConfiguration(process.env)
  const source = await common.readBoundedRegularFile(path.join(__dirname, '..', 'electron', 'cli-verified-versions.ts'), { maxBytes: MAX_SOURCE_BYTES })
  const recommendedVersion = readRecommendedGrokVersion(source.toString('utf8'))
  const result = await synchronizeGrok({ store: common.createCosStore(config), dependencies: createRuntimeDependencies(common), recommendedVersion,
    progress: function (event) { console.log(`[grok-sync] ${JSON.stringify(event)}`) } })
  console.log(JSON.stringify({ changed: result.changed, stable: result.manifest.stable.version, recommended: recommendedVersion, versions: result.manifest.releases.map(function (release) { return release.version }) }))
}

if (require.main === module) {
  main().catch(function (error) {
    console.error(`Grok 同步失败；安全诊断：${JSON.stringify(safeGrokSyncFailure(error))}`)
    process.exitCode = 1
  })
}

module.exports = { STABLE_URLS, ARTIFACT_ROOTS, OFFICIAL_HOSTS, LATEST_KEY, PRODUCT, CONTENT_TYPE, VERIFICATION, MIN_BINARY_BYTES, MAX_BINARY_BYTES, MAX_RELEASES, PLATFORMS,
  parseVersion, compareVersions, artifactFileName, artifactKey, sourceUrls, readRecommendedGrokVersion, targetVersions, validateLatest, validateSignature, mergeReleases,
  readPeMachine, inspectSignature, synchronizeGrok, createRuntimeDependencies, safeGrokSyncFailure }
