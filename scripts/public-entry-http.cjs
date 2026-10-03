// Temporary public-only runner probe. Transport and private diagnostics copied
// from PR #776 (54e47d6); no signing, storage mutation, or auth configuration.
const crypto = require('node:crypto')
const https = require('node:https')
const { Writable } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { performance } = require('node:perf_hooks')
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_JSON_BYTES = 1024 * 1024
const FAILURE_CODES = new Set(['network-request-failed', 'response-header-timeout', 'response-body-timeout', 'http-status', 'redirect-rejected', 'response-too-large', 'etag-changed', 'size-mismatch', 'digest-mismatch', 'cos-upload-unconfirmed', 'cos-readback-failed'])
const TRANSPORT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN'])
const failureDetails = new WeakMap()

function transferFailure(code, message, details = {}) {
  const error = new Error(message)
  failureDetails.set(error, { code, ...details })
  return error
}

function readSafeSyncFailure(error, seen, depth) {
  const value = failureDetails.get(error)
  if (!value || !FAILURE_CODES.has(value.code) || seen.has(error) || depth > 3) return { code: 'operation-failed' }
  seen.add(error)
  const result = { code: value.code }
  if (['GET', 'HEAD', 'PUT'].includes(value.method)) result.method = value.method
  if (['response-headers', 'upload-body', 'response-body'].includes(value.phase)) result.phase = value.phase
  if (TRANSPORT_CODES.has(value.transportCode)) result.transportCode = value.transportCode
  if (Number.isInteger(value.status) && value.status >= 100 && value.status <= 599) result.status = value.status
  for (const name of ['transferredBytes', 'expectedBytes']) {
    if (Number.isSafeInteger(value[name]) && value[name] >= 0 && value[name] <= MAX_FILE_BYTES) result[name] = value[name]
  }
  // Only publisher-created suberrors are inspected. Never serialize an
  // exception, message, URL, response body, headers, or credentials.
  if (value.put) result.put = readSafeSyncFailure(value.put, seen, depth + 1)
  if (value.readback) result.readback = readSafeSyncFailure(value.readback, seen, depth + 1)
  return result
}

function safeSyncFailure(error) {
  return readSafeSyncFailure(error, new WeakSet(), 0)
}

function validateResourceUrl(value, allowedHosts) {
  let url
  try { url = new URL(value) } catch { throw new Error('下载地址不合法') }
  if (!Array.isArray(allowedHosts) || !allowedHosts.includes(url.hostname) || url.protocol !== 'https:' ||
      url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new Error('下载地址未通过 HTTPS 域名白名单校验')
  }
  return url
}

function validateByteLimit(value = MAX_FILE_BYTES) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_FILE_BYTES) throw new Error('文件大小上限不合法')
  return value
}

function parseContentLength(headers) {
  const value = headers['content-length']
  if (value === undefined) return null
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('服务器返回的文件大小不合法')
  }
  return Number(value)
}

function networkFailure(cause, details) {
  // Never attach a raw transport error: an injected proxy can include authorization or signed URLs.
  return transferFailure('network-request-failed', '网络请求失败，未记录服务器正文或认证信息', {
    ...details,
    ...(TRANSPORT_CODES.has(cause?.code) ? { transportCode: cause.code } : {}),
  })
}

function validateTimeout(value, fallback) {
  const timeout = value === undefined ? fallback : value
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30 * 60 * 1000) throw new Error('网络超时配置不合法')
  return timeout
}

