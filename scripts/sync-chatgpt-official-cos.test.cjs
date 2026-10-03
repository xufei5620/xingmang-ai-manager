const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { hashFile, readBoundedRegularFile } = require('./cos-sync-utils.cjs')
const {
  OFFICIAL_HOST, WINDOWS_METADATA_URL, WINDOWS_PUBLISHER, SOURCES, LICENSE_SOURCE,
  LATEST_KEY, MAX_PACKAGE_BYTES, WINDOWS_INSPECTION_SCRIPT, parsePlatforms,
  compareWindowsVersions, validateWindowsMetadata, validateHead, parseMacAppcast,
  validateWindowsInspection, sanitizedWindowsEnvironment, synchronizeOfficialChatgpt,
  validatePackageMagic, createRuntimeDependencies, safeOfficialSyncFailure,
} = require('./sync-chatgpt-official-cos.cjs')

test('runtime temp aliases resolve to safe files and cleanup preserves neighboring directories', async function () {
  const temporaryBase = await fs.realpath(os.tmpdir())
  const root = await fs.mkdtemp(path.join(temporaryBase, 'official-temp-alias-test-'))
  const real = path.join(root, 'real')
  const alias = path.join(root, 'alias')
  const environmentKey = process.platform === 'win32' ? 'TEMP' : 'TMPDIR'
  const previous = process.env[environmentKey]
  try {
    await fs.mkdir(real)
    await fs.symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
    process.env[environmentKey] = alias
    assert.equal(os.tmpdir(), alias)
    const runtime = createRuntimeDependencies({})
    const directory = await runtime.createWorkDirectory()
    assert.equal(path.dirname(directory), await fs.realpath(alias))
    assert.match(path.basename(directory), /^xingmang-official-cos-/)
    const filePath = path.join(directory, 'verified-package.msix')
    const payload = Buffer.from('official package fixture')
    await fs.writeFile(filePath, payload)
    assert.deepEqual(await readBoundedRegularFile(filePath), payload)
    const hash = await hashFile(filePath)
    assert.equal(hash.bytes, payload.length)
    assert.equal(hash.sha256, createHash('sha256').update(payload).digest('hex'))

    const sibling = await runtime.createWorkDirectory()
    const siblingFile = path.join(sibling, 'keep.txt')
    await fs.writeFile(siblingFile, 'other run')
    const unrelated = path.join(real, 'unrelated')
    const outside = path.join(root, 'xingmang-official-cos-outside')
    await fs.mkdir(unrelated)
    await fs.mkdir(outside)
    await assert.rejects(runtime.removeWorkDirectory(unrelated), /拒绝删除/)
    await assert.rejects(runtime.removeWorkDirectory(outside), /拒绝删除/)
    await runtime.removeWorkDirectory(directory)
    await assert.rejects(fs.access(directory), { code: 'ENOENT' })
    assert.equal(await fs.readFile(siblingFile, 'utf8'), 'other run')
    assert.equal((await fs.stat(unrelated)).isDirectory(), true)
    assert.equal((await fs.stat(outside)).isDirectory(), true)
    await runtime.removeWorkDirectory(sibling)
  } finally {
    if (previous === undefined) delete process.env[environmentKey]
    else process.env[environmentKey] = previous
    if (path.dirname(root) !== temporaryBase || !path.basename(root).startsWith('official-temp-alias-test-')) {
      throw new Error('Unexpected temp-alias cleanup target')
    }
    await fs.rm(root, { recursive: true, force: true })
  }
})

function clone(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value))
}

function appcast(architecture, { appVersion = '26.930.21537', buildVersion = '12776', bytes = 64, extra = '' } = {}) {
  return `<?xml version="1.0"?><rss><channel><item><title>${appVersion}</title><sparkle:version>${buildVersion}</sparkle:version><sparkle:shortVersionString>${appVersion}</sparkle:shortVersionString><enclosure url="https://${OFFICIAL_HOST}/codex-app-prod/ChatGPT-darwin-${architecture}-${appVersion}.zip" length="${bytes}" type="application/octet-stream" sparkle:edSignature="example"/><sparkle:deltas><enclosure url="https://evil.invalid/delta.zip" length="8" sparkle:deltaFrom="12775" /></sparkle:deltas>${extra}</item></channel></rss>`
}

