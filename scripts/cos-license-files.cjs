const path = require('node:path')
const { checkFailure, hashFile } = require('./cos-sync-utils.cjs')

// 决定单 D98（yoyo 2026-11-11「决定单照推荐」，即「桶照旧」）：Grok CLI（Apache-2.0）和 OpenCode（MIT）
// 允许转发，条件是许可文字跟着程序走。桶里以前只放了程序本身：grok.exe 是单个可执行文件，OpenCode 1.19.5
// 的 .app.tar.gz 里列出来的只有两个依赖库各自的许可，没有它自己的 LICENSE（app.asar 里面没拆开看）。
// 这里把许可文件传进同一个前缀、写进清单，谁从桶里拿到清单，就能从同一份清单找到许可。
//
// The texts are vendored in scripts/cos-licenses/ (its README names each source) and pinned by
// SHA-256 in cos-license-files.test.cjs, so a sync uploads exactly what was reviewed and never
// fetches a license from a host the job does not otherwise trust. Each text lives under its own
// SHA-256 like the packages do, so a published object is never overwritten. Clients ignore the
// pointer's license field: since 0.2.22 both bucket parsers read only the keys they know.

const LICENSE_ROOT = path.join(__dirname, 'cos-licenses')
// Served as plain UTF-8 text so a browser shows the notices instead of downloading them.
const LICENSE_CONTENT_TYPE = 'text/plain; charset=utf-8'
const MAX_LICENSE_BYTES = 64 * 1024
const MAX_LICENSE_FILES = 8
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SPDX_PATTERN = /^[A-Za-z0-9.+-]{1,64}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
// 每个产品要放哪几份、按什么顺序写进清单。Grok 的 THIRD_PARTY_NOTICES.md 是 xAI 随 npm 包发的第三方声明
// （grok.exe 里嵌着 ripgrep，还移植了 Codex、OpenCode 的代码），转发 grok.exe 就得一起带上。
const LICENSE_SETS = Object.freeze({
  'grok-cli': Object.freeze({ spdx: 'Apache-2.0', files: Object.freeze(['LICENSE.txt', 'THIRD_PARTY_NOTICES.md']) }),
  'opencode-desktop': Object.freeze({ spdx: 'MIT', files: Object.freeze(['LICENSE.txt']) }),
})

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function licenseSet(product) {
  if (!Object.hasOwn(LICENSE_SETS, product)) throw checkFailure('license-unreadable', '这个产品没有登记要放进存储桶的许可文件')
  return LICENSE_SETS[product]
}

function licenseKey(prefix, sha256, fileName) {
  return `${prefix}/licenses/sha256-${sha256}/${fileName}`
}

function mediaType(value) {
  return typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : ''
}

/** Reads this product's vendored texts with the same bounded regular-file reader the uploads use. */
async function readLicenseFiles(product, directory = LICENSE_ROOT) {
  const set = licenseSet(product)
  const files = []
  for (const fileName of set.files) {
    const filePath = path.join(directory, product, fileName)
    let hash
    try { hash = await hashFile(filePath, { maxBytes: MAX_LICENSE_BYTES }) } catch { throw checkFailure('license-unreadable', `许可文件 ${fileName} 读不出来`) }
    if (!hash.bytes) throw checkFailure('license-unreadable', `许可文件 ${fileName} 是空的`)
    files.push({ fileName, filePath, bytes: hash.bytes, sha256: hash.sha256 })
  }
  return files
}

/**
 * Checks the license record of a pointer read from the bucket. A pointer written before D98 has
 * none, which is fine. A record listing other files than today's set is fine too: those texts are
 * simply uploaded again. So only the layout is held here, and assertCompleteLicense holds the record
 * this run writes to today's set.
 */
