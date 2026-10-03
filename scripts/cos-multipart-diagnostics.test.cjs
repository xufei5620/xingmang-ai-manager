const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { PassThrough, Readable, Writable } = require('node:stream')
const { test } = require('node:test')
const { THRESHOLD_BYTES } = require('./cos-multipart-upload.cjs')
const { createCosStore, fetchText, readCosConfiguration, safeSyncFailure } = require('./cos-sync-utils.cjs')

const config = readCosConfiguration({ COS_SECRET_ID: 'TESTSECRETID123456', COS_SECRET_KEY: 'TESTSECRETKEY123456' })
const host = new URL(config.publicBaseUrl).hostname
const errorCodes = ['RequestTimeout', 'BadDigest', 'InvalidDigest', 'AccessDenied', 'SignatureDoesNotMatch', 'NoSuchUpload', 'EntityTooSmall', 'InvalidPart', 'InvalidPartOrder', 'InvalidArgument']

function errorXml(code = 'RequestTimeout') {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>SECRET_MESSAGE &amp; authorization</Message><Resource>/SECRET_RESOURCE?token=SECRET</Resource><RequestId>SECRET_REQUEST_ID</RequestId><TraceId>SECRET_TRACE_ID</TraceId></Error>`)
}

function response(body, status = 400, headers = {}) {
  const stream = Readable.from(body.length ? [body] : [])
  stream.statusCode = status
  stream.headers = { 'content-type': 'application/xml', 'content-length': String(body.length), ...headers }
  stream.on('end', () => { stream.complete = true })
  return stream
}

function mockRequest(handler) {
  const calls = []
  function requestImpl(url, input, callback) {
    const request = new Writable({ write(chunk, encoding, done) { done() } })
    calls.push({ url, ...input, request })
    request.on('finish', () => handler(callback, request, calls.at(-1)))
    return request
  }
  return { requestImpl, calls }
}

function requestInput(fields = {}) {
  return { url: `${config.publicBaseUrl}/diagnostic.bin?uploadId=SECRET_UPLOAD_ID&partNumber=1`, allowedHosts: [host], method: 'PUT', multipartOperation: 'part', ...fields }
}

async function rejectHttp(promise, expectedCode, status = 400) {
  let diagnostic
  await assert.rejects(promise, error => {
    diagnostic = safeSyncFailure(error)
    assert.equal(error.status, status)
    assert.equal(diagnostic.code, status >= 300 && status < 400 ? 'redirect-rejected' : 'http-status')
    assert.equal(diagnostic.status, status)
    assert.equal(diagnostic.cosErrorCode, expectedCode)
    assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET|Message|Resource|RequestId|TraceId|rawbody|authorization|https?:|uploadId/i)
    return true
  })
  return diagnostic
}

test('multipart diagnostics expose only a recognized top-level COS error code', async () => {
  for (const code of errorCodes) {
    const mock = mockRequest(callback => callback(response(errorXml(code))))
    const diagnostic = await rejectHttp(fetchText(requestInput(), mock), code)
    assert.equal(diagnostic.method, 'PUT')
    assert.equal(diagnostic.multipartOperation, 'part')
  }
  for (const [multipartOperation, method] of [['init', 'POST'], ['part', 'PUT'], ['complete', 'POST'], ['abort', 'DELETE']]) {
    const mock = mockRequest(callback => callback(response(errorXml())))
    const diagnostic = await rejectHttp(fetchText(requestInput({ multipartOperation, method }), mock), 'RequestTimeout')
    assert.equal(diagnostic.multipartOperation, multipartOperation)
    assert.equal(diagnostic.method, method)
  }
  assert.deepEqual(safeSyncFailure({ cosErrorCode: 'RequestTimeout', status: 400, syncFailure: { code: 'http-status', cosErrorCode: 'RequestTimeout' } }), { code: 'operation-failed' })
})

test('malformed or ambiguous XML never supplies a COS diagnostic code', async () => {
  const invalidBodies = [
    '<Error><Message><Code>RequestTimeout</Code></Message></Error>',
    '<Error><Code>RequestTimeout</Code><Code>RequestTimeout</Code></Error>',
    '<Error><Code>RequestTimeout</Code><Code>AccessDenied</Code></Error>',
    '<Error><Code>SECRET_UNKNOWN_CODE</Code></Error>',
    '<Error><Code>requesttimeout</Code></Error>',
    '<Error><Code>RequestTimeout</Code></NotError>',
    '<html><Error><Code>RequestTimeout</Code></Error></html>',
    'prefix <Error><Code>RequestTimeout</Code></Error>',
    '<Error><Code>RequestTimeout</Code></Error> suffix',
    '<Error><Code>RequestTimeout</Code></Error><Error><Code>AccessDenied</Code></Error>',
    '<Error><Code><![CDATA[RequestTimeout]]></Code></Error>',
    '<Error><Code>Request&#84;imeout</Code></Error>',
    '<!DOCTYPE Error [<!ENTITY timeout "RequestTimeout">]><Error><Code>&timeout;</Code></Error>',
    '<Error><Code>RequestTimeout</Code><Message>&unknown;</Message></Error>',
    '<Error><Code>RequestTimeout</Code><Message>SECRET_MESSAGE</Error>',
    '<Error><Message>SECRET_MESSAGE</Message></Error>',
    '<Error Code="RequestTimeout"></Error>',
    'RequestTimeout',
    '',
  ]
  for (const text of invalidBodies) {
    const mock = mockRequest(callback => callback(response(Buffer.from(text))))
    await rejectHttp(fetchText(requestInput(), mock), undefined)
  }
  const invalidUtf8 = Buffer.concat([Buffer.from('<Error><Code>RequestTimeout</Code><Message>'), Buffer.from([0xc3, 0x28]), Buffer.from('</Message></Error>')])
  const mock = mockRequest(callback => callback(response(invalidUtf8)))
  await rejectHttp(fetchText(requestInput(), mock), undefined)
})

test('COS diagnostic bodies are bounded to four KiB including multibyte UTF8', async () => {
  const prefix = '<Error><Code>RequestTimeout</Code><Message>'
  const suffix = '</Message></Error>'
  const boundary = Buffer.from(`${prefix}${'x'.repeat(4096 - Buffer.byteLength(prefix + suffix))}${suffix}`)
  assert.equal(boundary.length, 4096)
  const accepted = mockRequest(callback => callback(response(boundary)))
  await rejectHttp(fetchText(requestInput(), accepted), 'RequestTimeout')
  for (const body of [Buffer.concat([boundary, Buffer.from(' ')]), Buffer.from(`${prefix}${'界'.repeat(1500)}${suffix}`)]) {
    for (const headers of [{}, { 'content-length': undefined }, { 'content-length': '1' }]) {
      let stream
      const mock = mockRequest(callback => { stream = response(body, 400, headers); callback(stream) })
      await rejectHttp(fetchText(requestInput(), mock), undefined)
      assert.equal(stream.destroyed, true)
    }
  }
})

test('invalid or inconsistent response lengths preserve the original HTTP failure', async () => {
  const body = errorXml()
  for (const value of ['-1', 'NaN', '1.5', '01', ['100', '100'], String(body.length + 1), String(body.length - 1), '4097']) {
    const mock = mockRequest(callback => callback(response(body, 400, { 'content-length': value })))
    await rejectHttp(fetchText(requestInput(), mock), undefined)
  }
  const compressed = mockRequest(callback => callback(response(body, 400, { 'content-encoding': 'gzip' })))
  await rejectHttp(fetchText(requestInput(), compressed), undefined)
})

test('diagnostic reads retain shorter deadlines and cap longer ones at five seconds', async t => {
  const realSetTimeout = global.setTimeout
  const scheduled = []
  t.mock.method(global, 'setTimeout', function (callback, milliseconds, ...args) {
    scheduled.push(milliseconds)
    return realSetTimeout(callback, milliseconds === 5000 ? 20 : milliseconds, ...args)
  })
  for (const [bodyTimeoutMs, expectedTimeout] of [[undefined, 5000], [20000, 5000], [20, 20]]) {
    scheduled.length = 0
    let stream
    const mock = mockRequest(callback => {
      stream = new PassThrough()
      stream.statusCode = 400
      stream.headers = {}
      callback(stream)
      stream.write(errorXml())
    })
    await rejectHttp(fetchText(requestInput(), { ...mock, headerTimeoutMs: 1000, bodyTimeoutMs }), undefined)
    assert.deepEqual(scheduled, [1000, expectedTimeout])
    assert.equal(stream.destroyed, true)
    assert.equal(mock.calls[0].request.destroyed, true)
  }
})

test('a failed diagnostic body stream cannot replace the HTTP error or leak transport text', async () => {
  let stream
  const mock = mockRequest(callback => {
    stream = new PassThrough()
    stream.statusCode = 400
    stream.headers = {}
    callback(stream)
    stream.write(errorXml())
    setImmediate(() => stream.destroy(new Error('SECRET transport authorization')))
  })
  await rejectHttp(fetchText(requestInput(), mock), undefined)
  assert.equal(stream.destroyed, true)
})

test('non-multipart requests, mismatched methods and non-COS hosts never read diagnostic bodies', async () => {
  const otherHost = 'cos.ap-shanghai.myqcloud.com.evil.example'
  for (const fields of [
    { multipartOperation: undefined },
    { multipartOperation: undefined, method: 'GET' },
    { multipartOperation: 'part', method: 'HEAD' },
    { multipartOperation: 'part', method: 'POST' },
    { multipartOperation: 'init', method: 'PUT' },
    { multipartOperation: 'complete', method: 'GET' },
    { multipartOperation: 'abort', method: 'POST' },
    { multipartOperation: 'unknown' },
    { url: `https://${otherHost}/diagnostic.bin`, allowedHosts: [otherHost] },
  ]) {
    let readCount = 0
    const stream = new Readable({ read() { readCount += 1; this.push(errorXml()); this.push(null) } })
    stream.statusCode = 400
    stream.headers = {}
    const mock = mockRequest(callback => callback(stream))
    await rejectHttp(fetchText(requestInput(fields), mock), undefined)
    assert.equal(readCount, 0)
    assert.equal(stream.destroyed, true)
  }
})

