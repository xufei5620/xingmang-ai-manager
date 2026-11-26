const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const fc = require('fast-check')
const {
  MANIFEST_ORIGIN, PREFIX, MIN_ARTIFACT_BYTES, MAX_RELEASES, PLATFORMS, FAMILIES,
  compareVersions, familyForRunner, manifestUrl, sourceUrl, artifactKey, parseManifest, validateIndex, validateWindowsSignature, darwinAntigravityRequirement,
  readPeMachine, inspectWindowsSignature, inspectMacArchive, synchronizeAntigravityCli, safeAntigravitySyncFailure,
} = require('./sync-antigravity-cli-cos.cjs')

// What the 11-23 probe read from agy.exe 1.5.15 on a Windows runner.
const GOOGLE_SUBJECT = 'CN=Google LLC, O=Google LLC, L=Mountain View, S=California, C=US, SERIALNUMBER=4638227, OID.2.5.4.15=Private Organization, OID.1.3.6.1.4.1.311.60.2.1.2=Delaware, OID.1.3.6.1.4.1.311.60.2.1.3=US'
const DIGICERT_ISSUER = 'CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1, O="DigiCert, Inc.", C=US'
const BUILD = '5887025308631040'
const MACHINES = { 'cli_windows_x64.exe': 0x8664, 'cli_windows_arm64.exe': 0xaa64 }

