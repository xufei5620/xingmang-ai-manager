const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const fc = require('fast-check')
const { checkFailure, safeSyncFailure } = require('./cos-sync-utils.cjs')
const {
  FEED_ORIGIN, PREFIX, MIN_ARTIFACT_BYTES, PLATFORMS, FAMILIES,
  compareVersions, familyForRunner, feedUrl, sourceUrl, artifactKey, parseFeed, validateIndex, validateWindowsSignature, darwinAntigravityDesktopRequirement,
  assertPeImage, inspectWindowsSignature, inspectMacArchive, synchronizeAntigravityDesktop, safeAntigravityDesktopSyncFailure,
} = require('./sync-antigravity-desktop-cos.cjs')
const { WINDOWS_SIGNER } = require('./sync-antigravity-cli-cos.cjs')

// What the 11-23 probe read on GitHub runners: the 2.34.0 installers carry the same Google LLC
// certificate as agy.exe. Nothing in this file reaches Google or the bucket.
const GOOGLE_SUBJECT = 'CN=Google LLC, O=Google LLC, L=Mountain View, S=California, C=US, SERIALNUMBER=4638227, OID.2.5.4.15=Private Organization, OID.1.3.6.1.4.1.311.60.2.1.2=Delaware, OID.1.3.6.1.4.1.311.60.2.1.3=US'
const DIGICERT_ISSUER = 'CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1, O="DigiCert, Inc.", C=US'
const BUILD = '5887025308631040'
const HUB = `https://storage.googleapis.com/antigravity-public/antigravity-hub/2.34.0-${BUILD}`

