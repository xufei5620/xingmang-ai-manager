const { setTimeout: delay } = require('node:timers/promises')

// GitHub-hosted runners lose the whole route to COS Shanghai for minutes at a
// time: on 2026-10-04 every in-flight part stalled together and then failed
// with header timeouts and EPIPE, and a 30-second HEAD timeout ended a backfill
// on its first try. Attempts spent within seconds cannot outlast that, so the
// waits grow to one or two minutes before a transfer is given up.
const RETRY_POLICIES = Object.freeze({
  // HEAD and full GET readbacks never change remote state.
  read: Object.freeze({ attempts: 12, baseMs: 2000, maxMs: 60 * 1000 }),
  // Writes repeat only where the caller has proven a repeat is harmless.
  write: Object.freeze({ attempts: 10, baseMs: 5000, maxMs: 2 * 60 * 1000 }),
})

function computeRetryDelay(policy, retryIndex, random = Math.random) {
  // Half of each step is fixed so an outage is really waited out; the other
  // half is random so part workers that failed together reconnect at different
  // moments instead of in lockstep.
  const step = Math.min(policy.maxMs, policy.baseMs * 2 ** retryIndex)
  const sample = random()
  const jitter = Number.isFinite(sample) && sample >= 0 && sample <= 1 ? sample : 0.5
  return Math.round(step / 2 + step / 2 * jitter)
}

function waitForRetry(milliseconds, signal) {
  return delay(milliseconds, undefined, signal ? { signal } : {})
}

async function retryTransfer(operation, { policy, shouldRetry, beforeRetry, onRetry, sleep = waitForRetry, random = Math.random, signal }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt)
    } catch (error) {
      if (attempt >= policy.attempts || !(await shouldRetry(error))) throw error
      const delayMs = computeRetryDelay(policy, attempt - 1, random)
      // The caller may veto the wait (deadline reached, a sibling worker
      // failed). Its error then replaces the transient one, exactly as a check
      // made before the next attempt would.
      if (beforeRetry) beforeRetry(delayMs)
      try { onRetry?.({ attempt, delayMs, error }) } catch {}
      await sleep(delayMs, signal)
    }
  }
}

module.exports = { RETRY_POLICIES, computeRetryDelay, retryTransfer }
