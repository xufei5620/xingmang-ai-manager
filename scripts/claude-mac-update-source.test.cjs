const assert = require('node:assert/strict')
const { test } = require('node:test')
const { Readable, Writable } = require('node:stream')
const { SOURCE_MODE, CHECKSUM_PROVENANCE, MAX_PACKAGE_BYTES, parseMacUpdateMetadata, isMacUpdateSourceResolution,
  validateMacUpdateSourceRecord, sameMacUpdateSourceResolution, validateMacUpdatePackageVersion,
  resolveMacUpdateReleaseCandidates, revalidateMacUpdateReleaseCandidates, createMacUpdateSourceDependencies } = require('./claude-mac-update-source.cjs')

const IDS = ['macos-dmg-universal', 'macos-pkg-universal']
const VERSION = '2.19675.0'
const RELEASE_ID = '5706e5524dba58b23e105c31c358df8ab0a95852'
const ARCHIVE_SHA = '86f1460ca694313223a0b524da4f411bbccf6531c2271698d1ffc29a2131e392'
const INSTALL_ID = '11111111-2222-4333-8444-555555555555'

function metadata(version = VERSION, releaseId = RELEASE_ID) {
  return { currentRelease: version, releases: [{ version, updateTo: { version,
    url: `https://downloads.claude.ai/releases/darwin/universal/${version}/Claude-${releaseId}.zip`, size: 378941973, sha256: ARCHIVE_SHA,
  } }] }
}

function fixture() {
  const value = { metadata: metadata(), reads: 0, heads: [], catalog: {}, headOverrides: {} }
  value.dependencies = {
    async readRelease() { value.reads += 1; return parseMacUpdateMetadata(JSON.stringify(value.metadata), 'arm64') },
    async inspectResource(input) {
      value.heads.push(structuredClone(input))
      if (value.headError) throw value.headError
      const id = input.url.endsWith('.dmg') ? IDS[0] : IDS[1]
      return { status: 200, bytes: 1024, etag: '"source"', lastModified: 'Fri, 02 Oct 2026 04:00:00 GMT', ...value.headOverrides[id] }
    },
    getConfirmedMacSource(id) { return value.catalog[id] },
  }
  return value
}

function setCatalog(value, id, resource) {
  const sha = id === IDS[0] ? 'c'.repeat(64) : 'd'.repeat(64)
  value.catalog[id] = { url: resource.url, version: VERSION, bytes: 1024, expectedSha256: sha,
    sourceResolution: { mode: 'operator-confirmed-direct-source', sourceVersion: VERSION, sourceSha256: sha, checksumProvenance: CHECKSUM_PROVENANCE },
  }
}

test('parses the actual official static ZIP metadata and keeps archive SHA separate from installer checksums', () => {
  const release = parseMacUpdateMetadata(JSON.stringify(metadata()), 'arm64')
  assert.equal(release.version, VERSION)
  assert.equal(release.releaseId, RELEASE_ID)
  assert.equal(release.archiveBytes, 378941973)
  assert.equal(release.archiveSha256, ARCHIVE_SHA)
  assert.equal(release.metadataArchitecture, 'arm64')
  assert.equal(release.expectedSha256, undefined)
  assert.equal(Object.isFrozen(release), true)
})

test('rejects duplicate or absent current releases, version mismatches, and missing archive integrity fields', () => {
  const duplicate = metadata()
  duplicate.releases.push(structuredClone(duplicate.releases[0]))
  const absent = metadata()
  absent.currentRelease = '2.19676.0'
  for (const bad of [duplicate, absent]) assert.throws(() => parseMacUpdateMetadata(JSON.stringify(bad), 'arm64'), /Claude Mac/)
  for (const change of [{ version: '2.19676.0' }, { size: null }, { size: MAX_PACKAGE_BYTES + 1 }, { sha256: undefined }, { sha256: 'a'.repeat(40) }]) {
    const bad = metadata()
    Object.assign(bad.releases[0].updateTo, change)
    assert.throws(() => parseMacUpdateMetadata(JSON.stringify(bad), 'arm64'), /完整 ZIP/)
  }
})

