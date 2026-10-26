const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Readable, Writable } = require('node:stream')
const { fetchText, safeSyncFailure } = require('./cos-sync-utils.cjs')
const {
  STABLE_URLS, LATEST_KEY, CONTENT_TYPE, VERIFICATION, MIN_BINARY_BYTES, MAX_RELEASES, PLATFORMS,
  parseVersion, compareVersions, artifactKey, sourceUrls, readRecommendedGrokVersion, targetVersions, validateLatest, validateSignature,
  readPeMachine, inspectSignature, synchronizeGrok, createRuntimeDependencies, safeGrokSyncFailure,
} = require('./sync-grok-cos.cjs')

const SIGNER = 'CN=X.AI LLC, O=X.AI LLC, L=Palo Alto, S=California, C=US'
const ISSUER = 'CN=SSL.com EV Code Signing Intermediate CA RSA R3, O=SSL Corp, L=Houston, S=Texas, C=US'
// xAI 从 1.0.54 起签 grok.exe 用的那张（#1051）。
const X_CORP_SIGNER = 'CN=X Corp., O=X Corp., L=Bastrop, S=Texas, C=US'
const X_CORP_ISSUER = 'CN=GlobalSign GCC R45 CodeSigning CA 2020, O=GlobalSign nv-sa, C=BE'
const MACHINES = { 'windows-x86_64': 0x8664, 'windows-aarch64': 0xaa64 }

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function binary(fileName) {
  return { bytes: MIN_BINARY_BYTES + 150 * 1024 * 1024 + fileName.length, sha256: sha256(fileName) }
}

function createFixture() {
  const fixture = {
    stable: '1.0.52',
    stableResponses: new Map(),
    failingHosts: new Set(),
    signature: { status: 'Valid', subject: SIGNER, issuer: ISSUER },
    machineOverride: null,
    latest: null,
    objects: new Map(),
    publications: [],
    pointers: [],
    downloads: [],
    stableRequests: [],
    removedFiles: [],
    removed: [],
    reads: 0,
  }
  fixture.dependencies = {
    async fetchText(input) {
      fixture.stableRequests.push(clone(input))
      if (fixture.stableResponses.has(input.url)) {
        const response = fixture.stableResponses.get(input.url)
        if (response instanceof Error) throw response
        return response
      }
      return `${fixture.stable}\n`
    },
    async downloadResource(input) {
      fixture.downloads.push(clone({ ...input, onProgress: undefined }))
      if (fixture.failingHosts.has(new URL(input.url).hostname)) throw new Error('HTTP 403 SECRET-HOST')
      return { ...binary(input.url.split('/').pop()), etag: '"source"' }
    },
    async readPeMachine(filePath) {
      if (fixture.machineOverride !== null) return fixture.machineOverride
      return MACHINES[/-(windows-[a-z0-9_]+)\.exe$/.exec(path.basename(filePath))[1]]
    },
    async inspectSignature() { return clone(fixture.signature) },
    async removeFile(filePath) { fixture.removedFiles.push(filePath) },
    async createWorkDirectory() { return path.resolve(os.tmpdir(), 'mock-grok-cos') },
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
      fixture.publications.push({ key, filePath, ...input, onProgress: undefined })
      if (fixture.publicationError) throw new Error('PRIMARY-SECRET signed URL')
      const existing = fixture.objects.get(key)
      if (existing && existing.sha256 !== input.expectedSha256) throw new Error('Mock immutable object conflict')
      const result = { key, bytes: input.expectedBytes, sha256: input.expectedSha256, contentType: input.contentType, etag: existing?.etag || `"cos-${input.expectedSha256.slice(0, 16)}"` }
      fixture.objects.set(key, result)
      return result
    },
    async publishJson(key, value, input) {
      assert.equal(key, LATEST_KEY)
      assert.equal(input.overwrite, true)
      assert.match(input.cacheControl, /no-cache/)
      fixture.pointers.push(clone(value))
      fixture.latest = clone(value)
      return { key }
    },
  }
  fixture.run = function (extra = {}) {
    return synchronizeGrok({ store: fixture.store, dependencies: fixture.dependencies, recommendedVersion: '1.0.46', now: function () { return '2026-10-14T16:00:00.000Z' }, ...extra })
  }
  return fixture
}

