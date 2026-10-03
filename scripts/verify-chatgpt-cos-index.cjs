const { buildOfficialPackageMatrix } = require('./cos-chatgpt-platform-matrix.cjs')
const { validatePreviousManifest, LATEST_KEY } = require('./sync-chatgpt-official-cos.cjs')
const { readCosLocation, fetchJson, safeSyncFailure } = require('./cos-sync-utils.cjs')

function validateOfficialIndex(value, selection = 'all', location = {}) {
  const { publicBaseUrl } = readCosLocation({ COS_BUCKET: location.bucket, COS_REGION: location.region })
  const manifest = validatePreviousManifest(value)
  const ids = buildOfficialPackageMatrix(selection).include.map(item => item.platform)
  if (!manifest || ids.some(id => !Object.hasOwn(manifest.platforms, id))) throw new Error('官方最新索引缺少本次要求的平台，请按精确平台恢复')
  for (const entry of Object.values(manifest.platforms)) {
    if (entry.artifact.url !== `${publicBaseUrl}/${entry.artifact.key}` || entry.license && entry.license.url !== `${publicBaseUrl}/${entry.license.key}`) throw new Error('官方最新索引下载地址与固定存储桶不一致')
  }
  // Producer validation enforces the selected Windows architecture's matching
  // package version, license key, size and source verification; this presence
  // check catches a prior job dropped by a later shared-version transition.
  return { platforms: ids, windowsLicenses: ids.filter(id => id.startsWith('windows-')).length }
}

async function main() {
  const location = readCosLocation(process.env)
  const manifest = await fetchJson({ url: `${location.publicBaseUrl}/${LATEST_KEY}`, allowedHosts: [new URL(location.publicBaseUrl).hostname], maxBytes: 1024 * 1024 }, { headerTimeoutMs: 30000, bodyTimeoutMs: 30000 })
  console.log(JSON.stringify(validateOfficialIndex(manifest, process.env.PLATFORM_REQUEST || 'all', location)))
}

if (require.main === module) main().catch(function (error) {
  console.error(`官方最新索引完整性验收失败；请核对所选平台：${JSON.stringify(safeSyncFailure(error))}`)
  process.exitCode = 1
})

module.exports = { validateOfficialIndex }