function createFixture() {
  const fixture = {
    metadata: { schemaVersion: 1, packageIdentity: 'OpenAI.Codex', storeProductId: '9PLM9XGG6VKS', buildVersion: '26.930.2377.0' },
    latest: null,
    resources: new Map(),
    objects: new Map(),
    downloads: [],
    inspections: [],
    publications: [],
    pointers: [],
    directories: [],
    removed: [],
    reads: 0,
  }
  function addResource(url) {
    const bytes = 64
    const sha256 = createHash('sha256').update(url).digest('hex')
    fixture.resources.set(url, { bytes, sha256, etag: `"${sha256.slice(0, 24)}"`, lastModified: 'Fri, 02 Oct 2026 06:49:49 GMT' })
  }
  for (const source of Object.values(SOURCES)) {
    if (source.url) addResource(source.url)
    else addResource(parseMacAppcast(appcast(source.architecture), source.architecture).url)
  }
  addResource(LICENSE_SOURCE.url)
  fixture.dependencies = {
    async fetchJson(input) {
      assert.equal(input.url, WINDOWS_METADATA_URL)
      assert.deepEqual(input.allowedHosts, [OFFICIAL_HOST])
      return clone(fixture.metadata)
    },
    async fetchText(input) {
      assert.deepEqual(input.allowedHosts, [OFFICIAL_HOST])
      assert.equal(input.maxBytes, 256 * 1024)
      return appcast(input.url.endsWith('appcast-x64.xml') ? 'x64' : 'arm64')
    },
    async inspectResource(input) {
      assert.deepEqual(input.allowedHosts, [OFFICIAL_HOST])
      const result = fixture.resources.get(input.url)
      assert.ok(result, `Unexpected mock HEAD URL ${input.url}`)
      return clone(result)
    },
    async downloadResource(input) {
      fixture.downloads.push(clone(input))
      assert.deepEqual(input.allowedHosts, [OFFICIAL_HOST])
      const result = fixture.resources.get(input.url)
      assert.ok(result, `Unexpected mock download URL ${input.url}`)
      assert.equal(input.expectedBytes, result.bytes)
      assert.equal(input.expectedEtag, result.etag)
      if (fixture.downloadError) throw new Error('Mock checksum failure')
      return fixture.downloadOverride ? fixture.downloadOverride(input, clone(result)) : clone(result)
    },
    async inspectWindowsFile(input) {
      fixture.inspections.push(clone(input))
      if (input.license) return { license: { rootName: 'License', namespace: 'urn:schemas-microsoft-com:windows:store:licensing:ls', productId: '9PLM9XGG6VKS', packageFamily: 'openai.codex_2p2nqsd0c76g0' } }
      const architecture = input.filePath.includes('arm64') ? 'arm64' : 'x64'
      return {
        manifest: { name: 'OpenAI.Codex', version: fixture.metadata.buildVersion, architecture, publisher: WINDOWS_PUBLISHER, containsPackageSignature: true },
        signature: { status: fixture.badSignatureArchitecture === architecture ? 'HashMismatch' : 'Valid', signerSubject: WINDOWS_PUBLISHER, signerIssuer: 'CN=Microsoft Marketplace CA G 028, O=Microsoft Corporation, C=US' },
      }
    },
    async validatePackageMagic() {},
    async createWorkDirectory() {
      const directory = path.resolve(os.tmpdir(), `mock-official-cos-${fixture.directories.length}`)
      fixture.directories.push(directory)
      return directory
    },
    async removeWorkDirectory(directory) { fixture.removed.push(directory) },
  }
  fixture.store = {
    async readJson(key) {
      assert.equal(key, LATEST_KEY)
      fixture.reads += 1
      return clone(fixture.readOverride ? fixture.readOverride(fixture.reads) : fixture.latest)
    },
    async inspect(key) { return clone(fixture.objects.get(key) || null) },
    publicUrl(key) { return `https://mock-bucket.cos.ap-shanghai.myqcloud.com/${key}` },
    async publishFile(key, filePath, input) {
      const call = { key, filePath, ...input }
      fixture.publications.push(call)
      if (fixture.publicationError) throw new Error('Mock COS verification failure')
      const existing = fixture.objects.get(key)
      if (existing && (existing.bytes !== input.expectedBytes || existing.sha256 !== input.expectedSha256)) throw new Error('Mock immutable object checksum conflict')
      const result = { key, bytes: input.expectedBytes, sha256: input.expectedSha256, contentType: input.contentType, etag: existing?.etag || `"cos-${input.expectedSha256.slice(0, 24)}"` }
      fixture.objects.set(key, result)
      call.reused = Boolean(existing)
      return result
    },
    async publishJson(key, value, input) {
      assert.equal(key, LATEST_KEY)
      assert.equal(input.overwrite, true)
      assert.match(input.cacheControl, /no-cache/)
      if (fixture.pointerError) throw new Error('Mock pointer write not confirmed')
      fixture.pointers.push(clone(value))
      fixture.latest = clone(value)
      return { key }
    },
  }
  fixture.run = function (platforms) { return synchronizeOfficialChatgpt({ store: fixture.store, dependencies: fixture.dependencies, platforms, now: function () { return '2026-10-02T12:00:00.000Z' } }) }
  return fixture
}