function validateLicense(value, { prefix, publicUrl, message }) {
  if (value === undefined) return null
  function invalid() { return checkFailure('cos-index-invalid', message) }
  if (!isRecord(value) || typeof value.spdx !== 'string' || !SPDX_PATTERN.test(value.spdx)
    || !Array.isArray(value.files) || !value.files.length || value.files.length > MAX_LICENSE_FILES) throw invalid()
  const names = new Set()
  for (const file of value.files) {
    if (!isRecord(file) || typeof file.fileName !== 'string' || !FILE_NAME_PATTERN.test(file.fileName) || names.has(file.fileName)
      || typeof file.sha256 !== 'string' || !SHA256_PATTERN.test(file.sha256) || file.key !== licenseKey(prefix, file.sha256, file.fileName)
      || typeof file.url !== 'string' || (publicUrl && file.url !== publicUrl(file.key))
      || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > MAX_LICENSE_BYTES
      || file.contentType !== LICENSE_CONTENT_TYPE
      || typeof file.cosEtag !== 'string' || !file.cosEtag || file.cosEtag.length > 256 || /[\r\n]/.test(file.cosEtag)) throw invalid()
    names.add(file.fileName)
  }
  return value
}

/** The record a run writes must carry every text registered for the product, in order. */
function assertCompleteLicense(value, product) {
  const set = licenseSet(product)
  if (!isRecord(value) || value.spdx !== set.spdx || !Array.isArray(value.files) || value.files.length !== set.files.length
    || value.files.some(function (file, index) { return !isRecord(file) || file.fileName !== set.files[index] })) throw checkFailure('cos-index-invalid', '清单里的许可文件和登记的不一致')
}

async function verifyUnchangedLicense(store, record) {
  const current = await store.inspect(record.key)
  return Boolean(current && current.bytes === record.bytes && current.etag === record.cosEtag && mediaType(current.contentType) === mediaType(record.contentType))
}

/**
 * Uploads each text the bucket does not already hold intact, the way the packages go up: immutable
 * key, the full public readback inside publishFile, then a HEAD whose ETag the record keeps. A text
 * the previous pointer lists and the bucket still serves unchanged is reused as it is, so a run with
 * nothing new writes the same record and the pointer comparison still sees no change.
 */
async function publishLicense({ stage, store, prefix, product, files, previous }) {
  const set = licenseSet(product)
  const records = []
  for (const file of files) {
    const key = licenseKey(prefix, file.sha256, file.fileName)
    const context = { fileName: file.fileName }
    const existing = previous?.files.find(function (record) { return record.key === key && record.bytes === file.bytes })
    if (existing && await stage('cos-check-license', context, function () { return verifyUnchangedLicense(store, existing) })) {
      records.push(existing)
      continue
    }
    const published = await stage('cos-publish-license', { ...context, expectedBytes: file.bytes }, async function (onProgress) {
      const result = await store.publishFile(key, file.filePath, { expectedBytes: file.bytes, expectedSha256: file.sha256, contentType: LICENSE_CONTENT_TYPE, cacheControl: 'public, max-age=31536000, immutable', onProgress })
      if (result.bytes !== file.bytes || result.sha256 !== file.sha256) throw checkFailure('cos-object-mismatch', 'COS 许可文件公共下载校验结果不一致')
      return result
    })
    const head = await stage('cos-head-license', context, async function () {
      const result = await store.inspect(key)
      if (!result || result.bytes !== file.bytes || typeof result.etag !== 'string' || result.etag !== published.etag) throw checkFailure('cos-object-mismatch', 'COS 许可文件发布后的 HEAD 与已核验正文不一致')
      return result
    })
    records.push({ fileName: file.fileName, key, url: store.publicUrl(key), bytes: file.bytes, sha256: file.sha256, contentType: LICENSE_CONTENT_TYPE, cosEtag: head.etag })
  }
  return { spdx: set.spdx, files: records }
}

module.exports = { LICENSE_ROOT, LICENSE_CONTENT_TYPE, MAX_LICENSE_BYTES, LICENSE_SETS,
  licenseKey, readLicenseFiles, validateLicense, assertCompleteLicense, publishLicense }