function versionsOf(manifest) {
  return manifest.releases.map(function (release) { return release.version })
}

test('versions follow the client rules for xAI stable and the pinned recommendation', () => {
  assert.equal(parseVersion(' 1.0.52\n'), '1.0.52')
  assert.equal(parseVersion('1.0.52-rc.1'), '1.0.52-rc.1')
  for (const value of ['', 'latest', '1.0', 'v1.0.52', '1.0.52 && calc', '<html>', null, `1.0.${'9'.repeat(80)}`]) assert.equal(parseVersion(value), null)
  assert.ok(compareVersions('1.0.52', '1.0.46') > 0)
  assert.ok(compareVersions('1.0.10', '1.0.9') > 0)
  assert.ok(compareVersions('1.0.52-rc.1', '1.0.52') < 0)
  assert.deepEqual(targetVersions('1.0.52', '1.0.46'), ['1.0.52', '1.0.46'])
  assert.deepEqual(targetVersions('1.0.52', '1.0.52'), ['1.0.52'])
  // A recommendation newer than stable installs stable on the client, so it is never fetched.
  assert.deepEqual(targetVersions('1.0.52', '1.0.60'), ['1.0.52'])
  assert.deepEqual(targetVersions('1.0.52', null), ['1.0.52'])
})

test('the recommended Grok version is read from the real verified-versions file', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'electron', 'cli-verified-versions.ts'), 'utf8')
  const recommended = readRecommendedGrokVersion(source)
  assert.ok(recommended, 'electron/cli-verified-versions.ts no longer matches the shape the Grok sync reads')
  assert.equal(parseVersion(recommended), recommended)
  assert.equal(readRecommendedGrokVersion("\n  grok: {\n    recommended: {\n      version: 'latest',"), null)
  assert.equal(readRecommendedGrokVersion('export const x = 1'), null)
  assert.equal(readRecommendedGrokVersion(null), null)
})

test('objects and source URLs are built only from the version, the platform and the digest', () => {
  const digest = 'a'.repeat(64)
  assert.equal(artifactKey('1.0.52', 'windows-x64', digest), `xingmang/offline/grok/windows-x64/sha256-${digest}/grok-1.0.52-windows-x86_64.exe`)
  assert.equal(artifactKey('1.0.52', 'windows-arm64', digest), `xingmang/offline/grok/windows-arm64/sha256-${digest}/grok-1.0.52-windows-aarch64.exe`)
  assert.deepEqual(sourceUrls('1.0.52', 'windows-x64'), [
    'https://x.ai/cli/grok-1.0.52-windows-x86_64.exe',
    'https://storage.googleapis.com/grok-build-public-artifacts/cli/grok-1.0.52-windows-x86_64.exe',
  ])
})

test('the first run uploads stable and the recommended version for both processors, then writes the pointer last', async () => {
  const fixture = createFixture()
  const result = await fixture.run()
  assert.equal(result.changed, true)
  assert.deepEqual(result.versions, ['1.0.52', '1.0.46'])
  assert.equal(fixture.publications.length, 4)
  for (const publication of fixture.publications) {
    assert.equal(publication.contentType, CONTENT_TYPE)
    assert.match(publication.cacheControl, /immutable/)
  }
  assert.deepEqual(fixture.downloads.map(function (download) { return download.url }), [
    'https://x.ai/cli/grok-1.0.52-windows-x86_64.exe',
    'https://x.ai/cli/grok-1.0.52-windows-aarch64.exe',
    'https://x.ai/cli/grok-1.0.46-windows-x86_64.exe',
    'https://x.ai/cli/grok-1.0.46-windows-aarch64.exe',
  ])
  for (const download of fixture.downloads) assert.deepEqual(download.allowedHosts, ['x.ai'])
  assert.deepEqual(fixture.stableRequests.map(function (request) { return [request.url, request.allowedHosts] }), [[STABLE_URLS[0], ['x.ai']]])
  assert.equal(fixture.pointers.length, 1)
  const manifest = fixture.latest
  assert.deepEqual(versionsOf(manifest), ['1.0.52', '1.0.46'])
  assert.deepEqual(manifest.stable, { version: '1.0.52', url: STABLE_URLS[0] })
  const file = manifest.releases[0].files[0]
  const expected = binary('grok-1.0.52-windows-x86_64.exe')
  const key = artifactKey('1.0.52', 'windows-x64', expected.sha256)
  assert.deepEqual(file, {
    platformId: 'windows-x64', platform: 'windows', architecture: 'x64', key, url: fixture.store.publicUrl(key),
    bytes: expected.bytes, sha256: expected.sha256, contentType: CONTENT_TYPE, verification: VERIFICATION,
    sourceUrl: 'https://x.ai/cli/grok-1.0.52-windows-x86_64.exe', cosEtag: `"cos-${expected.sha256.slice(0, 16)}"`,
  })
  assert.equal(validateLatest(manifest, fixture.store.publicUrl), manifest)
  assert.equal(fixture.removed.length, 1)
  // Every downloaded binary is removed once uploaded, so two releases never pile up on the runner.
  assert.equal(fixture.removedFiles.length, 4)
})