function digest(algorithm, value, encoding = 'hex') {
  return createHash(algorithm).update(value).digest(encoding)
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function artifactBody(url) {
  return `${url}#body`
}

function manifestFor(platformId, version, build = BUILD) {
  const url = sourceUrl(platformId, version, build)
  return { version, url, sha512: digest('sha512', artifactBody(url)) }
}

function createFixture(family = 'windows') {
  const fixture = {
    family,
    versions: Object.fromEntries(FAMILIES[family].platformIds.map((id) => [id, '1.5.15'])),
    manifestOverride: new Map(),
    signature: { status: 'Valid', subject: GOOGLE_SUBJECT, issuer: DIGICERT_ISSUER },
    machineOverride: null,
    macFailure: null,
    corruptDownload: false,
    latest: null,
    objects: new Map(),
    publications: [],
    pointers: [],
    downloads: [],
    manifestRequests: [],
    macInspections: [],
    removedFiles: [],
    removed: [],
    reads: 0,
  }
  fixture.dependencies = {
    async fetchText(input) {
      fixture.manifestRequests.push(clone(input))
      const platformId = Object.keys(PLATFORMS).find((id) => manifestUrl(id) === input.url)
      assert.ok(platformId, `unexpected manifest request ${input.url}`)
      if (fixture.manifestOverride.has(platformId)) return fixture.manifestOverride.get(platformId)
      return JSON.stringify(manifestFor(platformId, fixture.versions[platformId]))
    },
    async downloadResource(input) {
      fixture.downloads.push(clone({ ...input, onProgress: undefined }))
      const body = fixture.corruptDownload ? `${artifactBody(input.url)}!` : artifactBody(input.url)
      return { bytes: MIN_ARTIFACT_BYTES + 60 * 1024 * 1024 + body.length, sha256: digest('sha256', body), sha512: digest('sha512', body, 'base64'), etag: '"source"' }
    },
    async readPeMachine(filePath) {
      if (fixture.machineOverride !== null) return fixture.machineOverride
      return MACHINES[path.basename(filePath)]
    },
    async inspectWindowsSignature() { return clone(fixture.signature) },
    async inspectMacArchive(filePath, workDirectory, machine) {
      fixture.macInspections.push([path.basename(filePath), machine])
      if (fixture.macFailure) throw fixture.macFailure
    },
    async removeFile(filePath) { fixture.removedFiles.push(filePath) },
    async createWorkDirectory() { return path.resolve(os.tmpdir(), 'mock-antigravity-cli-cos') },
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
    return synchronizeAntigravityCli({ store: fixture.store, dependencies: fixture.dependencies, family, now: function () { return '2026-11-23T16:00:00.000Z' }, ...extra })
  }
  return fixture
}

function versionsOf(index) {
  return index.releases.map((release) => release.version)
}

// The client checks agy.exe against its own copy of this signer (electron/trusted-native-cli.ts);
// the two must name the same certificate, or the bucket would carry files every client refuses.
test('the sync and the client pin the same Windows signer', async () => {
  function nameComponents(text) {
    return [...text.matchAll(/nameComponent\('([^']+)', '([^']+)'\)/g)].map(function (match) { return `${match[1]}=${match[2]}` })
  }
  const script = await fs.readFile(path.join(__dirname, 'sync-antigravity-cli-cos.cjs'), 'utf8')
  const client = await fs.readFile(path.join(__dirname, '..', 'electron', 'trusted-native-cli.ts'), 'utf8')
  const scriptSigner = script.slice(script.indexOf('const WINDOWS_SIGNER'), script.indexOf('const PLATFORMS'))
  const clientSigner = client.slice(client.indexOf('  antigravity: ['), client.indexOf('\n}\n', client.indexOf('  antigravity: [')))
  assert.ok(nameComponents(scriptSigner).length >= 7)
  assert.deepEqual(nameComponents(clientSigner), nameComponents(scriptSigner))
})

test('each runner syncs only its own system\'s half', () => {
  assert.equal(familyForRunner('win32'), 'windows')
  assert.equal(familyForRunner('darwin'), 'macos')
  for (const platform of ['linux', 'freebsd', 'aix']) assert.throws(() => familyForRunner(platform))
  assert.deepEqual(FAMILIES.windows.platformIds, ['windows-x64', 'windows-arm64'])
  assert.deepEqual(FAMILIES.macos.platformIds, ['macos-arm64', 'macos-x64'])
  assert.equal(FAMILIES.windows.indexKey, 'xingmang/offline/antigravity-cli/windows.json')
  assert.equal(FAMILIES.macos.indexKey, 'xingmang/offline/antigravity-cli/macos.json')
})

test('manifests, sources and objects are built from the constants, the version and the digest only', () => {
  assert.equal(manifestUrl('windows-x64'), `${MANIFEST_ORIGIN}/manifests/windows_amd64.json`)
  assert.equal(manifestUrl('macos-arm64'), `${MANIFEST_ORIGIN}/manifests/darwin_arm64.json`)
  // The URL the probe read from Google's manifest for 1.5.15.
  assert.equal(sourceUrl('windows-x64', '1.5.15', BUILD), `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.15-${BUILD}/windows-x64/cli_windows_x64.exe`)
  assert.equal(sourceUrl('macos-arm64', '1.5.15', BUILD), `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.15-${BUILD}/darwin-arm/cli_mac_arm64.tar.gz`)
  for (const [version, build] of [['1.5', BUILD], ['1.5.15', '0'], ['1.5.15', '../x'], ['01.5.15', BUILD]]) assert.throws(() => sourceUrl('windows-x64', version, build))
  const sha = 'a'.repeat(64)
  assert.equal(artifactKey('windows-arm64', sha, '1.5.15'), `${PREFIX}/windows-arm64/sha256-${sha}/agy-1.5.15-windows-arm64.exe`)
  assert.equal(artifactKey('macos-x64', sha, '1.5.15'), `${PREFIX}/macos-x64/sha256-${sha}/agy-1.5.15-macos-x64.tar.gz`)
})

test('a manifest is accepted only when its URL is the one built from its own version and build', () => {
  const good = manifestFor('windows-x64', '1.5.15')
  assert.deepEqual(parseManifest(JSON.stringify({ ...good, sha512: good.sha512.toUpperCase() }), 'windows-x64'), { version: '1.5.15', build: BUILD, url: good.url, sha512: good.sha512 })
  const refused = [
    'not json',
    JSON.stringify([good]),
    JSON.stringify({ ...good, version: '1.5' }),
    JSON.stringify({ ...good, sha512: 'abc' }),
    JSON.stringify({ ...good, url: good.url.replace('storage.googleapis.com', 'storage.googleapis.com.evil.invalid') }),
    JSON.stringify({ ...good, url: good.url.replace('http', 'http') + '?x=1' }),
    JSON.stringify({ ...good, url: good.url.replace('windows-x64/', 'windows-arm/') }),
    JSON.stringify({ ...good, url: good.url.replace(`1.5.15-${BUILD}`, `1.5.14-${BUILD}`) }),
    JSON.stringify({ ...good, url: good.url.replace(`-${BUILD}/`, `-${BUILD}/../${BUILD}/`) }),
    JSON.stringify({ ...good, url: undefined }),
  ]
  for (const text of refused) assert.throws(() => parseManifest(text, 'windows-x64'), text)
  // The other chip's manifest is not accepted for this one.
  assert.throws(() => parseManifest(JSON.stringify(manifestFor('windows-arm64', '1.5.15')), 'windows-x64'))
})

test('only Google\'s certificate from DigiCert\'s code signing CA passes on Windows', () => {
  validateWindowsSignature({ status: 'Valid', subject: GOOGLE_SUBJECT, issuer: DIGICERT_ISSUER })
  const cases = [
    [{ status: 'NotSigned', subject: null, issuer: null }, 'package-signature-invalid'],
    [{ status: 'HashMismatch', subject: GOOGLE_SUBJECT, issuer: DIGICERT_ISSUER }, 'package-signature-invalid'],
    [{ status: 'Valid', subject: GOOGLE_SUBJECT.replace('O=Google LLC', 'O=Google LLC Evil'), issuer: DIGICERT_ISSUER }, 'package-signer-mismatch'],
    [{ status: 'Valid', subject: GOOGLE_SUBJECT.replace('CN=Google LLC', 'CN=Gooogle LLC'), issuer: DIGICERT_ISSUER }, 'package-signer-mismatch'],
    [{ status: 'Valid', subject: GOOGLE_SUBJECT.replace('L=Mountain View', 'L=Elsewhere'), issuer: DIGICERT_ISSUER }, 'package-signer-mismatch'],
    [{ status: 'Valid', subject: 'CN=X, OU=Google LLC', issuer: DIGICERT_ISSUER }, 'package-signer-mismatch'],
    [{ status: 'Valid', subject: GOOGLE_SUBJECT, issuer: 'CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1, O=Someone Else' }, 'package-signer-mismatch'],
    [{ status: 'Valid', subject: GOOGLE_SUBJECT, issuer: null }, 'package-signer-mismatch'],
  ]
  for (const [signature, code] of cases) {
    assert.throws(() => validateWindowsSignature(signature), (error) => {
      assert.equal(require('./cos-sync-utils.cjs').safeSyncFailure(error).code, code)
      return true
    }, JSON.stringify(signature))
  }
})

test('the first Windows run uploads both chips, checks each before upload and writes the index last', async () => {
  const fixture = createFixture('windows')
  const result = await fixture.run()
  assert.equal(result.changed, true)
  assert.deepEqual(fixture.manifestRequests.map((request) => [request.url, request.allowedHosts, request.maxBytes]), [
    [manifestUrl('windows-x64'), [new URL(MANIFEST_ORIGIN).hostname], 16 * 1024],
    [manifestUrl('windows-arm64'), [new URL(MANIFEST_ORIGIN).hostname], 16 * 1024],
  ])
  assert.deepEqual(fixture.downloads.map((download) => [download.url, download.allowedHosts]), [
    [sourceUrl('windows-x64', '1.5.15', BUILD), ['storage.googleapis.com']],
    [sourceUrl('windows-arm64', '1.5.15', BUILD), ['storage.googleapis.com']],
  ])
  assert.equal(fixture.publications.length, 2)
  for (const publication of fixture.publications) {
    assert.equal(publication.contentType, 'application/octet-stream')
    assert.match(publication.cacheControl, /immutable/)
  }
  assert.equal(fixture.pointers.length, 1)
  const index = fixture.latest
  assert.deepEqual(Object.keys(index), ['schemaVersion', 'product', 'family', 'generatedAt', 'checkedAt', 'releases'])
  assert.equal(index.family, 'windows')
  assert.deepEqual(versionsOf(index), ['1.5.15'])
  assert.equal(index.releases[0].build, BUILD)
  const body = artifactBody(sourceUrl('windows-x64', '1.5.15', BUILD))
  const key = artifactKey('windows-x64', digest('sha256', body), '1.5.15')
  assert.deepEqual(index.releases[0].files[0], {
    platformId: 'windows-x64', platform: 'windows', architecture: 'x64', manifest: 'windows_amd64', key, url: fixture.store.publicUrl(key),
    bytes: MIN_ARTIFACT_BYTES + 60 * 1024 * 1024 + body.length, sha256: digest('sha256', body), sha512: digest('sha512', body),
    contentType: 'application/octet-stream', verification: 'windows-authenticode-google', sourceUrl: sourceUrl('windows-x64', '1.5.15', BUILD),
    cosEtag: `"cos-${digest('sha256', body).slice(0, 16)}"`,
  })
  assert.equal(validateIndex(index, 'windows', fixture.store.publicUrl), index)
  assert.equal(fixture.removedFiles.length, 2)
  assert.equal(fixture.removed.length, 1)
})

test('the Mac half checks each archive on its own chip and writes its own index', async () => {
  const fixture = createFixture('macos')
  await fixture.run()
  assert.deepEqual(fixture.macInspections, [['cli_mac_arm64.tar.gz', 'arm64'], ['cli_mac_x64.tar.gz', 'x86_64']])
  assert.equal(fixture.latest.family, 'macos')
  assert.deepEqual(fixture.latest.releases[0].files.map((file) => [file.platformId, file.contentType, file.verification]), [
    ['macos-arm64', 'application/gzip', 'macos-developer-id-google'],
    ['macos-x64', 'application/gzip', 'macos-developer-id-google'],
  ])
  // A Windows index is never valid as the Mac one.
  assert.throws(() => validateIndex({ ...fixture.latest, family: 'windows' }, 'windows', fixture.store.publicUrl))

  const refused = createFixture('macos')
  refused.macFailure = require('./cos-sync-utils.cjs').checkFailure('package-signature-invalid', 'not Google')
  await assert.rejects(refused.run(), (error) => {
    assert.deepEqual(safeAntigravitySyncFailure(error), { stage: 'verify-artifact', version: '1.5.15', platformId: 'macos-arm64', expectedBytes: refused.downloads.length && MIN_ARTIFACT_BYTES + 60 * 1024 * 1024 + artifactBody(sourceUrl('macos-arm64', '1.5.15', BUILD)).length,
      latestState: 'not-written-by-this-run', failure: { code: 'package-signature-invalid' } })
    return true
  })
  assert.equal(refused.publications.length, 0)
  assert.equal(refused.pointers.length, 0)
})

test('an unchanged version with intact objects means no download and only a fresh checkedAt', async () => {
  const fixture = createFixture()
  await fixture.run()
  const before = clone(fixture.latest)
  const result = await fixture.run({ now: () => '2026-11-23T22:00:00.000Z' })
  assert.equal(result.changed, false)
  assert.equal(fixture.downloads.length, 2)
  assert.equal(fixture.publications.length, 2)
  assert.equal(fixture.pointers.length, 2)
  assert.deepEqual(fixture.latest, { ...before, checkedAt: '2026-11-23T22:00:00.000Z' })
})

test('a damaged object in the bucket is uploaded again', async () => {
  const fixture = createFixture()
  await fixture.run()
  const damaged = fixture.latest.releases[0].files[1].key
  fixture.objects.set(damaged, { ...fixture.objects.get(damaged), etag: '"changed"' })
  await fixture.run()
  assert.deepEqual(fixture.downloads.slice(2).map((download) => download.url), [sourceUrl('windows-arm64', '1.5.15', BUILD)])
})

test('a new version goes on top and the history keeps at most a few releases', async () => {
  const fixture = createFixture()
  const versions = ['1.5.15', '1.5.16', '1.6.0', '1.6.1', '1.10.0']
  for (const version of versions) {
    for (const id of FAMILIES.windows.platformIds) fixture.versions[id] = version
    await fixture.run()
  }
  assert.deepEqual(versionsOf(fixture.latest), ['1.10.0', '1.6.1', '1.6.0', '1.5.16'])
  assert.equal(fixture.latest.releases.length, MAX_RELEASES)
  assert.equal(validateIndex(fixture.latest, 'windows', fixture.store.publicUrl), fixture.latest)
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0)
})

