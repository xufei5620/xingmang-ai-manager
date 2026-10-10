const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fsCore = require('node:fs')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { PassThrough, Readable, Writable } = require('node:stream')
const { test } = require('node:test')
const {
  buildCosAuthorization,
  buildCosSigningMaterial,
  createCosStore,
  downloadResource,
  fetchJson,
  fetchText,
  hashFile,
  inspectResource,
  isTransientTransferFailure,
  readBoundedRegularFile,
  readCosConfiguration,
  validateObjectKey,
  safeSyncFailure,
} = require('./cos-sync-utils.cjs')
const { RETRY_POLICIES } = require('./cos-transfer-retry.cjs')

test('safe diagnostics recognize owned errors and never trust forged fields or raw transport details', async () => {
  const forged = new Error('Bearer SECRET signed-url')
  Object.defineProperty(forged, 'syncFailure', { get() { throw new Error('must not read forged diagnostics') } })
  assert.deepEqual(safeSyncFailure(forged), { code: 'operation-failed' })
  const cyclic = { syncFailure: { code: 'http-status', status: 403 } }
  cyclic.syncFailure.put = cyclic
  assert.deepEqual(safeSyncFailure(cyclic), { code: 'operation-failed' })
  const mock = mockRequest((call, callback, request) => {
    request.destroy(Object.assign(new Error('Authorization=SECRET https://signed.invalid/?token=SECRET'), { code: 'ECONNRESET' }))
  })
  await assert.rejects(fetchText({ url: `${config.publicBaseUrl}/a`, allowedHosts: [host] }, mock), (error) => {
    const diagnostic = safeSyncFailure(error)
    assert.equal(diagnostic.code, 'network-request-failed')
    assert.equal(diagnostic.transportCode, 'ECONNRESET')
    assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET|signed\.invalid|Authorization/)
    return true
  })
})

test('bounded network diagnostics identify HTTP failures and both timeout phases without response bodies', async () => {
  const forbidden = mockRequest((call, callback) => callback(response(Buffer.from('SECRET server body'), 403)))
  await assert.rejects(fetchText({ url: `${config.publicBaseUrl}/a`, allowedHosts: [host] }, forbidden), (error) => {
    const diagnostic = safeSyncFailure(error)
    assert.equal(diagnostic.code, 'http-status')
    assert.equal(diagnostic.status, 403)
    assert.equal(diagnostic.method, 'GET')
    assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET/)
    return true
  })
  const neverHeaders = mockRequest(() => {})
  await assert.rejects(fetchText({ url: `${config.publicBaseUrl}/a`, allowedHosts: [host] }, { ...neverHeaders, headerTimeoutMs: 20 }), (error) => safeSyncFailure(error).code === 'response-header-timeout')
  const neverBody = mockRequest((call, callback) => {
    const stream = new PassThrough()
    stream.statusCode = 200
    stream.headers = { 'content-length': '64' }
    callback(stream)
    stream.write('abc')
  })
  await assert.rejects(fetchText({ url: `${config.publicBaseUrl}/a`, allowedHosts: [host], expectedBytes: 64 }, { ...neverBody, bodyTimeoutMs: 20 }), (error) => {
    const diagnostic = safeSyncFailure(error)
    assert.equal(diagnostic.code, 'response-body-timeout')
    assert.equal(diagnostic.phase, 'response-body')
    assert.equal(diagnostic.transferredBytes, 3)
    assert.equal(diagnostic.expectedBytes, 64)
    return true
  })
})

test('integrity failures retain safe ETag, size and digest categories', async () => {
  const body = Buffer.from('package')
  for (const [fields, code] of [
    [{ expectedEtag: 'different' }, 'etag-changed'],
    [{ expectedBytes: body.length + 1 }, 'size-mismatch'],
    [{ expectedSha256: '0'.repeat(64) }, 'digest-mismatch'],
  ]) {
    const mock = mockRequest((call, callback) => callback(response(body, 200, { 'content-length': String(body.length), etag: 'current' })))
    await assert.rejects(fetchText({ url: `${config.publicBaseUrl}/a`, allowedHosts: [host], ...fields }, mock), (error) => safeSyncFailure(error).code === code)
  }
})

test('publication progress distinguishes upload bytes from complete public readback without exposing signed requests', async (t) => {
  const file = await fixture(t)
  const mock = memoryCos()
  const events = []
  const store = createCosStore(config, mock)
  await store.publishFile('chatgpt/test/app.msix', file.filePath, { contentType: 'application/vnd.ms-appx', onProgress: (event) => events.push(event) })
  assert.ok(events.some((event) => event.method === 'PUT' && event.phase === 'response-headers'
    && event.transferredBytes === file.body.length && event.expectedBytes === file.body.length))
  assert.ok(events.some((event) => event.method === 'GET' && event.phase === 'complete'
    && event.transferredBytes === file.body.length))
  assert.doesNotMatch(JSON.stringify(events), /authorization|q-sign|SECRET|myqcloud|filePath|https:/i)
})