test('when x.ai refuses the runner, the stable answer and the binaries come from xAI\'s public storage', async () => {
  const fixture = createFixture()
  fixture.stableResponses.set(STABLE_URLS[0], new Error('HTTP 403'))
  fixture.failingHosts.add('x.ai')
  await fixture.run()
  assert.deepEqual(fixture.latest.stable, { version: '1.0.52', url: STABLE_URLS[1] })
  for (const release of fixture.latest.releases) {
    for (const file of release.files) assert.match(file.sourceUrl, /^https:\/\/storage\.googleapis\.com\/grok-build-public-artifacts\/cli\//)
  }
  assert.equal(fixture.downloads.length, 8)

  const broken = createFixture()
  broken.stableResponses.set(STABLE_URLS[0], '<html>blocked</html>')
  broken.stableResponses.set(STABLE_URLS[1], 'latest')
  const events = []
  await assert.rejects(broken.run({ progress: (event) => events.push(event) }), (error) => {
    assert.deepEqual(safeGrokSyncFailure(error), { stage: 'source-stable', latestState: 'not-written-by-this-run', failure: { code: 'version-invalid' } })
    return true
  })
  assert.deepEqual(events.filter((event) => event.event === 'source-attempt-failed').map((event) => [event.sourceHost, event.failure.code]),
    [['x.ai', 'version-invalid'], ['storage.googleapis.com', 'version-invalid']])
  assert.equal(broken.downloads.length, 0)
  assert.equal(broken.pointers.length, 0)
})

// The stable lookup goes through the real shared transport; only the socket is fake.
function xaiStable(fixture, answer) {
  fixture.dependencies.fetchText = function (input) {
    fixture.stableRequests.push(clone(input))
    return fetchText(input, { requestImpl(url, options, callback) {
      const [status, body] = answer(new URL(input.url).hostname)
      const request = new Writable({ write(chunk, encoding, done) { done() } })
      request.on('finish', () => {
        const response = Readable.from([Buffer.from(body)])
        response.statusCode = status
        response.headers = {}
        callback(response)
      })
      return request
    } })
  }
}

test('each official host that fails is logged with its own reason, also when the other host answers', async () => {
  const fixture = createFixture()
  xaiStable(fixture, (host) => host === 'x.ai' ? [403, 'Access denied SECRET-PAGE'] : [200, '1.0.52\n'])
  fixture.failingHosts.add('x.ai')
  const events = []
  await fixture.run({ progress: (event) => events.push(event) })
  assert.deepEqual(fixture.latest.stable, { version: '1.0.52', url: STABLE_URLS[1] })
  const attempts = events.filter((event) => event.event === 'source-attempt-failed')
  assert.deepEqual(attempts[0], { event: 'source-attempt-failed', stage: 'source-stable', elapsedMs: attempts[0].elapsedMs, sourceHost: 'x.ai',
    failure: { code: 'http-status', method: 'GET', phase: 'response-headers', status: 403, transferredBytes: 0 } })
  // The fake download error is a bare exception: its text never reaches the log.
  assert.deepEqual(attempts.slice(1).map((event) => [event.stage, event.sourceHost, event.failure]),
    Array(4).fill(['source-download', 'x.ai', { code: 'operation-failed' }]))
  assert.ok(events.some((event) => event.event === 'stage-complete' && event.stage === 'source-stable'))
  assert.ok(events.every((event) => event.event !== 'stage-failed'))
  for (const event of events.filter((item) => item.stage === 'verify-binary')) assert.equal(event.sourceHost, 'storage.googleapis.com')
  assert.doesNotMatch(JSON.stringify(events), /SECRET|https:/)
})

test('an unchanged stable with intact objects means no download and only a fresh checkedAt', async () => {
  const fixture = createFixture()
  await fixture.run()
  const before = clone(fixture.latest)
  assert.equal(before.checkedAt, '2026-10-14T16:00:00.000Z')
  const result = await fixture.run({ now: function () { return '2026-10-14T22:00:00.000Z' } })
  assert.equal(result.changed, false)
  assert.equal(fixture.downloads.length, 4)
  assert.equal(fixture.publications.length, 4)
  // The index is rewritten anyway: clients stop trusting its "latest" once checkedAt is a day old (#1061 item 7).
  assert.equal(fixture.pointers.length, 2)
  assert.deepEqual(fixture.latest, { ...before, checkedAt: '2026-10-14T22:00:00.000Z' })
  assert.equal(validateLatest(fixture.latest, fixture.store.publicUrl), fixture.latest)
})

test('checkedAt is the moment xAI named its stable, not the end of the uploads', async () => {
  const fixture = createFixture()
  // Downloading and uploading four binaries takes a while; xAI may move on in between.
  const result = await fixture.run({ now: function () { return fixture.downloads.length === 0 ? '2026-10-14T16:00:00.000Z' : '2026-10-14T16:40:00.000Z' } })
  assert.equal(result.changed, true)
  assert.equal(fixture.downloads.length, 4)
  assert.equal(fixture.latest.checkedAt, '2026-10-14T16:00:00.000Z')
  assert.equal(fixture.latest.generatedAt, '2026-10-14T16:40:00.000Z')
})

test('a new stable is added on top of the history and a damaged object is uploaded again', async () => {
  const fixture = createFixture()
  await fixture.run()
  fixture.stable = '1.0.53'
  const next = await fixture.run()
  assert.equal(next.changed, true)
  assert.deepEqual(versionsOf(fixture.latest), ['1.0.53', '1.0.52', '1.0.46'])
  // Only the new stable was fetched; the recommended version was still intact in the bucket.
  assert.equal(fixture.downloads.length, 6)

  const key = fixture.latest.releases[2].files[1].key
  fixture.objects.set(key, { ...fixture.objects.get(key), etag: '"replaced-by-hand"' })
  const repaired = await fixture.run()
  assert.equal(repaired.changed, true)
  assert.equal(fixture.downloads.length, 7)
  assert.equal(fixture.downloads[6].url, 'https://x.ai/cli/grok-1.0.46-windows-aarch64.exe')
})

test('the history keeps stable, the recommendation and the newest older releases up to the limit', async () => {
  const fixture = createFixture()
  for (let patch = 40; patch <= 40 + MAX_RELEASES + 2; patch += 1) {
    fixture.stable = `1.0.${patch}`
    await fixture.run({ recommendedVersion: '1.0.41' })
  }
  const versions = versionsOf(fixture.latest)
  assert.equal(versions.length, MAX_RELEASES)
  assert.equal(versions[0], `1.0.${40 + MAX_RELEASES + 2}`)
  assert.ok(versions.includes('1.0.41'))
  assert.ok(!versions.includes('1.0.40'))
  assert.deepEqual([...versions].sort(function (left, right) { return compareVersions(right, left) }), versions)
})

test('binaries without xAI\'s valid signature or for the wrong processor are never uploaded', async () => {
  const evilSigner = 'CN=Evil LLC, O=Evil LLC'
  const austinSigner = 'CN=X Corp., O=X Corp., L=Austin, S=Texas, C=US'
  for (const [signature, machine, message, failure] of [
    [{ status: 'NotSigned', subject: null }, null, /Authenticode/, { code: 'package-signature-invalid', observed: { signatureStatus: 'NotSigned' } }],
    [{ status: 'HashMismatch', subject: SIGNER }, null, /Authenticode/, { code: 'package-signature-invalid', observed: { signatureStatus: 'HashMismatch', signerSubject: SIGNER } }],
    [{ status: 'Valid', subject: evilSigner }, null, /X\.AI LLC/, { code: 'package-signer-mismatch', observed: { signatureStatus: 'Valid', signerSubject: evilSigner } }],
    [{ status: 'Valid', subject: 'CN=X.AI LLC Fake, O=Other' }, null, /X\.AI LLC/, { code: 'package-signer-mismatch', observed: { signatureStatus: 'Valid', signerSubject: 'CN=X.AI LLC Fake, O=Other' } }],
    [{ status: 'Valid', subject: SIGNER }, null, /X\.AI LLC/, { code: 'package-signer-mismatch', observed: { signatureStatus: 'Valid', signerSubject: SIGNER } }],
    [{ status: 'Valid', subject: X_CORP_SIGNER, issuer: ISSUER }, null, /X Corp\./, { code: 'package-signer-mismatch', observed: { signatureStatus: 'Valid', signerSubject: X_CORP_SIGNER, signerIssuer: ISSUER } }],
    [{ status: 'Valid', subject: SIGNER, issuer: X_CORP_ISSUER }, null, /X Corp\./, { code: 'package-signer-mismatch', observed: { signatureStatus: 'Valid', signerSubject: SIGNER, signerIssuer: X_CORP_ISSUER } }],
    [{ status: 'Valid', subject: austinSigner, issuer: X_CORP_ISSUER }, null, /X Corp\./, { code: 'package-signer-mismatch', observed: { signatureStatus: 'Valid', signerSubject: austinSigner, signerIssuer: X_CORP_ISSUER } }],
    [{ status: 'Valid', subject: SIGNER, issuer: ISSUER }, 0x14c, /处理器架构/, { code: 'package-identity-mismatch', observed: { packageArchitecture: '0x014c' } }],
    [{ status: 'Valid', subject: SIGNER, issuer: ISSUER }, 0xaa64, /处理器架构/, { code: 'package-identity-mismatch', observed: { packageArchitecture: 'arm64' } }],
  ]) {
    const fixture = createFixture()
    fixture.signature = signature
    fixture.machineOverride = machine
    const events = []
    await assert.rejects(fixture.run({ progress: (event) => events.push(event) }), (error) => {
      assert.match(error.message, message)
      const diagnostic = safeGrokSyncFailure(error)
      assert.equal(diagnostic.stage, 'verify-binary')
      assert.equal(diagnostic.platformId, 'windows-x64')
      assert.equal(diagnostic.sourceHost, 'x.ai')
      assert.equal(diagnostic.latestState, 'not-written-by-this-run')
      assert.deepEqual(diagnostic.failure, failure)
      return true
    })
    assert.deepEqual(events.find((event) => event.event === 'stage-failed').diagnostic.failure, failure)
    assert.equal(fixture.publications.length, 0)
    assert.equal(fixture.pointers.length, 0)
    assert.equal(fixture.removed.length, 1)
    assert.ok(fixture.removedFiles.length >= 1)
  }
  assert.throws(() => validateSignature(null), /Authenticode/)
  assert.doesNotThrow(() => validateSignature({ status: 'Valid', subject: 'O=X.AI LLC, C=US', issuer: ISSUER }))
  assert.doesNotThrow(() => validateSignature({ status: 'Valid', subject: X_CORP_SIGNER, issuer: X_CORP_ISSUER }))
})

test('a stable signed by X Corp. and a recommendation signed by X.AI LLC are both uploaded', async () => {
  const fixture = createFixture()
  fixture.stable = '1.0.62'
  fixture.dependencies.inspectSignature = async function (filePath) {
    return path.basename(filePath).startsWith('grok-1.0.62-')
      ? { status: 'Valid', subject: X_CORP_SIGNER, issuer: X_CORP_ISSUER }
      : { status: 'Valid', subject: SIGNER, issuer: ISSUER }
  }
  const result = await fixture.run({ recommendedVersion: '1.0.52' })
  assert.deepEqual(versionsOf(result.manifest), ['1.0.62', '1.0.52'])
  assert.equal(fixture.publications.length, 4)
  assert.equal(fixture.pointers.length, 1)
})

test('a pointer changed by another run stops the write; a cleanup failure never hides the first error', async () => {
  const fixture = createFixture()
  fixture.readOverride = (reads) => reads === 1 ? null : { changed: true }
  await assert.rejects(fixture.run(), (error) => {
    assert.deepEqual(safeGrokSyncFailure(error), { stage: 'cos-recheck-latest', latestState: 'not-written-by-this-run', failure: { code: 'cos-index-invalid' } })
    return true
  })
  assert.equal(fixture.pointers.length, 0)

  const raced = createFixture()
  await raced.run()
  const theirs = { ...clone(raced.latest), generatedAt: '2026-10-14T17:00:00.000Z' }
  raced.pointers.length = 0
  raced.reads = 0
  raced.readOverride = (reads) => reads === 2 ? raced.latest : theirs
  await assert.rejects(raced.run(), (error) => {
    assert.deepEqual(safeGrokSyncFailure(error), { stage: 'cos-recheck-latest', latestState: 'not-written-by-this-run', failure: { code: 'cos-index-changed' } })
    return true
  })
  assert.equal(raced.pointers.length, 0)

  const failing = createFixture()
  failing.publicationError = true
  failing.dependencies.removeWorkDirectory = async function () { throw new Error('CLEANUP-SECRET') }
  const events = []
  await assert.rejects(failing.run({ progress: (event) => events.push(event) }), (error) => {
    const diagnostic = safeGrokSyncFailure(error)
    assert.equal(diagnostic.stage, 'cos-publish-binary')
    assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET/)
    return true
  })
  assert.doesNotMatch(JSON.stringify(events), /SECRET/)
  assert.deepEqual(safeGrokSyncFailure(new Error('SECRET')), { stage: 'setup', latestState: 'not-written-by-this-run', failure: { code: 'operation-failed' } })
})