test('multipart redirects are rejected without reading their body or following Location', async () => {
  let readCount = 0
  const stream = new Readable({ read() { readCount += 1; this.push(errorXml()); this.push(null) } })
  stream.statusCode = 302
  stream.headers = { location: 'https://SECRET.invalid/redirect' }
  const mock = mockRequest(callback => callback(stream))
  await rejectHttp(fetchText(requestInput(), mock), undefined, 302)
  assert.equal(readCount, 0)
  assert.equal(mock.calls.length, 1)
  assert.equal(stream.destroyed, true)
})

test('multipart publication retains a sanitized COS code inside nested upload failures', async t => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'xingmang-cos-diagnostic-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'installer.bin')
  await fs.writeFile(filePath, Buffer.alloc(THRESHOLD_BYTES, 71))
  const mock = mockRequest((callback, request, call) => {
    callback(call.method === 'POST' ? response(errorXml('AccessDenied')) : response(Buffer.alloc(0), 404))
  })
  const store = createCosStore({ ...config, multipart: { enabled: true, concurrency: 4 } }, mock)
  await assert.rejects(store.publishFile('chatgpt/diagnostic/installer.bin', filePath, { contentType: 'application/octet-stream' }), error => {
    const diagnostic = safeSyncFailure(error)
    assert.equal(diagnostic.code, 'cos-upload-unconfirmed')
    assert.equal(diagnostic.put.code, 'cos-multipart-unconfirmed')
    assert.equal(diagnostic.put.put.code, 'http-status')
    assert.equal(diagnostic.put.put.status, 400)
    assert.equal(diagnostic.put.put.cosErrorCode, 'AccessDenied')
    assert.equal(diagnostic.put.put.multipartOperation, 'init')
    assert.equal(diagnostic.readback.status, 404)
    assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET|Message|Resource|RequestId|TraceId|authorization|https?:|uploadId/i)
    return true
  })
  assert.deepEqual(mock.calls.map(call => call.method), ['HEAD', 'POST', 'GET'])
})