test('failed PUT and readback preserve separate safe causes without retrying the immutable write', async (t) => {
  const file = await fixture(t)
  const mock = memoryCos({ lostPut: true, corruptGet: true })
  const store = createCosStore(config, mock)
  await assert.rejects(store.publishFile('chatgpt/test/app.msix', file.filePath, { contentType: 'application/vnd.ms-appx' }), (error) => {
    const diagnostic = safeSyncFailure(error)
    assert.equal(diagnostic.code, 'cos-upload-unconfirmed')
    assert.equal(diagnostic.put.code, 'network-request-failed')
    assert.equal(diagnostic.readback.code, 'digest-mismatch')
    return true
  })
  assert.equal(mock.calls.filter((call) => call.method === 'PUT').length, 1)
})

test('an empty stalled PUT response counts received bytes independently of uploaded bytes', async (t) => {
  const file = await fixture(t)
  const mock = mockRequest((call, callback) => {
    if (call.method !== 'PUT') { callback(response(Buffer.alloc(0), 404)); return }
    const stream = new PassThrough()
    stream.statusCode = 200
    stream.headers = { 'content-length': '0' }
    callback(stream)
  })
  const store = createCosStore(config, { ...mock, bodyTimeoutMs: 20, sleep: noWait })
  await assert.rejects(store.publishFile('chatgpt/test/app.msix', file.filePath, { contentType: 'application/vnd.ms-appx' }), (error) => {
    const diagnostic = safeSyncFailure(error)
    assert.equal(diagnostic.put.code, 'response-body-timeout')
    assert.equal(diagnostic.put.phase, 'response-body')
    assert.equal(diagnostic.put.transferredBytes, 0)
    assert.equal(diagnostic.put.expectedBytes, 0)
    return true
  })
  // Every readback in this fixture is a 404, which proves the immutable object
  // is still absent, so the timed-out PUT is repeated until the policy runs out.
  assert.equal(mock.calls.filter((call) => call.method === 'PUT').length, RETRY_POLICIES.write.attempts)
})

const config = readCosConfiguration({ COS_SECRET_ID: 'TESTSECRETID123456', COS_SECRET_KEY: 'TESTSECRETKEY123456' })
const host = new URL(config.publicBaseUrl).hostname

function digest(body) {
  return crypto.createHash('sha256').update(body).digest('hex')
}

function response(body, status = 200, headers = {}) {
  const stream = Readable.from(body.length ? [body] : [])
  stream.statusCode = status
  stream.headers = headers
  stream.complete = false
  stream.on('end', () => { stream.complete = true })
  return stream
}

function mockRequest(handler) {
  const calls = []
  function requestImpl(url, input, callback) {
    const chunks = []
    const request = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done() } })
    const call = { url, ...input }
    calls.push(call)
    request.on('finish', () => {
      call.body = Buffer.concat(chunks)
      handler(call, callback, request)
    })
    return request
  }
  return { requestImpl, calls }
}

function memoryCos({ lostPut = false, lostPutCode, corruptGet = false, privateGet = false, putFaults = [] } = {}) {
  const objects = new Map()
  const faults = [...putFaults]
  const transport = mockRequest((call, callback, request) => {
    const key = decodeURIComponent(call.url.pathname.slice(1))
    if (call.method === 'PUT') {
      // A fault here happens before COS stores anything: a refused, reset or
      // rejected request that leaves the object absent.
      const fault = faults.shift()
      if (typeof fault === 'number') return callback(response(Buffer.alloc(0), fault))
      if (fault) return request.destroy(Object.assign(new Error(`Authorization: ${call.headers.authorization}`), { code: fault }))
      const existing = objects.get(key)
      if (existing && call.headers['x-cos-forbid-overwrite'] === 'true') {
        callback(response(Buffer.alloc(0), 409))
        return
      }
      assert.equal(call.headers['content-md5'], crypto.createHash('md5').update(call.body).digest('base64'))
      objects.set(key, { body: call.body, contentType: call.headers['content-type'], sha256: call.headers['x-cos-meta-sha256'] })
      if (lostPut || lostPutCode) request.destroy(Object.assign(new Error(`Authorization: ${call.headers.authorization}`), lostPutCode ? { code: lostPutCode } : {}))
      else callback(response(Buffer.alloc(0), 200, { 'content-length': '0' }))
      return
    }
    const object = objects.get(key)
    if (!object) return callback(response(Buffer.alloc(0), 404))
    if (privateGet && call.method === 'GET') return callback(response(Buffer.alloc(0), 403))
    const body = corruptGet ? Buffer.alloc(object.body.length, 88) : object.body
    callback(response(call.method === 'HEAD' ? Buffer.alloc(0) : body, 200, {
      'content-type': object.contentType,
      'content-length': String(body.length),
      etag: '"0123456789abcdef"',
      'x-cos-meta-sha256': object.sha256,
    }))
  })
  return { ...transport, objects }
}

function noWait() {
  return Promise.resolve()
}

async function fixture(t, contents = 'installer contents') {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'xingmang-cos-sync-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'installer.msix')
  await fs.writeFile(filePath, contents)
  return { directory, filePath, body: Buffer.from(contents) }
}

