const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { test } = require('node:test')
const YAML = require('yaml')
const { validateOfficialIndex } = require('./verify-chatgpt-cos-index.cjs')
const { SOURCES, LICENSE_SOURCE, artifactKey } = require('./sync-chatgpt-official-cos.cjs')
const { readCosLocation } = require('./cos-sync-utils.cjs')

function manifestFixture() {
  const { publicBaseUrl } = readCosLocation({})
  const version = '26.930.2377.0'
  const sha256 = 'a'.repeat(64)
  const fingerprint = { bytes: 8, etag: '"source"', lastModified: null }
  const platforms = {}
  for (const [id, source] of Object.entries(SOURCES)) {
    const fileName = source.platform === 'macos' ? `ChatGPT-darwin-${source.architecture}-2026.930.1234.zip` : source.fileName
    const key = artifactKey(id, version, sha256, fileName)
    const entry = { platform: source.platform, architecture: source.architecture, format: source.format,
      source: { url: source.url || `https://persistent.oaistatic.com/codex-app-prod/${fileName}`, ...fingerprint },
      artifact: { key, url: `${publicBaseUrl}/${key}`, bytes: 8, sha256, contentType: source.contentType, cosEtag: '"verified"', verification: source.platform === 'windows' ? 'windows-authenticode' : 'official-https-sha256' } }
    if (source.platform === 'macos') Object.assign(entry, { appVersion: '2026.930.1234', buildVersion: '1234', source: { ...entry.source, metadataUrl: source.metadataUrl } })
    if (source.platform === 'windows') {
      const licenseKey = `chatgpt/${id}/${version}/ChatGPT-License.xml`
      Object.assign(entry, { packageVersion: version, license: { key: licenseKey, url: `${publicBaseUrl}/${licenseKey}`, bytes: 8, sha256, contentType: LICENSE_SOURCE.contentType, cosEtag: '"license"', verification: 'official-https-sha256-and-product-identity', source: { url: LICENSE_SOURCE.url, ...fingerprint } } })
    }
    platforms[id] = entry
  }
  return { schemaVersion: 1, product: 'chatgpt', windows: { schemaVersion: 1, buildVersion: version, packageIdentity: 'OpenAI.Codex', storeProductId: '9PLM9XGG6VKS' }, platforms }
}

test('all success requires four Windows and macOS entries and the two producer-verified Windows licenses', () => {
  const manifest = manifestFixture()
  const result = validateOfficialIndex(manifest)
  assert.equal(result.platforms.length, 4)
  for (const id of Object.keys(manifest.platforms)) if (id.startsWith('linux-')) delete manifest.platforms[id]
  assert.deepEqual(validateOfficialIndex(manifest), result)
  assert.equal(result.windowsLicenses, 2)
  delete manifest.platforms['windows-x64']
  assert.throws(() => validateOfficialIndex(manifest), /缺少/)
  assert.deepEqual(validateOfficialIndex(manifest, 'windows-arm64').platforms, ['windows-arm64'])
  delete manifest.platforms['windows-arm64'].license
  assert.throws(() => validateOfficialIndex(manifest, 'windows-arm64'), /许可/)
})

test('final validation rejects foreign download URLs and producer schema changes', () => {
  const manifest = manifestFixture()
  manifest.platforms['linux-rpm-arm64'].artifact.url = 'https://evil.invalid/package'
  assert.throws(() => validateOfficialIndex(manifest), /固定存储桶/)
  assert.throws(() => validateOfficialIndex({ ...manifest, product: 'wrong' }), /格式/)
  assert.throws(() => validateOfficialIndex(null), /缺少/)
})

test('final public-only validation follows all selected jobs and has no credentials or write command', async () => {
  const text = await fs.readFile(path.join(__dirname, '../.github/workflows/sync-chatgpt-official-cos.yml'), 'utf8')
  const job = YAML.parse(text).jobs['verify-index']
  assert.deepEqual(job.needs, ['select', 'sync'])
  assert.equal(job['timeout-minutes'], 5)
  assert.equal(job.environment, undefined)
  assert.equal(job['continue-on-error'], undefined)
  const step = job.steps.find(item => item.env?.PLATFORM_REQUEST)
  assert.equal(step.run, 'node scripts/verify-chatgpt-cos-index.cjs')
  assert.doesNotMatch(JSON.stringify(job), /secrets\.|COS_SECRET|publishJson|publishFile/)
})
