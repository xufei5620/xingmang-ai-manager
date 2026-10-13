const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const zlib = require('node:zlib')
const { performance } = require('node:perf_hooks')
const { safeSyncFailure } = require('./cos-sync-utils.cjs')

// Codex 的官方插件目录（github.com/openai/plugins 的 main）放进星芒的腾讯云存储桶：星芒替 Codex
// 下第一份目录时先从桶里下（electron/codex-plugin-catalog-bucket.ts），国内快，也用不着加速
// （yoyo 2026-10-13「插件目录放存储桶」，为的是以后去掉游戏加速）。桶里没有或对不上，客户端照旧
// 去 GitHub。上游一两周才变一次，所以每次先问 main 现在是哪个提交，和桶里那份一样就什么都不做。
//
// Trust: only two fixed GitHub hosts are contacted and redirects are refused by the
// shared transport. The archive is requested by the exact commit the API named, its
// pax header must carry that commit, and it must pass the same path and manifest
// rules the client applies before anything is uploaded. The bucket copy is stored
// under its own SHA-256 so an object, once published, is never overwritten.

const SOURCE_REPOSITORY = 'openai/plugins'
const SOURCE_BRANCH = 'main'
const API_HOST = 'api.github.com'
const ARCHIVE_HOST = 'codeload.github.com'
const COMMIT_URL = `https://${API_HOST}/repos/${SOURCE_REPOSITORY}/commits/${SOURCE_BRANCH}`
// Keep the catalog inside the already authorized manager prefix (docs/cos-sync-policy.json).
const PREFIX = 'xingmang/offline/codex-plugins'
const LATEST_KEY = `${PREFIX}/latest.json`
const PRODUCT = 'codex-plugin-catalog'
const CONTENT_TYPE = 'application/gzip'
const VERIFICATION = 'github-commit-archive-manifests'
// 同 electron/codex-plugin-catalog.ts 的上限：2026-10 实测压缩包二十来 MB、解开五十到七十多 MB。
const MIN_ARCHIVE_BYTES = 64 * 1024
const MAX_ARCHIVE_BYTES = 150 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 600 * 1024 * 1024
const MAX_ENTRIES = 60000
const MAX_PATH_LENGTH = 1024
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024
const MAX_COMMIT_RESPONSE_BYTES = 256
const COMMIT_PATTERN = /^[0-9a-f]{40}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i
// 与 Codex 自己读的两份清单同名同市场名（codex-rs/core-plugins，客户端 codex-plugin-catalog.ts 同样核）。
const MARKETPLACES = Object.freeze([
  Object.freeze({ path: '.agents/plugins/marketplace.json', name: 'openai-curated' }),
  Object.freeze({ path: '.agents/plugins/api_marketplace.json', name: 'openai-api-curated' }),
])
const ARCHIVE_CHECKS = Object.freeze({
  'not-gzip': '插件目录压缩包无法解开',
  'too-large': '插件目录解开后超过大小或条目上限',
  truncated: '插件目录压缩包不完整',
  'unsafe-path': '插件目录里有不安全的文件路径',
  'duplicate-path': '插件目录里有只差大小写的重名文件',
  'commit-mismatch': '插件目录压缩包的提交号和 GitHub 说的不一致',
  'manifest-missing': '插件目录缺少市场清单',
  'manifest-invalid': '插件目录的市场清单格式不对',
})
const archiveChecks = new WeakMap()
const stageFailures = new WeakMap()

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function archiveFailure(code) {
  const error = new Error(ARCHIVE_CHECKS[code])
  archiveChecks.set(error, code)
  return error
}

function archiveUrl(commit) {
  return `https://${ARCHIVE_HOST}/${SOURCE_REPOSITORY}/tar.gz/${commit}`
}

function artifactKey(commit, sha256) {
  return `${PREFIX}/sha256-${sha256}/openai-plugins-${commit}.tar.gz`
}

function safeCodexPluginsSyncFailure(error) {
  const failure = stageFailures.get(error)
  if (!failure) return { stage: 'setup', latestState: 'not-written-by-this-run', failure: { code: 'operation-failed' } }
  const archiveCheck = archiveChecks.get(failure.error)
  return { ...failure.context, ...(archiveCheck ? { archiveCheck } : {}), failure: safeSyncFailure(failure.error) }
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
        if (Number.isSafeInteger(value[name]) && value[name] >= 0 && value[name] <= MAX_ARCHIVE_BYTES) safe[name === 'expectedBytes' ? 'transferExpectedBytes' : name] = value[name]
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
      const wrapped = new Error(error instanceof Error ? error.message : '插件目录同步阶段失败')
      stageFailures.set(wrapped, { error, context: { ...context, latestState: pointerState() } })
      report('stage-failed', { diagnostic: safeCodexPluginsSyncFailure(wrapped) })
      throw wrapped
    }
  }
}