test('matches the published COS upload signing material', () => {
  // Tencent publishes a redacted SecretKey and signature tail. The SignKey and canonical SHA1 are public.
  // https://cloud.tencent.com/document/product/436/7778, upload example.
  const material = buildCosSigningMaterial({
    method: 'PUT',
    pathname: '/exampleobject(腾讯云)',
    keyTime: '1557989151;1557996351',
    headers: {
      Date: 'Thu, 16 May 2019 06:45:51 GMT',
      Host: 'examplebucket-1250000000.cos.ap-beijing.myqcloud.com',
      'Content-Type': 'text/plain',
      'Content-Length': '13',
      'Content-MD5': 'mQ/fVh815F3k6TAUm8m0eg==',
      'x-cos-acl': 'private',
      'x-cos-grant-read': 'uin="100000000011"',
    },
  })
  assert.equal(material.headerList, 'content-length;content-md5;content-type;date;host;x-cos-acl;x-cos-grant-read')
  assert.equal(material.stringToSign, 'sha1\n1557989151;1557996351\n8b2751e77f43a0995d6e9eb9477f4b685cca4172\n')
  assert.equal(crypto.createHmac('sha1', 'eb2519b498b02ac213cb1f3d1a3d27a3b3c9bc5f').update(material.stringToSign).digest('hex'), '3b8851a11a569213c17ba8fa7dcf2abec6935172')
  assert.equal(crypto.createHmac('sha1', Buffer.alloc(20, 0x0b)).update('Hi There').digest('hex'), 'b617318655057264e28bc0b6fb378c8ef146be00')
})

test('signs all upload integrity headers and rejects repeated canonical keys', () => {
  const authorization = buildCosAuthorization({ ...config, method: 'PUT', pathname: '/a.msix', headers: { host, 'content-md5': 'example==', 'x-cos-forbid-overwrite': 'true' }, now: 1700000000 })
  assert.match(authorization, /q-header-list=content-md5;host;x-cos-forbid-overwrite/)
  assert.match(authorization, /q-sign-time=1699999940;1700001800/)
  assert.match(authorization, /q-signature=[0-9a-f]{40}$/)
  assert.throws(() => buildCosSigningMaterial({ method: 'GET', pathname: '/', headers: { Host: 'a', host: 'b' }, keyTime: '1;2' }), /重复/)
})

test('uses only validated COS bucket endpoints and safe object keys', () => {
  assert.equal(config.publicBaseUrl, 'https://xingmang-downloads-1342302199.cos.ap-shanghai.myqcloud.com')
  for (const bucket of ['bucket.evil.example', 'bucket-13423/path', 'bucket-13423@evil.example']) {
    assert.throws(() => readCosConfiguration({ COS_BUCKET: bucket, COS_SECRET_ID: config.secretId, COS_SECRET_KEY: config.secretKey }), /格式/)
  }
  for (const key of ['../x', 'a/../x', 'a//b', '/a', 'a\\b', 'a%2fb', 'a?x', 'a/#b']) assert.throws(() => validateObjectKey(key), /路径/)
  assert.equal(validateObjectKey('chatgpt/windows-x64/26.930.2377.0/ChatGPT-x64.msix'), 'chatgpt/windows-x64/26.930.2377.0/ChatGPT-x64.msix')
})

test('bounds safe file reads and hashes all needed release digests', async t => {
  const file = await fixture(t, 'release bytes')
  const result = await hashFile(file.filePath)
  assert.equal(result.sha256, digest(file.body))
  assert.equal(result.sha512, crypto.createHash('sha512').update(file.body).digest('base64'))
  assert.equal(result.md5Base64, crypto.createHash('md5').update(file.body).digest('base64'))
  assert.deepEqual(await readBoundedRegularFile(file.filePath), file.body)
  await assert.rejects(hashFile(file.filePath, { maxBytes: 2 }), /安全性或大小/)
  const hardlink = path.join(file.directory, 'hardlink.msix')
  await fs.link(file.filePath, hardlink)
  await assert.rejects(hashFile(hardlink), /单链接/)
})

test('rejects non-HTTPS URLs before any transport call', async () => {
  const mock = mockRequest(() => assert.fail('network must not run'))
  for (const url of [`http://${host}/a`, `https://${host}.evil.example/a`, `https://user:password@${host}/a`, `https://${host}:8443/a`]) {
    await assert.rejects(fetchJson({ url, allowedHosts: [host] }, mock), /白名单/)
  }
  assert.equal(mock.calls.length, 0)
})

test('rejects redirects without exposing authorization or following Location', async () => {
  const mock = mockRequest((call, callback) => callback(response(Buffer.alloc(0), 302, { location: 'https://evil.example/Authorization-secret' })))
  await assert.rejects(fetchJson({ url: `${config.publicBaseUrl}/a`, allowedHosts: [host] }, mock), /重定向已拒绝/)
  assert.equal(mock.calls.length, 1)
})