test('defaults to Windows packages and allows only fixed platform identifiers', function () {
  assert.deepEqual(parsePlatforms(), ['windows-x64', 'windows-arm64'])
  assert.deepEqual(parsePlatforms('windows'), ['windows-x64', 'windows-arm64'])
  assert.equal(parsePlatforms('all').length, 8)
  assert.deepEqual(parsePlatforms('macos'), ['macos-arm64', 'macos-x64'])
  assert.deepEqual(parsePlatforms('linux'), ['linux-deb-x64', 'linux-deb-arm64', 'linux-rpm-x64', 'linux-rpm-arm64'])
  assert.deepEqual(parsePlatforms('linux-rpm-arm64'), ['linux-rpm-arm64'])
  assert.ok(parsePlatforms('all').includes('macos-x64'))
  assert.throws(function () { parsePlatforms('https://evil.invalid/package') }, /平台无效/)
  assert.throws(function () { parsePlatforms('windows-x64,../escape') }, /平台无效/)
})

test('exact platform recovery merges the other seven verified entries and retains both Windows licenses', async function () {
  const fixture = createFixture()
  await fixture.run('all')
  const previous = clone(fixture.latest)
  const url = SOURCES['linux-rpm-arm64'].url
  fixture.resources.set(url, { ...fixture.resources.get(url), etag: '"new-source"' })
  const before = fixture.downloads.length
  const result = await fixture.run('linux-rpm-arm64')
  assert.equal(fixture.downloads.length, before + 1)
  assert.equal(Object.keys(result.manifest.platforms).length, 8)
  for (const [id, entry] of Object.entries(previous.platforms)) {
    if (id !== 'linux-rpm-arm64') assert.deepEqual(result.manifest.platforms[id], entry)
  }
  assert.ok(result.manifest.platforms['windows-x64'].license)
  assert.ok(result.manifest.platforms['windows-arm64'].license)
})

test('source changes after object publication stop the latest pointer and identify the changed platform', async function () {
  const fixture = createFixture()
  const inspect = fixture.dependencies.inspectResource
  fixture.dependencies.inspectResource = async function (input) {
    const head = await inspect(input)
    return fixture.publications.length && input.url === SOURCES['linux-rpm-arm64'].url
      ? { ...head, etag: '"changed-after-upload"' } : head
  }
  await assert.rejects(fixture.run('all'), (error) => {
    const diagnostic = safeOfficialSyncFailure(error)
    assert.equal(diagnostic.stage, 'source-recheck-package')
    assert.equal(diagnostic.platform, 'linux-rpm-arm64')
    assert.equal(diagnostic.latestState, 'not-written-by-this-run')
    return true
  })
  assert.equal(fixture.publications.length, 10)
  assert.equal(fixture.pointers.length, 0)
})

