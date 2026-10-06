const SOURCE_VERSION = '2.19675.0'
const SOURCE_MODE = 'operator-confirmed-direct-source'
const CHECKSUM_PROVENANCE = 'operator-official-browser-local-sha256'
const RESOLUTION_FIELDS = Object.freeze(['mode', 'sourceVersion', 'sourceSha256', 'checksumProvenance'])
const MAC_FORMATS = Object.freeze({ 'macos-dmg-universal': 'dmg', 'macos-pkg-universal': 'pkg' })

// These two locations were independently obtained through the official browser
// download flow. A catalog update requires another operator-confirmed download;
// no URL, package digest or discovery result is inferred from the other format.
const CONFIRMED_SOURCES = Object.freeze({
  'macos-dmg-universal': buildConfirmedSource(
    'https://downloads.claude.ai/releases/darwin/universal/2.19675.0/Claude-5706e5524dba58b23e105c31c358df8ab0a95852.dmg',
    377037896, 'c0e6e512c5913e20567cdbfad33f8622e69ab39a2a9886bf2a752b2ab06455cb'),
  'macos-pkg-universal': buildConfirmedSource(
    'https://downloads.claude.ai/releases/darwin/universal/2.19675.0/Claude-5706e5524dba58b23e105c31c358df8ab0a95852.pkg',
    384935158, '5c8d7ec0fc49121d29bf80ea08b754b1ce486afd695fec157de97de8dbef080e'),
})

function buildConfirmedSource(url, bytes, expectedSha256) {
  return Object.freeze({ url, version: SOURCE_VERSION, bytes, expectedSha256,
    sourceResolution: Object.freeze({ mode: SOURCE_MODE, sourceVersion: SOURCE_VERSION,
      sourceSha256: expectedSha256, checksumProvenance: CHECKSUM_PROVENANCE }) })
}

function getConfirmedMacSource(platformId) {
  if (typeof platformId !== 'string' || !Object.hasOwn(CONFIRMED_SOURCES, platformId)) throw new Error('Claude Mac 已确认来源平台无效')
  return CONFIRMED_SOURCES[platformId]
}

function isThreePartVersion(value) {
  return typeof value === 'string' && value.length <= 64 && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(value)
    && value.split('.').every(function (part) { return Number.isSafeInteger(Number(part)) })
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function isConfirmedMacSourceResolution(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Reflect.ownKeys(value).length !== RESOLUTION_FIELDS.length
    || !RESOLUTION_FIELDS.every(function (field) { return Object.hasOwn(value, field) })) return false
  return value.mode === SOURCE_MODE && value.checksumProvenance === CHECKSUM_PROVENANCE
    && isThreePartVersion(value.sourceVersion) && isSha256(value.sourceSha256)
}

function validateConfirmedMacSourceRecord(record, platformId, fileVersion, fileSha256) {
  if (typeof platformId !== 'string' || !Object.hasOwn(MAC_FORMATS, platformId)) throw new Error('Claude Mac 已确认来源平台无效')
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !Object.hasOwn(record, 'requestUrl') || !Object.hasOwn(record, 'sourceResolution')
    || typeof record.requestUrl !== 'string' || record.requestUrl.length > 4096
    || !isConfirmedMacSourceResolution(record.sourceResolution)
    || !isThreePartVersion(fileVersion) || !isSha256(fileSha256)) throw new Error('Claude Mac 已确认来源记录格式或依据无效')
  let url
  try { url = new URL(record.requestUrl) } catch { throw new Error('Claude Mac 已确认来源地址无效') }
  const match = /^\/releases\/darwin\/universal\/([0-9]+\.[0-9]+\.[0-9]+)\/Claude-[a-f0-9]{40}\.(dmg|pkg)$/.exec(url.pathname)
  // Stored sources outlive the active catalog. Verify their complete recorded
  // identity instead of making a later catalog revision invalidate old indexes.
  // Exact serialization also rejects normalized credentials, default ports,
  // empty queries and path aliases that URL parsing alone can hide.
  if (url.protocol !== 'https:' || url.hostname !== 'downloads.claude.ai' || url.port
    || url.username || url.password || url.search || url.hash
    || record.requestUrl !== `https://downloads.claude.ai${url.pathname}`
    || !match || match[2] !== MAC_FORMATS[platformId] || match[1] !== fileVersion
    || record.sourceResolution.sourceVersion !== fileVersion
    || record.sourceResolution.sourceSha256 !== fileSha256) throw new Error('Claude Mac 已确认来源地址、版本或本地摘要不匹配')
  return record
}

function sameConfirmedMacSourceResolution(left, right) {
  const leftAbsent = left === undefined || left === null
  const rightAbsent = right === undefined || right === null
  if (leftAbsent || rightAbsent) return leftAbsent && rightAbsent
  if (!isConfirmedMacSourceResolution(left) || !isConfirmedMacSourceResolution(right)) return false
  return RESOLUTION_FIELDS.every(function (field) { return left[field] === right[field] })
}

module.exports = { getConfirmedMacSource, validateConfirmedMacSourceRecord, sameConfirmedMacSourceResolution }
