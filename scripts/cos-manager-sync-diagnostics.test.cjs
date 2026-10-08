const assert = require('node:assert/strict')
const { Readable, Writable } = require('node:stream')
const { test } = require('node:test')
const { setTimeout: delay } = require('node:timers/promises')
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

async function ownedHttpFailure(status) {
  try {
    await fetchJson({ url: 'https://example.myqcloud.com/latest.json', allowedHosts: ['example.myqcloud.com'] }, { requestImpl: (url, options, callback) => {
      const request = new Writable({ write(chunk, encoding, done) { done() } })
      request.on('finish', () => {
        const response = Readable.from([Buffer.from('PRIVATE upstream body')])
        response.statusCode = status
        response.headers = {}
        callback(response)
      })
      return request
    } })
  } catch (error) { return error }
  assert.fail('the fixture request must fail')
}

async function waitFor(condition) {
  for (let turn = 0; turn < 400 && !condition(); turn += 1) await delay(5)
  assert.ok(condition(), 'the expected event never arrived')
}

test('retry events carry the stage, the attempt and the wait but only the owned failure code', async () => {
  const events = []
  const stage = createManagerSyncDiagnostics(event => events.push(event), () => 'not-written-by-this-run')
  const busy = await ownedHttpFailure(503)
  const forged = Object.assign(new Error('PRIVATE signed URL'), { status: 503, code: 'ECONNRESET' })
  const result = await stage('cos-publish-file', { version: '0.2.16', platform: 'macos', architecture: 'arm64' }, report => {
    report.retry({ attempt: 2, delayMs: 5000, error: busy, url: 'https://signed.invalid/?token=PRIVATE' })
    report.retry({ attempt: 0, delayMs: -1, error: forged })
    report.retry({ attempt: 3, delayMs: 11 * 60 * 1000, get error() { throw new Error('PRIVATE getter') } })
    report.retry(null)
    return 23
  })
  assert.equal(result, 23)
  const context = { event: 'retry', stage: 'cos-publish-file', latestState: 'not-written-by-this-run', version: '0.2.16', platform: 'macos', architecture: 'arm64' }
  const retries = events.filter(event => event.event === 'retry')
  for (const retry of retries) assert.ok(Number.isSafeInteger(retry.elapsedMs) && retry.elapsedMs >= 0)
  assert.deepEqual(retries.map(({ elapsedMs, ...value }) => value), [
    { ...context, attempt: 2, delayMs: 5000, failure: { code: 'http-status', method: 'GET', phase: 'response-headers', status: 503, transferredBytes: 0 } },
    { ...context, failure: { code: 'operation-failed' } },
    { ...context, attempt: 3, failure: { code: 'operation-failed' } },
    { ...context, failure: { code: 'operation-failed' } },
  ])
  assert.ok(Number.isSafeInteger(events.at(-1).elapsedMs))
  assert.equal(events.at(-1).event, 'stage-complete')
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|signed\.invalid|myqcloud|https:|upstream body/)
})

test('a long transfer prints a heartbeat with the latest progress until its stage ends', async () => {
  const events = []
  const stage = createManagerSyncDiagnostics(event => events.push(event), () => 'not-written-by-this-run', { heartbeatMs: 5 })
  const waits = () => events.filter(event => event.event === 'stage-wait')
  let report
  await stage('cos-publish-file', { version: '0.2.16', platform: 'windows', architecture: 'x64' }, async value => {
    report = value
    report.transfer({ method: 'PUT', phase: 'upload-body', transferredBytes: 1048576, expectedBytes: 121063667, url: 'https://signed.invalid/?token=PRIVATE' })
    await waitFor(() => waits().length > 0)
    report.transfer({ method: 'PUT', phase: 'upload-body', transferredBytes: 2097152, expectedBytes: 121063667 })
    await waitFor(() => waits().at(-1).transferredBytes === 2097152)
    // Fields outside the allow-list, accessors and impossible sizes are dropped.
    report.transfer({ method: 'DELETE', phase: 'PRIVATE', get transferredBytes() { throw new Error('PRIVATE getter') }, expectedBytes: 3 * 1024 * 1024 * 1024 })
    await waitFor(() => waits().at(-1).method === undefined)
  })
  const { elapsedMs, ...first } = waits()[0]
  assert.ok(Number.isSafeInteger(elapsedMs) && elapsedMs >= 0)
  assert.deepEqual(first, {
    event: 'stage-wait', stage: 'cos-publish-file', latestState: 'not-written-by-this-run', version: '0.2.16', platform: 'windows', architecture: 'x64',
    method: 'PUT', transferPhase: 'upload-body', transferredBytes: 1048576, transferExpectedBytes: 121063667,
  })
  const { elapsedMs: lastElapsedMs, ...last } = waits().at(-1)
  assert.deepEqual(last, { event: 'stage-wait', stage: 'cos-publish-file', latestState: 'not-written-by-this-run', version: '0.2.16', platform: 'windows', architecture: 'x64' })
  assert.ok(lastElapsedMs >= elapsedMs)
  // Once the stage has ended the heartbeat stops and late reports are ignored.
  const settled = events.length
  assert.equal(events.at(-1).event, 'stage-complete')
  report.transfer({ method: 'PUT', phase: 'upload-body', transferredBytes: 1, expectedBytes: 2 })
  report.retry({ attempt: 1, delayMs: 1 })
  await delay(40)
  assert.equal(events.length, settled)
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|signed\.invalid|https:/)
})

test('a stage that reports no transfer stays quiet and an invalid heartbeat interval is refused', async () => {
  const events = []
  const stage = createManagerSyncDiagnostics(event => events.push(event), () => 'not-written-by-this-run', { heartbeatMs: 1 })
  await stage('cos-read-latest', { version: '0.2.16' }, async () => { await delay(20) })
  await assert.rejects(stage('cos-read-latest', { version: '0.2.16' }, async report => {
    report.transfer({ method: 'GET', phase: 'response-body', transferredBytes: 1, expectedBytes: 2 })
    throw new Error('PRIVATE readback failure')
  }), /PRIVATE readback failure/)
  await delay(20)
  assert.deepEqual(events.map(event => event.event), ['stage-start', 'stage-complete', 'stage-start', 'stage-failed'])
  assert.ok(Number.isSafeInteger(events[1].elapsedMs) && events[1].elapsedMs >= 0)
  assert.ok(Number.isSafeInteger(events[3].elapsedMs))
  // The failure record kept for the final error carries no timing.
  assert.equal(Object.hasOwn(events[3].diagnostic, 'elapsedMs'), false)
  for (const heartbeatMs of [0, -1, 1.5, Number.NaN, '30000']) {
    assert.throws(() => createManagerSyncDiagnostics(undefined, () => 'not-written-by-this-run', { heartbeatMs }), /进度间隔无效/)
  }
})