test('Mac appcast size validation remains inside the reported HEAD phase', async function () {
  const fixture = createFixture()
  fixture.dependencies.fetchText = async function () { return appcast('arm64', { bytes: 65 }) }
  await assert.rejects(fixture.run('macos-arm64'), (error) => {
    const diagnostic = safeOfficialSyncFailure(error)
    assert.equal(diagnostic.stage, 'source-head-package')
    assert.equal(diagnostic.platform, 'macos-arm64')
    return true
  })
  assert.equal(fixture.downloads.length, 0)
})

test('safe stages report transfer counts and preserve the primary error when cleanup also fails', async function () {
  const fixture = createFixture()
  const events = []
  const download = fixture.dependencies.downloadResource
  fixture.dependencies.downloadResource = async function (input) {
    input.onProgress({ phase: 'response-body', method: 'GET', transferredBytes: 32, expectedBytes: 64,
      url: 'https://signed.invalid/?token=SECRET', authorization: 'Bearer SECRET' })
    return download(input)
  }
  fixture.store.publishFile = async function () { throw new Error('PRIMARY-SECRET signed URL and authorization') }
  fixture.dependencies.removeWorkDirectory = async function () { throw new Error('CLEANUP-SECRET') }
  await assert.rejects(synchronizeOfficialChatgpt({ store: fixture.store, dependencies: fixture.dependencies,
    platforms: 'linux-rpm-arm64', progress: (event) => events.push(event) }), (error) => {
    const diagnostic = safeOfficialSyncFailure(error)
    assert.equal(diagnostic.stage, 'cos-publish-package')
    assert.equal(diagnostic.platform, 'linux-rpm-arm64')
    assert.equal(diagnostic.latestState, 'not-written-by-this-run')
    return true
  })
  assert.ok(events.some((event) => event.event === 'transfer' && event.transferredBytes === 32 && event.transferExpectedBytes === 64))
  assert.ok(events.some((event) => event.event === 'stage-failed' && event.stage === 'cleanup-temp'))
  assert.doesNotMatch(JSON.stringify(events), /SECRET|signed\.invalid|authorization|filePath|Bearer/i)
  assert.equal(fixture.pointers.length, 0)
  assert.deepEqual(safeOfficialSyncFailure({ stage: 'SECRET', syncFailure: { code: 'http-status' } }),
    { stage: 'setup', latestState: 'not-written-by-this-run', failure: { code: 'operation-failed' } })
})

test('latest write uncertainty and cleanup after confirmed publication are reported honestly', async function () {
  const uncertain = createFixture()
  uncertain.pointerError = true
  await assert.rejects(uncertain.run('linux-rpm-arm64'), (error) => {
    const diagnostic = safeOfficialSyncFailure(error)
    assert.equal(diagnostic.stage, 'cos-publish-latest')
    assert.equal(diagnostic.latestState, 'write-unconfirmed')
    return true
  })
  const cleanup = createFixture()
  cleanup.dependencies.removeWorkDirectory = async function () { throw new Error('cleanup failed') }
  await assert.rejects(cleanup.run('linux-rpm-arm64'), (error) => {
    const diagnostic = safeOfficialSyncFailure(error)
    assert.equal(diagnostic.stage, 'cleanup-temp')
    assert.equal(diagnostic.latestState, 'published-and-read-back')
    return true
  })
  assert.equal(cleanup.pointers.length, 1)
})

test('validates official Windows identity and numeric version precedence', function () {
  const fixture = createFixture()
  assert.equal(validateWindowsMetadata(fixture.metadata).buildVersion, '26.930.2377.0')
  assert.throws(function () { validateWindowsMetadata({ ...fixture.metadata, packageIdentity: 'Attacker.App' }) }, /身份/)
  assert.throws(function () { validateWindowsMetadata({ ...fixture.metadata, storeProductId: 'OTHER' }) }, /身份/)
  assert.throws(function () { validateWindowsMetadata({ ...fixture.metadata, buildVersion: '26.930.2377' }) }, /四段/)
  assert.equal(compareWindowsVersions('26.1000.0.0', '26.930.65535.0'), 1)
  assert.throws(function () { compareWindowsVersions('26.65536.0.0', '26.1.1.1') }, /范围/)
})

test('rejects missing ETag and packages larger than two GiB', function () {
  assert.throws(function () { validateHead({ bytes: 1 }, MAX_PACKAGE_BYTES) }, /ETag/)
  assert.throws(function () { validateHead({ bytes: MAX_PACKAGE_BYTES + 1, etag: 'etag' }, MAX_PACKAGE_BYTES) }, /超过限制/)
})

