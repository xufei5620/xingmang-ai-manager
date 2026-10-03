const assert = require('node:assert/strict')
const { Readable, Writable } = require('node:stream')
const { test } = require('node:test')
const { fetchJson } = require('./cos-sync-utils.cjs')
const { createManagerSyncDiagnostics, safeManagerSyncFailure } = require('./cos-manager-sync-diagnostics.cjs')

test('safe stage failures retain owned HTTP codes without raw messages, signed URLs or forged context', async () => {
  const events = []
  const stage = createManagerSyncDiagnostics(event => events.push(event), () => 'not-written-by-this-run')
  await assert.rejects(stage('github-release-metadata', { version: '0.2.14', url: 'https://signed.invalid/?token=PRIVATE' }, () => fetchJson({
    url: 'https://example.myqcloud.com/releases', allowedHosts: ['example.myqcloud.com'],
  }, { requestImpl: (url, options, callback) => {
    const request = new Writable({ write(chunk, encoding, done) { done() } })
    request.on('finish', () => {
      const response = Readable.from([Buffer.from('PRIVATE upstream body')])
      response.statusCode = 403
      response.headers = {}
      callback(response)
    })
    return request
  } })), error => {
    const value = safeManagerSyncFailure(error)
    assert.equal(value.stage, 'github-release-metadata')
    assert.equal(value.failure.code, 'http-status')
    assert.equal(value.failure.status, 403)
    return true
  })
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|signed\.invalid|myqcloud|upstream body/)
  const forged = new Error('PRIVATE authorization and file path')
  Object.defineProperty(forged, 'stage', { get() { throw new Error('untrusted getter') } })
  assert.deepEqual(safeManagerSyncFailure(forged), { stage: 'setup', latestState: 'not-written-by-this-run', failure: { code: 'operation-failed' } })
})

test('nested publication failures retain the exact write uncertainty and ignore observer failures', async () => {
  let state = 'write-unconfirmed'
  const inner = createManagerSyncDiagnostics(() => { throw new Error('observer failure') }, () => state)
  const outer = createManagerSyncDiagnostics(undefined, () => 'not-written-by-this-run')
  await assert.rejects(outer('cos-manager-publication', { version: '0.2.14' }, () => inner('cos-publish-latest', { version: '0.2.14' }, () => {
    throw new Error('PRIVATE signed upload URL')
  })), error => {
    const value = safeManagerSyncFailure(error)
    assert.equal(value.latestState, 'write-unconfirmed')
    assert.equal(value.failure.stage, 'cos-publish-latest')
    assert.equal(value.failure.latestState, 'write-unconfirmed')
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE|signed upload/)
    return true
  })
  state = 'published-and-read-back'
  assert.equal(await inner('cos-publish-latest', {}, () => 17), 17)
})

test('diagnostic context excludes invalid version, platform and all additional fields', async () => {
  const events = []
  const stage = createManagerSyncDiagnostics(value => events.push(value), () => 'forged PRIVATE')
  await stage('PRIVATE', { version: '0.2.14 PRIVATE', platform: 'PRIVATE', architecture: 'PRIVATE', filePath: 'PRIVATE', headers: { authorization: 'PRIVATE' } }, () => 1)
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|filePath|headers|authorization/)
  assert.equal(events[0].stage, 'setup')
  assert.equal(events[0].latestState, 'not-written-by-this-run')
})

test('an asynchronously rejected observer never changes success or the original operation failure', async () => {
  const stage = createManagerSyncDiagnostics(async () => { throw new Error('PRIVATE async observer') }, () => 'not-written-by-this-run')
  assert.equal(await stage('prepare-manager-plan', {}, () => 19), 19)
  await assert.rejects(stage('prepare-manager-plan', {}, () => { throw new Error('operation fixture failure') }), /operation fixture failure/)
  await new Promise(resolve => setImmediate(resolve))
})
