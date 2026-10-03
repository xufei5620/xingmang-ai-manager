const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const https = require('node:https')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { Writable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_JSON_BYTES = 1024 * 1024
const DEFAULT_BUCKET = 'xingmang-downloads-1342302199'
const DEFAULT_REGION = 'ap-shanghai'
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

function readCosConfiguration(env = process.env) {
  const bucket = env.COS_BUCKET || DEFAULT_BUCKET
  const region = env.COS_REGION || DEFAULT_REGION
  if (!/^[a-z0-9][a-z0-9-]{0,49}-[0-9]{5,20}$/.test(bucket) || !/^[a-z]{2}-[a-z]+(?:-[a-z]+)?$/.test(region)) {
    throw new Error('COS 存储桶或地域格式不合法')
  }
  const secretId = env.COS_SECRET_ID
  const secretKey = env.COS_SECRET_KEY
  if (typeof secretId !== 'string' || !/^[A-Za-z0-9]{8,128}$/.test(secretId) ||
      typeof secretKey !== 'string' || !/^[A-Za-z0-9+/=]{8,128}$/.test(secretKey)) {
    throw new Error('请配置有效的 COS_SECRET_ID 和 COS_SECRET_KEY')
  }
  return { bucket, region, publicBaseUrl: `https://${bucket}.cos.${region}.myqcloud.com`, secretId, secretKey }
}

function validateObjectKey(key) {
  if (typeof key !== 'string' || Buffer.byteLength(key) > 1024 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(key) || key.endsWith('/') ||
      key.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('COS 对象路径不合法')
  }
  return key
}

function encodeComponent(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

function canonicalize(entries) {
  const values = new Map()
  for (const [name, value] of entries) {
    const key = encodeComponent(String(name)).toLowerCase()
    if (values.has(key)) throw new Error('签名参数重复')
    values.set(key, encodeComponent(String(value)))
  }
  const keys = [...values.keys()].sort()
  return { list: keys.join(';'), text: keys.map(key => `${key}=${values.get(key)}`).join('&') }
}

function buildCosSigningMaterial({ method, pathname, headers = {}, query = {}, keyTime }) {
  const headerValues = canonicalize(Object.entries(headers))
  const queryValues = canonicalize(Object.entries(query))
  const httpString = `${method.toLowerCase()}\n${pathname}\n${queryValues.text}\n${headerValues.text}\n`
  const stringToSign = `sha1\n${keyTime}\n${crypto.createHash('sha1').update(httpString).digest('hex')}\n`
  return { httpString, stringToSign, headerList: headerValues.list, queryList: queryValues.list }
}

function buildCosAuthorization({ secretId, secretKey, method, pathname, headers, query, now = Math.floor(Date.now() / 1000), expiresSeconds = 1800 }) {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 3600) {
    throw new Error('COS 签名时间不合法')
  }
  const keyTime = `${now - 60};${now + expiresSeconds}`
  const material = buildCosSigningMaterial({ method, pathname, headers, query, keyTime })
  // COS v5 uses the hexadecimal SignKey as the second HMAC key, not its decoded bytes.
  const signKey = crypto.createHmac('sha1', secretKey).update(keyTime).digest('hex')
  const signature = crypto.createHmac('sha1', signKey).update(material.stringToSign).digest('hex')
  return `q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=${material.headerList}&q-url-param-list=${material.queryList}&q-signature=${signature}`
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

async function assertSafePath(filePath, requireFile) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('文件路径必须是绝对路径')
  const resolved = path.resolve(filePath)
  const root = path.parse(resolved).root
  const components = resolved.slice(root.length).split(path.sep).filter(Boolean)
  let current = root
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index])
    const last = index === components.length - 1
    let stat
    try { stat = await fsp.lstat(current) } catch (error) {
      if (last && !requireFile && error.code === 'ENOENT') return resolved
      throw new Error('文件路径不存在或不可访问')
    }
    if (stat.isSymbolicLink() || (!last && !stat.isDirectory())) throw new Error('文件路径包含链接或不安全目录')
    if (last && (!stat.isFile() || stat.nlink !== 1)) throw new Error('文件必须是单链接普通文件')
  }
  return resolved
}