test('parses actual Mac appcast version children and ignores delta enclosures', function () {
  const parsed = parseMacAppcast(appcast('x64', { bytes: 675266945 }), 'x64')
  assert.equal(parsed.buildVersion, '12776')
  assert.equal(parsed.appVersion, '26.930.21537')
  assert.equal(parsed.fileName, 'ChatGPT-darwin-x64-26.930.21537.zip')
  assert.equal(parsed.declaredBytes, 675266945)
  assert.equal(new URL(parsed.url).hostname, OFFICIAL_HOST)
})

test('rejects malicious XML, duplicate full enclosures, and foreign Mac URLs', function () {
  assert.throws(function () { parseMacAppcast(`<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///secret">]>${appcast('x64')}`, 'x64') }, /XML/)
  assert.throws(function () { parseMacAppcast(appcast('x64').replace(`https://${OFFICIAL_HOST}`, 'https://evil.invalid'), 'x64') }, /官方主机/)
  assert.throws(function () { parseMacAppcast(appcast('x64'), 'arm64') }, /完整 ZIP/)
  assert.throws(function () { parseMacAppcast(appcast('x64', { extra: '<enclosure url="https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-x64-26.930.21537.zip" length="64"/>' }), 'x64') }, /歧义/)
  assert.throws(function () { parseMacAppcast(appcast('x64').replace('length="64"', 'length="64" length="64"'), 'x64') }, /属性/)
})

test('downloads validates and publishes both MSIX packages before the latest pointer', async function () {
  const fixture = createFixture()
  const result = await fixture.run()
  assert.equal(result.changed, true)
  assert.equal(fixture.downloads.length, 3)
  assert.equal(fixture.inspections.length, 3)
  assert.equal(fixture.publications.length, 4)
  assert.equal(fixture.pointers.length, 1)
  assert.equal(result.manifest.platforms['windows-x64'].artifact.key, 'chatgpt/windows-x64/26.930.2377.0/ChatGPT-x64.msix')
  assert.equal(result.manifest.platforms['windows-arm64'].license.key, 'chatgpt/windows-arm64/26.930.2377.0/ChatGPT-License.xml')
  assert.equal(result.manifest.platforms['windows-x64'].artifact.verification, 'windows-authenticode')
  assert.deepEqual(fixture.removed, fixture.directories)
})

test('reuses manual COS uploads only after an official full download and exact checksum verification', async function () {
  const fixture = createFixture()
  const resource = fixture.resources.get(SOURCES['windows-x64'].url)
  const key = 'chatgpt/windows-x64/26.930.2377.0/ChatGPT-x64.msix'
  fixture.objects.set(key, { ...resource, contentType: 'application/vnd.ms-appx' })
  await fixture.run(['windows-x64'])
  assert.equal(fixture.downloads.filter(function (item) { return item.url === SOURCES['windows-x64'].url }).length, 1)
  assert.equal(fixture.publications.find(function (item) { return item.key === key }).reused, true)
})

test('unchanged upstream fingerprints and intact COS objects skip large downloads', async function () {
  const fixture = createFixture()
  await fixture.run()
  const downloadCount = fixture.downloads.length
  const pointerCount = fixture.pointers.length
  const directoryCount = fixture.directories.length
  const result = await fixture.run()
  assert.equal(result.changed, false)
  assert.equal(fixture.downloads.length, downloadCount)
  assert.equal(fixture.pointers.length, pointerCount)
  assert.equal(fixture.directories.length, directoryCount)
})

test('checks a changed ETag even when official Windows version is unchanged', async function () {
  const fixture = createFixture()
  await fixture.run()
  fixture.resources.get(SOURCES['windows-x64'].url).etag = '"new-etag"'
  const downloadCount = fixture.downloads.length
  const result = await fixture.run()
  assert.equal(result.changed, true)
  assert.equal(fixture.downloads.length, downloadCount + 2)
  assert.equal(result.manifest.platforms['windows-x64'].source.etag, '"new-etag"')
})