function parseCommit(text) {
  const commit = typeof text === 'string' ? text.trim() : ''
  if (!COMMIT_PATTERN.test(commit)) throw new Error('GitHub 返回的插件目录提交号格式无效')
  return commit
}

function validateLatest(value) {
  if (value === null || value === undefined) return null
  if (!isRecord(value) || value.schemaVersion !== 1 || value.product !== PRODUCT || typeof value.generatedAt !== 'string'
    || !isRecord(value.source) || !isRecord(value.artifact)) throw new Error('COS 现有插件目录清单格式无效，已保留现有清单')
  const { source, artifact } = value
  if (source.repository !== SOURCE_REPOSITORY || source.ref !== SOURCE_BRANCH || !COMMIT_PATTERN.test(source.commit || '')
    || source.url !== archiveUrl(source.commit)) throw new Error('COS 现有插件目录来源无效')
  if (!SHA256_PATTERN.test(artifact.sha256 || '') || artifact.key !== artifactKey(source.commit, artifact.sha256)
    || typeof artifact.url !== 'string' || artifact.contentType !== CONTENT_TYPE || artifact.verification !== VERIFICATION
    || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < MIN_ARCHIVE_BYTES || artifact.bytes > MAX_ARCHIVE_BYTES) throw new Error('COS 现有插件目录路径、大小或校验记录无效')
  if (typeof artifact.cosEtag !== 'string' || !artifact.cosEtag || artifact.cosEtag.length > 256 || /[\r\n]/.test(artifact.cosEtag)) throw new Error('COS 现有插件目录缺少已核验对象指纹')
  return value
}

function headerText(block, start, length) {
  const field = block.subarray(start, start + length)
  const end = field.indexOf(0)
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8')
}

function headerNumber(block, start, length) {
  if (block[start] & 0x80) throw archiveFailure('too-large')
  const text = headerText(block, start, length).trim()
  if (!text) return 0
  if (!/^[0-7]+$/.test(text)) throw archiveFailure('truncated')
  return Number.parseInt(text, 8)
}

function parsePaxRecords(data) {
  const records = new Map()
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space < 0) break
    const length = Number.parseInt(data.subarray(offset, space).toString('ascii'), 10)
    if (!Number.isSafeInteger(length) || length <= space - offset || offset + length > data.length) throw archiveFailure('truncated')
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8')
    const separator = record.indexOf('=')
    if (separator > 0) records.set(record.slice(0, separator), record.slice(separator + 1))
    offset += length
  }
  return records
}

// Same rules as catalogEntryPath in electron/codex-plugin-catalog.ts: a path the client
// would refuse must not be published, or every customer downloads it only to fall back.
function catalogEntryPath(rawPath) {
  if (!rawPath || rawPath.length > MAX_PATH_LENGTH || /[\\:\0]/.test(rawPath) || rawPath.startsWith('/')) throw archiveFailure('unsafe-path')
  const relative = rawPath.split('/').filter(Boolean).slice(1)
  if (!relative.length) return null
  for (const segment of relative) {
    if (segment === '.' || segment === '..' || /[. ]$/.test(segment) || WINDOWS_RESERVED_NAME.test(segment)) throw archiveFailure('unsafe-path')
  }
  return relative.join('/')
}

function countMarketplacePlugins(data, name) {
  if (data.length > MAX_MANIFEST_BYTES) throw archiveFailure('manifest-invalid')
  let manifest
  try { manifest = JSON.parse(data.toString('utf8')) } catch { throw archiveFailure('manifest-invalid') }
  if (!isRecord(manifest) || manifest.name !== name || !Array.isArray(manifest.plugins)
    || !manifest.plugins.every(function (plugin) {
      if (!isRecord(plugin) || typeof plugin.name !== 'string' || !plugin.name.trim() || !isRecord(plugin.source)) return false
      const source = plugin.source
      return typeof source.source === 'string' && source.source.trim().length > 0
        && (source.source !== 'local' || (typeof source.path === 'string' && source.path.trim().length > 0))
    })) throw archiveFailure('manifest-invalid')
  return manifest.plugins.length
}