test('keeps the body deadline after response headers arrive', async () => {
  let stream
  const mock = mockRequest((call, callback) => {
    stream = new PassThrough()
    stream.statusCode = 200
    stream.headers = {}
    callback(stream)
    stream.write('{')
  })
  await assert.rejects(fetchJson({ url: `${config.publicBaseUrl}/a`, allowedHosts: [host] }, { ...mock, bodyTimeoutMs: 20 }), /读取正文超时/)
  assert.equal(stream.destroyed, true)
})

test('times out while waiting for response headers and aborts the request', async () => {
  let pendingRequest
  const mock = mockRequest((call, callback, request) => { pendingRequest = request })
  await assert.rejects(fetchText({ url: `${config.publicBaseUrl}/a`, allowedHosts: [host] }, { ...mock, headerTimeoutMs: 20 }), /响应头超时/)
  assert.equal(pendingRequest.destroyed, true)
})

test('fetches bounded UTF8 metadata and refuses automatic decompression', async () => {
  const text = '<version>26.930.2377.0</version>'
  const mock = mockRequest((call, callback) => callback(response(Buffer.from(text), 200)))
  assert.equal(await fetchText({ url: `${config.publicBaseUrl}/appcast.xml`, allowedHosts: [host], maxBytes: 256 * 1024 }, mock), text)
  const encoded = mockRequest((call, callback) => callback(response(Buffer.from('gzip bytes'), 200, { 'content-encoding': 'gzip' })))
  await assert.rejects(fetchText({ url: `${config.publicBaseUrl}/appcast.xml`, allowedHosts: [host] }, encoded), /压缩正文/)
})

test('bounds responses even when Content-Length is absent or misleading', async () => {
  const mock = mockRequest((call, callback) => callback(response(Buffer.from('123456789'), 200)))
  await assert.rejects(fetchJson({ url: `${config.publicBaseUrl}/a`, allowedHosts: [host], maxBytes: 5 }, mock), /超过大小/)
  const misleading = mockRequest((call, callback) => callback(response(Buffer.from('{}'), 200, { 'content-length': '3' })))
  await assert.rejects(fetchJson({ url: `${config.publicBaseUrl}/a`, allowedHosts: [host] }, misleading), /正文大小/)
})

test('rejects changed upstream ETag without publishing a partial file', async t => {
  const file = await fixture(t)
  const target = path.join(file.directory, 'download.msix')
  const mock = mockRequest((call, callback) => callback(response(file.body, 200, { etag: '"changed"', 'content-length': String(file.body.length) })))
  await assert.rejects(downloadResource({ url: `${config.publicBaseUrl}/a`, filePath: target, allowedHosts: [host], expectedEtag: '"original"' }, mock), /ETag/)
  await assert.rejects(fs.stat(target), { code: 'ENOENT' })
  assert.deepEqual(await fs.readdir(file.directory), ['installer.msix'])
})

test('downloads complete bytes atomically and reports upstream inspection metadata', async t => {
  const file = await fixture(t)
  const target = path.join(file.directory, 'download.msix')
  const headers = { etag: '"original"', 'content-length': String(file.body.length), 'content-type': 'application/vnd.ms-appx', 'last-modified': 'Fri, 02 Oct 2026 00:00:00 GMT' }
  const mock = mockRequest((call, callback) => callback(response(call.method === 'HEAD' ? Buffer.alloc(0) : file.body, 200, headers)))
  const inspected = await inspectResource({ url: `${config.publicBaseUrl}/a`, allowedHosts: [host] }, mock)
  assert.equal(inspected.bytes, file.body.length)
  assert.equal(inspected.etag, '"original"')
  const result = await downloadResource({ url: `${config.publicBaseUrl}/a`, filePath: target, allowedHosts: [host], expectedBytes: file.body.length, expectedSha256: digest(file.body), expectedEtag: inspected.etag }, mock)
  assert.deepEqual(await fs.readFile(target), file.body)
  assert.equal(result.sha256, digest(file.body))
  assert.equal(result.etag, inspected.etag)
})

test('preserves an existing destination instead of silently replacing local bytes', async t => {
  const file = await fixture(t, 'old bytes')
  const mock = mockRequest((call, callback) => callback(response(Buffer.from('new bytes'), 200)))
  await assert.rejects(downloadResource({ url: `${config.publicBaseUrl}/a`, filePath: file.filePath, allowedHosts: [host] }, mock), { code: 'EEXIST' })
  assert.deepEqual(await fs.readFile(file.filePath), file.body)
})