test('an existing pointer must describe this bucket and the exact object layout', async () => {
  const fixture = createFixture()
  await fixture.run()
  const good = clone(fixture.latest)
  for (const mutate of [
    (value) => { value.product = 'claude' },
    (value) => { value.stable.url = 'https://evil.invalid/stable' },
    (value) => { value.stable.version = '1.0.99' },
    (value) => { value.releases[0].files.pop() },
    (value) => { value.releases[0].files[1] = clone(value.releases[0].files[0]) },
    (value) => { value.releases.push(clone(value.releases[0])) },
    (value) => { value.releases[0].files[0].key = 'xingmang/offline/grok/latest.json' },
    (value) => { value.releases[0].files[0].sourceUrl = 'https://evil.invalid/grok.exe' },
    (value) => { value.releases[0].files[0].verification = 'none' },
    (value) => { value.releases[0].files[0].contentType = 'text/html' },
    (value) => { value.releases[0].files[0].bytes = 1 },
    (value) => { value.releases[0].files[0].cosEtag = '' },
  ]) {
    const value = clone(good)
    mutate(value)
    assert.throws(() => validateLatest(value, fixture.store.publicUrl), (error) => safeSyncFailure(error).code === 'cos-index-invalid')
  }
  const elsewhere = createFixture()
  const moved = clone(good)
  moved.releases[0].files[0].url = `https://other-bucket.cos.ap-shanghai.myqcloud.com/${moved.releases[0].files[0].key}`
  elsewhere.latest = moved
  await assert.rejects(elsewhere.run(), (error) => {
    assert.deepEqual(safeGrokSyncFailure(error), { stage: 'cos-read-latest', latestState: 'not-written-by-this-run', failure: { code: 'cos-index-invalid' } })
    return true
  })
  assert.equal(elsewhere.downloads.length, 0)
})

