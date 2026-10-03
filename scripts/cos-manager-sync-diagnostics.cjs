const { safeSyncFailure } = require('./cos-sync-utils.cjs')

const stages = new Set(['github-release-metadata', 'prepare-temp', 'github-download-location', 'github-download-installer', 'verify-github-installer', 'prepare-manager-plan', 'cos-manager-publication', 'cos-read-latest', 'cos-validate-index', 'cos-publish-file', 'cos-recheck-latest', 'cos-publish-candidate', 'cos-recheck-candidate-state', 'cos-publish-latest', 'cleanup-temp'])
const latestStates = new Set(['not-written-by-this-run', 'write-unconfirmed', 'published-and-read-back'])
const failures = new WeakMap()
const probeFailures = new WeakMap()
const probeCodes = new Set(['github-head-timeout', 'github-head-network-failed', 'github-head-http-status', 'github-head-redirect-rejected'])
const transportCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID'])

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

function createManagerSyncDiagnostics(observer, pointerState) {
  function emit(value) {
    if (typeof observer === 'function') { try { Promise.resolve(observer(value)).catch(function () {}) } catch {} }
  }
  return async function (stage, input, operation) {
    function context() { return safeContext(stage, input, pointerState()) }
    emit({ event: 'stage-start', ...context() })
    try {
      const result = await operation()
      emit({ event: 'stage-complete', ...context() })
      return result
    } catch (error) {
      // Keep the original message in memory for existing callers, but never
      // serialize exceptions: only private, owned records reach the CLI log.
      const wrapped = new Error(error instanceof Error ? error.message : '星芒 COS 同步阶段失败')
      const snapshot = context()
      const nested = failures.get(error)
      if (nested) snapshot.latestState = nested.context.latestState
      failures.set(wrapped, { error, context: snapshot })
      emit({ event: 'stage-failed', ...snapshot, diagnostic: safeManagerSyncFailure(wrapped) })
      throw wrapped
    }
  }
}

module.exports = { createManagerProbeFailure, createManagerSyncDiagnostics, safeManagerSyncFailure }