test('closes each download descriptor once, through its FileHandle only', async t => {
  // 10-03 两次偶发红（上面那条 ETag 用例报 EBADF）：写入流拿着 FileHandle 的同一个号，destroy() 时又关一次，
  // 跟 handle.close() 抢。ETag 不符时流还没人监听，抢输的 EBADF 成了未捕获异常；下载成功时那次重复关落在
  // link 之后，号若已被别的文件拿去，关掉的就是别人的。抢先后看线程池，所以直接查有没有绕过 FileHandle 的关闭。
  const file = await fixture(t)
  const headers = { etag: '"original"', 'content-length': String(file.body.length) }
  const rawCloses = t.mock.method(fsCore, 'close')
  const changed = mockRequest((call, callback) => callback(response(file.body, 200, { ...headers, etag: '"changed"' })))
  await assert.rejects(downloadResource({ url: `${config.publicBaseUrl}/a`, filePath: path.join(file.directory, 'changed.msix'), allowedHosts: [host], expectedEtag: '"original"' }, changed), /ETag/)
  // 下载一还回文件号就另开一个文件：新开的拿最小的空闲号，通常就是刚还回来的那个。
  const bystanderPath = path.join(file.directory, 'bystander.log')
  const link = fs.link
  let bystander
  t.mock.method(fs, 'link', async function (...args) {
    await link.apply(fs, args)
    bystander = await fs.open(bystanderPath, 'w')
  })
  const complete = mockRequest((call, callback) => callback(response(file.body, 200, headers)))
  await downloadResource({ url: `${config.publicBaseUrl}/a`, filePath: path.join(file.directory, 'download.msix'), allowedHosts: [host], expectedEtag: '"original"' }, complete)
  try { await bystander.writeFile('still mine') } finally { await bystander.close() }
  assert.equal(await fs.readFile(bystanderPath, 'utf8'), 'still mine')
  assert.deepEqual(rawCloses.mock.calls.map((call) => call.arguments[0]), [])
})

test('writes every downloaded byte when the disk takes a chunk in pieces and gives up on a stalled write', async t => {
  const file = await fixture(t)
  const body = crypto.randomBytes(64 * 1024 + 7)
  const probe = await fs.open(file.filePath)
  const fileHandle = Object.getPrototypeOf(probe)
  await probe.close()
  const write = fileHandle.write
  const writes = t.mock.method(fileHandle, 'write', function (buffer, offset, length, ...rest) {
    return write.call(this, buffer, offset, Math.min(length, 4096), ...rest)
  })
  const mock = mockRequest((call, callback) => callback(response(body, 200, { 'content-length': String(body.length) })))
  const target = path.join(file.directory, 'download.msix')
  await downloadResource({ url: `${config.publicBaseUrl}/a`, filePath: target, allowedHosts: [host], expectedSha256: digest(body) }, mock)
  assert.deepEqual(await fs.readFile(target), body)
  assert.equal(writes.mock.callCount(), Math.ceil(body.length / 4096))
  writes.mock.mockImplementation(async function () { return { bytesWritten: 0 } })
  await assert.rejects(downloadResource({ url: `${config.publicBaseUrl}/a`, filePath: path.join(file.directory, 'stalled.msix'), allowedHosts: [host] }, mock))
  assert.deepEqual((await fs.readdir(file.directory)).sort(), ['download.msix', 'installer.msix'])
})

test('publishes immutable objects with signed MD5 metadata and public full readback', async t => {
  const file = await fixture(t)
  const mock = memoryCos()
  const store = createCosStore(config, mock)
  const key = 'chatgpt/windows-x64/26.930.2377.0/ChatGPT-x64.msix'
  const result = await store.publishFile(key, file.filePath, { contentType: 'application/vnd.ms-appx' })
  assert.equal(result.sha256, digest(file.body))
  assert.equal(result.etag, '"0123456789abcdef"')
  assert.equal(result.url, `${config.publicBaseUrl}/${key}`)
  const put = mock.calls.find(call => call.method === 'PUT')
  assert.equal(put.headers['x-cos-forbid-overwrite'], 'true')
  assert.equal(put.headers['x-cos-meta-sha256'], result.sha256)
  assert.match(put.headers.authorization, /content-md5/)
  for (const call of mock.calls.filter(call => call.method !== 'PUT')) assert.equal(call.headers.authorization, undefined)
  await store.publishFile(key, file.filePath, { contentType: 'application/vnd.ms-appx' })
  assert.equal(mock.calls.filter(call => call.method === 'PUT').length, 1)
})

test('verifies an already public object in full without ever writing it', async () => {
  const body = Buffer.from('published installer')
  const mock = memoryCos()
  const key = 'xingmang/releases/0.2.15/XingMang-AI-Manager-0.2.15-Setup.exe'
  const contentType = 'application/vnd.microsoft.portable-executable'
  const store = createCosStore(config, mock)
  const input = { contentType, expectedBytes: body.length, expectedSha256: digest(body) }
  await assert.rejects(store.verifyFile(key, input), /只核对、不上传/)
  mock.objects.set(key, { body, contentType, sha256: digest(body) })
  const result = await store.verifyFile(key, input)
  assert.equal(result.sha256, digest(body))
  assert.equal(result.url, `${config.publicBaseUrl}/${key}`)
  assert.ok(mock.calls.some(call => call.method === 'GET'))
  mock.objects.set(key, { body: Buffer.alloc(body.length, 88), contentType, sha256: digest(body) })
  await assert.rejects(store.verifyFile(key, input), /SHA256/)
  const calls = mock.calls.length
  for (const invalid of [{ ...input, expectedSha256: undefined }, { ...input, expectedBytes: -1 }, { ...input, expectedSha256: 'X'.repeat(64) }]) {
    await assert.rejects(store.verifyFile(key, invalid), /预期大小和 SHA256/)
  }
  assert.equal(mock.calls.length, calls)
  assert.equal(mock.calls.filter(call => call.method === 'PUT').length, 0)
})