test('does not skip verification when a same-size COS object fingerprint changes', async function () {
  const fixture = createFixture()
  await fixture.run()
  const old = clone(fixture.latest)
  const artifact = old.platforms['windows-x64'].artifact
  fixture.objects.set(artifact.key, { ...fixture.objects.get(artifact.key), etag: '"changed-cos-object"', sha256: '0'.repeat(64) })
  const downloadCount = fixture.downloads.length
  await assert.rejects(fixture.run(), /checksum conflict/)
  assert.equal(fixture.downloads.length, downloadCount + 2)
  assert.deepEqual(fixture.latest, old)
})

test('refuses to record a COS fingerprint that changed after the verified full GET', async function () {
  const fixture = createFixture()
  const originalInspect = fixture.store.inspect
  fixture.store.inspect = async function (key) {
    const result = await originalInspect(key)
    if (result && fixture.publications.length) return { ...result, etag: '"different-after-public-get"' }
    return result
  }
  await assert.rejects(fixture.run(['windows-x64']), /已核验正文不一致/)
  assert.equal(fixture.latest, null)
  assert.equal(fixture.pointers.length, 0)
})

test('rejects Windows downgrade before downloading or publishing', async function () {
  const fixture = createFixture()
  await fixture.run()
  const old = clone(fixture.latest)
  fixture.metadata.buildVersion = '26.929.100.0'
  const downloadCount = fixture.downloads.length
  await assert.rejects(fixture.run(), (error) => {
    assert.match(error.message, /拒绝倒退/)
    assert.equal(safeOfficialSyncFailure(error).stage, 'source-windows-metadata')
    return true
  })
  assert.equal(fixture.downloads.length, downloadCount)
  assert.deepEqual(fixture.latest, old)
})

test('existing download URLs are validated before the latest-read stage reports success', async function () {
  const fixture = createFixture()
  await fixture.run()
  fixture.latest.platforms['windows-x64'].artifact.url += '?unexpected'
  const before = fixture.downloads.length
  await assert.rejects(fixture.run(), (error) => {
    assert.match(error.message, /下载地址与当前存储桶不一致/)
    assert.equal(safeOfficialSyncFailure(error).stage, 'cos-read-latest')
    return true
  })
  assert.equal(fixture.downloads.length, before)
})

test('rejects official metadata mismatch without remote writes', async function () {
  const fixture = createFixture()
  fixture.metadata.packageIdentity = 'Attacker.App'
  await assert.rejects(fixture.run(), /身份不匹配/)
  assert.equal(fixture.publications.length, 0)
  assert.equal(fixture.pointers.length, 0)
})

test('rejects signature failure in any architecture before publishing any package', async function () {
  const fixture = createFixture()
  fixture.badSignatureArchitecture = 'arm64'
  await assert.rejects(fixture.run(), /可信签名/)
  assert.equal(fixture.publications.length, 0)
  assert.equal(fixture.pointers.length, 0)
  assert.deepEqual(fixture.removed, fixture.directories)
})

test('rejects a valid unrelated signer despite matching package identity', function () {
  const fixture = createFixture()
  const report = { manifest: { name: 'OpenAI.Codex', version: fixture.metadata.buildVersion, architecture: 'x64', publisher: WINDOWS_PUBLISHER, containsPackageSignature: true }, signature: { status: 'Valid', signerSubject: 'CN=Attacker', signerIssuer: 'O=Microsoft Corporation' } }
  assert.throws(function () { validateWindowsInspection(report, fixture.metadata, 'x64') }, /可信签名/)
})

test('rejects HEAD and GET changes and checksum failures without switching the pointer', async function () {
  for (const failure of ['etag', 'bytes', 'sha256', 'transport']) {
    const fixture = createFixture()
    fixture.downloadOverride = function (_, result) { return { ...result, [failure]: failure === 'bytes' ? 63 : 'wrong' } }
    if (failure === 'transport') fixture.downloadError = true
    await assert.rejects(fixture.run(), /不一致|checksum/)
    assert.equal(fixture.pointers.length, 0)
    assert.equal(fixture.latest, null)
  }
})