test('accepts only the exact public ZIP and rejects deltas, queries, aliases, other architectures, and unknown locations', () => {
  const base = metadata().releases[0].updateTo.url
  for (const url of [base.replace('.zip', '.delta'), base.replace('.zip', '.dmg'), base.replace('universal', 'x64'),
    base.replace('universal', 'aarch64'), base.replace('universal', 'Universal'), base.replace('/universal/', '/'),
    base.replace(VERSION, '2.19676.0'), base.replace(RELEASE_ID, RELEASE_ID.toUpperCase()), base.replace('https:', 'http:'),
    base.replace('downloads.claude.ai', 'downloads.claude.ai.evil.test'), base.replace('downloads.claude.ai', 'downloads.claude.ai:443'),
    base.replace('downloads.claude.ai', 'user@downloads.claude.ai'), base.replace('/darwin/', '/darwin%2f'),
    base.replace('/universal/', '/universal/../universal/'), `${base}?`, `${base}?sig=SECRET`, `${base}#`, `${base}\n`]) {
    const bad = metadata()
    bad.releases[0].updateTo.url = url
    assert.throws(() => parseMacUpdateMetadata(JSON.stringify(bad), 'arm64'), /固定无 query/)
  }
})

test('accepts the per-architecture ZIP of the queried architecture and still derives universal installers from it', async () => {
  for (const architecture of ['arm64', 'x64']) {
    const value = metadata()
    value.releases[0].updateTo.url = value.releases[0].updateTo.url.replace('/universal/', `/${architecture}/`)
    const release = parseMacUpdateMetadata(JSON.stringify(value), architecture)
    assert.equal(release.releaseId, RELEASE_ID)
    assert.equal(release.archiveUrl, value.releases[0].updateTo.url)
    assert.equal(release.metadataArchitecture, architecture)
    const other = architecture === 'arm64' ? 'x64' : 'arm64'
    assert.throws(() => parseMacUpdateMetadata(JSON.stringify(value), other), /架构匹配/)
    const dependencies = { ...fixture().dependencies, async readRelease() { return release } }
    const resources = await resolveMacUpdateReleaseCandidates(IDS, dependencies)
    assert.deepEqual(resources.map((resource) => resource.url), [
      `https://downloads.claude.ai/releases/darwin/universal/${VERSION}/Claude-${RELEASE_ID}.dmg`,
      `https://downloads.claude.ai/releases/darwin/universal/${VERSION}/Claude-${RELEASE_ID}.pkg`,
    ])
    assert.equal(resources[0].sourceResolution.metadataArchitecture, architecture)
    await revalidateMacUpdateReleaseCandidates(resources, dependencies)
  }
})

test('ignores the documented optional delta object and still selects the complete ZIP', () => {
  const value = metadata()
  value.releases[0].updateTo.delta = { from_version: '2.19674.0', url: 'https://unselected.invalid/ignored.delta?token=SECRET', sha256: 'f'.repeat(64), size: 1024 }
  const release = parseMacUpdateMetadata(JSON.stringify(value), 'arm64')
  assert.equal(release.archiveUrl, metadata().releases[0].updateTo.url)
  assert.equal(release.archiveSha256, metadata().releases[0].updateTo.sha256)
  assert.equal(Object.hasOwn(release, 'delta'), false)
  assert.doesNotMatch(JSON.stringify(release), /SECRET|unselected/)
})

test('bounds upstream metadata before traversing arrays, objects, or selecting a payload', () => {
  const many = metadata()
  many.releases = Array.from({ length: 17 }, () => metadata().releases[0])
  const deep = metadata()
  deep.releases[0].updateTo.extra = { deeper: { value: 'SECRET' } }
  for (const bad of [many, deep]) assert.throws(() => parseMacUpdateMetadata(JSON.stringify(bad), 'arm64'), /上限/)
  assert.throws(() => parseMacUpdateMetadata(' '.repeat(1024 * 1024 + 1), 'arm64'), /大小/)
  assert.throws(() => parseMacUpdateMetadata(JSON.stringify(metadata()), 'universal'), /架构/)
})

