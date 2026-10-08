const { performance } = require('node:perf_hooks')
const { safeSyncFailure } = require('./cos-sync-utils.cjs')

const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024
const STAGES = new Set(['cos-read-latest', 'source-resolve', 'source-head', 'cos-check-existing', 'prepare-temp',
  'source-download', 'native-inspect', 'native-validate', 'cos-publish-package', 'cos-head-package',
  'validate-latest', 'source-recheck', 'cos-publish-candidate', 'cos-recheck-latest', 'cos-publish-latest',
  'cos-confirm-latest', 'cleanup-temp'])
const PLATFORMS = new Set(['windows-x64', 'windows-arm64', 'macos-dmg-universal', 'macos-pkg-universal', 'linux-deb-x64', 'linux-deb-arm64'])
const POINTER_STATES = new Set(['not-written-by-this-run', 'write-unconfirmed', 'published-and-read-back'])
const TRANSFER_METHODS = new Set(['GET', 'HEAD', 'PUT'])
const TRANSFER_PHASES = new Set(['upload-body', 'response-headers', 'response-body', 'complete'])
const stageFailures = new WeakMap()

function safeClaudeSyncFailure(error) {
  // Ownership comes only from this private map. Reading diagnostic-shaped
  // fields or walking a public cause chain would allow errors to forge context
  // and could invoke getters that disclose credentials or replace the failure.
  const failure = stageFailures.get(error)
  return failure ? { ...failure.context, failure: safeSyncFailure(failure.cause) }
    : { stage: 'setup', latestState: 'not-written-by-this-run', failure: { code: 'operation-failed' } }
}

function isByteCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_PACKAGE_BYTES
}

function readOwnData(value, field) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
  } catch { return undefined }
}

function buildStageContext(name, input) {
  if (typeof name !== 'string' || !STAGES.has(name)) throw new Error('Claude 官方同步阶段无效')
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Claude 官方同步阶段入参无效')
  let platform
  let expectedBytes
  try {
    platform = Object.getOwnPropertyDescriptor(input, 'platform')
    expectedBytes = Object.getOwnPropertyDescriptor(input, 'expectedBytes')
  } catch { throw new Error('Claude 官方同步阶段入参无效') }
  const context = { stage: name }
  if (platform) {
    if (!Object.hasOwn(platform, 'value') || !PLATFORMS.has(platform.value)) throw new Error('Claude 官方同步阶段平台无效')
    context.platform = platform.value
  }
  if (expectedBytes) {
    if (!Object.hasOwn(expectedBytes, 'value') || !isByteCount(expectedBytes.value)) throw new Error('Claude 官方同步阶段字节数无效')
    context.expectedBytes = expectedBytes.value
  }
  return Object.freeze(context)
}

function readPointerState(pointerState) {
  try {
    const value = typeof pointerState === 'function' ? pointerState() : undefined
    if (POINTER_STATES.has(value)) return value
  } catch {}
  return 'not-written-by-this-run'
}

function readOriginalMessage(error) {
  try {
    if (error instanceof Error) {
      const message = readOwnData(error, 'message')
      if (typeof message === 'string') return message
    }
  } catch {}
  return 'Claude 官方同步阶段失败'
}

function createClaudeStageRunner(progress, pointerState) {
  function emit(value) {
    if (typeof progress === 'function') {
      try { progress(value) } catch {}
    }
  }
  return async function stage(name, input = {}, operation) {
    const context = buildStageContext(name, input)
    if (typeof operation !== 'function') throw new Error('Claude 官方同步阶段操作无效')
    const started = performance.now()
    let active = true
    let elapsedMs = 0
    let lastTransfer = {}
    function report(event, extra = {}) {
      if (!active) return
      elapsedMs = Math.max(elapsedMs, Math.round(performance.now() - started))
      emit({ event, ...context, elapsedMs, ...extra })
    }
    function transfer(value) {
      if (!active || !value || typeof value !== 'object') return
      const safe = {}
      const method = readOwnData(value, 'method')
      const phase = readOwnData(value, 'phase')
      if (TRANSFER_METHODS.has(method)) safe.method = method
      if (TRANSFER_PHASES.has(phase)) safe.transferPhase = phase
      for (const field of ['transferredBytes', 'expectedBytes']) {
        const bytes = readOwnData(value, field)
        if (isByteCount(bytes)) safe[field === 'expectedBytes' ? 'transferExpectedBytes' : field] = bytes
      }
      lastTransfer = safe
      report('transfer', safe)
    }
    report('stage-start')
    const heartbeat = typeof progress === 'function' ? setInterval(function () { report('stage-wait', lastTransfer) }, 30000) : null
    try {
      const result = await operation(transfer)
      report('stage-complete')
      return result
    } catch (error) {
      // Preserve the error text for existing callers only; the logger receives
      // safeClaudeSyncFailure, never this Error or native command output.
      const wrapped = new Error(readOriginalMessage(error))
      if (readOwnData(error, 'preserveWorkDirectory') === true) wrapped.preserveWorkDirectory = true
      const owned = stageFailures.get(error)
      stageFailures.set(wrapped, { cause: owned ? owned.cause : error,
        context: Object.freeze({ ...context, latestState: readPointerState(pointerState) }) })
      report('stage-failed', { diagnostic: safeClaudeSyncFailure(wrapped) })
      throw wrapped
    } finally {
      active = false
      if (heartbeat) clearInterval(heartbeat)
    }
  }
}

module.exports = { createClaudeStageRunner, safeClaudeSyncFailure }