test('Google going back a version publishes nothing', async () => {
  const fixture = createFixture()
  for (const id of FAMILIES.windows.platformIds) fixture.versions[id] = '1.5.16'
  await fixture.run()
  for (const id of FAMILIES.windows.platformIds) fixture.versions[id] = '1.5.15'
  await assert.rejects(fixture.run(), (error) => {
    assert.deepEqual(safeAntigravitySyncFailure(error), { stage: 'source-compare', latestState: 'not-written-by-this-run', failure: { code: 'version-regressed' } })
    return true
  })
  assert.equal(fixture.pointers.length, 1)
  assert.equal(fixture.downloads.length, 2)
})

test('the two chips naming different versions publishes nothing this round', async () => {
  const fixture = createFixture()
  fixture.versions['windows-arm64'] = '1.5.16'
  await assert.rejects(fixture.run(), (error) => {
    assert.deepEqual(safeAntigravitySyncFailure(error), { stage: 'source-compare', latestState: 'not-written-by-this-run', failure: { code: 'source-changed' } })
    return true
  })
  assert.equal(fixture.downloads.length, 0)
  assert.equal(fixture.pointers.length, 0)
})

test('a download that does not match Google\'s SHA-512 is never uploaded', async () => {
  const fixture = createFixture()
  fixture.corruptDownload = true
  await assert.rejects(fixture.run(), (error) => {
    assert.equal(safeAntigravitySyncFailure(error).stage, 'source-download')
    assert.equal(safeAntigravitySyncFailure(error).failure.code, 'download-mismatch')
    return true
  })
  assert.equal(fixture.publications.length, 0)
  assert.equal(fixture.pointers.length, 0)
  assert.ok(fixture.removedFiles.length >= 1)
})