function digest(algorithm, value, encoding = 'hex') {
  return createHash(algorithm).update(value).digest(encoding)
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function artifactBody(url) {
  return `${url}#body`
}

function artifactBytes(url) {
  return MIN_ARTIFACT_BYTES + 100 * 1024 * 1024 + artifactBody(url).length
}

/** A feed in the exact shape electron-updater writes (the 2.34.0 ones, with this test's digests). */
function feedFor(platformId, version, build = BUILD, overrides = {}) {
  const url = overrides.url ?? sourceUrl(platformId, version, build)
  const sha512 = overrides.sha512 ?? digest('sha512', artifactBody(url), 'base64')
  const lines = [`version: ${version}`, 'files:', `  - url: ${url}`, `    sha512: ${sha512}`, `    size: ${overrides.size ?? artifactBytes(url)}`]
  if (overrides.path !== null) lines.push(`path: ${overrides.path ?? PLATFORMS[platformId].sourceFileName}`)
  if (overrides.topSha512 !== null) lines.push(`sha512: ${overrides.topSha512 ?? sha512}`)
  lines.push("releaseDate: '2026-11-20T18:04:11.000Z'")
  return `${lines.join('\n')}\n`
}

function createFixture(family = 'windows') {
  const fixture = {
    family,
    versions: Object.fromEntries(FAMILIES[family].platformIds.map((id) => [id, '2.34.0'])),
    feedOverride: new Map(),
    signature: { status: 'Valid', subject: GOOGLE_SUBJECT, issuer: DIGICERT_ISSUER },
    peFailure: null,
    macFailure: null,
    corruptDownload: false,
    latest: null,
    objects: new Map(),
    publications: [],
    pointers: [],
    downloads: [],
    feedRequests: [],
    macInspections: [],
    peChecks: [],
    removedFiles: [],
    removed: [],
    reads: 0,
  }
  fixture.dependencies = {
    async fetchText(input) {
      fixture.feedRequests.push(clone(input))
      const platformId = Object.keys(PLATFORMS).find((id) => feedUrl(id) === input.url)
      assert.ok(platformId, `unexpected feed request ${input.url}`)
      if (fixture.feedOverride.has(platformId)) return fixture.feedOverride.get(platformId)
      return feedFor(platformId, fixture.versions[platformId])
    },
    async downloadResource(input) {
      fixture.downloads.push(clone({ ...input, onProgress: undefined }))
      const body = fixture.corruptDownload ? `${artifactBody(input.url)}!` : artifactBody(input.url)
      return { bytes: artifactBytes(input.url), sha256: digest('sha256', body), sha512: digest('sha512', body, 'base64'), etag: '"source"' }
    },
    async assertPeImage(filePath) {
      fixture.peChecks.push(path.basename(filePath))
      if (fixture.peFailure) throw fixture.peFailure
    },
    async inspectWindowsSignature() { return clone(fixture.signature) },
    async inspectMacArchive(filePath, workDirectory, expected) {
      fixture.macInspections.push([path.basename(filePath), expected.machine, expected.version])
      if (fixture.macFailure) throw fixture.macFailure
    },
    async removeFile(filePath) { fixture.removedFiles.push(filePath) },
    async createWorkDirectory() { return path.resolve(os.tmpdir(), 'mock-antigravity-desktop-cos') },
    async removeWorkDirectory(directory) { fixture.removed.push(directory) },
  }
  fixture.store = {
    async readJson(key) {
      assert.equal(key, FAMILIES[family].indexKey)
      fixture.reads += 1
      return clone(fixture.readOverride ? fixture.readOverride(fixture.reads) : fixture.latest)
    },
    async inspect(key) { return clone(fixture.objects.get(key) || null) },
    publicUrl(key) { return `https://mock-bucket.cos.ap-shanghai.myqcloud.com/${key}` },
    async publishFile(key, filePath, input) {
      fixture.publications.push({ key, filePath, ...input, onProgress: undefined })
      const existing = fixture.objects.get(key)
      if (existing && existing.sha256 !== input.expectedSha256) throw new Error('Mock immutable object conflict')
      const result = { key, bytes: input.expectedBytes, sha256: input.expectedSha256, contentType: input.contentType, etag: existing?.etag || `"cos-${input.expectedSha256.slice(0, 16)}"` }
      fixture.objects.set(key, result)
      return result
    },
    async publishJson(key, value, input) {
      assert.equal(key, FAMILIES[family].indexKey)
      assert.equal(input.overwrite, true)
      assert.match(input.cacheControl, /no-cache/)
      fixture.pointers.push(clone(value))
      fixture.latest = clone(value)
      return { key }
    },
  }
  fixture.run = function (extra = {}) {
    return synchronizeAntigravityDesktop({ store: fixture.store, dependencies: fixture.dependencies, family, now: function () { return '2026-11-24T16:00:00.000Z' }, ...extra })
  }
  return fixture
}

function failureOf(error) {
  return safeAntigravityDesktopSyncFailure(error)
}

test('the desktop sync pins the same Windows signer as agy and the client', () => {
  // The client checks the installer with trusted-native-cli.ts's antigravity entry, whose copy
  // sync-antigravity-cli-cos.test.cjs already compares with WINDOWS_SIGNER.
  validateWindowsSignature({ status: 'Valid', subject: GOOGLE_SUBJECT, issuer: DIGICERT_ISSUER })
  assert.ok(WINDOWS_SIGNER.subject.length >= 5)
  assert.ok(WINDOWS_SIGNER.issuer.length >= 2)
})

test('each runner syncs only its own system\'s half', () => {
  assert.equal(familyForRunner('win32'), 'windows')
  assert.equal(familyForRunner('darwin'), 'macos')
  for (const platform of ['linux', 'freebsd', 'aix']) assert.throws(() => familyForRunner(platform))
  assert.deepEqual(FAMILIES.windows.platformIds, ['windows-x64', 'windows-arm64'])
  assert.deepEqual(FAMILIES.macos.platformIds, ['macos-arm64', 'macos-x64'])
  assert.equal(FAMILIES.windows.indexKey, 'xingmang/offline/antigravity-desktop/windows.json')
  assert.equal(FAMILIES.macos.indexKey, 'xingmang/offline/antigravity-desktop/macos.json')
})

test('feeds, sources and objects are built from the constants, the version and the digest only', () => {
  assert.equal(feedUrl('windows-x64'), `${FEED_ORIGIN}/manifest/latest-x64-win.yml`)
  assert.equal(feedUrl('windows-arm64'), `${FEED_ORIGIN}/manifest/latest-arm64-win.yml`)
  assert.equal(feedUrl('macos-arm64'), `${FEED_ORIGIN}/manifest/latest-arm64-mac.yml`)
  assert.equal(feedUrl('macos-x64'), `${FEED_ORIGIN}/manifest/latest-x64-mac.yml`)
  // The URLs the 11-23 probe read from Google's 2.34.0 feeds.
  assert.equal(sourceUrl('windows-x64', '2.34.0', BUILD), `${HUB}/windows-x64/Antigravity-x64.exe`)
  assert.equal(sourceUrl('windows-arm64', '2.34.0', BUILD), `${HUB}/windows-arm/Antigravity-arm64.exe`)
  assert.equal(sourceUrl('macos-x64', '2.34.0', BUILD), `${HUB}/darwin-x64/Antigravity.zip`)
  assert.equal(sourceUrl('macos-arm64', '2.34.0', BUILD), `${HUB}/darwin-arm/Antigravity.zip`)
  for (const [version, build] of [['2.34', BUILD], ['2.34.0', '0'], ['2.34.0', '../x'], ['02.34.0', BUILD]]) assert.throws(() => sourceUrl('windows-x64', version, build))
  const sha = 'a'.repeat(64)
  assert.equal(artifactKey('windows-arm64', sha), `${PREFIX}/windows-arm64/sha256-${sha}/Antigravity-arm64.exe`)
  assert.equal(artifactKey('macos-x64', sha), `${PREFIX}/macos-x64/sha256-${sha}/Antigravity-darwin-x64.zip`)
  assert.equal(artifactKey('macos-arm64', sha), `${PREFIX}/macos-arm64/sha256-${sha}/Antigravity-darwin-arm64.zip`)
})

test('a feed is accepted only in the fixed shape and with the URL built from its own version and build', () => {
  const url = sourceUrl('windows-x64', '2.34.0', BUILD)
  const sha512 = digest('sha512', artifactBody(url))
  assert.deepEqual(parseFeed(feedFor('windows-x64', '2.34.0'), 'windows-x64'), { version: '2.34.0', build: BUILD, url, bytes: artifactBytes(url), sha512 })
  // Without the legacy top-level path and sha512, and with a byte order mark and CRLF.
  assert.equal(parseFeed(`﻿${feedFor('windows-x64', '2.34.0', BUILD, { path: null, topSha512: null }).replace(/\n/g, '\r\n')}`, 'windows-x64').build, BUILD)
  const otherSha = digest('sha512', 'other', 'base64')
  const refused = [
    ['empty', ''],
    ['too large', `${feedFor('windows-x64', '2.34.0')}${'#'.repeat(16 * 1024)}`],
    ['another host', feedFor('windows-x64', '2.34.0', BUILD, { url: url.replace('storage.googleapis.com', 'storage.googleapis.com.evil.invalid') })],
    ['a query', feedFor('windows-x64', '2.34.0', BUILD, { url: `${url}?x=1` })],
    ['the other chip', feedFor('windows-x64', '2.34.0', BUILD, { url: url.replace('windows-x64/Antigravity-x64.exe', 'windows-arm/Antigravity-arm64.exe') })],
    ['another version folder', feedFor('windows-x64', '2.34.0', BUILD, { url: url.replace(`2.34.0-${BUILD}`, `2.33.0-${BUILD}`) })],
    ['a traversal', feedFor('windows-x64', '2.34.0', BUILD, { url: url.replace(`-${BUILD}/`, `-${BUILD}/../${BUILD}/`) })],
    ['a bad version', feedFor('windows-x64', '2.34', BUILD, { url: `${HUB.replace('2.34.0', '2.34')}/windows-x64/Antigravity-x64.exe` })],
    ['a short digest', feedFor('windows-x64', '2.34.0', BUILD, { sha512: 'abc' })],
    ['a disagreeing top-level digest', feedFor('windows-x64', '2.34.0', BUILD, { topSha512: otherSha })],
    ['another top-level path', feedFor('windows-x64', '2.34.0', BUILD, { path: 'Antigravity-arm64.exe' })],
    ['a size below the floor', feedFor('windows-x64', '2.34.0', BUILD, { size: 1024 })],
    ['a size above the ceiling', feedFor('windows-x64', '2.34.0', BUILD, { size: 2 * 1024 * 1024 * 1024 })],
    ['a second file', feedFor('windows-x64', '2.34.0').replace('path:', `  - url: ${url}\n    sha512: ${otherSha}\n    size: 20000000\npath:`)],
    ['a repeated key', `version: 2.34.0\n${feedFor('windows-x64', '2.34.0')}`],
    ['a nested value', feedFor('windows-x64', '2.34.0').replace("releaseDate: '2026-11-20T18:04:11.000Z'", 'extra:\n  nested: 1')],
  ]
  for (const [label, text] of refused) assert.throws(() => parseFeed(text, 'windows-x64'), label)
  // The other chip's feed is never accepted for this one.
  assert.throws(() => parseFeed(feedFor('windows-arm64', '2.34.0'), 'windows-x64'))
  assert.throws(() => parseFeed(feedFor('macos-arm64', '2.34.0'), 'macos-x64'))
})

test('only Google\'s certificate from DigiCert\'s code signing CA passes on Windows', () => {
  const cases = [
    [{ status: 'NotSigned', subject: null, issuer: null }, 'package-signature-invalid'],
    [{ status: 'HashMismatch', subject: GOOGLE_SUBJECT, issuer: DIGICERT_ISSUER }, 'package-signature-invalid'],
    [{ status: 'Valid', subject: GOOGLE_SUBJECT.replace('O=Google LLC', 'O=Google LLC Evil'), issuer: DIGICERT_ISSUER }, 'package-signer-mismatch'],
    [{ status: 'Valid', subject: 'CN=X, OU=Google LLC', issuer: DIGICERT_ISSUER }, 'package-signer-mismatch'],
    [{ status: 'Valid', subject: GOOGLE_SUBJECT, issuer: 'CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1, O=Someone Else' }, 'package-signer-mismatch'],
    [{ status: 'Valid', subject: GOOGLE_SUBJECT, issuer: null }, 'package-signer-mismatch'],
  ]
  for (const [signature, code] of cases) {
    assert.throws(() => validateWindowsSignature(signature), (error) => {
      assert.equal(safeSyncFailure(error).code, code)
      return true
    }, JSON.stringify(signature))
  }
})

test('the first Windows run uploads both installers, checks each before upload and writes the index last', async () => {
  const fixture = createFixture('windows')
  const result = await fixture.run()
  assert.equal(result.changed, true)
  assert.deepEqual(fixture.feedRequests.map((request) => [request.url, request.allowedHosts, request.maxBytes]), [
    [feedUrl('windows-x64'), [new URL(FEED_ORIGIN).hostname], 16 * 1024],
    [feedUrl('windows-arm64'), [new URL(FEED_ORIGIN).hostname], 16 * 1024],
  ])
  assert.deepEqual(fixture.downloads.map((download) => [download.url, download.allowedHosts, download.maxBytes === download.expectedBytes]), [
    [sourceUrl('windows-x64', '2.34.0', BUILD), ['storage.googleapis.com'], true],
    [sourceUrl('windows-arm64', '2.34.0', BUILD), ['storage.googleapis.com'], true],
  ])
  assert.equal(fixture.downloads[0].expectedBytes, artifactBytes(sourceUrl('windows-x64', '2.34.0', BUILD)))
  assert.deepEqual(fixture.peChecks, ['windows-x64-Antigravity-x64.exe', 'windows-arm64-Antigravity-arm64.exe'])
  assert.equal(fixture.publications.length, 2)
  for (const publication of fixture.publications) {
    assert.equal(publication.contentType, 'application/octet-stream')
    assert.match(publication.cacheControl, /immutable/)
  }
  assert.equal(fixture.pointers.length, 1)
  const index = fixture.latest
  assert.deepEqual(Object.keys(index), ['schemaVersion', 'product', 'family', 'generatedAt', 'checkedAt', 'version', 'build', 'files'])
  assert.equal(index.product, 'antigravity-desktop')
  assert.equal(index.family, 'windows')
  assert.equal(index.version, '2.34.0')
  assert.equal(index.build, BUILD)
  const url = sourceUrl('windows-x64', '2.34.0', BUILD)
  const sha256 = digest('sha256', artifactBody(url))
  const key = artifactKey('windows-x64', sha256)
  assert.deepEqual(index.files[0], {
    platformId: 'windows-x64', platform: 'windows', architecture: 'x64', kind: 'installer', format: 'exe', fileName: 'Antigravity-x64.exe',
    type: 'application/octet-stream', verification: 'windows-authenticode-google', version: '2.34.0', key, url: fixture.store.publicUrl(key),
    size: artifactBytes(url), sha256, sha512: digest('sha512', artifactBody(url)), sourceUrl: url, cosEtag: `"cos-${sha256.slice(0, 16)}"`,
  })
  assert.equal(validateIndex(index, 'windows', fixture.store.publicUrl), index)
  assert.equal(fixture.removedFiles.length, 2)
  assert.equal(fixture.removed.length, 1)
})

test('the Mac half checks each zip on its own chip and version and writes its own index', async () => {
  const fixture = createFixture('macos')
  await fixture.run()
  assert.deepEqual(fixture.macInspections, [['macos-arm64-Antigravity.zip', 'arm64', '2.34.0'], ['macos-x64-Antigravity.zip', 'x86_64', '2.34.0']])
  assert.deepEqual(fixture.peChecks, [])
  assert.equal(fixture.latest.family, 'macos')
  assert.deepEqual(fixture.latest.files.map((file) => [file.platformId, file.kind, file.format, file.fileName, file.type, file.verification]), [
    ['macos-arm64', 'app-archive', 'zip', 'Antigravity-darwin-arm64.zip', 'application/zip', 'macos-developer-id-notarized'],
    ['macos-x64', 'app-archive', 'zip', 'Antigravity-darwin-x64.zip', 'application/zip', 'macos-developer-id-notarized'],
  ])
  // A Mac index is never valid as the Windows one.
  assert.throws(() => validateIndex({ ...fixture.latest, family: 'windows' }, 'windows', fixture.store.publicUrl))

  const refused = createFixture('macos')
  refused.macFailure = checkFailure('package-signature-invalid', 'not Google')
  await assert.rejects(refused.run(), (error) => {
    assert.deepEqual(failureOf(error), {
      stage: 'verify-artifact', version: '2.34.0', platformId: 'macos-arm64', expectedBytes: artifactBytes(sourceUrl('macos-arm64', '2.34.0', BUILD)),
      latestState: 'not-written-by-this-run', failure: { code: 'package-signature-invalid' },
    })
    return true
  })
  assert.equal(refused.publications.length, 0)
  assert.equal(refused.pointers.length, 0)
})

test('an unchanged version with intact objects means no download and only a fresh checkedAt', async () => {
  const fixture = createFixture()
  await fixture.run()
  const before = clone(fixture.latest)
  const result = await fixture.run({ now: () => '2026-11-24T22:00:00.000Z' })
  assert.equal(result.changed, false)
  assert.equal(fixture.downloads.length, 2)
  assert.equal(fixture.publications.length, 2)
  assert.equal(fixture.pointers.length, 2)
  assert.deepEqual(fixture.latest, { ...before, checkedAt: '2026-11-24T22:00:00.000Z' })
})

test('a damaged object in the bucket is uploaded again', async () => {
  const fixture = createFixture()
  await fixture.run()
  const damaged = fixture.latest.files[1].key
  fixture.objects.set(damaged, { ...fixture.objects.get(damaged), etag: '"changed"' })
  await fixture.run()
  assert.deepEqual(fixture.downloads.slice(2).map((download) => download.url), [sourceUrl('windows-arm64', '2.34.0', BUILD)])
})

test('a new version or a rebuilt one replaces the index entry', async () => {
  const fixture = createFixture()
  await fixture.run()
  for (const id of FAMILIES.windows.platformIds) fixture.versions[id] = '2.35.1'
  await fixture.run()
  assert.equal(fixture.latest.version, '2.35.1')
  assert.deepEqual(fixture.latest.files.map((file) => file.sourceUrl), FAMILIES.windows.platformIds.map((id) => sourceUrl(id, '2.35.1', BUILD)))
  assert.equal(fixture.downloads.length, 4)
  // Same version, new build number: Google rebuilt it, so the new files go up.
  const rebuilt = '5887025308631041'
  for (const id of FAMILIES.windows.platformIds) fixture.feedOverride.set(id, feedFor(id, '2.35.1', rebuilt))
  await fixture.run()
  assert.equal(fixture.latest.build, rebuilt)
  assert.equal(fixture.downloads.length, 6)
  assert.ok(compareVersions('2.10.0', '2.9.9') > 0)
})

test('Google going back a version publishes nothing', async () => {
  const fixture = createFixture()
  for (const id of FAMILIES.windows.platformIds) fixture.versions[id] = '2.35.0'
  await fixture.run()
  for (const id of FAMILIES.windows.platformIds) fixture.versions[id] = '2.34.0'
  await assert.rejects(fixture.run(), (error) => {
    assert.deepEqual(failureOf(error), { stage: 'source-compare', latestState: 'not-written-by-this-run', failure: { code: 'version-regressed' } })
    return true
  })
  assert.equal(fixture.pointers.length, 1)
  assert.equal(fixture.downloads.length, 2)
})

test('the two chips naming different versions publishes nothing this round', async () => {
  const fixture = createFixture()
  fixture.versions['windows-arm64'] = '2.35.0'
  await assert.rejects(fixture.run(), (error) => {
    assert.deepEqual(failureOf(error), { stage: 'source-compare', latestState: 'not-written-by-this-run', failure: { code: 'source-changed' } })
    return true
  })
  assert.equal(fixture.downloads.length, 0)
  assert.equal(fixture.pointers.length, 0)
})

test('a download that does not match Google\'s SHA-512 is never uploaded', async () => {
  const fixture = createFixture()
  fixture.corruptDownload = true
  await assert.rejects(fixture.run(), (error) => {
    assert.equal(failureOf(error).stage, 'source-download')
    assert.equal(failureOf(error).failure.code, 'download-mismatch')
    return true
  })
  assert.equal(fixture.publications.length, 0)
  assert.equal(fixture.pointers.length, 0)
  assert.ok(fixture.removedFiles.length >= 1)
})

test('an installer that is not a PE image or carries another signer is never uploaded', async () => {
  const notPe = createFixture()
  notPe.peFailure = checkFailure('package-format-invalid', 'not PE')
  await assert.rejects(notPe.run(), (error) => {
    assert.equal(failureOf(error).failure.code, 'package-format-invalid')
    return true
  })
  assert.equal(notPe.publications.length, 0)

  const otherSigner = createFixture()
  otherSigner.signature = { status: 'Valid', subject: 'CN=Someone, O=Someone', issuer: DIGICERT_ISSUER }
  await assert.rejects(otherSigner.run(), (error) => {
    const failure = failureOf(error).failure
    assert.equal(failure.code, 'package-signer-mismatch')
    assert.equal(failure.observed.signerSubject, 'CN=Someone, O=Someone')
    return true
  })
  assert.equal(otherSigner.publications.length, 0)
  assert.equal(otherSigner.pointers.length, 0)
})

test('an index that changed while the run was uploading is left as it is', async () => {
  const fixture = createFixture()
  fixture.readOverride = (read) => (read === 1 ? null : { schemaVersion: 1 })
  await assert.rejects(fixture.run(), (error) => {
    assert.equal(failureOf(error).stage, 'cos-recheck-latest')
    return true
  })
  assert.equal(fixture.pointers.length, 0)
})

test('a broken existing index stops the run before anything is downloaded', async () => {
  const good = createFixture()
  await good.run()
  const valid = good.latest
  const broken = [
    { schemaVersion: 2 },
    { ...valid, product: 'antigravity-cli' },
    { ...valid, files: [] },
    { ...valid, files: [valid.files[0], valid.files[0]] },
    { ...valid, files: [{ ...valid.files[0], key: `${PREFIX}/windows-x64/sha256-${'b'.repeat(64)}/Antigravity-x64.exe` }, valid.files[1]] },
    { ...valid, files: [{ ...valid.files[0], version: '2.33.0' }, valid.files[1]] },
    { ...valid, files: [{ ...valid.files[0], cosEtag: '' }, valid.files[1]] },
  ]
  for (const index of broken) {
    const fixture = createFixture()
    fixture.latest = index
    await assert.rejects(fixture.run(), (error) => {
      assert.deepEqual(failureOf(error), { stage: 'cos-read-latest', family: 'windows', latestState: 'not-written-by-this-run', failure: { code: 'cos-index-invalid' } })
      return true
    }, JSON.stringify(index).slice(0, 80))
    assert.equal(fixture.downloads.length, 0)
  }
})

test('progress events carry no URL or exception text', async () => {
  const fixture = createFixture()
  fixture.dependencies.downloadResource = async () => { throw new Error('HTTP 403 SECRET https://signed.example/?token=1') }
  const events = []
  await assert.rejects(fixture.run({ progress: (event) => events.push(event) }))
  assert.doesNotMatch(JSON.stringify(events), /SECRET|https:|token/)
})

test('the Windows signature check runs only on Windows and the Mac one only on a Mac', async () => {
  await assert.rejects(inspectWindowsSignature('a.exe', os.tmpdir(), async () => assert.fail('must not run'), 'linux'), (error) => {
    assert.equal(safeSyncFailure(error).code, 'inspector-unavailable')
    return true
  })
  await assert.rejects(inspectMacArchive('a.zip', os.tmpdir(), { machine: 'arm64', version: '2.34.0' }, async () => assert.fail('must not run'), 'win32'), (error) => {
    assert.equal(safeSyncFailure(error).code, 'inspector-unavailable')
    return true
  })
})

async function workDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'antigravity-desktop-inspect-'))
}

