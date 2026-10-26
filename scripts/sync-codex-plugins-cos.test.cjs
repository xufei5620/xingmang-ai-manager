const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHash, randomBytes } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Readable, Writable } = require('node:stream')
const zlib = require('node:zlib')
const { fetchText } = require('./cos-sync-utils.cjs')
const {
  API_HOST, ARCHIVE_HOST, COMMIT_URL, LATEST_KEY, CONTENT_TYPE, MIN_ARCHIVE_BYTES,
  archiveUrl, artifactKey, parseCommit, validateLatest, inspectCatalogArchive, commitRequest,
  synchronizeCodexPlugins, createRuntimeDependencies, safeCodexPluginsSyncFailure,
} = require('./sync-codex-plugins-cos.cjs')

const COMMIT = '1dc19589aa0d3f1c2b4e5f60718293a4b5c6d7e8'
const NEXT_COMMIT = '2ab19589aa0d3f1c2b4e5f60718293a4b5c6d7e9'
const TOKEN = 'ghs_0123456789abcdefghijABCDEFGHIJ'
// Random bytes keep the gzip above the minimum archive size the client accepts.
const PADDING = randomBytes(MIN_ARCHIVE_BYTES + 4096).toString('base64')

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, '0')}\0`
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  let length = Buffer.byteLength(body) + 1
  while (`${length}`.length + Buffer.byteLength(body) !== length) length += 1
  return `${length}${body}`
}

function tar(entries, { end = true } = {}) {
  const blocks = []
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '')
    const header = Buffer.alloc(512)
    header.write(entry.name.slice(0, 100), 0, 'utf8')
    header.write(octal(entry.mode ?? 0o644, 8), 100, 'ascii')
    header.write(octal(0, 8), 108, 'ascii')
    header.write(octal(0, 8), 116, 'ascii')
    header.write(octal(data.length, 12), 124, 'ascii')
    header.write(octal(0, 12), 136, 'ascii')
    header.write('        ', 148, 'ascii')
    header.write(entry.type ?? '0', 156, 'ascii')
    header.write('ustar\0', 257, 'ascii')
    header.write('00', 263, 'ascii')
    let checksum = 0
    for (const byte of header) checksum += byte
    header.write(octal(checksum, 7), 148, 'ascii')
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  if (end) blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

function catalogEntries({ commit = COMMIT, extra = [], api = '{"name":"openai-api-curated","plugins":[{"name":"demo","source":{"source":"local","path":"./plugins/demo"}}]}' } = {}) {
  return [
    { name: 'pax_global_header', type: 'g', data: paxRecord('comment', commit) },
    { name: `plugins-${commit}/`, type: '5', mode: 0o755 },
    { name: `plugins-${commit}/.agents/plugins/marketplace.json`, data: '{"name":"openai-curated","plugins":[]}' },
    ...(api === null ? [] : [{ name: `plugins-${commit}/.agents/plugins/api_marketplace.json`, data: api }]),
    { name: `plugins-${commit}/plugins/demo/.codex-plugin/plugin.json`, data: '{"name":"demo"}' },
    { name: `plugins-${commit}/plugins/demo/assets/noise.txt`, data: PADDING },
    ...extra,
  ]
}

function archive(options) {
  return zlib.gzipSync(tar(catalogEntries(options)))
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function createFixture() {
  const fixture = {
    commit: COMMIT,
    archives: new Map([[COMMIT, archive()], [NEXT_COMMIT, archive({ commit: NEXT_COMMIT })]]),
    latest: null,
    objects: new Map(),
    publications: [],
    pointers: [],
    downloads: [],
    commitRequests: [],
    removed: [],
    reads: 0,
  }
  fixture.dependencies = {
    async fetchText(input) {
      fixture.commitRequests.push(clone(input))
      return `${fixture.commit}\n`
    },
    async downloadResource(input) {
      fixture.downloads.push(clone({ ...input, onProgress: undefined }))
      const body = fixture.archives.get(input.url.split('/').pop())
      assert.ok(body, `Unexpected archive URL ${input.url}`)
      return { bytes: body.length, sha256: sha256(body), etag: '"codeload"' }
    },
    async readFile(filePath) {
      return fixture.archives.get(path.basename(filePath).replace(/^openai-plugins-|\.tar\.gz$/g, ''))
    },
    async createWorkDirectory() { return path.resolve(os.tmpdir(), 'mock-codex-plugins-cos') },
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
      fixture.publications.push({ key, filePath, ...input })
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
    return synchronizeCodexPlugins({ store: fixture.store, dependencies: fixture.dependencies, token: TOKEN, now: function () { return '2026-10-13T16:00:00.000Z' }, ...extra })
  }
  return fixture
}

test('the commit lookup names main on the fixed API host and only sends a well-formed token', () => {
  const request = commitRequest(TOKEN)
  assert.equal(request.url, COMMIT_URL)
  assert.equal(COMMIT_URL, 'https://api.github.com/repos/openai/plugins/commits/main')
  assert.deepEqual(request.allowedHosts, [API_HOST])
  assert.equal(request.headers.accept, 'application/vnd.github.sha')
  assert.match(request.headers['user-agent'], /xingmang/)
  assert.equal(request.headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(commitRequest(undefined).headers.authorization, undefined)
  assert.equal(commitRequest('token\r\nx-evil: 1').headers.authorization, undefined)
  assert.equal(parseCommit(`${COMMIT}\n`), COMMIT)
  for (const value of ['', 'main', COMMIT.toUpperCase(), `${COMMIT}0`, '{"sha":"x"}', null]) assert.throws(() => parseCommit(value), /提交号/)
})

test('a valid catalog reports both marketplaces and the archive is bound to the requested commit', () => {
  assert.deepEqual(inspectCatalogArchive(archive(), COMMIT).plugins, { 'openai-curated': 0, 'openai-api-curated': 1 })
  assert.equal(archiveUrl(COMMIT), `https://${ARCHIVE_HOST}/openai/plugins/tar.gz/${COMMIT}`)
  assert.equal(artifactKey(COMMIT, 'a'.repeat(64)), `xingmang/offline/codex-plugins/sha256-${'a'.repeat(64)}/openai-plugins-${COMMIT}.tar.gz`)
})

