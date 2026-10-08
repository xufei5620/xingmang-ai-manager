const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

function loadHelper(overrides = {}, abortSignal = AbortSignal) {
  const constructors = []
  const dispatchers = []
  class EnvHttpProxyAgent {
    constructor(options) {
      this.options = options
      constructors.push(this)
    }
  }
  const peer = {
    EnvHttpProxyAgent,
    setGlobalDispatcher(dispatcher) { dispatchers.push(dispatcher) },
    ...overrides,
  }
  const context = {
    module: { exports: {} },
    require(name) {
      assert.equal(name, 'undici')
      return peer
    },
    AbortSignal: abortSignal,
    Error,
    Set,
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'builder-fetch-compat.cjs'), 'utf8'), context)
  return { ...context.module.exports, constructors, dispatchers }
}

function fakeGet() {
  return { initializeProxy() { throw new Error('The upstream silent fallback must not be used') } }
}

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

test('initializes a mandatory standard proxy dispatcher once without relaxing TLS', () => {
  const helper = loadHelper()
  helper.initializeProxyOnce(fakeGet())
  helper.initializeProxyOnce(fakeGet())
  assert.equal(helper.constructors.length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(helper.constructors[0].options)), {
    connect: { rejectUnauthorized: true },
    requestTls: { rejectUnauthorized: true },
    proxyTls: { rejectUnauthorized: true },
  })
  assert.equal(helper.dispatchers.length, 1)
  assert.equal(helper.dispatchers[0], helper.constructors[0])
})

test('fails closed without exposing proxy details when proxy initialization fails', () => {
  const helper = loadHelper({ EnvHttpProxyAgent: class {
    constructor() { throw new Error('https://user:proxy-secret@proxy.invalid') }
  } })
  assert.throws(() => helper.initializeProxyOnce(fakeGet()), error => {
    assert.match(error.message, /构建下载代理初始化失败/)
    assert.doesNotMatch(error.message, /proxy-secret|proxy\.invalid/)
    assert.equal(error.cause, undefined)
    return true
  })
  assert.equal(helper.dispatchers.length, 0)
  const missing = loadHelper({ EnvHttpProxyAgent: undefined })
  assert.throws(() => missing.initializeProxyOnce(fakeGet()), /构建下载代理初始化失败/)
})

test('creates fresh deadlines while preserving progress, cache, mirrors and checksums', () => {
  const helper = loadHelper()
  const progress = async () => {}
  const cache = { cacheRoot: '/mock-cache', cacheMode: 2 }
  const mirrorOptions = { resolveAssetURL: async () => 'https://example.invalid/mock.zip' }
  const checksums = { 'mock.zip': 'mock-sha256' }
  const config = { ...cache, mirrorOptions, checksums, downloadOptions: { quiet: true } }
  const options = { timeout: { request: 600000 }, getProgressCallback: progress }
  const first = helper.buildAttemptConfig(config, options)
  const second = helper.buildAttemptConfig(config, options)
  assert.notEqual(first.downloadOptions.signal, second.downloadOptions.signal)
  assert.equal(first.downloadOptions.signal.aborted, false)
  assert.equal(first.downloadOptions.getProgressCallback, progress)
  assert.equal(first.downloadOptions.quiet, true)
  assert.equal(first.cacheRoot, cache.cacheRoot)
  assert.equal(first.cacheMode, cache.cacheMode)
  assert.equal(first.mirrorOptions, mirrorOptions)
  assert.equal(first.checksums, checksums)
  assert.equal(Object.hasOwn(first.downloadOptions, 'timeout'), false)
  assert.equal(Object.hasOwn(first.downloadOptions, 'agent'), false)
  assert.equal(Object.hasOwn(first.downloadOptions, 'https'), false)
  assert.equal(config.downloadOptions.signal, undefined)
  assert.equal(options.signal, undefined)
})