test('reads one release for the selected formats and returns frozen distinct installer candidates', async () => {
  const value = fixture()
  const resources = await resolveMacUpdateReleaseCandidates(IDS, value.dependencies)
  assert.equal(value.reads, 1)
  assert.equal(value.heads.length, 2)
  assert.equal(Object.isFrozen(resources), true)
  for (let index = 0; index < resources.length; index += 1) {
    const resource = resources[index]
    assert.equal(resource.platformId, IDS[index])
    assert.equal(resource.requestUrl, resource.url)
    assert.deepEqual(resource.redirects, [])
    assert.equal(resource.sourceResolution.mode, SOURCE_MODE)
    assert.equal(resource.sourceResolution.archiveSha256, ARCHIVE_SHA)
    assert.equal(resource.expectedSha256, undefined)
    assert.equal(Object.isFrozen(resource), true)
    assert.equal(Object.isFrozen(resource.sourceResolution), true)
    assert.deepEqual(value.heads[index].allowedHosts, ['downloads.claude.ai'])
  }
  const single = fixture()
  await resolveMacUpdateReleaseCandidates([IDS[1]], single.dependencies)
  assert.equal(single.reads, 1)
  assert.equal(single.heads.length, 1)
  assert.ok(single.heads[0].url.endsWith('.pkg'))
})

test('uses browser checksums only for exact matching candidates and never borrows them or ZIP hashes for a future release', async () => {
  const value = fixture()
  const original = await resolveMacUpdateReleaseCandidates(IDS, value.dependencies)
  for (const resource of original) setCatalog(value, resource.platformId, resource)
  const matching = await resolveMacUpdateReleaseCandidates(IDS, value.dependencies)
  for (const resource of matching) {
    assert.equal(resource.expectedSha256, value.catalog[resource.platformId].expectedSha256)
    assert.notEqual(resource.expectedSha256, ARCHIVE_SHA)
    assert.equal(resource.sourceResolution.sourceSha256, resource.expectedSha256)
    assert.equal(resource.sourceResolution.checksumProvenance, CHECKSUM_PROVENANCE)
  }
  value.metadata = metadata('2.19676.0', 'f'.repeat(40))
  const future = await resolveMacUpdateReleaseCandidates(IDS, value.dependencies)
  for (const resource of future) {
    assert.equal(resource.expectedSha256, undefined)
    assert.equal(resource.sourceResolution.sourceSha256, undefined)
    assert.equal(resource.sourceResolution.checksumProvenance, undefined)
  }
})

test('fails a missing candidate, timeout, or catalog size mismatch without another path trial', async () => {
  for (const change of [{ status: 404 }, { bytes: MAX_PACKAGE_BYTES + 1 }, { etag: '' }]) {
    const value = fixture()
    value.headOverrides[IDS[0]] = change
    await assert.rejects(resolveMacUpdateReleaseCandidates(IDS, value.dependencies), /HEAD/)
    assert.equal(value.heads.length, 1)
  }
  const value = fixture()
  const [resource] = await resolveMacUpdateReleaseCandidates([IDS[0]], value.dependencies)
  setCatalog(value, IDS[0], resource)
  value.headOverrides[IDS[0]] = { bytes: 1025 }
  await assert.rejects(resolveMacUpdateReleaseCandidates([IDS[0]], value.dependencies), /浏览器来源/)
  const timeout = fixture()
  const error = new Error('controlled HEAD timeout')
  timeout.headError = error
  await assert.rejects(resolveMacUpdateReleaseCandidates([IDS[0]], timeout.dependencies), thrown => thrown === error)
  assert.equal(timeout.heads.length, 1)
})

test('binds native versions and rejects altered URL, request URL, ID, or an archive digest installed as a file checksum', async () => {
  const value = fixture()
  const [resource] = await resolveMacUpdateReleaseCandidates([IDS[0]], value.dependencies)
  assert.equal(validateMacUpdatePackageVersion(resource, VERSION), VERSION)
  assert.throws(() => validateMacUpdatePackageVersion(resource, `${VERSION}.0`), /包内版本/)
  for (const altered of [{ ...resource, url: resource.url.replace('.dmg', '.pkg') }, { ...resource, requestUrl: `${resource.url}?` },
    { ...resource, platformId: IDS[1] }, { ...resource, platformId: [IDS[0]] }, { ...resource, expectedSha256: ARCHIVE_SHA }]) {
    assert.throws(() => validateMacUpdatePackageVersion(altered, VERSION), /候选资源/)
    const before = value.reads
    await assert.rejects(revalidateMacUpdateReleaseCandidates([altered], value.dependencies), /候选资源/)
    assert.equal(value.reads, before)
  }
})