test('a binary for the wrong processor or with another signer is never uploaded', async () => {
  const wrongChip = createFixture()
  wrongChip.machineOverride = 0x014c
  await assert.rejects(wrongChip.run(), (error) => {
    assert.equal(safeAntigravitySyncFailure(error).failure.code, 'package-identity-mismatch')
    assert.equal(safeAntigravitySyncFailure(error).failure.observed.packageArchitecture, '0x014c')
    return true
  })
  assert.equal(wrongChip.publications.length, 0)

  const otherSigner = createFixture()
  otherSigner.signature = { status: 'Valid', subject: 'CN=Someone, O=Someone', issuer: DIGICERT_ISSUER }
  await assert.rejects(otherSigner.run(), (error) => {
    const failure = safeAntigravitySyncFailure(error).failure
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
    assert.equal(safeAntigravitySyncFailure(error).stage, 'cos-recheck-latest')
    return true
  })
  assert.equal(fixture.pointers.length, 0)
})

test('a broken existing index stops the run before anything is downloaded', async () => {
  for (const broken of [{ schemaVersion: 2 }, { schemaVersion: 1, product: 'antigravity-cli', family: 'windows', generatedAt: 'x', checkedAt: 'x', releases: [] }]) {
    const fixture = createFixture()
    fixture.latest = broken
    await assert.rejects(fixture.run(), (error) => {
      assert.deepEqual(safeAntigravitySyncFailure(error), { stage: 'cos-read-latest', family: 'windows', latestState: 'not-written-by-this-run', failure: { code: 'cos-index-invalid' } })
      return true
    })
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
    assert.equal(require('./cos-sync-utils.cjs').safeSyncFailure(error).code, 'inspector-unavailable')
    return true
  })
  await assert.rejects(inspectMacArchive('a.tar.gz', os.tmpdir(), 'arm64', async () => assert.fail('must not run'), 'win32'), (error) => {
    assert.equal(require('./cos-sync-utils.cjs').safeSyncFailure(error).code, 'inspector-unavailable')
    return true
  })
})

