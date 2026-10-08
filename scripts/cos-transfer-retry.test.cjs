const assert = require('node:assert/strict')
const { test } = require('node:test')
const { RETRY_POLICIES, computeRetryDelay, retryTransfer } = require('./cos-transfer-retry.cjs')

test('waits grow from a few seconds to the policy cap and always keep their fixed half', () => {
  const read = RETRY_POLICIES.read
  const write = RETRY_POLICIES.write
  assert.deepEqual(Array.from({ length: 7 }, (_, index) => computeRetryDelay(read, index, () => 0)), [1000, 2000, 4000, 8000, 16000, 30000, 30000])
  assert.deepEqual(Array.from({ length: 7 }, (_, index) => computeRetryDelay(read, index, () => 1)), [2000, 4000, 8000, 16000, 32000, 60000, 60000])
  assert.deepEqual(Array.from({ length: 7 }, (_, index) => computeRetryDelay(write, index, () => 0)), [2500, 5000, 10000, 20000, 40000, 60000, 60000])
  assert.equal(computeRetryDelay(write, 30, () => 1), 120000)
  for (const sample of [Number.NaN, -1, 2, Infinity]) assert.equal(computeRetryDelay(write, 0, () => sample), 3750)
})

test('both policies leave several minutes of waiting before a transfer is given up', () => {
  // A blackout seen on 2026-10-04 lasted minutes; the waits alone must cover it
  // even when every attempt fails at once instead of timing out.
  for (const policy of Object.values(RETRY_POLICIES)) {
    let shortest = 0
    for (let index = 0; index < policy.attempts - 1; index += 1) shortest += computeRetryDelay(policy, index, () => 0)
    assert.ok(shortest >= 3 * 60 * 1000, `${policy.attempts} attempts wait only ${shortest} ms`)
  }
})

test('a retryable failure is repeated until the policy runs out and then surfaces unchanged', async () => {
  const failure = new Error('transient')
  const waits = []
  const retries = []
  let calls = 0
  await assert.rejects(retryTransfer(async function (attempt) {
    calls += 1
    assert.equal(attempt, calls)
    throw failure
  }, {
    policy: { attempts: 4, baseMs: 10, maxMs: 25 },
    shouldRetry: error => error === failure,
    sleep: async (milliseconds, signal) => { waits.push([milliseconds, signal]) },
    random: () => 0,
    onRetry: value => retries.push(value),
  }), error => error === failure)
  assert.equal(calls, 4)
  assert.deepEqual(waits, [[5, undefined], [10, undefined], [13, undefined]])
  assert.deepEqual(retries.map(({ attempt, delayMs, error }) => [attempt, delayMs, error === failure]), [[1, 5, true], [2, 10, true], [3, 13, true]])
})

test('a final answer, a vetoed wait or a throwing observer never turns into another attempt', async () => {
  const final = new Error('final')
  let calls = 0
  await assert.rejects(retryTransfer(async function () { calls += 1; throw final }, {
    policy: RETRY_POLICIES.write, shouldRetry: () => false, sleep: async () => assert.fail('must not wait'),
  }), error => error === final)
  assert.equal(calls, 1)

  const veto = new Error('deadline')
  calls = 0
  await assert.rejects(retryTransfer(async function () { calls += 1; throw new Error('transient') }, {
    policy: RETRY_POLICIES.write, shouldRetry: () => true, beforeRetry: () => { throw veto }, sleep: async () => assert.fail('must not wait'),
  }), error => error === veto)
  assert.equal(calls, 1)

  calls = 0
  const result = await retryTransfer(async function () {
    calls += 1
    if (calls === 1) throw new Error('transient')
    return 'done'
  }, { policy: RETRY_POLICIES.read, shouldRetry: async () => true, onRetry: () => { throw new Error('observer failure') }, sleep: async () => {} })
  assert.equal(result, 'done')
  assert.equal(calls, 2)
})

test('an aborted signal ends a real wait early instead of sleeping it out', async () => {
  const controller = new AbortController()
  const reason = new Error('sibling failed')
  const run = retryTransfer(async function () { throw new Error('transient') }, {
    policy: RETRY_POLICIES.write, shouldRetry: () => true, signal: controller.signal,
  })
  setImmediate(() => controller.abort(reason))
  await assert.rejects(run, error => error.name === 'AbortError' && error.cause === reason)
})