test('checks the preverified local digest before making any upload request', async t => {
  const file = await fixture(t)
  const mock = memoryCos()
  const store = createCosStore(config, mock)
  await assert.rejects(store.publishFile('chatgpt/v1/app.msix', file.filePath, { contentType: 'application/vnd.ms-appx', expectedSha256: '0'.repeat(64) }), /预校验/)
  await assert.rejects(store.publishFile('chatgpt/v1/app.msix', file.filePath, { contentType: 'application/vnd.ms-appx', expectedBytes: file.body.length + 1 }), /预校验/)
  assert.equal(mock.calls.length, 0)
})

test('rejects same-length immutable collisions instead of trusting stored metadata', async t => {
  const file = await fixture(t)
  const mock = memoryCos()
  const key = 'chatgpt/v1/ChatGPT-x64.msix'
  mock.objects.set(key, { body: Buffer.alloc(file.body.length, 88), contentType: 'application/vnd.ms-appx', sha256: digest(file.body) })
  const store = createCosStore(config, mock)
  await assert.rejects(store.publishFile(key, file.filePath, { contentType: 'application/vnd.ms-appx' }), /SHA256/)
  assert.equal(mock.calls.filter(call => call.method === 'PUT').length, 0)
})

test('reuses matching legacy XML media types but rejects an incorrect MSIX media type', async t => {
  const file = await fixture(t)
  const mock = memoryCos()
  mock.objects.set('chatgpt/v1/license.xml', { body: file.body, contentType: 'text/xml', sha256: digest(file.body) })
  mock.objects.set('chatgpt/v1/app.msix', { body: file.body, contentType: 'text/plain', sha256: digest(file.body) })
  const store = createCosStore(config, mock)
  assert.equal((await store.publishFile('chatgpt/v1/license.xml', file.filePath, { contentType: 'application/xml' })).contentType, 'text/xml')
  await assert.rejects(store.publishFile('chatgpt/v1/app.msix', file.filePath, { contentType: 'application/vnd.ms-appx' }), /Content-Type/)
})

test('recovers a lost successful PUT response only through full public readback', async t => {
  const file = await fixture(t)
  const mock = memoryCos({ lostPut: true })
  const store = createCosStore(config, mock)
  const result = await store.publishFile('chatgpt/v1/app.msix', file.filePath, { contentType: 'application/vnd.ms-appx' })
  assert.equal(result.sha256, digest(file.body))
  assert.equal(mock.calls.filter(call => call.method === 'PUT').length, 1)
})

test('reports unknown write state without blindly retrying or logging injected credentials', async t => {
  const file = await fixture(t)
  const mock = memoryCos({ lostPut: true, corruptGet: true })
  const store = createCosStore(config, mock)
  await assert.rejects(store.publishFile('chatgpt/v1/app.msix', file.filePath, { contentType: 'application/vnd.ms-appx' }), error => {
    assert.match(error.message, /未确认成功/)
    assert.equal(error.message.includes(config.secretId), false)
    assert.equal(error.message.includes('Authorization'), false)
    return true
  })
  assert.equal(mock.calls.filter(call => call.method === 'PUT').length, 1)
})

test('publishes each of the three fixed latest pointers with complete public readback', async () => {
  const mock = memoryCos()
  const store = createCosStore(config, mock)
  for (const key of ['xingmang/latest.json', 'chatgpt/latest.json', 'xingmang/offline/claude/latest.json']) {
    const manifest = { version: '1', key }
    await store.publishJson(key, manifest, { overwrite: true })
    assert.deepEqual(await store.readJson(key), manifest)
  }
  assert.equal(mock.calls.filter(call => call.method === 'PUT').length, 3)
  await assert.rejects(store.publishJson('claude/latest.json', {}, { overwrite: true }), /固定/)
  await assert.rejects(store.publishJson('xingmang/offline/other/latest.json', {}, { overwrite: true }), /固定/)
  await assert.rejects(store.publishJson('claude/v1/latest.json', {}, { overwrite: true }), /固定/)
  await assert.rejects(store.publishJson('other/latest.json', {}, { overwrite: true }), /固定/)
  assert.equal(mock.calls.filter(call => call.method === 'PUT').length, 3)
})

test('refuses private objects and only permits overwriting the three fixed latest pointers', async () => {
  const mock = memoryCos({ privateGet: true })
  const store = createCosStore(config, mock)
  await assert.rejects(store.publishJson('chatgpt/latest.json', { version: '1' }, { overwrite: true }), /公共下载核验失败/)
  await assert.rejects(store.publishJson('chatgpt/v1/latest.json', { version: '1' }, { overwrite: true }), /固定/)
  assert.equal(await store.readJson('not-present.json'), null)
  await assert.rejects(store.publishJson('chatgpt/latest.json', {}, { overwrite: true, ifMatch: '"old"' }), /尚未验证/)
})