test('validates finite stored provenance and preserves historical records independently of the active browser catalog', async () => {
  const value = fixture()
  const [resource] = await resolveMacUpdateReleaseCandidates([IDS[0]], value.dependencies)
  const record = { requestUrl: resource.url, sourceResolution: resource.sourceResolution }
  assert.equal(validateMacUpdateSourceRecord(record, IDS[0], VERSION, 'b'.repeat(64)), record)
  assert.equal(sameMacUpdateSourceResolution(record.sourceResolution, structuredClone(record.sourceResolution)), true)
  for (const sourceResolution of [{ ...record.sourceResolution, extra: 'SECRET' }, Object.assign([], record.sourceResolution),
    { ...record.sourceResolution, releaseId: [RELEASE_ID] }, { ...record.sourceResolution, sourceSha256: 'b'.repeat(64) }]) {
    assert.equal(isMacUpdateSourceResolution(sourceResolution), false)
    assert.throws(() => validateMacUpdateSourceRecord({ ...record, sourceResolution }, IDS[0], VERSION, 'b'.repeat(64)), /来源记录/)
  }
  assert.throws(() => validateMacUpdateSourceRecord({ ...record, requestUrl: `${resource.url}?` }, IDS[0], VERSION, 'b'.repeat(64)), /来源记录/)
  const changed = { ...record.sourceResolution, archiveSha256: 'e'.repeat(64) }
  assert.equal(sameMacUpdateSourceResolution(record.sourceResolution, changed), false)
})

test('rechecks fresh metadata once and both candidate fingerprints before publication', async () => {
  const value = fixture()
  const resources = await resolveMacUpdateReleaseCandidates(IDS, value.dependencies)
  value.heads.length = 0
  await revalidateMacUpdateReleaseCandidates(resources, value.dependencies)
  assert.equal(value.reads, 2)
  assert.equal(value.heads.length, 2)
  assert.ok(value.heads.every(head => head.expectedBytes === 1024 && head.expectedEtag === '"source"'))
  for (const change of [metadata('2.19676.0', RELEASE_ID), metadata(VERSION, 'f'.repeat(40))]) {
    value.metadata = change
    value.heads.length = 0
    await assert.rejects(revalidateMacUpdateReleaseCandidates(resources, value.dependencies), /同步期间变化/)
    assert.equal(value.heads.length, 0)
  }
})

test('rejects changed declared ZIP integrity or candidate HEAD and snapshots persisted fingerprints before awaiting', async () => {
  for (const change of [{ size: 378941974 }, { sha256: 'f'.repeat(64) }]) {
    const value = fixture()
    const resources = await resolveMacUpdateReleaseCandidates(IDS, value.dependencies)
    Object.assign(value.metadata.releases[0].updateTo, change)
    value.heads.length = 0
    await assert.rejects(revalidateMacUpdateReleaseCandidates(resources, value.dependencies), /同步期间变化/)
    assert.equal(value.heads.length, 0)
  }
  const value = fixture()
  const resources = structuredClone(await resolveMacUpdateReleaseCandidates([IDS[0]], value.dependencies))
  const read = value.dependencies.readRelease
  let resume
  let notify
  const started = new Promise(resolve => { notify = resolve })
  value.dependencies.readRelease = async function () { notify(); await new Promise(resolve => { resume = resolve }); return read() }
  const checking = revalidateMacUpdateReleaseCandidates(resources, value.dependencies)
  await started
  resources[0].bytes = 8
  resources[0].etag = '"changed-during-await"'
  value.headOverrides[IDS[0]] = { bytes: 8, etag: resources[0].etag }
  resume()
  await assert.rejects(checking, /HEAD/)
  assert.equal(value.heads.at(-1).expectedBytes, 1024)
  assert.equal(value.heads.at(-1).expectedEtag, '"source"')
})

function runtimeFixture(status = 200, headers = {}) {
  const value = { calls: [], runCalls: [], idCalls: 0, metadata: metadata() }
  function requestImpl(url, options, callback) {
    value.calls.push({ url, options })
    const request = new Writable({ write() { assert.fail('no upload body') } })
    request.on('finish', function () {
      const blocked = status !== 200 || Object.keys(headers).some(key => ['location', 'cf-mitigated', 'www-authenticate', 'proxy-authenticate', 'refresh'].includes(key.toLowerCase()))
      const response = blocked ? new Readable({ read() { assert.fail('blocked response body must not be read') } }) : Readable.from([Buffer.from(JSON.stringify(value.metadata))])
      response.statusCode = status
      response.headers = headers
      response.complete = true
      callback(response)
      if (blocked) assert.equal(response.destroyed, true)
    })
    return request
  }
  value.dependencies = createMacUpdateSourceDependencies({ inspectResource: async function () { assert.fail('metadata discovery must not HEAD a package') } }, {
    platform: 'darwin', architecture: 'arm64', requestImpl,
    createId() { value.idCalls += 1; return INSTALL_ID },
    async run(executable, args, options) { value.runCalls.push({ executable, args, options }); return { stdout: '26.6.2\n' } },
  })
  return value
}