async function performRequest(input, options = {}) {
  const url = validateResourceUrl(input.url, input.allowedHosts)
  const maxBytes = validateByteLimit(input.maxBytes)
  const headerTimeoutMs = validateTimeout(options.headerTimeoutMs, input.method === 'PUT' ? 20 * 60 * 1000 : 30000)
  const bodyTimeoutMs = validateTimeout(options.bodyTimeoutMs, 20 * 60 * 1000)
  const requestImpl = options.requestImpl || https.request
  const method = input.method || 'GET'
  const started = performance.now()
  let transferredBytes = 0
  let phase = 'response-headers'
  let responseDeclaredBytes
  let lastProgressBytes = 0
  let lastProgressAt = started
  function reportProgress(phase, bytes, expectedBytes, force = false) {
    if (typeof input.onProgress !== 'function') return
    const now = performance.now()
    if (!force && bytes - lastProgressBytes < 16 * 1024 * 1024 && now - lastProgressAt < 15000) return
    lastProgressBytes = bytes
    lastProgressAt = now
    try { input.onProgress({ phase, method, transferredBytes: bytes, expectedBytes, elapsedMs: Math.round(now - started) }) } catch {}
  }
  function details(extra = {}) {
    const expectedBytes = phase === 'response-body' ? input.expectedBytes ?? responseDeclaredBytes
      : method === 'PUT' ? input.uploadBytes : input.expectedBytes
    return { method, phase, transferredBytes, ...(expectedBytes === undefined ? {} : { expectedBytes }), ...extra }
  }
  let request
  let response
  let headerTimer
  let bodyTimer
  let timerError
  let uploadError
  try {
    response = await new Promise((resolve, reject) => {
      function fail(error) {
        reject(error)
        if (request) request.destroy()
        if (input.body && typeof input.body.destroy === 'function') input.body.destroy()
      }
      headerTimer = setTimeout(() => {
        timerError = transferFailure('response-header-timeout', '网络请求等待响应头超时', details())
        fail(timerError)
      }, headerTimeoutMs)
      try {
        request = requestImpl(url, { method: input.method || 'GET', headers: { 'accept-encoding': 'identity', ...input.headers }, agent: false, maxHeaderSize: 16 * 1024 }, resolve)
        request.on('error', (error) => fail(timerError || networkFailure(error, details())))
        if (input.body && typeof input.body.pipe === 'function') {
          input.body.on('data', (chunk) => {
            phase = 'upload-body'
            transferredBytes += chunk.length
            reportProgress('upload-body', transferredBytes, input.uploadBytes)
          })
          input.body.on('error', (error) => {
            uploadError = networkFailure(error, details())
            fail(uploadError)
          })
          input.body.pipe(request)
        } else {
          request.end(input.body)
        }
      } catch (error) {
        fail(networkFailure(error, details()))
      }
    })
    clearTimeout(headerTimer)
    reportProgress('response-headers', transferredBytes, method === 'PUT' ? input.uploadBytes : input.expectedBytes, true)
    const status = response.statusCode
    // Redirects are rejected even for public GETs so credentials can never cross a host boundary.
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      const error = transferFailure(status >= 300 && status < 400 ? 'redirect-rejected' : 'http-status', status >= 300 && status < 400 ? '服务器重定向已拒绝' : `服务器请求失败（HTTP ${Number.isInteger(status) ? status : 0}）`, details({ status }))
      error.status = status
      throw error
    }
    const headers = Object.fromEntries(Object.entries(response.headers || {}).map(([key, value]) => [key.toLowerCase(), value]))
    if (headers['content-encoding'] && headers['content-encoding'] !== 'identity') throw new Error('服务器返回了不支持的压缩正文')
    const declaredBytes = parseContentLength(headers)
    responseDeclaredBytes = declaredBytes
    if (declaredBytes !== null && declaredBytes > maxBytes) throw transferFailure('response-too-large', '下载内容超过大小上限', details())
    if (input.expectedEtag !== undefined && headers.etag !== input.expectedEtag) throw transferFailure('etag-changed', '下载期间上游 ETag 发生变化', details())
    if (input.expectedBytes !== undefined && declaredBytes !== null && declaredBytes !== input.expectedBytes) throw transferFailure('size-mismatch', '下载文件大小与预期不一致', details())
    if (input.method === 'HEAD') {
      response.resume()
      return { bytes: declaredBytes, etag: headers.etag, lastModified: headers['last-modified'], contentType: headers['content-type'], headers, status }
    }
    phase = 'response-body'
    transferredBytes = 0
    bodyTimer = setTimeout(() => {
      timerError = transferFailure('response-body-timeout', '网络请求读取正文超时', details())
      response.destroy(timerError)
      request.destroy()
    }, bodyTimeoutMs)
    const hashes = { sha256: crypto.createHash('sha256'), sha512: crypto.createHash('sha512'), md5: crypto.createHash('md5') }
    const chunks = []
    let bytes = 0
    const sink = new Writable({
      write(chunk, encoding, callback) {
        bytes += chunk.length
        transferredBytes = bytes
        if (bytes > maxBytes) return callback(transferFailure('response-too-large', '下载内容超过大小上限', details()))
        reportProgress('response-body', bytes, input.expectedBytes ?? declaredBytes)
        for (const hash of Object.values(hashes)) hash.update(chunk)
        if (input.collectBody) chunks.push(chunk)
        if (input.output) input.output.write(chunk, callback)
        else callback()
      },
      final(callback) {
        if (input.output) input.output.end(callback)
        else callback()
      },
    })
    if (input.output) input.output.on('error', () => sink.destroy(new Error('写入下载文件失败')))
    try { await pipeline(response, sink) } catch (error) {
      if (timerError) throw timerError
      if (failureDetails.get(error)?.code === 'response-too-large') throw error
      throw networkFailure(error, details())
    }
    if (uploadError) throw uploadError
    if (declaredBytes !== null && bytes !== declaredBytes) throw transferFailure('size-mismatch', '下载正文大小与响应头不一致', details({ expectedBytes: declaredBytes }))
    if (input.expectedBytes !== undefined && bytes !== input.expectedBytes) throw transferFailure('size-mismatch', '下载文件大小与预期不一致', details())
    const result = { bytes, sha256: hashes.sha256.digest('hex'), sha512: hashes.sha512.digest('base64'), md5Base64: hashes.md5.digest('base64'), headers, etag: headers.etag, status }
    if (input.expectedSha256 !== undefined && result.sha256 !== input.expectedSha256) throw transferFailure('digest-mismatch', '下载文件 SHA256 与预期不一致', details())
    reportProgress('complete', bytes, input.expectedBytes ?? declaredBytes, true)
    if (input.collectBody) result.body = Buffer.concat(chunks)
    return result
  } finally {
    clearTimeout(headerTimer)
    clearTimeout(bodyTimer)
    if (response && !response.complete) response.destroy()
    if (request) request.destroy()
    if (input.body && typeof input.body.destroy === 'function') input.body.destroy()
  }
}