async function openRegularFile(filePath, maxBytes) {
  const resolved = await assertSafePath(filePath, true)
  let handle
  try {
    handle = await fsp.open(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const stat = await handle.stat()
    const current = await fsp.lstat(resolved)
    if (!stat.isFile() || stat.nlink !== 1 || current.isSymbolicLink() || stat.dev !== current.dev || stat.ino !== current.ino || stat.size > maxBytes) {
      throw new Error('文件安全性或大小校验失败')
    }
    return { handle, stat }
  } catch {
    if (handle) await handle.close().catch(() => {})
    throw new Error('文件安全性或大小校验失败')
  }
}

async function readFileChunks(filePath, maxBytes, consume) {
  const opened = await openRegularFile(filePath, maxBytes)
  let bytes = 0
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    while (true) {
      const read = await opened.handle.read(buffer, 0, buffer.length, bytes)
      if (!read.bytesRead) break
      bytes += read.bytesRead
      if (bytes > maxBytes) throw new Error('文件超过大小上限')
      consume(buffer.subarray(0, read.bytesRead))
    }
    const after = await opened.handle.stat()
    if (bytes !== opened.stat.size || after.size !== opened.stat.size || after.mtimeMs !== opened.stat.mtimeMs || after.ctimeMs !== opened.stat.ctimeMs || after.nlink !== 1) {
      throw new Error('读取期间文件发生变化')
    }
    return bytes
  } finally {
    await opened.handle.close()
  }
}

async function hashFile(filePath, { maxBytes = MAX_FILE_BYTES } = {}) {
  validateByteLimit(maxBytes)
  const sha256 = crypto.createHash('sha256')
  const sha512 = crypto.createHash('sha512')
  const md5 = crypto.createHash('md5')
  const bytes = await readFileChunks(filePath, maxBytes, chunk => {
    sha256.update(chunk)
    sha512.update(chunk)
    md5.update(chunk)
  })
  return { bytes, sha256: sha256.digest('hex'), sha512: sha512.digest('base64'), md5Base64: md5.digest('base64') }
}

async function readBoundedRegularFile(filePath, { maxBytes = MAX_JSON_BYTES } = {}) {
  validateByteLimit(maxBytes)
  const chunks = []
  await readFileChunks(filePath, maxBytes, chunk => chunks.push(Buffer.from(chunk)))
  return Buffer.concat(chunks)
}

async function downloadResource(input, options = {}) {
  validateResourceUrl(input.url, input.allowedHosts)
  await assertSafePath(input.filePath, false)
  const temporaryPath = `${input.filePath}.partial-${crypto.randomUUID()}`
  let handle
  let output
  try {
    handle = await fsp.open(temporaryPath, 'wx', 0o600)
    output = fs.createWriteStream(temporaryPath, { fd: handle.fd, autoClose: false })
    const result = await performRequest({ ...input, output }, options)
    await handle.sync()
    await handle.close()
    handle = null
    // link() atomically refuses an existing destination, including a symlink raced into place.
    await fsp.link(temporaryPath, input.filePath)
    return result
  } finally {
    if (output) output.destroy()
    if (handle) await handle.close().catch(() => {})
    await fsp.unlink(temporaryPath).catch(() => {})
  }
}

async function inspectResource(input, options = {}) {
  return performRequest({ ...input, method: 'HEAD' }, options)
}

async function fetchJson(input, options = {}) {
  let result
  try { result = await performRequest({ ...input, collectBody: true, maxBytes: input.maxBytes === undefined ? MAX_JSON_BYTES : input.maxBytes }, options) } catch (error) {
    if (input.missingOk && error.status === 404) return null
    throw error
  }
  try { return JSON.parse(result.body.toString('utf8')) } catch { throw new Error('服务器返回的 JSON 不合法') }
}

async function fetchText(input, options = {}) {
  const result = await performRequest({ ...input, collectBody: true, maxBytes: input.maxBytes === undefined ? MAX_JSON_BYTES : input.maxBytes }, options)
  return result.body.toString('utf8')
}

function contentTypesMatch(actual, expected, accepted = []) {
  const normalize = value => typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : ''
  const actualType = normalize(actual)
  const expectedType = normalize(expected)
  if (actualType === expectedType || accepted.some(type => normalize(type) === actualType)) return true
  return ['text/xml', 'application/xml'].includes(actualType) && ['text/xml', 'application/xml'].includes(expectedType)
}

function validatePublicationOptions(key, input) {
  if (typeof input.contentType !== 'string' || !/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+(?:; charset=utf-8)?$/.test(input.contentType)) throw new Error('上传 Content-Type 不合法')
  if (input.cacheControl !== undefined && (typeof input.cacheControl !== 'string' || input.cacheControl.length > 128 || /[\r\n]/.test(input.cacheControl))) throw new Error('上传缓存配置不合法')
  if (input.overwrite && !['xingmang/latest.json', 'chatgpt/latest.json', 'claude/latest.json'].includes(key)) throw new Error('仅允许覆盖固定的 latest 指针')
  if (input.ifMatch !== undefined || input.ifNoneMatch !== undefined) throw new Error('COS 目标条件写入尚未验证，不能使用条件头')
}