// A stand-in for tar, plutil, codesign, spctl and lipo: tar "unpacks" what the test says, the others answer as told.
function fakeMacTools(unpack, answers = {}) {
  const calls = []
  async function run(executable, args) {
    calls.push([executable, args])
    if (executable === '/usr/bin/tar') {
      await unpack(args[args.indexOf('-C') + 1])
      return { stdout: '' }
    }
    if (executable === '/usr/bin/plutil') {
      return { stdout: JSON.stringify({ CFBundleIdentifier: 'com.google.antigravity', CFBundleShortVersionString: '2.34.0', CFBundleExecutable: 'Electron', ...answers.info }) }
    }
    if (executable === '/usr/bin/codesign') {
      if (answers.codesign === false) throw Object.assign(new Error('codesign SECRET'), { code: 3 })
      return { stdout: '' }
    }
    if (executable === '/usr/sbin/spctl') {
      if (answers.spctl === false) throw Object.assign(new Error('rejected'), { code: 3 })
      return { stdout: '' }
    }
    if (executable === '/usr/bin/lipo') return { stdout: `${answers.archs || 'arm64'}\n` }
    throw new Error(`unexpected ${executable}`)
  }
  return { run, calls }
}

function application(directory) {
  return fs.mkdir(path.join(directory, 'Antigravity.app', 'Contents', 'MacOS'), { recursive: true })
}