async function macWorkDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agy-mac-inspect-'))
}

// A stand-in for tar, codesign and lipo: tar "unpacks" what the test says, the others answer as told.
function fakeMacTools(unpack, answers = {}) {
  const calls = []
  async function run(executable, args) {
    calls.push([executable, args])
    if (executable === '/usr/bin/tar') {
      await unpack(args[args.indexOf('-C') + 1])
      return { stdout: '' }
    }
    if (executable === '/usr/bin/codesign') {
      if (answers.codesign === false) throw Object.assign(new Error('codesign SECRET'), { code: 3 })
      return { stdout: '' }
    }
    if (executable === '/usr/bin/lipo') return { stdout: `${answers.archs || 'arm64'}\n` }
    throw new Error(`unexpected ${executable}`)
  }
  return { run, calls }
}

test('a Mac archive passes only as exactly one regular file signed by Google for agy on the right chip', async () => {
  const workDirectory = await macWorkDirectory()
  try {
    const good = fakeMacTools((directory) => fs.writeFile(path.join(directory, 'antigravity'), 'mach-o'))
    await inspectMacArchive('/tmp/cli_mac_arm64.tar.gz', workDirectory, 'arm64', good.run, 'darwin')
    assert.deepEqual(good.calls.map(([executable]) => executable), ['/usr/bin/tar', '/usr/bin/codesign', '/usr/bin/lipo'])
    const codesignArgs = good.calls[1][1]
    assert.deepEqual(codesignArgs.slice(0, 2), ['--verify', '--strict'])
    assert.equal(codesignArgs[2], `-R=${darwinAntigravityRequirement()}`)
    assert.equal(darwinAntigravityRequirement(), 'identifier "cli" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "EQHXZ8M8AV"')
    // The unpacked copy is removed whatever happens.
    assert.deepEqual(await fs.readdir(workDirectory), [])

    const cases = [
      [fakeMacTools((directory) => Promise.all([fs.writeFile(path.join(directory, 'antigravity'), 'x'), fs.writeFile(path.join(directory, 'extra'), 'x')])), 'package-format-invalid'],
      [fakeMacTools((directory) => fs.writeFile(path.join(directory, 'agy'), 'x')), 'package-format-invalid'],
      [fakeMacTools((directory) => fs.mkdir(path.join(directory, 'antigravity'))), 'package-format-invalid'],
      [fakeMacTools((directory) => fs.symlink('/bin/sh', path.join(directory, 'antigravity'))), 'package-format-invalid'],
      [fakeMacTools((directory) => fs.writeFile(path.join(directory, 'antigravity'), 'x'), { codesign: false }), 'package-signature-invalid'],
      [fakeMacTools((directory) => fs.writeFile(path.join(directory, 'antigravity'), 'x'), { archs: 'x86_64' }), 'package-identity-mismatch'],
    ]
    for (const [tools, code] of cases) {
      await assert.rejects(inspectMacArchive('/tmp/cli_mac_arm64.tar.gz', workDirectory, 'arm64', tools.run, 'darwin'), (error) => {
        assert.equal(require('./cos-sync-utils.cjs').safeSyncFailure(error).code, code)
        return true
      })
      assert.deepEqual(await fs.readdir(workDirectory), [])
    }
  } finally {
    await fs.rm(workDirectory, { recursive: true, force: true })
  }
})