test('only failures of the path to COS and busy answers count as transient', async () => {
  async function failureOf(handler, options = {}) {
    try { await fetchText({ url: `${config.publicBaseUrl}/a`, allowedHosts: [host] }, { ...mockRequest(handler), ...options }) } catch (error) { return error }
    assert.fail('the request unexpectedly succeeded')
  }
  function reset(code) { return (call, callback, request) => request.destroy(Object.assign(new Error('SECRET'), { code })) }
  function status(value) { return (call, callback) => callback(response(Buffer.alloc(0), value)) }
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_STREAM_PREMATURE_CLOSE']) {
    assert.equal(isTransientTransferFailure(await failureOf(reset(code))), true, code)
  }
  // A host that does not resolve, a bad certificate or an unknown error is an
  // answer, not an outage: retrying would only delay the real diagnosis.
  for (const code of ['ENOTFOUND', 'CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT_IN_CHAIN', 'EACCES', undefined]) {
    assert.equal(isTransientTransferFailure(await failureOf(reset(code))), false, String(code))
  }
  for (const value of [429, 500, 502, 503, 504]) assert.equal(isTransientTransferFailure(await failureOf(status(value))), true, String(value))
  for (const value of [400, 401, 403, 404, 409, 412]) assert.equal(isTransientTransferFailure(await failureOf(status(value))), false, String(value))
  assert.equal(isTransientTransferFailure(await failureOf(() => {}, { headerTimeoutMs: 20 })), true)
  assert.equal(isTransientTransferFailure(Object.assign(new Error('forged'), { status: 503, code: 'ECONNRESET' })), false)
})

test('transient read failures are retried with growing waits while final answers are not', async () => {
  const body = Buffer.from('{"version":"1"}')
  const faults = ['ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT']
  const mock = mockRequest((call, callback, request) => {
    const fault = faults.shift()
    if (fault) return request.destroy(Object.assign(new Error('SECRET'), { code: fault }))
    callback(response(body, 200, { 'content-length': String(body.length) }))
  })
  const waits = []
  const retries = []
  const store = createCosStore(config, { ...mock, sleep: async (milliseconds) => { waits.push(milliseconds) }, random: () => 0 })
  assert.deepEqual(await store.readJson('chatgpt/latest.json', { onRetry: (value) => retries.push(value) }), { version: '1' })
  assert.equal(mock.calls.length, 4)
  assert.deepEqual(waits, [1000, 2000, 4000])
  assert.deepEqual(retries.map(({ attempt, delayMs, error }) => [attempt, delayMs, safeSyncFailure(error).transportCode]), [[1, 1000, 'ECONNRESET'], [2, 2000, 'EAI_AGAIN'], [3, 4000, 'ETIMEDOUT']])

  for (const [statusCode, expected] of [[403, 'reject'], [404, null]]) {
    const answer = mockRequest((call, callback) => callback(response(Buffer.alloc(0), statusCode)))
    const client = createCosStore(config, { ...answer, sleep: async () => assert.fail('a final answer must not wait') })
    if (expected === 'reject') await assert.rejects(client.readJson('chatgpt/latest.json'))
    else assert.equal(await client.readJson('chatgpt/latest.json'), expected)
    assert.equal(answer.calls.length, 1)
  }
  const exhausted = mockRequest((call, callback, request) => request.destroy(Object.assign(new Error('SECRET'), { code: 'ECONNRESET' })))
  await assert.rejects(createCosStore(config, { ...exhausted, sleep: noWait }).readJson('chatgpt/latest.json'), (error) => safeSyncFailure(error).transportCode === 'ECONNRESET')
  assert.equal(exhausted.calls.length, RETRY_POLICIES.read.attempts)
})

test('a stalled first HEAD no longer ends a run before an uploaded installer is verified', async (t) => {
  // 0.2.15 补传第一次：核对已传好的 Intel 包时 HEAD 30 秒没回应，整次补传就此停下。
  const file = await fixture(t)
  const cos = memoryCos()
  const key = 'xingmang/releases/0.2.15/XingMang-AI-Manager-0.2.15-x64.dmg'
  cos.objects.set(key, { body: file.body, contentType: 'application/x-apple-diskimage', sha256: digest(file.body) })
  let stalls = 1
  const transport = { calls: cos.calls, requestImpl(url, input, callback) {
    if (input.method === 'HEAD' && stalls > 0) {
      stalls -= 1
      return cos.requestImpl(url, input, () => {})
    }
    return cos.requestImpl(url, input, callback)
  } }
  const waits = []
  const store = createCosStore(config, { ...transport, headerTimeoutMs: 20, sleep: async (milliseconds) => { waits.push(milliseconds) } })
  const result = await store.publishFile(key, file.filePath, { contentType: 'application/x-apple-diskimage' })
  assert.equal(result.sha256, digest(file.body))
  assert.deepEqual(cos.calls.map((call) => call.method), ['HEAD', 'HEAD', 'GET'])
  assert.equal(waits.length, 1)
})