test('a Mac zip passes only as exactly Antigravity.app of this version, signed by Google, notarized and on the right chip', async () => {
  const directory = await workDirectory()
  const expected = { machine: 'arm64', version: '2.34.0' }
  try {
    const good = fakeMacTools(application)
    await inspectMacArchive('/tmp/Antigravity.zip', directory, expected, good.run, 'darwin')
    assert.deepEqual(good.calls.map(([executable]) => executable), ['/usr/bin/tar', '/usr/bin/plutil', '/usr/bin/codesign', '/usr/sbin/spctl', '/usr/bin/lipo'])
    assert.deepEqual(good.calls[0][1].slice(0, 2), ['-xf', '/tmp/Antigravity.zip'])
    const codesignArgs = good.calls[2][1]
    assert.deepEqual(codesignArgs.slice(0, 3), ['--verify', '--strict', '--deep'])
    assert.equal(codesignArgs[3], `-R=${darwinAntigravityDesktopRequirement()}`)
    assert.equal(darwinAntigravityDesktopRequirement(), 'identifier "com.google.antigravity" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "EQHXZ8M8AV"')
    assert.deepEqual(good.calls[3][1], ['--assess', '--type', 'execute', path.join(directory, 'extract-arm64', 'Antigravity.app')])
    assert.equal(good.calls[4][1][1], path.join(directory, 'extract-arm64', 'Antigravity.app', 'Contents', 'MacOS', 'Electron'))
    // The unpacked copy is removed whatever happens.
    assert.deepEqual(await fs.readdir(directory), [])

    const cases = [
      [fakeMacTools((target) => Promise.all([application(target), fs.writeFile(path.join(target, 'extra'), 'x')])), 'package-format-invalid'],
      [fakeMacTools((target) => fs.mkdir(path.join(target, 'Other.app'))), 'package-format-invalid'],
      [fakeMacTools((target) => fs.writeFile(path.join(target, 'Antigravity.app'), 'x')), 'package-format-invalid'],
      [fakeMacTools((target) => fs.symlink('/Applications', path.join(target, 'Antigravity.app'))), 'package-format-invalid'],
      [fakeMacTools(application, { info: { CFBundleIdentifier: 'com.example.antigravity' } }), 'package-identity-mismatch'],
      [fakeMacTools(application, { info: { CFBundleShortVersionString: '2.33.0' } }), 'package-identity-mismatch'],
      [fakeMacTools(application, { info: { CFBundleExecutable: '../../bin/sh' } }), 'package-identity-mismatch'],
      [fakeMacTools(application, { codesign: false }), 'package-signature-invalid'],
      [fakeMacTools(application, { spctl: false }), 'package-signature-invalid'],
      [fakeMacTools(application, { archs: 'x86_64' }), 'package-identity-mismatch'],
    ]
    for (const [tools, code] of cases) {
      await assert.rejects(inspectMacArchive('/tmp/Antigravity.zip', directory, expected, tools.run, 'darwin'), (error) => {
        assert.equal(safeSyncFailure(error).code, code)
        return true
      })
      assert.deepEqual(await fs.readdir(directory), [])
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('the PE header is read without running the file', async () => {
  const directory = await workDirectory()
  try {
    const file = path.join(directory, 'Antigravity-x64.exe')
    const image = Buffer.alloc(256)
    image.writeUInt16LE(0x5a4d, 0)
    image.writeUInt32LE(0x80, 0x3c)
    image.writeUInt32LE(0x00004550, 0x80)
    // An NSIS stub is 32-bit x86 whatever it installs; the machine is deliberately not checked.
    image.writeUInt16LE(0x014c, 0x84)
    await fs.writeFile(file, image)
    await assertPeImage(file)
    await fs.writeFile(file, Buffer.from('#!/bin/sh\n'.padEnd(128, ' ')))
    await assert.rejects(assertPeImage(file), (error) => safeSyncFailure(error).code === 'package-format-invalid')
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('sync-antigravity-desktop-cos with random inputs never accepts a feed URL outside Google\'s folder for that version', () => {
  const version = fc.tuple(fc.nat(30), fc.nat(30), fc.nat(99)).map(([a, b, c]) => `${a}.${b}.${c}`)
  fc.assert(fc.property(version, fc.string({ maxLength: 160 }), fc.constantFrom(...Object.keys(PLATFORMS)), (value, url, platformId) => {
    const text = `version: ${value}\nfiles:\n  - url: ${url}\n    sha512: ${'b'.repeat(86)}==\n    size: 200000000\n`
    let parsed
    try {
      parsed = parseFeed(text, platformId)
    } catch {
      return
    }
    assert.equal(parsed.url, sourceUrl(platformId, value, parsed.build))
  }))
})
