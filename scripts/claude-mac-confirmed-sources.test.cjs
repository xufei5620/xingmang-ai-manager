const assert = require('node:assert/strict')
const { test } = require('node:test')
const { getConfirmedMacSource, validateConfirmedMacSourceRecord, sameConfirmedMacSourceResolution } = require('./claude-mac-confirmed-sources.cjs')

const VERSION = '2.19675.0'
const RELEASE_ID = '5706e5524dba58b23e105c31c358df8ab0a95852'
const SOURCES = {
  'macos-dmg-universal': { format: 'dmg', bytes: 377037896, sha256: 'c0e6e512c5913e20567cdbfad33f8622e69ab39a2a9886bf2a752b2ab06455cb' },
  'macos-pkg-universal': { format: 'pkg', bytes: 384935158, sha256: '5c8d7ec0fc49121d29bf80ea08b754b1ce486afd695fec157de97de8dbef080e' },
}

function recordFor(platformId = 'macos-dmg-universal') {
  const resource = getConfirmedMacSource(platformId)
  return { requestUrl: resource.url, bytes: resource.bytes, etag: '"confirmed"', lastModified: null,
    resolvedHost: 'downloads.claude.ai', redirectCount: 0, sourceResolution: { ...resource.sourceResolution } }
}

function validateRecord(record, platformId = 'macos-dmg-universal', version = VERSION, sha256 = SOURCES[platformId]?.sha256) {
  return validateConfirmedMacSourceRecord(record, platformId, version, sha256)
}

test('returns immutable independently confirmed DMG and PKG resources with exact byte and local digest evidence', () => {
  for (const [id, expected] of Object.entries(SOURCES)) {
    const source = getConfirmedMacSource(id)
    assert.deepEqual(source, {
      url: `https://downloads.claude.ai/releases/darwin/universal/${VERSION}/Claude-${RELEASE_ID}.${expected.format}`,
      version: VERSION,
      bytes: expected.bytes,
      expectedSha256: expected.sha256,
      sourceResolution: { mode: 'operator-confirmed-direct-source', sourceVersion: VERSION,
        sourceSha256: expected.sha256, checksumProvenance: 'operator-official-browser-local-sha256' },
    })
    assert.equal(Object.isFrozen(source), true)
    assert.equal(Object.isFrozen(source.sourceResolution), true)
    assert.throws(() => Object.assign(source, { bytes: 1 }), TypeError)
    assert.throws(() => Object.assign(source.sourceResolution, { sourceSha256: 'wrong' }), TypeError)
    assert.equal(getConfirmedMacSource(id).bytes, expected.bytes)
  }
})

test('rejects unknown platforms without exposing other catalog entries', () => {
  for (const id of ['windows-x64', 'linux-deb-x64', 'macos-dmg-arm64', '__proto__', '', null, undefined]) {
    assert.throws(() => getConfirmedMacSource(id), /平台/)
    assert.throws(() => validateConfirmedMacSourceRecord(recordFor(), id, VERSION, SOURCES['macos-dmg-universal'].sha256), /平台/)
  }
})

test('validates current source records while leaving package byte checks to the producer', () => {
  for (const id of Object.keys(SOURCES)) {
    const record = recordFor(id)
    assert.equal(validateRecord(record, id), record)
    delete record.bytes
    assert.equal(validateRecord(record, id), record)
  }
})

test('keeps prior confirmed releases readable after the active catalog changes', () => {
  for (const [id, source] of Object.entries(SOURCES)) {
    const record = recordFor(id)
    const oldVersion = '1.19500.0'
    const oldSha256 = 'a'.repeat(64)
    record.requestUrl = `https://downloads.claude.ai/releases/darwin/universal/${oldVersion}/Claude-${'b'.repeat(40)}.${source.format}`
    record.sourceResolution.sourceVersion = oldVersion
    record.sourceResolution.sourceSha256 = oldSha256
    assert.equal(validateRecord(record, id, oldVersion, oldSha256), record)
    assert.notEqual(record.requestUrl, getConfirmedMacSource(id).url)
  }
})