test('the PE header check reads the machine field without running the file', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-pe-test-'))
  try {
    function pe(machine, { offset = 0x80, signature = 0x00004550 } = {}) {
      const buffer = Buffer.alloc(0x200)
      buffer.writeUInt16LE(0x5a4d, 0)
      buffer.writeUInt32LE(offset, 0x3c)
      if (offset + 6 <= buffer.length) {
        buffer.writeUInt32LE(signature, offset)
        buffer.writeUInt16LE(machine, offset + 4)
      }
      return buffer
    }
    const cases = [
      ['x64.exe', pe(PLATFORMS['windows-x64'].machine), PLATFORMS['windows-x64'].machine],
      ['arm64.exe', pe(PLATFORMS['windows-arm64'].machine), PLATFORMS['windows-arm64'].machine],
    ]
    for (const [name, body, machine] of cases) {
      await fs.writeFile(path.join(directory, name), body)
      assert.equal(await readPeMachine(path.join(directory, name)), machine)
    }
    for (const [name, body] of [
      ['html.exe', Buffer.from('<html>blocked</html>'.padEnd(128, ' '))],
      ['offset.exe', pe(0x8664, { offset: 0x20 })],
      ['missing.exe', pe(0x8664, { signature: 0x12345678 })],
    ]) {
      await fs.writeFile(path.join(directory, name), body)
      await assert.rejects(readPeMachine(path.join(directory, name)), (error) => safeSyncFailure(error).code === 'package-format-invalid')
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('the signature probe uses the fixed Windows PowerShell with a minimal environment', async () => {
  await assert.rejects(inspectSignature('C:\\work\\grok.exe', os.tmpdir(), async function () { throw new Error('not reached') }, 'linux'), (error) => {
    assert.match(error.message, /Windows runner/)
    assert.deepEqual(safeSyncFailure(error), { code: 'inspector-unavailable' })
    return true
  })
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-signature-test-'))
  try {
    const calls = []
    const result = await inspectSignature(path.join(directory, 'grok.exe'), directory, async function (executable, args, options) {
      calls.push({ executable, args, options })
      return { stdout: `\uFEFF${JSON.stringify({ status: 'Valid', subject: SIGNER, issuer: ISSUER })}\r\n` }
    }, 'win32')
    assert.deepEqual(result, { status: 'Valid', subject: SIGNER, issuer: ISSUER })
    assert.equal(calls[0].executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.deepEqual(calls[0].args.slice(0, 6), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])
    assert.deepEqual(calls[0].args.slice(7), ['-FilePath', path.join(directory, 'grok.exe')])
    assert.deepEqual(Object.keys(calls[0].options.env).sort(), ['PSModulePath', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR'])
    assert.match(await fs.readFile(calls[0].args[6], 'utf8'), /Get-AuthenticodeSignature -LiteralPath \$FilePath/)
    assert.match(await fs.readFile(calls[0].args[6], 'utf8'), /issuer=if\(\$signature\.SignerCertificate\)\{\[string\]\$signature\.SignerCertificate\.Issuer\}/)
    await assert.rejects(inspectSignature(path.join(directory, 'grok.exe'), directory, async function () { return { stdout: 'not json' } }, 'win32'), (error) => {
      assert.match(error.message, /无法解析/)
      assert.deepEqual(safeSyncFailure(error), { code: 'inspection-unparsable' })
      return true
    })
    await assert.rejects(inspectSignature(path.join(directory, 'grok.exe'), directory, async function () {
      throw Object.assign(new Error('Command failed: SECRET'), { code: 1, killed: false, stdout: 'SECRET', stderr: 'SECRET' })
    }, 'win32'), (error) => {
      assert.match(error.message, /签名检查失败/)
      // Only how PowerShell ended is kept, never what it printed.
      assert.deepEqual(safeSyncFailure(error), { code: 'inspector-failed', observed: { exitCode: 1, timedOut: false } })
      return true
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('runtime temp directories are created under the real temp root and only they can be removed', async () => {
  const runtime = createRuntimeDependencies({})
  const directory = await runtime.createWorkDirectory()
  try {
    assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir()))
    assert.match(path.basename(directory), /^xingmang-grok-cos-/)
    await assert.rejects(runtime.removeWorkDirectory(path.join(directory, 'nested')), (error) => /拒绝删除/.test(error.message) && safeSyncFailure(error).code === 'temp-path-rejected')
    await assert.rejects(runtime.removeWorkDirectory(path.join(path.dirname(directory), 'unrelated')), /拒绝删除/)
  } finally {
    await runtime.removeWorkDirectory(directory)
  }
  await assert.rejects(fs.access(directory), { code: 'ENOENT' })
})