/** 解开、走一遍 tar，核提交号、路径和两份市场清单；返回每份清单里有几个插件。 */
function inspectCatalogArchive(compressed, commit) {
  let tar
  try { tar = zlib.gunzipSync(compressed, { maxOutputLength: MAX_EXTRACTED_BYTES + MAX_ENTRIES * 1024 }) } catch (error) {
    throw archiveFailure(error && error.code === 'ERR_BUFFER_TOO_LARGE' ? 'too-large' : 'not-gzip')
  }
  const seen = new Set()
  const manifests = new Map()
  let archiveCommit = null
  let pendingPath = null
  let offset = 0
  let entries = 0
  let extracted = 0
  let ended = false
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512)
    if (block.every(function (byte) { return byte === 0 })) {
      ended = true
      break
    }
    entries += 1
    if (entries > MAX_ENTRIES) throw archiveFailure('too-large')
    const size = headerNumber(block, 124, 12)
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw archiveFailure('truncated')
    const data = tar.subarray(dataStart, dataEnd)
    offset = dataStart + Math.ceil(size / 512) * 512
    const type = String.fromCharCode(block[156] || 0x30)
    if (type === 'g') {
      const comment = parsePaxRecords(data).get('comment') || ''
      if (COMMIT_PATTERN.test(comment)) archiveCommit = comment
      continue
    }
    if (type === 'x') {
      pendingPath = parsePaxRecords(data).get('path') || null
      continue
    }
    const prefix = headerText(block, 345, 155)
    const name = headerText(block, 0, 100)
    const rawPath = pendingPath || (prefix ? `${prefix}/${name}` : name)
    pendingPath = null
    if (type !== '0' && type !== '5') continue
    const relative = catalogEntryPath(rawPath)
    if (!relative) continue
    const identity = relative.toLowerCase()
    if (seen.has(identity)) throw archiveFailure('duplicate-path')
    seen.add(identity)
    if (type === '5') continue
    extracted += size
    if (extracted > MAX_EXTRACTED_BYTES) throw archiveFailure('too-large')
    if (MARKETPLACES.some(function (entry) { return entry.path === relative })) manifests.set(relative, data)
  }
  if (!ended) throw archiveFailure('truncated')
  if (archiveCommit !== commit) throw archiveFailure('commit-mismatch')
  const plugins = {}
  for (const entry of MARKETPLACES) {
    const data = manifests.get(entry.path)
    if (!data) throw archiveFailure('manifest-missing')
    plugins[entry.name] = countMarketplacePlugins(data, entry.name)
  }
  return { entries, extractedBytes: extracted, plugins }
}

async function verifyUnchangedArtifact(store, artifact) {
  const current = await store.inspect(artifact.key)
  const contentType = typeof current?.contentType === 'string' ? current.contentType.split(';')[0].trim().toLowerCase() : ''
  return Boolean(current && current.bytes === artifact.bytes && current.etag === artifact.cosEtag && contentType === artifact.contentType)
}

function commitRequest(token) {
  const headers = { accept: 'application/vnd.github.sha', 'user-agent': 'xingmang-codex-plugins-cos-sync/1', 'x-github-api-version': '2022-11-28' }
  // The workflow token only raises the shared runner's anonymous rate limit; the
  // transport never follows a redirect, so it cannot leave api.github.com.
  if (typeof token === 'string' && /^[A-Za-z0-9_]{20,255}$/.test(token)) headers.authorization = `Bearer ${token}`
  return { url: COMMIT_URL, allowedHosts: [API_HOST], maxBytes: MAX_COMMIT_RESPONSE_BYTES, headers }
}