test('archives the client would refuse are refused before anything is uploaded', async () => {
  const cases = [
    [archive({ commit: NEXT_COMMIT }), 'commit-mismatch'],
    [archive({ api: null }), 'manifest-missing'],
    [archive({ api: '{"name":"openai-curated","plugins":[]}' }), 'manifest-invalid'],
    [archive({ api: '{"name":"openai-api-curated","plugins":[{"name":"x","source":{"source":"local"}}]}' }), 'manifest-invalid'],
    [archive({ extra: [{ name: `plugins-${COMMIT}/../outside.txt`, data: 'x' }] }), 'unsafe-path'],
    [archive({ extra: [{ name: `plugins-${COMMIT}/plugins/demo/CON`, data: 'x' }] }), 'unsafe-path'],
    [archive({ extra: [{ name: `plugins-${COMMIT}/plugins/demo/file.`, data: 'x' }] }), 'unsafe-path'],
    [archive({ extra: [{ name: `plugins-${COMMIT}/plugins/demo/a\\b`, data: 'x' }] }), 'unsafe-path'],
    [archive({ extra: [{ name: `plugins-${COMMIT}/plugins/Demo/.codex-plugin/plugin.json`, data: 'x' }] }), 'duplicate-path'],
    [zlib.gzipSync(tar(catalogEntries(), { end: false })), 'truncated'],
    [Buffer.concat([Buffer.from('<html>rate limited</html>'), randomBytes(MIN_ARCHIVE_BYTES)]), 'not-gzip'],
  ]
  for (const [buffer, code] of cases) {
    assert.throws(() => inspectCatalogArchive(buffer, COMMIT), Error, code)
    const fixture = createFixture()
    fixture.archives.set(COMMIT, buffer)
    await assert.rejects(fixture.run(), (error) => {
      const diagnostic = safeCodexPluginsSyncFailure(error)
      assert.equal(diagnostic.stage, 'verify-archive', code)
      assert.equal(diagnostic.archiveCheck, code)
      return true
    })
    assert.equal(fixture.publications.length, 0, code)
    assert.equal(fixture.pointers.length, 0, code)
  }
})

