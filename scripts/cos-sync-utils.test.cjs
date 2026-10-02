const assert = require('node:assert/strict')
const crypto = require('node:crypto')
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
  readBoundedRegularFile,
  readCosConfiguration,
  validateObjectKey,
} = require('./cos-sync-utils.cjs')

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

function memoryCos({ lostPut = false, corruptGet = false, privateGet = false } = {}) {
  const objects = new Map()
  const transport = mockRequest((call, callback, request) => {
    const key = decodeURIComponent(call.url.pathname.slice(1))
    if (call.method === 'PUT') {
      const existing = objects.get(key)
      if (existing && call.headers['x-cos-forbid-overwrite'] === 'true') {
        callback(response(Buffer.alloc(0), 409))
        return
      }
      assert.equal(call.headers['content-md5'], crypto.createHash('md5').update(call.body).digest('base64'))
      objects.set(key, { body: call.body, contentType: call.headers['content-type'], sha256: call.headers['x-cos-meta-sha256'] })
      if (lostPut) request.destroy(new Error(`Authorization: ${call.headers.authorization}`))
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
  for (const key of ['xingmang/latest.json', 'chatgpt/latest.json', 'claude/latest.json']) {
    const manifest = { version: '1', key }
    await store.publishJson(key, manifest, { overwrite: true })
    assert.deepEqual(await store.readJson(key), manifest)
  }
  assert.equal(mock.calls.filter(call => call.method === 'PUT').length, 3)
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