test('rejects credentials, queries, fragments, alternate hosts, ports and paths before accepting a recorded direct source', () => {
  const valid = recordFor().requestUrl
  const invalid = [
    valid.replace('https:', 'http:'),
    valid.replace('downloads.claude.ai', 'downloads.claude.ai.evil.invalid'),
    valid.replace('downloads.claude.ai', 'claude.ai'),
    valid.replace('downloads.claude.ai', 'user:password@downloads.claude.ai'),
    valid.replace('downloads.claude.ai', 'downloads.claude.ai:443'),
    valid.replace('downloads.claude.ai', 'downloads.claude.ai:8443'),
    valid + '?token=mock', valid + '?', valid + '#fragment', valid + '#',
    valid.replace('/darwin/universal/', '/darwin/arm64/'),
    valid.replace('/releases/', '/arbitrary/'),
    valid.replace(RELEASE_ID, 'b'.repeat(39)),
    valid.replace(RELEASE_ID, 'g'.repeat(40)),
    valid.replace('.dmg', '.pkg'),
    valid.replace('/Claude-', '/%43laude-'),
    valid.replace('/releases/', '/arbitrary/../releases/'),
    valid + '/extra', ` ${valid}`, 'not a URL', null,
  ]
  for (const url of invalid) assert.throws(() => validateRecord({ ...recordFor(), requestUrl: url }), /来源/)
})

test('requires matching three-part numeric versions in the path, source resolution and manifest file', () => {
  const record = recordFor()
  assert.throws(() => validateRecord(record, 'macos-dmg-universal', '2.19675.1'), /来源/)
  for (const version of ['2.19675', '2.19675.0.1', '2.19675.0-1', '9007199254740992.1.0', 'invalid', null]) {
    const changed = recordFor()
    changed.requestUrl = changed.requestUrl.replace(VERSION, String(version))
    changed.sourceResolution.sourceVersion = version
    assert.throws(() => validateRecord(changed, 'macos-dmg-universal', version), /来源/)
  }
  const changed = recordFor()
  changed.sourceResolution.sourceVersion = '2.19675.1'
  assert.throws(() => validateRecord(changed), /来源/)
})

test('requires local SHA256 equality and exactly the four declared provenance fields', () => {
  assert.throws(() => validateRecord(recordFor(), 'macos-dmg-universal', VERSION, 'f'.repeat(64)), /来源/)
  for (const sha256 of ['not-a-digest', 'a'.repeat(63), 'A'.repeat(64), null]) {
    const record = recordFor()
    record.sourceResolution.sourceSha256 = sha256
    assert.throws(() => validateRecord(record, 'macos-dmg-universal', VERSION, sha256), /来源/)
  }
  const changes = [
    value => { value.mode = 'api-redirect' },
    value => { value.checksumProvenance = 'official-published-checksum' },
    value => { value.token = 'mock-secret' },
    value => { value[Symbol('injected')] = 'mock-secret' },
    value => { Object.defineProperty(value, 'hidden', { value: 'mock-secret' }) },
    value => { delete value.mode },
  ]
  for (const change of changes) {
    const record = recordFor()
    change(record.sourceResolution)
    assert.throws(() => validateRecord(record), /来源/)
  }
  for (const sourceResolution of [null, undefined, [], Object.create(recordFor().sourceResolution)]) {
    assert.throws(() => validateRecord({ ...recordFor(), sourceResolution }), /来源/)
  }
  assert.throws(() => validateRecord(Object.create(recordFor())), /来源/)
})

test('compares source resolutions by meaning instead of insertion order or object identity', () => {
  const left = recordFor().sourceResolution
  const right = { checksumProvenance: left.checksumProvenance, sourceSha256: left.sourceSha256,
    sourceVersion: left.sourceVersion, mode: left.mode }
  assert.equal(sameConfirmedMacSourceResolution(left, right), true)
  for (const [key, value] of Object.entries({ mode: 'api-redirect', sourceVersion: '2.19675.1',
    sourceSha256: 'f'.repeat(64), checksumProvenance: 'official-published-checksum' })) {
    assert.equal(sameConfirmedMacSourceResolution(left, { ...right, [key]: value }), false)
  }
  assert.equal(sameConfirmedMacSourceResolution(left, { ...right, injected: true }), false)
  assert.equal(sameConfirmedMacSourceResolution({}, {}), false)
})

test('preserves legacy absent source-resolution equality without equating it with confirmed evidence', () => {
  assert.equal(sameConfirmedMacSourceResolution(undefined, undefined), true)
  assert.equal(sameConfirmedMacSourceResolution(null, undefined), true)
  assert.equal(sameConfirmedMacSourceResolution(recordFor().sourceResolution, undefined), false)
  assert.equal(sameConfirmedMacSourceResolution(undefined, recordFor().sourceResolution), false)
})