async function synchronizeCodexPlugins({ store, dependencies, token, progress, now = function () { return new Date().toISOString() } }) {
  let latestState = 'not-written-by-this-run'
  const stage = createStageRunner(progress, function () { return latestState })
  const old = await stage('cos-read-latest', {}, async function () {
    const manifest = validateLatest(await store.readJson(LATEST_KEY, { missingOk: true }))
    if (manifest && manifest.artifact.url !== store.publicUrl(manifest.artifact.key)) throw new Error('COS 现有插件目录下载地址与当前存储桶不一致')
    return manifest
  })
  const commit = await stage('source-commit', {}, async function () { return parseCommit(await dependencies.fetchText(commitRequest(token))) })
  if (old && old.source.commit === commit) {
    const intact = await stage('cos-check-existing', {}, function () { return verifyUnchangedArtifact(store, old.artifact) })
    if (intact) return { changed: false, manifest: old }
  }
  const workDirectory = await stage('prepare-temp', {}, function () { return dependencies.createWorkDirectory() })
  let primaryError
  try {
    const filePath = path.join(workDirectory, `openai-plugins-${commit}.tar.gz`)
    const downloaded = await stage('source-download', {}, async function (onProgress) {
      const result = await dependencies.downloadResource({ url: archiveUrl(commit), filePath, allowedHosts: [ARCHIVE_HOST], maxBytes: MAX_ARCHIVE_BYTES, onProgress })
      if (!result || !Number.isSafeInteger(result.bytes) || result.bytes < MIN_ARCHIVE_BYTES || result.bytes > MAX_ARCHIVE_BYTES || !SHA256_PATTERN.test(result.sha256 || '')) throw new Error('插件目录压缩包大小或摘要无效')
      return { bytes: result.bytes, sha256: result.sha256 }
    })
    const inspection = await stage('verify-archive', { expectedBytes: downloaded.bytes }, async function () {
      const compressed = await dependencies.readFile(filePath, MAX_ARCHIVE_BYTES)
      if (compressed.length !== downloaded.bytes) throw new Error('插件目录压缩包读回的大小和下载时不一致')
      return inspectCatalogArchive(compressed, commit)
    })
    const key = artifactKey(commit, downloaded.sha256)
    const published = await stage('cos-publish-archive', { expectedBytes: downloaded.bytes }, async function (onProgress) {
      const result = await store.publishFile(key, filePath, { expectedBytes: downloaded.bytes, expectedSha256: downloaded.sha256, contentType: CONTENT_TYPE, cacheControl: 'public, max-age=31536000, immutable', onProgress })
      if (result.bytes !== downloaded.bytes || result.sha256 !== downloaded.sha256) throw new Error('COS 插件目录公共下载校验结果不一致')
      return result
    })
    const cosHead = await stage('cos-head-archive', {}, async function () {
      const head = await store.inspect(key)
      if (!head || head.bytes !== downloaded.bytes || typeof head.etag !== 'string' || head.etag !== published.etag) throw new Error('COS 插件目录发布后的 HEAD 与已核验正文不一致')
      return head
    })
    const manifest = {
      schemaVersion: 1,
      product: PRODUCT,
      generatedAt: now(),
      source: { repository: SOURCE_REPOSITORY, ref: SOURCE_BRANCH, commit, url: archiveUrl(commit) },
      artifact: { key, url: store.publicUrl(key), bytes: downloaded.bytes, sha256: downloaded.sha256, contentType: CONTENT_TYPE, verification: VERIFICATION, cosEtag: cosHead.etag },
    }
    await stage('validate-latest', {}, async function () { validateLatest(manifest) })
    await stage('cos-recheck-latest', {}, async function () {
      const current = validateLatest(await store.readJson(LATEST_KEY, { missingOk: true }))
      if (JSON.stringify(current) !== JSON.stringify(old)) throw new Error('COS 插件目录清单在同步期间发生变化，停止发布以保留现有状态')
    })
    latestState = 'write-unconfirmed'
    await stage('cos-publish-latest', {}, function (onProgress) { return store.publishJson(LATEST_KEY, manifest, { overwrite: true, cacheControl: 'no-cache, max-age=0, must-revalidate', onProgress }) })
    latestState = 'published-and-read-back'
    return { changed: true, manifest, plugins: inspection.plugins }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try { await stage('cleanup-temp', {}, function () { return dependencies.removeWorkDirectory(workDirectory) }) } catch (error) {
      if (!primaryError) throw error
    }
  }
}

function createRuntimeDependencies(common) {
  return {
    fetchText: common.fetchText,
    downloadResource: common.downloadResource,
    readFile: function (filePath, maxBytes) { return common.readBoundedRegularFile(filePath, { maxBytes }) },
    createWorkDirectory: async function () { return fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'xingmang-codex-plugins-cos-')) },
    removeWorkDirectory: async function (directory) {
      const resolved = path.resolve(directory)
      const temporaryRoot = await fs.realpath(os.tmpdir())
      if (path.dirname(resolved) !== temporaryRoot || !path.basename(resolved).startsWith('xingmang-codex-plugins-cos-')) throw new Error('拒绝删除临时同步目录以外的路径')
      await fs.rm(resolved, { recursive: true, force: true })
    },
  }
}

async function main() {
  const common = require('./cos-sync-utils.cjs')
  if (process.argv.length > 2) throw new Error('插件目录同步不接受命令行参数')
  const config = common.readCosConfiguration(process.env)
  const result = await synchronizeCodexPlugins({ store: common.createCosStore(config), dependencies: createRuntimeDependencies(common), token: process.env.GITHUB_TOKEN,
    progress: function (event) { console.log(`[codex-plugins-sync] ${JSON.stringify(event)}`) } })
  console.log(JSON.stringify({ changed: result.changed, commit: result.manifest.source.commit, bytes: result.manifest.artifact.bytes, ...(result.plugins ? { plugins: result.plugins } : {}) }))
}

if (require.main === module) {
  main().catch(function (error) {
    console.error(`Codex 插件目录同步失败；安全诊断：${JSON.stringify(safeCodexPluginsSyncFailure(error))}`)
    process.exitCode = 1
  })
}

module.exports = { SOURCE_REPOSITORY, API_HOST, ARCHIVE_HOST, COMMIT_URL, LATEST_KEY, PRODUCT, CONTENT_TYPE, VERIFICATION, MIN_ARCHIVE_BYTES, MAX_ARCHIVE_BYTES,
  archiveUrl, artifactKey, parseCommit, validateLatest, inspectCatalogArchive, commitRequest, synchronizeCodexPlugins, createRuntimeDependencies, safeCodexPluginsSyncFailure }