test('the PE machine field is read from the header without running the file', async () => {
  const directory = await macWorkDirectory()
  try {
    const file = path.join(directory, 'agy.exe')
    const image = Buffer.alloc(256)
    image.writeUInt16LE(0x5a4d, 0)
    image.writeUInt32LE(0x80, 0x3c)
    image.writeUInt32LE(0x00004550, 0x80)
    image.writeUInt16LE(0xaa64, 0x84)
    await fs.writeFile(file, image)
    assert.equal(await readPeMachine(file), 0xaa64)
    await fs.writeFile(file, Buffer.from('#!/bin/sh\n'.padEnd(128, ' ')))
    await assert.rejects(readPeMachine(file))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('sync-antigravity-cli-cos with random inputs never accepts a manifest URL outside Google\'s folder for that version', () => {
  const version = fc.tuple(fc.nat(30), fc.nat(30), fc.nat(99)).map(([a, b, c]) => `${a}.${b}.${c}`)
  fc.assert(fc.property(version, fc.string({ maxLength: 120 }), fc.constantFrom(...Object.keys(PLATFORMS)), (value, url, platformId) => {
    const text = JSON.stringify({ version: value, url, sha512: 'b'.repeat(128) })
    let parsed
    try {
      parsed = parseManifest(text, platformId)
    } catch {
      return
    }
    assert.equal(parsed.url, sourceUrl(platformId, value, parsed.build))
  }))
})
