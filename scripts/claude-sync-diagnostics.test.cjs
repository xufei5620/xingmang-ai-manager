const assert = require('node:assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('node:events')
const common = require('./cos-sync-utils.cjs')
const { createClaudeStageRunner, safeClaudeSyncFailure } = require('./claude-sync-diagnostics.cjs')

const STAGES = ['cos-read-latest', 'source-resolve', 'source-head', 'cos-check-existing', 'prepare-temp',
  'source-download', 'native-inspect', 'native-validate', 'cos-publish-package', 'cos-head-package',
  'validate-latest', 'source-recheck', 'cos-publish-candidate', 'cos-recheck-latest', 'cos-publish-latest',
  'cos-confirm-latest', 'cleanup-temp']
const PLATFORMS = ['windows-x64', 'windows-arm64', 'macos-dmg-universal', 'macos-pkg-universal', 'linux-deb-x64', 'linux-deb-arm64']
const MAX_BYTES = 2 * 1024 * 1024 * 1024
const SETUP_FAILURE = { stage: 'setup', latestState: 'not-written-by-this-run', failure: { code: 'operation-failed' } }

async function mockOwnedNetworkError() {
  try {
    await common.fetchText({ url: 'https://mock-source.invalid/package', allowedHosts: ['mock-source.invalid'], expectedBytes: 512 }, {
      requestImpl() {
        const request = new EventEmitter()
        request.end = () => queueMicrotask(() => request.emit('error', Object.assign(new Error('Bearer SECRET https://signed.invalid/?token=SECRET'), { code: 'ECONNRESET' })))
        request.destroy = () => {}
        return request
      },
    })
  } catch (error) { return error }
  throw new Error('Expected mock network failure')
}

test('accepts only the fixed stages and six platforms and returns operation results without logging them', async () => {
  const events = []
  const stage = createClaudeStageRunner(value => events.push(value), () => 'not-written-by-this-run')
  for (const name of STAGES) assert.equal(await stage(name, {}, async () => 'SECRET result'), 'SECRET result')
  for (const platform of PLATFORMS) await stage('source-resolve', { platform, expectedBytes: 0 }, async () => {})
  await stage('source-head', { expectedBytes: MAX_BYTES }, async () => {})
  assert.equal(events.filter(value => value.event === 'stage-start').length, STAGES.length + PLATFORMS.length + 1)
  assert.ok(events.some(value => value.expectedBytes === MAX_BYTES))
  assert.doesNotMatch(JSON.stringify(events), /SECRET/)
})

test('rejects unknown stages, platforms and byte inputs before running the operation', async () => {
  let operations = 0
  const events = []
  const stage = createClaudeStageRunner(value => events.push(value))
  for (const [name, input] of [['unknown', {}], ['SECRET stage', {}], [null, {}],
    ['source-head', { platform: 'macos-arm64' }], ['source-head', { platform: 'SECRET' }],
    ['source-head', { expectedBytes: -1 }], ['source-head', { expectedBytes: MAX_BYTES + 1 }],
    ['source-head', { expectedBytes: 0.5 }], ['source-head', { expectedBytes: '512' }],
    ['source-head', null], ['source-head', []]]) {
    await assert.rejects(stage(name, input, async () => { operations += 1 }), error => {
      assert.deepEqual(safeClaudeSyncFailure(error), SETUP_FAILURE)
      return true
    })
  }
  assert.equal(operations, 0)
  assert.deepEqual(events, [])
})

test('drops other input fields without evaluating their getters or allowing them to override the stage', async () => {
  const events = []
  const input = { platform: 'windows-x64', expectedBytes: 512, stage: 'SECRET', latestState: 'SECRET' }
  for (const field of ['sourceURI', 'headers', 'nativeOutput', 'diagnostic']) {
    Object.defineProperty(input, field, { enumerable: true, get() { throw new Error('Must not inspect SECRET fields') } })
  }
  const stage = createClaudeStageRunner(value => events.push(value))
  await stage('source-head', input, async () => {})
  assert.deepEqual(events.map(({ elapsedMs, ...value }) => value), [
    { event: 'stage-start', stage: 'source-head', platform: 'windows-x64', expectedBytes: 512 },
    { event: 'stage-complete', stage: 'source-head', platform: 'windows-x64', expectedBytes: 512 },
  ])
})

test('unowned errors and forged diagnostic getters always produce setup failure without property access', () => {
  const forged = new Error('SECRET raw error')
  for (const field of ['diagnostic', 'syncFailure', 'stage', 'latestState', 'cause', 'message']) {
    Object.defineProperty(forged, field, { get() { throw new Error('Must not read forged fields') } })
  }
  for (const error of [forged, new Proxy({}, { get() { throw new Error('Must not inspect proxy') } }), null, undefined, 'SECRET']) {
    assert.deepEqual(safeClaudeSyncFailure(error), SETUP_FAILURE)
  }
})

test('classifies only privately owned network causes inside a stage without attributing downloads to uploads', async () => {
  const cause = await mockOwnedNetworkError()
  assert.deepEqual(safeClaudeSyncFailure(cause), SETUP_FAILURE)
  const events = []
  const stage = createClaudeStageRunner(value => events.push(value), () => 'not-written-by-this-run')
  await assert.rejects(stage('source-download', { platform: 'windows-arm64', expectedBytes: 512 }, async () => { throw cause }), error => {
    assert.deepEqual(safeClaudeSyncFailure(error), {
      stage: 'source-download', platform: 'windows-arm64', expectedBytes: 512, latestState: 'not-written-by-this-run',
      failure: { code: 'network-request-failed', method: 'GET', phase: 'response-headers', transportCode: 'ECONNRESET', transferredBytes: 0, expectedBytes: 512 },
    })
    return true
  })
  assert.doesNotMatch(JSON.stringify(events), /SECRET|signed\.invalid|Authorization|Bearer|https:/i)
})

test('preserves error messages and the original mount-cleanup flag while refusing forged diagnostics', async () => {
  const cause = new Error('Original native failure SECRET')
  cause.preserveWorkDirectory = true
  Object.defineProperty(cause, 'diagnostic', { get() { throw new Error('Must not read forged diagnostic') } })
  const stage = createClaudeStageRunner(() => { throw new Error('Logger failure SECRET') }, () => 'published-and-read-back')
  await assert.rejects(stage('native-inspect', { platform: 'macos-dmg-universal' }, async () => { throw cause }), error => {
    assert.equal(error.message, cause.message)
    assert.equal(error.preserveWorkDirectory, true)
    assert.deepEqual(safeClaudeSyncFailure(error), { stage: 'native-inspect', platform: 'macos-dmg-universal',
      latestState: 'published-and-read-back', failure: { code: 'operation-failed' } })
    return true
  })
})

test('bounds pointer states and ignores pointer callbacks that throw without replacing the primary error', async () => {
  for (const state of ['not-written-by-this-run', 'write-unconfirmed', 'published-and-read-back', 'SECRET']) {
    const stage = createClaudeStageRunner(undefined, () => state)
    await assert.rejects(stage('cos-publish-latest', {}, async () => { throw new Error('Primary failure') }), error => {
      assert.equal(error.message, 'Primary failure')
      assert.equal(safeClaudeSyncFailure(error).latestState, state === 'SECRET' ? 'not-written-by-this-run' : state)
      return true
    })
  }
  const stage = createClaudeStageRunner(undefined, () => { throw new Error('SECRET pointer callback') })
  await assert.rejects(stage('cleanup-temp', {}, async () => { throw new Error('Primary failure') }), error => {
    assert.equal(error.message, 'Primary failure')
    assert.equal(safeClaudeSyncFailure(error).latestState, 'not-written-by-this-run')
    return true
  })
})

test('filters transfer metadata and byte ranges while keeping elapsed times monotonic', async () => {
  const events = []
  const stage = createClaudeStageRunner(value => events.push(value))
  await stage('source-download', { expectedBytes: 512 }, async onProgress => {
    onProgress({ method: 'GET', phase: 'response-body', transferredBytes: 32, expectedBytes: 512,
      elapsedMs: -1, url: 'https://signed.invalid/SECRET', headers: 'SECRET', nativeOutput: 'SECRET' })
    onProgress({ method: 'HEAD', phase: 'response-headers', transferredBytes: 0, expectedBytes: MAX_BYTES })
    onProgress({ method: 'PUT', phase: 'complete', transferredBytes: MAX_BYTES, expectedBytes: 0 })
    onProgress({ method: 'SECRET', phase: 'SECRET', transferredBytes: -1, expectedBytes: MAX_BYTES + 1 })
    onProgress({ method: 'GET', phase: 'upload-body', transferredBytes: 0.5, expectedBytes: '512' })
    const forged = {}
    Object.defineProperty(forged, 'method', { get() { throw new Error('Must not read forged transfer getter') } })
    Object.defineProperty(forged, 'headers', { get() { throw new Error('Must not read SECRET headers') } })
    onProgress(forged)
  })
  const transfers = events.filter(value => value.event === 'transfer')
  assert.deepEqual(transfers.slice(0, 5).map(({ event, stage, expectedBytes, elapsedMs, ...value }) => value), [
    { method: 'GET', transferPhase: 'response-body', transferredBytes: 32, transferExpectedBytes: 512 },
    { method: 'HEAD', transferPhase: 'response-headers', transferredBytes: 0, transferExpectedBytes: MAX_BYTES },
    { method: 'PUT', transferPhase: 'complete', transferredBytes: MAX_BYTES, transferExpectedBytes: 0 },
    {}, { method: 'GET', transferPhase: 'upload-body' },
  ])
  assert.doesNotMatch(JSON.stringify(events), /SECRET|signed\.invalid|"headers"\s*:|nativeOutput|https:/)
  for (let index = 0; index < events.length; index += 1) {
    assert.ok(events[index].elapsedMs >= 0)
    if (index > 0) assert.ok(events[index].elapsedMs >= events[index - 1].elapsedMs)
  }
})

test('uses thirty-second heartbeats and clears them on both completion and failure', async t => {
  const intervals = []
  const cleared = []
  t.mock.method(global, 'setInterval', (callback, delay) => {
    const handle = { callback, delay }
    intervals.push(handle)
    return handle
  })
  t.mock.method(global, 'clearInterval', handle => cleared.push(handle))
  const events = []
  const stage = createClaudeStageRunner(value => events.push(value))
  let release
  let lateProgress
  const pending = new Promise(resolve => { release = resolve })
  const operation = stage('source-download', { expectedBytes: 512 }, async onProgress => {
    lateProgress = onProgress
    onProgress({ method: 'GET', phase: 'response-body', transferredBytes: 32, expectedBytes: 512 })
    return pending
  })
  assert.equal(intervals[0].delay, 30000)
  intervals[0].callback()
  assert.ok(events.some(value => value.event === 'stage-wait' && value.transferredBytes === 32 && value.transferExpectedBytes === 512))
  release('done')
  assert.equal(await operation, 'done')
  const completedEvents = events.length
  lateProgress({ method: 'GET', phase: 'complete', transferredBytes: 512 })
  intervals[0].callback()
  assert.equal(events.length, completedEvents)
  await assert.rejects(stage('cleanup-temp', {}, async () => { throw new Error('Cleanup failure') }))
  assert.deepEqual(cleared, intervals)
  const silent = createClaudeStageRunner()
  await silent('prepare-temp', {}, async () => {})
  assert.equal(intervals.length, 2)
})