test('the first run uploads the verified archive under its digest, then writes the pointer last', async () => {
  const fixture = createFixture()
  const result = await fixture.run()
  const body = fixture.archives.get(COMMIT)
  const key = artifactKey(COMMIT, sha256(body))
  assert.equal(result.changed, true)
  assert.deepEqual(result.plugins, { 'openai-curated': 0, 'openai-api-curated': 1 })
  assert.equal(fixture.downloads.length, 1)
  assert.equal(fixture.downloads[0].url, archiveUrl(COMMIT))
  assert.deepEqual(fixture.downloads[0].allowedHosts, [ARCHIVE_HOST])
  assert.equal(fixture.commitRequests[0].headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(fixture.publications.length, 1)
  assert.equal(fixture.publications[0].key, key)
  assert.equal(fixture.publications[0].contentType, CONTENT_TYPE)
  assert.match(fixture.publications[0].cacheControl, /immutable/)
  assert.deepEqual(fixture.pointers, [{
    schemaVersion: 1,
    product: 'codex-plugin-catalog',
    generatedAt: '2026-10-13T16:00:00.000Z',
    source: { repository: 'openai/plugins', ref: 'main', commit: COMMIT, url: archiveUrl(COMMIT) },
    artifact: { key, url: fixture.store.publicUrl(key), bytes: body.length, sha256: sha256(body), contentType: 'application/gzip',
      verification: 'github-commit-archive-manifests', cosEtag: `"cos-${sha256(body).slice(0, 16)}"` },
  }])
  assert.equal(validateLatest(fixture.latest), fixture.latest)
  assert.equal(fixture.removed.length, 1)
})

// The commit lookup goes through the real shared transport; only the socket is fake.
// `answer` gets whether the request carried a token and returns [status, body].
function githubCommitApi(fixture, answer) {
  fixture.dependencies.fetchText = function (input) {
    fixture.commitRequests.push(clone(input))
    return fetchText(input, { requestImpl(url, options, callback) {
      const [status, body] = answer(Boolean(options.headers.authorization))
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

test('GitHub refusing the workflow token falls back to one anonymous lookup of the same commit', async () => {
  const fixture = createFixture()
  githubCommitApi(fixture, (withToken) => withToken ? [403, 'Although you appear to have the correct authorization credentials, the organization has an IP allow list enabled'] : [200, `${COMMIT}\n`])
  const events = []
  const result = await fixture.run({ progress: (event) => events.push(event) })
  assert.equal(result.changed, true)
  assert.equal(fixture.latest.source.commit, COMMIT)
  assert.equal(fixture.commitRequests.length, 2)
  assert.equal(fixture.commitRequests[0].headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(fixture.commitRequests[1].headers.authorization, undefined)
  for (const request of fixture.commitRequests) {
    assert.equal(request.url, COMMIT_URL)
    assert.deepEqual(request.allowedHosts, [API_HOST])
    assert.equal(request.maxBytes, 256)
  }
  const failed = events.find((event) => event.event === 'stage-failed')
  assert.equal(failed.stage, 'source-commit')
  assert.deepEqual(failed.diagnostic.failure, { code: 'http-status', method: 'GET', phase: 'response-headers', status: 403, transferredBytes: 0 })
  assert.ok(events.some((event) => event.event === 'stage-complete' && event.stage === 'source-commit-anonymous'))
  assert.doesNotMatch(JSON.stringify(events), /Bearer|ghs_|allow list/)
})

test('only a refused token is retried without it, and only once', async () => {
  const refusedTwice = createFixture()
  githubCommitApi(refusedTwice, () => [403, ''])
  await assert.rejects(refusedTwice.run(), (error) => {
    const diagnostic = safeCodexPluginsSyncFailure(error)
    assert.equal(diagnostic.stage, 'source-commit-anonymous')
    assert.equal(diagnostic.failure.status, 403)
    return true
  })
  assert.equal(refusedTwice.commitRequests.length, 2)

  const noToken = createFixture()
  githubCommitApi(noToken, () => [403, ''])
  await assert.rejects(noToken.run({ token: undefined }), (error) => safeCodexPluginsSyncFailure(error).stage === 'source-commit')
  assert.equal(noToken.commitRequests.length, 1)

  for (const status of [404, 429, 500]) {
    const other = createFixture()
    githubCommitApi(other, () => [status, ''])
    await assert.rejects(other.run(), (error) => safeCodexPluginsSyncFailure(error).failure.status === status)
    assert.equal(other.commitRequests.length, 1, String(status))
  }

  const malformed = createFixture()
  githubCommitApi(malformed, (withToken) => withToken ? [403, ''] : [200, 'main'])
  await assert.rejects(malformed.run(), (error) => safeCodexPluginsSyncFailure(error).stage === 'source-commit-anonymous')
  for (const fixture of [refusedTwice, noToken, malformed]) {
    assert.equal(fixture.downloads.length, 0)
    assert.equal(fixture.publications.length, 0)
    assert.equal(fixture.pointers.length, 0)
  }
})

test('an unchanged main and an intact bucket copy mean no download and no write', async () => {
  const fixture = createFixture()
  await fixture.run()
  const result = await fixture.run()
  assert.equal(result.changed, false)
  assert.equal(fixture.downloads.length, 1)
  assert.equal(fixture.publications.length, 1)
  assert.equal(fixture.pointers.length, 1)
})

test('a new commit on main is published and replaces the pointer; a damaged copy of the same commit is repaired', async () => {
  const fixture = createFixture()
  await fixture.run()
  fixture.commit = NEXT_COMMIT
  const next = await fixture.run()
  assert.equal(next.changed, true)
  assert.equal(fixture.latest.source.commit, NEXT_COMMIT)
  assert.equal(fixture.publications.length, 2)

  const key = fixture.latest.artifact.key
  fixture.objects.set(key, { ...fixture.objects.get(key), etag: '"replaced-by-hand"' })
  const repaired = await fixture.run()
  assert.equal(repaired.changed, true)
  assert.equal(fixture.downloads.length, 3)
  assert.equal(fixture.pointers.length, 3)
})

test('a refused archive leaves the bucket untouched and names the failed check without leaking details', async () => {
  const fixture = createFixture()
  fixture.archives.set(COMMIT, archive({ extra: [{ name: `plugins-${COMMIT}/../SECRET-PATH`, data: 'x' }] }))
  const events = []
  await assert.rejects(fixture.run({ progress: (event) => events.push(event) }), (error) => {
    const diagnostic = safeCodexPluginsSyncFailure(error)
    assert.equal(diagnostic.stage, 'verify-archive')
    assert.equal(diagnostic.archiveCheck, 'unsafe-path')
    assert.equal(diagnostic.latestState, 'not-written-by-this-run')
    return true
  })
  assert.equal(fixture.publications.length, 0)
  assert.equal(fixture.pointers.length, 0)
  assert.equal(fixture.removed.length, 1)
  assert.doesNotMatch(JSON.stringify(events), /SECRET|Bearer|ghs_/)
})

test('a pointer changed by another run stops the write; a cleanup failure never hides the first error', async () => {
  const fixture = createFixture()
  fixture.readOverride = (reads) => reads === 1 ? null : { changed: true }
  await assert.rejects(fixture.run(), (error) => safeCodexPluginsSyncFailure(error).stage === 'cos-recheck-latest')
  assert.equal(fixture.pointers.length, 0)

  const failing = createFixture()
  failing.publicationError = true
  failing.dependencies.removeWorkDirectory = async function () { throw new Error('CLEANUP-SECRET') }
  await assert.rejects(failing.run(), (error) => {
    const diagnostic = safeCodexPluginsSyncFailure(error)
    assert.equal(diagnostic.stage, 'cos-publish-archive')
    assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET/)
    return true
  })
  assert.deepEqual(safeCodexPluginsSyncFailure(new Error('SECRET')), { stage: 'setup', latestState: 'not-written-by-this-run', failure: { code: 'operation-failed' } })
})

test('an existing pointer must describe this bucket and the exact object layout', async () => {
  const fixture = createFixture()
  await fixture.run()
  const good = clone(fixture.latest)
  for (const mutate of [
    (value) => { value.product = 'chatgpt' },
    (value) => { value.source.repository = 'evil/plugins' },
    (value) => { value.source.url = 'https://evil.invalid/plugins.tar.gz' },
    (value) => { value.artifact.key = 'xingmang/offline/codex-plugins/latest.json' },
    (value) => { value.artifact.contentType = 'text/html' },
    (value) => { value.artifact.bytes = 1 },
    (value) => { value.artifact.cosEtag = '' },
  ]) {
    const value = clone(good)
    mutate(value)
    assert.throws(() => validateLatest(value))
  }
  const elsewhere = createFixture()
  elsewhere.latest = { ...clone(good), artifact: { ...good.artifact, url: `https://other-bucket.cos.ap-shanghai.myqcloud.com/${good.artifact.key}` } }
  await assert.rejects(elsewhere.run(), (error) => safeCodexPluginsSyncFailure(error).stage === 'cos-read-latest')
  assert.equal(elsewhere.downloads.length, 0)
})

test('runtime temp directories are created under the real temp root and only they can be removed', async () => {
  const runtime = createRuntimeDependencies({})
  const directory = await runtime.createWorkDirectory()
  try {
    assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir()))
    assert.match(path.basename(directory), /^xingmang-codex-plugins-cos-/)
    await assert.rejects(runtime.removeWorkDirectory(path.join(directory, 'nested')), /拒绝删除/)
    await assert.rejects(runtime.removeWorkDirectory(path.join(path.dirname(directory), 'unrelated')), /拒绝删除/)
  } finally {
    await runtime.removeWorkDirectory(directory)
  }
  await assert.rejects(fs.access(directory), { code: 'ENOENT' })
})