function createCosStore(configuration, options = {}) {
  const config = readCosConfiguration({ COS_BUCKET: configuration.bucket, COS_REGION: configuration.region, COS_SECRET_ID: configuration.secretId, COS_SECRET_KEY: configuration.secretKey })
  const host = new URL(config.publicBaseUrl).hostname

  function publicUrl(key) {
    validateObjectKey(key)
    return `${config.publicBaseUrl}/${key.split('/').map(encodeComponent).join('/')}`
  }

  async function inspect(key) {
    try {
      const result = await inspectResource({ url: publicUrl(key), allowedHosts: [host], maxBytes: MAX_FILE_BYTES }, options)
      return { bytes: result.bytes, etag: result.etag, contentType: result.contentType, sha256: result.headers['x-cos-meta-sha256'] }
    } catch (error) {
      if (error.status === 404) return null
      throw error
    }
  }

  async function readJson(key) {
    return fetchJson({ url: publicUrl(key), allowedHosts: [host], missingOk: true }, options)
  }

  async function verify(key, hash, input) {
    const result = await performRequest({ url: publicUrl(key), allowedHosts: [host], maxBytes: hash.bytes, expectedBytes: hash.bytes, expectedSha256: hash.sha256, onProgress: input.onProgress }, options)
    if (!contentTypesMatch(result.headers['content-type'], input.contentType, input.acceptedContentTypes)) throw new Error('COS 文件的 Content-Type 与预期不一致')
    return { key, url: publicUrl(key), bytes: hash.bytes, sha256: hash.sha256, contentType: result.headers['content-type'], etag: result.etag }
  }

  async function publish(key, hash, createBody, input) {
    validateObjectKey(key)
    validatePublicationOptions(key, input)
    const existing = await inspect(key)
    if (existing && !input.overwrite) return verify(key, hash, input)
    const url = new URL(publicUrl(key))
    const headers = {
      host,
      'content-length': String(hash.bytes),
      'content-md5': hash.md5Base64,
      'content-type': input.contentType,
      'x-cos-meta-sha256': hash.sha256,
      'cache-control': input.cacheControl || (input.overwrite ? 'no-cache' : 'public, max-age=31536000, immutable'),
    }
    if (!input.overwrite) headers['x-cos-forbid-overwrite'] = 'true'
    headers.authorization = buildCosAuthorization({ secretId: config.secretId, secretKey: config.secretKey, method: 'PUT', pathname: decodeURIComponent(url.pathname), headers, now: options.now ? options.now() : Math.floor(Date.now() / 1000) })
    let putError
    try {
      await performRequest({ url: url.href, allowedHosts: [host], method: 'PUT', headers, body: await createBody(), uploadBytes: hash.bytes, onProgress: input.onProgress, maxBytes: MAX_JSON_BYTES }, options)
    } catch (error) { putError = error }
    // A lost PUT response does not justify another write: first confirm the complete public object.
    try { return await verify(key, hash, input) } catch (readbackError) {
      if (putError) throw transferFailure('cos-upload-unconfirmed', 'COS 上传未确认成功；已尝试读取核验，请检查远程状态后再重试', { put: putError, readback: readbackError })
      throw transferFailure('cos-readback-failed', 'COS 上传后的公共下载核验失败，请检查远程状态', { readback: readbackError })
    }
  }

  async function publishFile(key, filePath, input) {
    const hash = await hashFile(filePath)
    if (input.expectedBytes !== undefined && hash.bytes !== input.expectedBytes) throw new Error('上传文件大小与预校验结果不一致')
    if (input.expectedSha256 !== undefined && hash.sha256 !== input.expectedSha256) throw new Error('上传文件 SHA256 与预校验结果不一致')
    return publish(key, hash, async () => {
      const opened = await openRegularFile(filePath, MAX_FILE_BYTES)
      if (opened.stat.size !== hash.bytes) {
        await opened.handle.close()
        throw new Error('上传前文件发生变化')
      }
      if (!hash.bytes) {
        await opened.handle.close()
        return Buffer.alloc(0)
      }
      // Bound upload reads to the hashed length even if another process grows the source file.
      return opened.handle.createReadStream({ start: 0, end: hash.bytes - 1, autoClose: true })
    }, input)
  }

  async function publishJson(key, value, input = {}) {
    const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    if (body.length > MAX_JSON_BYTES) throw new Error('JSON 清单超过大小上限')
    const hash = { bytes: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'), md5Base64: crypto.createHash('md5').update(body).digest('base64') }
    return publish(key, hash, async () => body, { ...input, contentType: 'application/json' })
  }

  return { publicUrl, inspect, readJson, publishFile, publishJson }
}

module.exports = {
  MAX_FILE_BYTES,
  buildCosAuthorization,
  buildCosSigningMaterial,
  createCosStore,
  downloadResource,
  fetchJson,
  fetchText,
  hashFile,
  inspectResource,
  readBoundedRegularFile,
  readCosConfiguration,
  safeSyncFailure,
  validateObjectKey,
}
