const assert = require('node:assert/strict')
const { test } = require('node:test')
const { Readable, Writable } = require('node:stream')
const { probeMacUpdate, safeMetadata } = require('./public-claude-mac-update-probe.cjs')

const INSTALL_ID = '11111111-2222-4333-8444-555555555555'

function fixture({ status = 200, headers = {}, body = '{}' } = {}) {
  const calls = []
  function requestImpl(url, options, callback) {
    calls.push({ url, options })
    const request = new Writable({ write() { assert.fail('no request body') } })
    request.on('finish', function () {
      const response = status !== 200 || Object.hasOwn(headers, 'cf-mitigated')
        ? new Readable({ read() { assert.fail('blocked response body must not be consumed') } }) : Readable.from([Buffer.from(body)])
      response.statusCode = status
      response.headers = headers
      response.complete = true
      callback(response)
      if (status !== 200 || Object.hasOwn(headers, 'cf-mitigated')) assert.equal(response.destroyed, true)
    })
    return request
  }
  return { calls, options: { platform: 'darwin', architecture: 'arm64', requestImpl,
    async run(executable, argv, options) {
      assert.equal(executable, '/usr/bin/sw_vers')
      assert.deepEqual(argv, ['-productVersion'])
      assert.equal(options.timeout, 5000)
      assert.equal(options.maxBuffer, 256)
      assert.equal(options.env.HOME, undefined)
      return { stdout: '15.7\n' }
    },
    createId() { return INSTALL_ID },
  } }
}

