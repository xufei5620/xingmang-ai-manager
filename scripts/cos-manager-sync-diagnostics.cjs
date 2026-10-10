const { performance } = require('node:perf_hooks')
const { safeSyncFailure } = require('./cos-sync-utils.cjs')

const stages = new Set(['github-release-metadata', 'prepare-temp', 'github-download-location', 'github-download-installer', 'verify-github-installer', 'prepare-manager-plan', 'cos-manager-publication', 'cos-read-latest', 'cos-validate-index', 'cos-publish-file', 'cos-verify-history-file', 'cos-recheck-latest', 'cos-publish-candidate', 'cos-recheck-candidate-state', 'cos-publish-latest', 'cleanup-temp'])
const latestStates = new Set(['not-written-by-this-run', 'write-unconfirmed', 'published-and-read-back'])
const failures = new WeakMap()
const probeFailures = new WeakMap()
const probeCodes = new Set(['github-head-timeout', 'github-head-network-failed', 'github-head-http-status', 'github-head-redirect-rejected'])
const transportCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID'])
const transferMethods = new Set(['GET', 'HEAD', 'PUT'])
const transferPhases = new Set(['upload-body', 'response-headers', 'response-body', 'complete'])
const MAX_TRANSFER_BYTES = 2 * 1024 * 1024 * 1024
const MAX_RETRY_DELAY_MS = 10 * 60 * 1000

function createManagerProbeFailure(code, message, details = {}) {
  const error = new Error(message)
  const failure = { code: probeCodes.has(code) ? code : 'operation-failed', method: 'HEAD' }
  if (Number.isInteger(details.status) && details.status >= 100 && details.status <= 599) failure.status = details.status
  if (transportCodes.has(details.transportCode)) failure.transportCode = details.transportCode
  if (['invalid-start', 'missing-location', 'redirect-limit', 'invalid-target', 'repository-switch'].includes(details.reason)) failure.reason = details.reason
  probeFailures.set(error, failure)
  return error
}

function safeLeafFailure(error) {
  return probeFailures.has(error) ? { ...probeFailures.get(error) } : safeSyncFailure(error)
}

// Progress values come from the store, but are copied field by field like any
// other input: a getter or an extra property must never reach the log.
function readOwnData(value, field) {
  if (!value || typeof value !== 'object') return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
  } catch { return undefined }
}

function safeTransfer(value) {
  const result = {}
  const method = readOwnData(value, 'method')
  const phase = readOwnData(value, 'phase')
  if (transferMethods.has(method)) result.method = method
  if (transferPhases.has(phase)) result.transferPhase = phase
  for (const [field, name] of [['transferredBytes', 'transferredBytes'], ['expectedBytes', 'transferExpectedBytes']]) {
    const bytes = readOwnData(value, field)
    if (Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= MAX_TRANSFER_BYTES) result[name] = bytes
  }
  return result
}

function safeRetry(value) {
  const result = {}
  const attempt = readOwnData(value, 'attempt')
  const delayMs = readOwnData(value, 'delayMs')
  if (Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= 100) result.attempt = attempt
  if (Number.isSafeInteger(delayMs) && delayMs >= 0 && delayMs <= MAX_RETRY_DELAY_MS) result.delayMs = delayMs
  // The store hands over its own error; only the owned failure record is read.
  result.failure = safeLeafFailure(readOwnData(value, 'error'))
  return result
}

function safeContext(stage, input, state) {
  const result = { stage: stages.has(stage) ? stage : 'setup', latestState: latestStates.has(state) ? state : 'not-written-by-this-run' }
  if (typeof input.version === 'string' && input.version.length <= 32 && /^\d+\.\d+\.\d+$/.test(input.version)) result.version = input.version
  if (['windows', 'macos', 'linux'].includes(input.platform)) result.platform = input.platform
  if (['x64', 'arm64', 'universal'].includes(input.architecture)) result.architecture = input.architecture
  return result
}

function safeManagerSyncFailure(error, seen = new WeakSet(), depth = 0) {
  const record = failures.get(error)
  if (!record || seen.has(error) || depth > 3) return { stage: 'setup', latestState: 'not-written-by-this-run', failure: safeLeafFailure(error) }
  seen.add(error)
  return { ...record.context, failure: failures.has(record.error) ? safeManagerSyncFailure(record.error, seen, depth + 1) : safeLeafFailure(record.error) }
}

function createManagerSyncDiagnostics(observer, pointerState, { heartbeatMs = 30000 } = {}) {
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) throw new Error('星芒 COS 同步进度间隔无效')
  function emit(value) {
    if (typeof observer === 'function') { try { Promise.resolve(observer(value)).catch(function () {}) } catch {} }
  }
  return async function (stage, input, operation) {
    function context() { return safeContext(stage, input, pointerState()) }
    const started = performance.now()
    let active = true
    let lastTransfer
    let heartbeat
    function elapsedMs() { return Math.round(performance.now() - started) }
    // An installer upload runs for many minutes. Part commits arrive every few
    // seconds, so they are only remembered and a heartbeat prints the latest one;
    // a stage that never reports a transfer stays as quiet as before.
    const report = {
      transfer(value) {
        if (!active) return
        lastTransfer = safeTransfer(value)
        if (!heartbeat && typeof observer === 'function') {
          heartbeat = setInterval(function () { emit({ event: 'stage-wait', ...context(), elapsedMs: elapsedMs(), ...lastTransfer }) }, heartbeatMs)
        }
      },
      retry(value) {
        if (active) emit({ event: 'retry', ...context(), elapsedMs: elapsedMs(), ...safeRetry(value) })
      },
    }
    emit({ event: 'stage-start', ...context() })
    try {
      const result = await operation(report)
      emit({ event: 'stage-complete', ...context(), elapsedMs: elapsedMs() })
      return result
    } catch (error) {
      // Keep the original message in memory for existing callers, but never
      // serialize exceptions: only private, owned records reach the CLI log.
      const wrapped = new Error(error instanceof Error ? error.message : '星芒 COS 同步阶段失败')
      const snapshot = context()
      const nested = failures.get(error)
      if (nested) snapshot.latestState = nested.context.latestState
      failures.set(wrapped, { error, context: snapshot })
      emit({ event: 'stage-failed', ...snapshot, elapsedMs: elapsedMs(), diagnostic: safeManagerSyncFailure(wrapped) })
      throw wrapped
    } finally {
      active = false
      clearInterval(heartbeat)
    }
  }
}

module.exports = { createManagerProbeFailure, createManagerSyncDiagnostics, safeManagerSyncFailure }
