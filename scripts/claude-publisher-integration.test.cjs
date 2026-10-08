const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const { test } = require('node:test')
const { SOURCES, LATEST_KEY, synchronizeOfficialClaude, sourceRecord, validateIndex } = require('./sync-claude-official-cos.cjs')
const { getConfirmedMacSource } = require('./claude-mac-confirmed-sources.cjs')
const { parseMacUpdateMetadata, resolveMacUpdateReleaseCandidates, revalidateMacUpdateReleaseCandidates } = require('./claude-mac-update-source.cjs')
const { safeClaudeSyncFailure } = require('./claude-sync-diagnostics.cjs')

const IDS = ['macos-dmg-universal', 'macos-pkg-universal']
const VERSION = '2.19675.0'
const RELEASE_ID = '5706e5524dba58b23e105c31c358df8ab0a95852'

function clone(value) { return structuredClone(value) }

async function fixture() {
  const value = { events: [], publications: [], candidates: [], pointers: [], removed: [], latest: null, objects: new Map(), releaseReads: 0 }
  const release = parseMacUpdateMetadata(JSON.stringify({ currentRelease: VERSION, releases: [{ version: VERSION,
    updateTo: { version: VERSION, url: `https://downloads.claude.ai/releases/darwin/universal/${VERSION}/Claude-${RELEASE_ID}.zip`,
      size: 378941973, sha256: '86f1460ca694313223a0b524da4f411bbccf6531c2271698d1ffc29a2131e392' },
  }] }), 'arm64')
  value.macSources = {
    getConfirmedMacSource,
    async readRelease() {
      value.releaseReads += 1
      return { ...release, ...(value.changeRelease && value.releaseReads > 1 ? { releaseId: 'f'.repeat(40) } : {}) }
    },
    async inspectResource(input) {
      const id = IDS.find(item => getConfirmedMacSource(item).url === input.url)
      assert.ok(id)
      const source = getConfirmedMacSource(id)
      return { status: 200, bytes: source.bytes, etag: `"source-${id}"`, lastModified: null,
        ...(value.changeHead && value.publications.length ? { etag: '"changed-source"' } : {}) }
    },
  }
  const resources = await resolveMacUpdateReleaseCandidates(IDS, value.macSources)
  value.resources = new Map(resources.map(item => [item.platformId, item]))
  value.dependencies = {
    async resolveOfficialPackage(requestUrl) {
      const id = IDS.find(item => SOURCES[item].requestUrl === requestUrl)
      assert.ok(id)
      return value.resources.get(id)
    },
    async revalidateMacSources(selected) { await revalidateMacUpdateReleaseCandidates(selected, value.macSources) },
    async downloadResource(input) {
      const resource = resources.find(item => item.url === input.url)
      assert.equal(input.expectedBytes, resource.bytes)
      assert.equal(input.expectedEtag, resource.etag)
      assert.equal(input.expectedSha256, resource.expectedSha256)
      input.onProgress?.({ method: 'GET', phase: 'complete', transferredBytes: resource.bytes, expectedBytes: resource.bytes, url: 'SECRET' })
      return { bytes: resource.bytes, etag: resource.etag, sha256: value.badDigest ? 'f'.repeat(64) : resource.expectedSha256 }
    },
    async validatePackageMagic() {},
    async inspectPackage({ source }) {
      if (value.nativeError) throw value.nativeError
      return { version: value.badVersion || VERSION, signerOrganization: 'Anthropic PBC', signatureStatus: 'Valid',
        bundleIdentifier: 'com.anthropic.claudefordesktop', teamIdentifier: 'Q6L2SF6YDW', architectures: ['arm64', 'x86_64'],
        ...(source.format === 'pkg' ? { architectureProof: 'native-payload-mach-o', installerTeamIdentifier: 'Q6L2SF6YDW', installerSignatureStatus: 'Valid' } : {}) }
    },
    async createWorkDirectory() { return path.join(os.tmpdir(), 'mock-confirmed-claude-publisher') },
    async removeWorkDirectory(directory) {
      value.removed.push(directory)
      if (value.cleanupError) throw value.cleanupError
    },
  }
  value.store = {
    publicUrl(key) { return `https://mock.cos.ap-shanghai.myqcloud.com/${key}` },
    async readJson(key) { assert.equal(key, LATEST_KEY); return clone(value.latest) },
    async inspect(key) { return clone(value.objects.get(key)) },
    async publishFile(key, filePath, input) {
      value.publications.push({ key, filePath })
      const entry = { bytes: input.expectedBytes, sha256: input.expectedSha256, contentType: input.contentType, etag: `"cos-${input.expectedSha256}"` }
      value.objects.set(key, entry)
      input.onProgress?.({ method: 'PUT', phase: 'complete', transferredBytes: entry.bytes, expectedBytes: entry.bytes, headers: 'SECRET' })
      return { ...entry, url: this.publicUrl(key) }
    },
    async publishJson(key, manifest) {
      if (key !== LATEST_KEY) { value.candidates.push(clone(manifest)); return {} }
      value.pointers.push(clone(manifest))
      if (!value.unknownNotApplied) value.latest = clone(manifest)
      if (value.unknownWrite) throw new Error('SECRET unknown signed write')
      return {}
    },
  }
  value.run = function () {
    return synchronizeOfficialClaude({ store: value.store, platforms: 'macos', dependencies: value.dependencies,
      progress: event => value.events.push(event), now: () => '2026-10-03T06:00:00.000Z' })
  }
  return value
}