test('issues one exact SDK request using native OS, verified version, and a private ephemeral installation UUID', async () => {
  const value = fixture({ body: JSON.stringify({ url: 'https://downloads.claude.ai/releases/darwin/universal/2.19676.0/Claude-public.zip?sig=SECRET',
    name: '2.19676.0', size: 377037896, sha256: 'a'.repeat(64), notes: 'SECRET', delta: { url: 'https://unknown.test/SECRET' } }) })
  const row = await probeMacUpdate(value.options)
  assert.equal(value.calls.length, 1)
  const { url, options } = value.calls[0]
  assert.equal(url.origin, 'https://api.anthropic.com')
  assert.equal(url.pathname, '/api/desktop/darwin/arm64/squirrel/update')
  assert.deepEqual([...url.searchParams], [['device_id', INSTALL_ID], ['version', '2.19675.0'], ['os_version', '15.7']])
  assert.equal(options.method, 'GET')
  assert.deepEqual(options.headers, { accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': 'xingmang-official-offline-sync/1' })
  assert.equal(row.schema, 'squirrel-server-json')
  assert.equal(row.payload.queryPresent, true)
  assert.equal(row.claimedNameVersion, '2.19676.0')
  assert.equal(row.claimedSize, 377037896)
  assert.equal(row.claimedSha256, 'a'.repeat(64))
  assert.equal(row.claimScope, 'public-metadata-not-file-verification')
  assert.doesNotMatch(JSON.stringify(row), new RegExp(`${INSTALL_ID}|device_id|SECRET|sig=|notes|unknown\\.test`))
})

test('records no-update honestly and stops before bodies for unauthorized, challenge, and redirect responses', async () => {
  for (const [status, headers, expected] of [[204, {}, 'no-update'], [401, {}, 'unauthorized'],
    [403, { 'cf-mitigated': 'challenge' }, 'challenge'], [302, { location: 'https://unknown.test/?SECRET' }, 'redirect-rejected']]) {
    const value = fixture({ status, headers })
    const row = await probeMacUpdate(value.options)
    assert.equal(value.calls.length, 1)
    assert.equal(row.status, status)
    assert.equal(row.code, expected)
    assert.equal(row.metadataBytesConsumed, 0)
    assert.equal(row.payload, undefined)
    assert.doesNotMatch(JSON.stringify(row), /SECRET|device_id/)
  }
})

test('rejects unrecognized payload sources and unsafe metadata fields without exposing their values', () => {
  for (const url of ['https://unknown.test/SECRET.zip', 'https://downloads.claude.ai:443/releases/SECRET.zip',
    'https://user:SECRET@downloads.claude.ai/releases/SECRET.zip', 'https://downloads.claude.ai/releases/SECRET%2fprivate.zip',
    'http://downloads.claude.ai/releases/SECRET.zip']) {
    const row = safeMetadata({ url, version: 'SECRET', size: 2 * 1024 * 1024 * 1024 + 1, sha256: 'SECRET' })
    assert.equal(row.schema, 'squirrel-server-json-unverified-url')
    assert.equal(row.payload, undefined)
    assert.equal(row.claimedVersion, undefined)
    assert.equal(row.claimedSize, undefined)
    assert.equal(row.claimedSha256, undefined)
    assert.doesNotMatch(JSON.stringify(row), /SECRET/)
  }
})

test('bounds metadata before JSON parsing and never treats HTML as an update schema', async () => {
  for (const [body, code] of [['SECRET'.repeat(180000), 'metadata-body-too-large'], ['<html>SECRET</html>', 'metadata-not-json']]) {
    const value = fixture({ body })
    const row = await probeMacUpdate(value.options)
    assert.equal(row.code, code)
    assert.equal(row.payload, undefined)
    assert.doesNotMatch(JSON.stringify(row), /SECRET/)
  }
})

test('refuses nonnative or malformed fixture scope before issuing any network request', async () => {
  for (const override of [{ platform: 'win32' }, { architecture: 'universal' }, { deadlineMs: 30001 }, { createId: () => 'SECRET' }]) {
    const value = fixture()
    await assert.rejects(probeMacUpdate({ ...value.options, ...override }), /Unsupported/)
    assert.equal(value.calls.length, 0)
  }
})

function staticMetadata() {
  return { currentRelease: '2.19675.0', releases: [{ version: '2.19675.0', updateTo: {
    version: '2.19675.0', url: 'https://downloads.claude.ai/releases/darwin/universal/2.19675.0/Claude-public.zip',
    name: '2.19675.0', pub_date: '2026-10-02T03:04:05Z', size: 377037896, sha256: 'a'.repeat(64), notes: 'SECRET',
  } }] }
}

test('reads only the unique currentRelease updateTo using the official static JSON schema and keeps fields claimed', async () => {
  const metadata = staticMetadata()
  metadata.releases.unshift({ version: '2.19674.0', updateTo: { url: 'https://unknown.test/SECRET.zip', notes: 'SECRET' } })
  const value = fixture({ body: JSON.stringify(metadata) })
  const row = await probeMacUpdate(value.options)
  assert.equal(value.calls.length, 1)
  assert.equal(row.schema, 'squirrel-static-json')
  assert.equal(row.releaseCount, 2)
  assert.equal(row.matchingReleaseCount, 1)
  assert.equal(row.selectedRelease.metadataPath, 'releases[].updateTo')
  assert.equal(row.selectedRelease.claimedVersion, '2.19675.0')
  assert.equal(row.selectedRelease.claimedName, '2.19675.0')
  assert.equal(row.selectedRelease.claimedPubDate, '2026-10-02T03:04:05Z')
  assert.equal(row.selectedRelease.claimedSize, 377037896)
  assert.equal(row.selectedRelease.claimedSha256, 'a'.repeat(64))
  assert.equal(row.selectedRelease.payload.eligibleAsPersistentSource, true)
  assert.equal(row.claimScope, 'public-metadata-not-file-verification')
  assert.doesNotMatch(JSON.stringify(row), /SECRET|unknown\.test|device_id|notes/)
})

test('refuses ambiguous or missing selections and mismatched updateTo versions', () => {
  const duplicated = staticMetadata()
  duplicated.releases.push(structuredClone(duplicated.releases[0]))
  assert.equal(safeMetadata(duplicated).schema, 'squirrel-static-json-ambiguous-selection')
  const missing = staticMetadata()
  missing.currentRelease = '2.19676.0'
  assert.equal(safeMetadata(missing).schema, 'squirrel-static-json-missing-selection')
  const mismatch = staticMetadata()
  mismatch.releases[0].updateTo.version = '2.19676.0'
  assert.equal(safeMetadata(mismatch).schema, 'squirrel-static-json-version-mismatch')
})

test('bounds every array and object layer and does not descend into overdeep or malformed metadata', () => {
  const oversized = staticMetadata()
  oversized.releases = Array.from({ length: 17 }, () => structuredClone(oversized.releases[0]))
  assert.deepEqual(safeMetadata(oversized), { schema: 'metadata-shape-rejected' })
  const deep = staticMetadata()
  deep.releases[0].updateTo.extra = { private: 'SECRET' }
  assert.deepEqual(safeMetadata(deep), { schema: 'metadata-shape-rejected' })
  const wide = staticMetadata()
  for (let index = 0; index < 33; index += 1) wide[`extra-${index}`] = 'SECRET'
  assert.deepEqual(safeMetadata(wide), { schema: 'metadata-shape-rejected' })
  const malformed = staticMetadata()
  malformed.releases[0].updateTo = []
  assert.equal(safeMetadata(malformed).schema, 'squirrel-static-json-invalid-releases')
})

test('marks signed-query payloads as unsuitable for a persistent source and excludes unsafe nested sources', () => {
  const signed = staticMetadata()
  signed.releases[0].updateTo.url += '?sig=SECRET'
  const row = safeMetadata(signed)
  assert.equal(row.selectedRelease.payload.queryPresent, true)
  assert.equal(row.selectedRelease.payload.eligibleAsPersistentSource, false)
  assert.doesNotMatch(JSON.stringify(row), /SECRET|sig=/)
  signed.releases[0].updateTo.url = 'https://unknown.test/SECRET.zip'
  const unknown = safeMetadata(signed)
  assert.equal(unknown.schema, 'squirrel-static-json-unverified-payload')
  assert.equal(unknown.selectedRelease.payload, undefined)
  assert.doesNotMatch(JSON.stringify(unknown), /SECRET|unknown\.test/)
})