test('an immutable PUT is repeated only after a transient failure that a 404 readback proves never landed', async (t) => {
  const file = await fixture(t)
  const key = 'xingmang/releases/0.2.16/latest.yml'
  const input = { contentType: 'text/yaml' }
  const repeated = memoryCos({ putFaults: ['ECONNRESET'] })
  const waits = []
  const result = await createCosStore(config, { ...repeated, sleep: async (milliseconds) => { waits.push(milliseconds) }, random: () => 0 }).publishFile(key, file.filePath, input)
  assert.equal(result.sha256, digest(file.body))
  assert.deepEqual(repeated.calls.map((call) => call.method), ['HEAD', 'PUT', 'GET', 'PUT', 'GET'])
  assert.deepEqual(waits, [2500])
  for (const put of repeated.calls.filter((call) => call.method === 'PUT')) assert.equal(put.headers['x-cos-forbid-overwrite'], 'true')

  // A refused write (403) is an answer; a reset after COS stored the bytes but
  // with different public content proves someone else's object. Neither repeats.
  for (const transport of [memoryCos({ putFaults: [403] }), memoryCos({ lostPutCode: 'ECONNRESET', corruptGet: true })]) {
    await assert.rejects(createCosStore(config, { ...transport, sleep: async () => assert.fail('must not wait') }).publishFile(key, file.filePath, input), (error) => {
      assert.equal(safeSyncFailure(error).code, 'cos-upload-unconfirmed')
      return true
    })
    assert.equal(transport.calls.filter((call) => call.method === 'PUT').length, 1)
  }
  // A reset whose bytes did land is recovered by the readback without a second PUT.
  const landed = memoryCos({ lostPutCode: 'ECONNRESET' })
  assert.equal((await createCosStore(config, { ...landed, sleep: async () => assert.fail('must not wait') }).publishFile(key, file.filePath, input)).sha256, digest(file.body))
  assert.equal(landed.calls.filter((call) => call.method === 'PUT').length, 1)
})

test('the latest pointer is written again only when the earlier request never left the runner', async () => {
  const previous = Buffer.from('{"version":"0"}\n')
  for (const [code, succeeds] of [['ECONNREFUSED', true], ['EHOSTUNREACH', true], ['EAI_AGAIN', true], ['ECONNRESET', false], ['ETIMEDOUT', false], ['EPIPE', false]]) {
    const mock = memoryCos({ putFaults: [code] })
    mock.objects.set('chatgpt/latest.json', { body: previous, contentType: 'application/json', sha256: digest(previous) })
    const store = createCosStore(config, { ...mock, sleep: noWait })
    const run = store.publishJson('chatgpt/latest.json', { version: '1' }, { overwrite: true })
    if (succeeds) await run
    else await assert.rejects(run, (error) => safeSyncFailure(error).code === 'cos-upload-unconfirmed')
    assert.equal(mock.calls.filter((call) => call.method === 'PUT').length, succeeds ? 2 : 1, code)
    assert.deepEqual(await store.readJson('chatgpt/latest.json'), { version: succeeds ? '1' : '0' })
  }
})

test('global acceleration is an explicit opt-in that rejects ambiguous values', () => {
  const secrets = { COS_SECRET_ID: 'TESTSECRETID123456', COS_SECRET_KEY: 'TESTSECRETKEY123456' }
  for (const value of [undefined, '', 'false']) assert.equal(readCosConfiguration({ ...secrets, XINGMANG_COS_ACCELERATE: value }).accelerate, false)
  assert.equal(readCosConfiguration({ ...secrets, XINGMANG_COS_ACCELERATE: 'true' }).accelerate, true)
  for (const value of ['TRUE', '1', 'yes']) assert.throws(() => readCosConfiguration({ ...secrets, XINGMANG_COS_ACCELERATE: value }), /全球加速/)
  // Customers keep downloading from the regional address either way.
  assert.equal(readCosConfiguration({ ...secrets, XINGMANG_COS_ACCELERATE: 'true' }).publicBaseUrl, config.publicBaseUrl)
})

test('global acceleration moves only the signed writes and keeps every readback regional', async (t) => {
  const file = await fixture(t)
  const mock = memoryCos()
  const store = createCosStore({ ...config, accelerate: true }, { ...mock, now: () => 1000 })
  const key = 'xingmang/releases/0.2.16/latest.yml'
  const result = await store.publishFile(key, file.filePath, { contentType: 'text/yaml' })
  const accelerated = `${config.bucket}.cos.accelerate.myqcloud.com`
  assert.equal(result.url, `${config.publicBaseUrl}/${key}`)
  assert.deepEqual(mock.calls.map((call) => [call.method, call.url.hostname]), [['HEAD', host], ['PUT', accelerated], ['GET', host]])
  const put = mock.calls[1]
  assert.equal(put.headers.host, accelerated)
  const signed = { ...put.headers }
  delete signed.authorization
  delete signed['accept-encoding']
  assert.equal(put.headers.authorization, buildCosAuthorization({ secretId: config.secretId, secretKey: config.secretKey, method: 'PUT', pathname: `/${key}`, headers: signed, now: 1000 }))
  for (const call of mock.calls.filter((entry) => entry.method !== 'PUT')) assert.equal(call.headers.authorization, undefined)
})