test('uses a ten-minute deadline by default on every attempt', () => {
  const timeouts = []
  class ObservedAbortSignal {
    static timeout(milliseconds) {
      timeouts.push(milliseconds)
      return AbortSignal.timeout(milliseconds)
    }
    static any(signals) { return AbortSignal.any(signals) }
    static [Symbol.hasInstance](value) { return value instanceof AbortSignal }
  }
  const helper = loadHelper({}, ObservedAbortSignal)
  helper.buildAttemptConfig({})
  helper.buildAttemptConfig({})
  assert.deepEqual(timeouts, [600000, 600000])
})

test('aborts a hanging attempt and gives the next attempt a new deadline', async () => {
  const helper = loadHelper()
  const keepAlive = setTimeout(() => {}, 1000)
  try {
    const first = helper.buildAttemptConfig({}, { timeout: { request: 15 } })
    await assert.rejects(waitForAbort(first.downloadOptions.signal), error => error.name === 'TimeoutError')
    assert.equal(helper.shouldRetryDownloadError(first.downloadOptions.signal.reason), true)
    const second = helper.buildAttemptConfig({}, { timeout: { request: 15 } })
    assert.equal(second.downloadOptions.signal.aborted, false)
    assert.notEqual(first.downloadOptions.signal, second.downloadOptions.signal)
    await assert.rejects(waitForAbort(second.downloadOptions.signal), error => error.name === 'TimeoutError')
  } finally {
    clearTimeout(keepAlive)
  }
})

test('aborts a pending native fetch through an official dispatcher with network disabled', async () => {
  const { MockAgent } = require('undici')
  const dispatcher = new MockAgent()
  dispatcher.disableNetConnect()
  dispatcher.get('https://builder.invalid').intercept({ path: '/pending' }).reply(200, 'mock').delay(100)
  const helper = loadHelper()
  const config = helper.buildAttemptConfig({}, { timeout: { request: 15 }, dispatcher })
  try {
    await assert.rejects(fetch('https://builder.invalid/pending', config.downloadOptions), error => {
      assert.equal(error.name, 'TimeoutError')
      assert.equal(helper.shouldRetryDownloadError(error), true)
      return true
    })
  } finally {
    await dispatcher.close()
  }
})

test('merges every explicitly supplied signal with the fresh deadline', () => {
  const helper = loadHelper()
  for (const source of ['config', 'configOptions', 'attemptOptions']) {
    const controller = new AbortController()
    const config = {
      signal: source === 'config' ? controller.signal : new AbortController().signal,
      downloadOptions: { signal: source === 'configOptions' ? controller.signal : new AbortController().signal },
    }
    const options = { signal: source === 'attemptOptions' ? controller.signal : new AbortController().signal }
    const result = helper.buildAttemptConfig(config, options)
    const reason = new Error('explicit cancellation')
    controller.abort(reason)
    assert.equal(result.downloadOptions.signal.aborted, true)
    assert.equal(result.downloadOptions.signal.reason, reason)
  }
})

test('rejects disabled TLS verification without creating a permissive dispatcher', () => {
  const helper = loadHelper()
  helper.initializeProxyOnce(fakeGet())
  assert.throws(() => helper.buildAttemptConfig({}, { https: { rejectUnauthorized: false } }), /不允许关闭 TLS 证书校验/)
  assert.throws(() => helper.buildAttemptConfig({ downloadOptions: { https: { rejectUnauthorized: false } } }), /不允许关闭 TLS 证书校验/)
  assert.equal(helper.constructors.length, 1)
  assert.equal(helper.dispatchers.length, 1)
  const strict = helper.buildAttemptConfig({}, { https: { rejectUnauthorized: true } })
  assert.equal(strict.downloadOptions.dispatcher, undefined)
  assert.deepEqual(JSON.parse(JSON.stringify(helper.dispatchers[0].options)), {
    connect: { rejectUnauthorized: true },
    requestTls: { rejectUnauthorized: true },
    proxyTls: { rejectUnauthorized: true },
  })
})