test('publishes the two browser-bound Mac candidates only after native verification and fresh official metadata', async () => {
  const value = await fixture()
  const result = await value.run()
  assert.equal(result.changed, true)
  assert.equal(value.releaseReads, 2)
  assert.equal(value.publications.length, 2)
  assert.equal(value.pointers.length, 1)
  assert.equal(value.removed.length, 1)
  assert.equal(validateIndex(value.latest, value.store.publicUrl).files.length, 2)
  for (const file of value.latest.files) {
    assert.equal(file.source.sourceResolution.mode, 'official-mac-update-release-candidate')
    assert.equal(file.source.sourceResolution.sourceSha256, file.sha256)
    assert.equal(file.source.requestUrl, getConfirmedMacSource(file.platformId).url)
  }
  assert.ok(value.events.some(event => event.stage === 'source-recheck' && event.event === 'stage-complete'))
  assert.doesNotMatch(JSON.stringify(value.events), /SECRET|https?:|headers|device_id|authorization/i)
})

test('rejects a different installer digest and a different native app version before any COS upload', async () => {
  for (const setting of [{ badDigest: true }, { badVersion: '2.19676.0' }]) {
    const value = await fixture()
    Object.assign(value, setting)
    await assert.rejects(value.run())
    assert.equal(value.publications.length, 0)
    assert.equal(value.pointers.length, 0)
    const failed = value.events.find(event => event.event === 'stage-failed')
    assert.equal(failed.stage, setting.badDigest ? 'source-download' : 'native-validate')
  }
})

test('source rollover or a changed candidate HEAD prevents the latest pointer from moving', async () => {
  for (const setting of [{ changeRelease: true }, { changeHead: true }]) {
    const value = await fixture()
    Object.assign(value, setting)
    await assert.rejects(value.run(), error => safeClaudeSyncFailure(error).stage === 'source-recheck')
    assert.equal(value.publications.length, 2)
    assert.equal(value.candidates.length, 0)
    assert.equal(value.pointers.length, 0)
    assert.equal(value.latest, null)
  }
})

test('a matching existing record reuses only the exact validated source resolution', async () => {
  const value = await fixture()
  await value.run()
  value.publications.length = 0
  assert.equal((await value.run()).changed, false)
  assert.equal(value.publications.length, 0)
  value.latest.files[0].source.sourceResolution.archiveSha256 = 'f'.repeat(64)
  await value.run()
  assert.equal(value.publications.length, 1)
})

test('unknown pointer writes are independently read back and never repeated', async () => {
  const applied = await fixture()
  applied.unknownWrite = true
  assert.equal((await applied.run()).changed, true)
  assert.equal(applied.pointers.length, 1)
  const missing = await fixture()
  missing.unknownWrite = missing.unknownNotApplied = true
  await assert.rejects(missing.run(), error => safeClaudeSyncFailure(error).latestState === 'write-unconfirmed')
  assert.equal(missing.pointers.length, 1)
  assert.equal(missing.latest, null)
})

test('a cleanup failure never hides the original native failure or emits raw native output', async () => {
  const value = await fixture()
  value.nativeError = new Error('SECRET original native failure')
  value.cleanupError = new Error('SECRET secondary cleanup failure')
  await assert.rejects(value.run(), error => safeClaudeSyncFailure(error).stage === 'native-inspect')
  assert.equal(value.removed.length, 1)
  assert.doesNotMatch(JSON.stringify(value.events), /SECRET/)
})

test('unknown source-resolution fields and false optional records fail strict index validation', async () => {
  const value = await fixture()
  await value.run()
  for (const resolution of [false, { ...value.latest.files[0].source.sourceResolution, device_id: 'SECRET' }]) {
    const manifest = clone(value.latest)
    manifest.files[0].source.sourceResolution = resolution
    assert.throws(() => validateIndex(manifest, value.store.publicUrl), /来源/)
  }
  const resource = value.resources.get(IDS[0])
  assert.equal(sourceRecord(SOURCES[IDS[0]], resource).requestUrl, resource.url)
})