const MAX_PUBLIC_BYTES = 256 * 1024
const RESOURCES = Object.freeze([
  Object.freeze({ label: 'cos-manager-latest', url: 'https://xingmang-downloads-1342302199.cos.ap-shanghai.myqcloud.com/xingmang/latest.json', kind: 'manager-index' }),
  Object.freeze({ label: 'cos-codex-latest', url: 'https://xingmang-downloads-1342302199.cos.ap-shanghai.myqcloud.com/chatgpt/latest.json', kind: 'codex-index' }),
  Object.freeze({ label: 'cos-claude-latest', url: 'https://xingmang-downloads-1342302199.cos.ap-shanghai.myqcloud.com/xingmang/offline/claude/latest.json', kind: 'claude-index' }),
  Object.freeze({ label: 'official-windows-metadata', url: 'https://persistent.oaistatic.com/codex-app-prod/windows-store-update.json', kind: 'windows-metadata' }),
  Object.freeze({ label: 'official-mac-arm64-appcast', url: 'https://persistent.oaistatic.com/codex-app-prod/appcast.xml', kind: 'mac-arm64' }),
  Object.freeze({ label: 'official-mac-x64-appcast', url: 'https://persistent.oaistatic.com/codex-app-prod/appcast-x64.xml', kind: 'mac-x64' }),
  Object.freeze({ label: 'official-windows-license', url: 'https://persistent.oaistatic.com/codex-app-prod/ChatGPT-License.xml', kind: 'license-xml' }),
])

async function publicRequest(label, phase, requestImpl) {
  const resource = RESOURCES.find((item) => item.label === label)
  if (!resource || !['head', 'get'].includes(phase)) throw new Error('Public probe request is outside its fixed read-only scope')
  return performRequest({
    url: resource.url,
    method: phase === 'head' ? 'HEAD' : 'GET',
    allowedHosts: [new URL(resource.url).hostname],
    maxBytes: MAX_PUBLIC_BYTES,
    collectBody: phase === 'get',
  }, { headerTimeoutMs: 15000, bodyTimeoutMs: 15000, requestImpl })
}

module.exports = { RESOURCES, MAX_PUBLIC_BYTES, publicRequest, safeSyncFailure }