test('preserves old latest pointer when immutable object conflicts or public upload verification fails', async function () {
  const fixture = createFixture()
  await fixture.run()
  const old = clone(fixture.latest)
  fixture.metadata.buildVersion = '26.931.1.0'
  fixture.publicationError = true
  await assert.rejects(fixture.run(), /COS verification/)
  assert.deepEqual(fixture.latest, old)
  assert.equal(fixture.pointers.length, 1)
  const conflict = createFixture()
  conflict.objects.set('chatgpt/windows-x64/26.930.2377.0/ChatGPT-x64.msix', { bytes: 64, sha256: '0'.repeat(64) })
  await assert.rejects(conflict.run(['windows-x64']), /checksum conflict/)
  assert.equal(conflict.latest, null)
})

test('rechecks latest state before publication and stops on concurrent pointer changes', async function () {
  const fixture = createFixture()
  await fixture.run()
  const old = clone(fixture.latest)
  fixture.metadata.buildVersion = '26.931.1.0'
  const concurrent = { ...clone(old), generatedAt: '2026-10-02T12:01:00.000Z' }
  const initialReadCount = fixture.reads
  fixture.readOverride = function (count) { return count === initialReadCount + 1 ? old : concurrent }
  await assert.rejects(fixture.run(), /同步期间发生变化/)
  assert.equal(fixture.pointers.length, 1)
})

test('does not retry or roll back an unconfirmed latest write', async function () {
  const fixture = createFixture()
  fixture.pointerError = true
  await assert.rejects(fixture.run(), /not confirmed/)
  assert.equal(fixture.reads, 2)
  assert.equal(fixture.latest, null)
  assert.equal(fixture.pointers.length, 0)
})

test('publishes all verified platforms with separate Mac versions and honest signature labels', async function () {
  const fixture = createFixture()
  const result = await fixture.run('all')
  assert.equal(Object.keys(result.manifest.platforms).length, 8)
  const mac = result.manifest.platforms['macos-x64']
  assert.equal(mac.buildVersion, '12776')
  assert.equal(mac.appVersion, '26.930.21537')
  assert.equal(mac.packageVersion, undefined)
  assert.equal(mac.format, 'zip')
  assert.match(mac.artifact.key, /^chatgpt\/macos-x64\/sha256-[a-f0-9]{64}\/ChatGPT-darwin-x64-26\.930\.21537\.zip$/)
  assert.equal(mac.artifact.verification, 'official-https-sha256')
  assert.equal(result.manifest.platforms['linux-deb-arm64'].artifact.verification, 'official-https-sha256')
  const before = fixture.downloads.length
  assert.equal((await fixture.run('all')).changed, false)
  assert.equal(fixture.downloads.length, before)
})

test('detects package formats without executing packages', async function () {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'official-magic-test-'))
  try {
    for (const [format, buffer] of [['zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])], ['deb', Buffer.from('!<arch>\n')], ['rpm', Buffer.from([0xed, 0xab, 0xee, 0xdb, 0, 0, 0, 0])]]) {
      const filePath = path.join(directory, format)
      await fs.writeFile(filePath, buffer)
      await validatePackageMagic(filePath, format, buffer.length)
    }
    const filePath = path.join(directory, 'invalid.deb')
    await fs.writeFile(filePath, 'HTML err')
    await assert.rejects(validatePackageMagic(filePath, 'deb', 8), /格式无效/)
  } finally { await fs.rm(directory, { recursive: true, force: true }) }
})

test('Windows inspection has bounded XML readers and excludes COS secrets from subprocesses', function () {
  const env = sanitizedWindowsEnvironment('C:\\private-temp')
  assert.equal(env.SystemRoot, 'C:\\Windows')
  assert.equal(env.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules')
  assert.equal(env.COS_SECRET_ID, undefined)
  assert.equal(env.COS_SECRET_KEY, undefined)
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.match(WINDOWS_INSPECTION_SCRIPT, /DtdProcessing = \[Xml\.DtdProcessing\]::Prohibit/)
  assert.match(WINDOWS_INSPECTION_SCRIPT, /Get-AuthenticodeSignature -LiteralPath \$PackagePath/)
  assert.doesNotMatch(WINDOWS_INSPECTION_SCRIPT, /Add-AppxPackage|Add-AppxProvisionedPackage/)
})