test('rejects unsupported explicit agent and TLS settings instead of ignoring them', () => {
  const helper = loadHelper()
  assert.throws(() => helper.buildAttemptConfig({}, { agent: { https: {} } }), /显式代理 agent/)
  assert.throws(() => helper.buildAttemptConfig({ downloadOptions: { agent: { https: {} } } }, {}), /显式代理 agent/)
  assert.throws(() => helper.buildAttemptConfig({}, { https: { certificateAuthority: 'mock' } }), /TLS 配置/)
  assert.throws(() => helper.buildAttemptConfig({}, { https: { rejectUnauthorized: false }, dispatcher: {} }), /TLS 配置/)
  assert.throws(() => helper.buildAttemptConfig({}, { timeout: { request: 0 } }), /超时/)
  assert.throws(() => helper.buildAttemptConfig({}, { signal: {} }), /取消信号/)
})

test('retries server, transient network and timeout errors but never authentication or certificate failures', () => {
  const helper = loadHelper()
  for (const status of [500, 503]) {
    assert.equal(helper.shouldRetryDownloadError({ response: { status } }), true)
    assert.equal(helper.shouldRetryDownloadError({ response: { statusCode: status } }), true)
  }
  for (const code of ['ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOENT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']) {
    assert.equal(helper.shouldRetryDownloadError({ code }), true)
    assert.equal(helper.shouldRetryDownloadError(new TypeError('fetch failed', { cause: { code } })), true)
  }
  assert.equal(helper.shouldRetryDownloadError(new DOMException('mock timeout', 'TimeoutError')), true)
  for (const status of [401, 403, 404]) {
    assert.equal(helper.shouldRetryDownloadError({ response: { status }, code: 'ECONNRESET' }), false)
    assert.equal(helper.shouldRetryDownloadError({ response: { statusCode: status } }), false)
  }
  for (const code of ['DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
    assert.equal(helper.shouldRetryDownloadError({ code }), false)
    assert.equal(helper.shouldRetryDownloadError({ cause: { code } }), false)
  }
  for (const error of [null, undefined, false, new Error('mock'), new DOMException('cancelled', 'AbortError')]) {
    assert.equal(helper.shouldRetryDownloadError(error), false)
  }
})

test('never retries an aborted caller total deadline from any supported signal slot', () => {
  const helper = loadHelper()
  for (const slot of ['config', 'configOptions', 'downloadOptions']) {
    for (const reason of [new DOMException('caller total deadline', 'TimeoutError'), new Error('caller cancelled')]) {
      const controller = new AbortController()
      const config = { signal: slot === 'config' ? controller.signal : undefined, downloadOptions: { signal: slot === 'configOptions' ? controller.signal : undefined } }
      const options = { signal: slot === 'downloadOptions' ? controller.signal : undefined }
      const attempt = helper.buildAttemptConfig(config, options)
      controller.abort(reason)
      assert.equal(attempt.downloadOptions.signal.aborted, true)
      assert.equal(attempt.downloadOptions.signal.reason, reason)
      const callerSignals = [config.signal, config.downloadOptions.signal, options.signal]
      for (const error of [reason, { response: { status: 503 } }, { cause: { code: 'ECONNRESET' } }]) {
        assert.equal(helper.shouldRetryDownloadError(error, callerSignals), false)
      }
    }
  }
})

test('an expired per-attempt deadline still retries while original caller signals remain active', async () => {
  const helper = loadHelper()
  const caller = new AbortController()
  const config = { signal: caller.signal }
  const options = { timeout: { request: 5 } }
  const attempt = helper.buildAttemptConfig(config, options)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal(attempt.downloadOptions.signal.aborted, true)
  assert.equal(caller.signal.aborted, false)
  assert.equal(helper.shouldRetryDownloadError(attempt.downloadOptions.signal.reason, [config.signal]), true)
})