test('performs real fresh requests within the factory using one private installation cohort and native OS discovery', async () => {
  const value = runtimeFixture()
  const first = await value.dependencies.readRelease()
  value.metadata = metadata('2.19676.0', 'f'.repeat(40))
  const second = await value.dependencies.readRelease()
  assert.notEqual(first.version, second.version)
  assert.equal(value.calls.length, 2)
  assert.equal(value.idCalls, 1)
  assert.equal(value.runCalls.length, 1)
  assert.equal(value.runCalls[0].executable, '/usr/bin/sw_vers')
  assert.deepEqual(value.runCalls[0].args, ['-productVersion'])
  assert.equal(value.runCalls[0].options.timeout, 5000)
  assert.equal(value.runCalls[0].options.env.HOME, undefined)
  for (const { url, options } of value.calls) {
    assert.equal(url.origin, 'https://api.anthropic.com')
    assert.equal(url.pathname, '/api/desktop/darwin/arm64/squirrel/update')
    assert.deepEqual([...url.searchParams], [['device_id', INSTALL_ID], ['version', VERSION], ['os_version', '26.6.2']])
    assert.deepEqual(options.headers, { accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': 'xingmang-official-offline-sync/1' })
    assert.equal(options.method, 'GET')
  }
  assert.doesNotMatch(JSON.stringify([first, second]), new RegExp(`${INSTALL_ID}|device_id|os_version`))
})

test('rejects authentication, challenge, redirect, and no-update replies without another request or disclosure', async () => {
  for (const [status, headers] of [[401, {}], [403, { 'cf-mitigated': 'challenge' }], [200, { 'CF-Mitigated': '' }],
    [302, { location: 'https://unknown.test/?SECRET' }], [200, { location: undefined }], [204, {}]]) {
    const value = runtimeFixture(status, headers)
    await assert.rejects(value.dependencies.readRelease(), error => /元数据不可用/.test(error.message) && !error.message.includes(INSTALL_ID) && !/SECRET|device_id/.test(error.message))
    assert.equal(value.calls.length, 1)
  }
})

test('enforces native factory scope and bounded header/body transport failures', async () => {
  assert.throws(() => createMacUpdateSourceDependencies({ inspectResource() {} }, { platform: 'win32', architecture: 'x64' }), /原生 macOS/)
  const inspectResource = async function () {}
  const run = async function () { return { stdout: '26.6.2\n' } }
  const createId = () => INSTALL_ID
  const hung = createMacUpdateSourceDependencies({ inspectResource }, { platform: 'darwin', architecture: 'x64', run, createId, timeoutMs: 5,
    requestImpl() { return new Writable({ write() { assert.fail('no upload') } }) },
  })
  await assert.rejects(hung.readRelease(), /响应头超时/)
  const bodyHung = createMacUpdateSourceDependencies({ inspectResource }, { platform: 'darwin', architecture: 'x64', run, createId, timeoutMs: 5,
    requestImpl(url, options, callback) {
      const request = new Writable({ write() { assert.fail('no upload') } })
      request.on('finish', function () {
        const response = new Readable({ read() {} })
        response.statusCode = 200
        response.headers = {}
        response.complete = false
        callback(response)
      })
      return request
    },
  })
  await assert.rejects(bodyHung.readRelease(), /正文超时/)
  const tooLarge = runtimeFixture(200, { 'content-length': String(1024 * 1024 + 1) })
  await assert.rejects(tooLarge.dependencies.readRelease(), /声明大小/)
  const malformed = runtimeFixture()
  malformed.metadata = { notes: 'SECRET'.repeat(180000) }
  await assert.rejects(malformed.dependencies.readRelease(), error => /上限/.test(error.message) && !error.message.includes('SECRET'))
})
