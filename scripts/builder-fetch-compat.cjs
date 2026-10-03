const DEFAULT_REQUEST_TIMEOUT_MS = 600000
const transientDownloadCodes = new Set([
  'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOENT',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
])

let undici
let proxyInitialized = false

function resolveUndici() {
  if (!undici) {
    const peer = require('undici')
    if (typeof peer.EnvHttpProxyAgent !== 'function' || typeof peer.setGlobalDispatcher !== 'function') {
      throw new Error('构建下载代理依赖不完整')
    }
    undici = peer
  }
  return undici
}

function initializeProxyOnce(get) {
  if (!get || typeof get.initializeProxy !== 'function') {
    throw new Error('构建下载接口版本不兼容')
  }
  if (proxyInitialized) return
  try {
    const peer = resolveUndici()
    // @electron/get's optional proxy initializer swallows failures. The locked
    // mandatory peer must initialize successfully instead of falling back to
    // a direct connection. EnvHttpProxyAgent owns standard proxy/NO_PROXY rules.
    peer.setGlobalDispatcher(new peer.EnvHttpProxyAgent({
      connect: { rejectUnauthorized: true },
      requestTls: { rejectUnauthorized: true },
      proxyTls: { rejectUnauthorized: true },
    }))
    proxyInitialized = true
  } catch {
    // Constructor errors may contain an authenticated proxy URL.
    throw new Error('构建下载代理初始化失败，请重新安装锁定的构建依赖并检查代理配置')
  }
}

function resolveSourceTlsDispatcher(https, dispatcher) {
  if (https === undefined || https === null) return dispatcher
  if (typeof https !== 'object' || Array.isArray(https)
    || Object.keys(https).some(key => key !== 'rejectUnauthorized')
    || (https.rejectUnauthorized !== undefined && typeof https.rejectUnauthorized !== 'boolean')) {
    throw new Error('构建下载 TLS 配置不受支持，不能静默忽略')
  }
  if (https.rejectUnauthorized === false) {
    throw new Error('构建下载不允许关闭 TLS 证书校验，请修正 TLS 配置')
  }
  return dispatcher
}

function buildAttemptConfig(config = {}, downloadOptions = {}) {
  const originalOptions = config.downloadOptions || {}
  const { timeout, agent, https, signal, dispatcher, ...fetchOptions } = {
    ...originalOptions,
    ...downloadOptions,
  }
  if (agent !== undefined && agent !== null) {
    throw new Error('构建下载不支持旧版显式代理 agent，请使用标准 HTTP(S)_PROXY 和 NO_PROXY 配置')
  }
  const timeoutMs = typeof timeout === 'number' ? timeout : timeout?.request ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 4294967295) {
    throw new Error('构建下载请求超时必须是有效的正整数毫秒数')
  }
  const explicitSignals = [...new Set([config.signal, originalOptions.signal, downloadOptions.signal, signal])]
    .filter(value => value !== undefined && value !== null)
  if (explicitSignals.some(value => !(value instanceof AbortSignal))) {
    throw new Error('构建下载取消信号无效')
  }
  const effectiveDispatcher = resolveSourceTlsDispatcher(https, dispatcher)
  // The deadline is recreated inside every retry invocation, rather than once
  // before retry(). Preserve caller cancellation alongside that fresh deadline.
  const deadline = AbortSignal.timeout(timeoutMs)
  const attemptSignal = explicitSignals.length ? AbortSignal.any([deadline, ...explicitSignals]) : deadline
  return {
    ...config,
    downloadOptions: {
      ...fetchOptions,
      signal: attemptSignal,
      ...(effectiveDispatcher !== undefined && effectiveDispatcher !== null ? { dispatcher: effectiveDispatcher } : {}),
    },
  }
}

function shouldRetryDownloadError(error) {
  if (!error || typeof error !== 'object') return false
  const status = error.response?.status ?? error.response?.statusCode ?? error.statusCode
  if (typeof status === 'number') return status >= 500
  if (error.name === 'TimeoutError' || error.cause?.name === 'TimeoutError') return true
  const code = typeof error.code === 'string' ? error.code : error.cause?.code
  return transientDownloadCodes.has(code)
}

module.exports = {
  initializeProxyOnce,
  buildAttemptConfig,
  shouldRetryDownloadError,
}
