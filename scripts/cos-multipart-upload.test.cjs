const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { PassThrough, Readable, Writable } = require('node:stream')
const { test } = require('node:test')
const { PART_BYTES, THRESHOLD_BYTES, readMultipartOptions, parseMultipartXml, uploadMultipart } = require('./cos-multipart-upload.cjs')
const { createCosStore, readCosConfiguration, buildCosAuthorization, safeSyncFailure } = require('./cos-sync-utils.cjs')

const config = readCosConfiguration({ COS_SECRET_ID: 'TESTSECRETID123456', COS_SECRET_KEY: 'TESTSECRETKEY123456' })
const key = 'chatgpt/linux-rpm-arm64/sha256-test/installer.rpm'
const uploadId = 'owned-upload-123'

function digest(body, algorithm, encoding = 'hex') { return crypto.createHash(algorithm).update(body).digest(encoding) }
function initXml() { return Buffer.from(`<InitiateMultipartUploadResult><Bucket>${config.bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`) }
function completeXml() { return Buffer.from(` <CompleteMultipartUploadResult><Location>http://untrusted.invalid/ignored</Location><Bucket>${config.bucket}</Bucket><Key>${key}</Key><ETag>&quot;${'a'.repeat(32)}-5&quot;</ETag></CompleteMultipartUploadResult>`) }
function response(body, status = 200, headers = {}) {
  const result = Readable.from(body.length ? [body] : [])
  result.statusCode = status
  result.headers = { 'content-length': String(body.length), ...headers }
  result.on('end', () => { result.complete = true })
  return result
}
async function fixture(t, size = THRESHOLD_BYTES + 123) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'xingmang-multipart-test-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const filePath = path.join(directory, 'installer.rpm')
  const body = Buffer.alloc(size, 71)
  await fs.writeFile(filePath, body)
  return { filePath, body, input: { expectedBytes: size, expectedSha256: digest(body, 'sha256'), contentType: 'application/x-rpm' } }
}
function memoryMultipart({ loseComplete = false, errorComplete = false, completeHttpError = false, corruptReadback = false, existing = null, failPart = false, partFault, now = function () { return 1000 } } = {}) {
  const calls = []
  const parts = new Map()
  const attempts = new Map()
  let object = existing
  let contentType = 'application/x-rpm'
  let active = 0
  let peak = 0
  function requestImpl(url, input, callback) {
    const chunks = []
    const request = new Writable({ autoDestroy: false, write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done() } })
    const call = { url, ...input }
    calls.push(call)
    request.on('finish', () => {
      call.body = Buffer.concat(chunks)
      const query = Object.fromEntries(url.searchParams)
      if (input.headers.authorization) {
        const headers = { ...input.headers }
        delete headers.authorization
        // The common transport adds identity encoding after signing; COS v5
        // signs the explicitly declared header-list, not every wire header.
        delete headers['accept-encoding']
        assert.equal(input.headers.authorization, buildCosAuthorization({ secretId: config.secretId, secretKey: config.secretKey, method: input.method, pathname: decodeURIComponent(url.pathname), query, headers, now: now() }))
        if (input.method !== 'DELETE') assert.equal(headers['content-md5'], digest(call.body, 'md5', 'base64'))
      }
      if (input.method === 'POST' && Object.hasOwn(query, 'uploads')) {
        assert.equal(input.headers['x-cos-forbid-overwrite'], 'true')
        return callback(response(initXml()))
      }
      if (input.method === 'PUT' && query.uploadId) {
        assert.equal(query.uploadId, uploadId)
        assert.ok(call.body.length <= PART_BYTES)
        active += 1
        peak = Math.max(peak, active)
        setTimeout(() => {
          active -= 1
          if (failPart && query.partNumber === '1') return callback(response(Buffer.alloc(0), 403))
          parts.set(Number(query.partNumber), call.body)
          const attempt = (attempts.get(query.partNumber) || 0) + 1
          attempts.set(query.partNumber, attempt)
          if (partFault?.({ call, callback, request, attempt })) return
          callback(response(Buffer.alloc(0), 200, { etag: `"${digest(call.body, 'md5')}"` }))
        }, 100)
        return
      }
      if (input.method === 'PUT') {
        object = call.body
        contentType = input.headers['content-type']
        return callback(response(Buffer.alloc(0)))
      }
      if (input.method === 'POST' && query.uploadId) {
        assert.equal(query.uploadId, uploadId)
        assert.equal(input.headers['x-cos-forbid-overwrite'], 'true')
        const numbers = [...call.body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map(match => Number(match[1]))
        assert.deepEqual(numbers, [...parts.keys()].sort((a, b) => a - b))
        if (errorComplete) return callback(response(Buffer.from('<Error><Code>SECRET</Code></Error>')))
        if (completeHttpError) return callback(response(Buffer.from('<Error><Code>RequestTimeout</Code></Error>'), 400))
        object = Buffer.concat(numbers.map(number => parts.get(number)))
        if (loseComplete) return request.destroy(Object.assign(new Error('SECRET signed upload URL'), { code: 'ECONNRESET' }))
        return callback(response(completeXml()))
      }
      if (input.method === 'DELETE') {
        assert.equal(active, 0)
        assert.deepEqual(query, { uploadId })
        return callback(response(Buffer.alloc(0), 204))
      }
      assert.equal(url.search, '')
      if (!object) return callback(response(Buffer.alloc(0), 404))
      const body = corruptReadback ? Buffer.alloc(object.length, 82) : object
      callback(response(input.method === 'HEAD' ? Buffer.alloc(0) : body, 200, { 'content-length': String(body.length), 'content-type': contentType, etag: '"public-object"' }))
    })
    return request
  }
  return { requestImpl, calls, get peak() { return peak } }
}
function store(transport, enabled = true, concurrency = 4) {
  return createCosStore({ ...config, multipart: { enabled, concurrency } }, { requestImpl: transport.requestImpl, now: () => 1000 })
}

test('multipart is disabled by default and concurrency stays inside four to eight workers', () => {
  assert.deepEqual(readMultipartOptions({}), { enabled: false, concurrency: 8 })
  assert.equal(readMultipartOptions({ XINGMANG_COS_MULTIPART_ENABLED: 'false' }).enabled, false)
  for (const value of ['TRUE', '1']) assert.throws(() => readMultipartOptions({ XINGMANG_COS_MULTIPART_ENABLED: value }))
  for (const value of ['3', '9', '4.5', 'NaN']) assert.throws(() => readMultipartOptions({ XINGMANG_COS_MULTIPART_CONCURRENCY: value }))
})

test('strict XML rejects error bodies, entities, duplicate fields and unrelated identities', () => {
  const fields = ['Bucket', 'Key', 'UploadId']
  for (const value of ['<!DOCTYPE x><InitiateMultipartUploadResult/>', '<Error><Code>SECRET</Code></Error>', initXml().toString().replace('<Key>', '<Bucket>other</Bucket><Key>'), initXml().toString().replace(uploadId, '&xxe;'), '<InitiateMultipartUploadResult><UploadId>x</UploadId></InitiateMultipartUploadResult>']) {
    assert.throws(() => parseMultipartXml(Buffer.from(value), 'InitiateMultipartUploadResult', fields))
  }
  assert.equal(parseMultipartXml(initXml(), 'InitiateMultipartUploadResult', fields).UploadId, uploadId)
})

test('bounded parallel parts sign exact queries and MD5 then confirm the full public SHA256', async t => {
  const data = await fixture(t)
  const transport = memoryMultipart()
  const progress = []
  const result = await store(transport).publishFile(key, data.filePath, { ...data.input, onProgress: value => progress.push(value) })
  assert.equal(result.sha256, data.input.expectedSha256)
  assert.equal(transport.peak, 4)
  assert.equal(transport.calls.filter(call => call.method === 'POST').length, 2)
  assert.equal(transport.calls.filter(call => call.method === 'DELETE').length, 0)
  assert.equal(transport.calls.at(-1).method, 'GET')
  assert.equal(progress.findLast(value => value.phase === 'upload-body').transferredBytes, data.body.length)
  assert.doesNotMatch(JSON.stringify(progress), /uploadId|SECRET|authorization|url/)
})

test('part response headers allow six minutes within each signature and honor shorter caller budgets', async t => {
  const data = await fixture(t)
  const realSetTimeout = global.setTimeout
  let latestTimeoutMs
  t.mock.method(global, 'setTimeout', function (callback, milliseconds, ...args) {
    latestTimeoutMs = milliseconds
    return realSetTimeout(callback, milliseconds, ...args)
  })
  for (const [headerTimeoutMs, expectedPartTimeoutMs] of [[undefined, 360000], [1200000, 360000], [120000, 120000]]) {
    const transport = memoryMultipart()
    const requests = []
    const client = createCosStore({ ...config, multipart: { enabled: true, concurrency: 4 } }, {
      now: () => 1000,
      headerTimeoutMs,
      requestImpl: function (url, input, callback) {
        requests.push({ url, ...input, headerTimeoutMs: latestTimeoutMs })
        return transport.requestImpl(url, input, callback)
      },
    })
    await client.publishFile(key, data.filePath, data.input)
    const partRequests = requests.filter(call => call.url.searchParams.has('partNumber'))
    assert.equal(partRequests.length, Math.ceil(data.body.length / PART_BYTES))
    for (const call of partRequests) {
      assert.equal(call.headerTimeoutMs, expectedPartTimeoutMs)
      const [start, end] = new URLSearchParams(call.headers.authorization).get('q-sign-time').split(';').map(Number)
      assert.equal(start, 940)
      assert.equal(end, 2800)
      assert.ok(end - 1000 > call.headerTimeoutMs / 1000)
    }
    for (const call of requests.filter(call => !call.url.searchParams.has('partNumber'))) {
      assert.equal(call.headerTimeoutMs, headerTimeoutMs ?? 30000)
    }
  }
})

test('a lost complete response is never retried or aborted and matching public content recovers', async t => {
  const data = await fixture(t)
  const transport = memoryMultipart({ loseComplete: true })
  assert.equal((await store(transport).publishFile(key, data.filePath, data.input)).sha256, data.input.expectedSha256)
  assert.equal(transport.calls.filter(call => call.method === 'POST').length, 2)
  assert.equal(transport.calls.filter(call => call.method === 'DELETE').length, 0)
})

test('HTTP 200 Error remains an uncertain complete and never permits latest publication', async t => {
  const data = await fixture(t)
  const transport = memoryMultipart({ errorComplete: true })
  await assert.rejects(store(transport).publishFile(key, data.filePath, data.input), error => {
    const diagnostic = safeSyncFailure(error)
    assert.equal(diagnostic.put.multipartState, 'complete-unconfirmed')
    assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET|upload-123|authorization|https?:/)
    return true
  })
  assert.equal(transport.calls.filter(call => call.method === 'DELETE').length, 0)
  assert.equal(transport.calls.at(-1).method, 'GET')
})

test('failed parts all settle before aborting only the owned session with no complete', async t => {
  const data = await fixture(t)
  const transport = memoryMultipart({ failPart: true })
  await assert.rejects(store(transport).publishFile(key, data.filePath, data.input))
  assert.equal(transport.calls.filter(call => call.method === 'POST').length, 1)
  assert.equal(transport.calls.filter(call => call.method === 'DELETE').length, 1)
})

test('a saved part with a lost reply retries identical bytes and digests with a fresh signature', async t => {
  const data = await fixture(t)
  let now = 1000
  const transport = memoryMultipart({ now: () => now, partFault: function ({ call, request, attempt }) {
    if (call.url.searchParams.get('partNumber') !== '1' || attempt !== 1) return false
    now = 1010
    request.destroy(Object.assign(new Error('SECRET response lost'), { code: 'ETIMEDOUT' }))
    return true
  } })
  const progress = []
  const client = createCosStore({ ...config, multipart: { enabled: true, concurrency: 4 } }, { requestImpl: transport.requestImpl, now: () => now })
  await client.publishFile(key, data.filePath, { ...data.input, onProgress: value => { if (value.method === 'PUT' && value.phase === 'upload-body') progress.push(value.transferredBytes) } })
  const attempts = transport.calls.filter(call => call.url.searchParams.get('partNumber') === '1')
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0].url.href, attempts[1].url.href)
  assert.deepEqual(attempts[0].body, attempts[1].body)
  assert.equal(attempts[0].headers['content-md5'], attempts[1].headers['content-md5'])
  assert.equal(digest(attempts[0].body, 'sha256'), digest(attempts[1].body, 'sha256'))
  assert.notEqual(attempts[0].headers.authorization, attempts[1].headers.authorization)
  assert.equal(progress.at(-1), data.body.length)
  assert.equal(progress.length, Math.ceil(data.body.length / PART_BYTES))
  assert.equal(transport.calls.filter(call => call.method === 'POST').length, 2)
  assert.equal(transport.calls.filter(call => call.method === 'DELETE').length, 0)
})

test('only a diagnosed HTTP 400 RequestTimeout retries and each part stops after three attempts', async t => {
  const data = await fixture(t)
  for (const [code, failCount, expectedAttempts, succeeds] of [
    ['RequestTimeout', 2, 3, true], ['RequestTimeout', 3, 3, false],
    ['BadDigest', 1, 1, false], ['InvalidDigest', 1, 1, false], ['UnknownSECRET', 1, 1, false],
    ...['UserNetworkTooSlow', 'IncompleteBody', 'EntitySizeNotMatch', 'MissingRequestBodyError', 'BadRequest', 'InvalidRequest', 'UnexpectedContent', 'EntityTooLarge', 'MalformedXML'].map(code => [code, 1, 1, false]),
  ]) {
    const transport = memoryMultipart({ partFault: function ({ call, callback, attempt }) {
      if (call.url.searchParams.get('partNumber') !== '1' || attempt > failCount) return false
      callback(response(Buffer.from(`<Error><Code>${code}</Code><Message>SECRET</Message></Error>`), 400))
      return true
    } })
    const run = store(transport).publishFile(key, data.filePath, data.input)
    if (succeeds) await run
    else await assert.rejects(run, error => {
      const diagnostic = safeSyncFailure(error)
      assert.equal(diagnostic.put.put.status, 400)
      assert.equal(diagnostic.put.put.cosErrorCode, code === 'UnknownSECRET' ? undefined : code)
      assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET|authorization|upload-123/)
      return true
    })
    assert.equal(transport.calls.filter(call => call.url.searchParams.get('partNumber') === '1').length, expectedAttempts)
    assert.equal(transport.calls.filter(call => call.method === 'POST').length, succeeds ? 2 : 1)
    assert.equal(transport.calls.filter(call => call.method === 'DELETE').length, succeeds ? 0 : 1)
  }
})

test('part checksum and certificate failures never retry', async t => {
  const data = await fixture(t)
  for (const failure of ['etag', 'CERT_HAS_EXPIRED', 'ECONNRESET']) {
    const transport = memoryMultipart({ partFault: function ({ call, callback, request }) {
      if (call.url.searchParams.get('partNumber') !== '1') return false
      if (failure === 'etag') callback(response(Buffer.alloc(0), 200, { etag: '"wrong-md5"' }))
      else request.destroy(Object.assign(new Error('SECRET'), { code: failure }))
      return true
    } })
    await assert.rejects(store(transport).publishFile(key, data.filePath, data.input))
    assert.equal(transport.calls.filter(call => call.url.searchParams.get('partNumber') === '1').length, 1)
    assert.equal(transport.calls.filter(call => call.method === 'POST').length, 1)
    assert.equal(transport.calls.filter(call => call.method === 'DELETE').length, 1)
  }
})

test('part response header and body timeouts retry only the failed part', async t => {
  const data = await fixture(t)
  for (const phase of ['header', 'body']) {
    const transport = memoryMultipart({ partFault: function ({ call, callback, attempt }) {
      if (call.url.searchParams.get('partNumber') !== '1' || attempt !== 1) return false
      if (phase === 'body') {
        const stream = new PassThrough()
        stream.statusCode = 200
        stream.headers = { 'content-length': '0', etag: `"${digest(call.body, 'md5')}"` }
        callback(stream)
      }
      return true
    } })
    const client = createCosStore({ ...config, multipart: { enabled: true, concurrency: 4 } }, { requestImpl: transport.requestImpl, now: () => 1000, headerTimeoutMs: 500, bodyTimeoutMs: 20 })
    await client.publishFile(key, data.filePath, data.input)
    assert.equal(transport.calls.filter(call => call.url.searchParams.get('partNumber') === '1').length, 2)
    assert.equal(transport.calls.filter(call => call.method === 'DELETE').length, 0)
  }
})

test('a diagnosed complete timeout remains uncertain without retry or abort', async t => {
  const data = await fixture(t)
  const transport = memoryMultipart({ completeHttpError: true })
  await assert.rejects(store(transport).publishFile(key, data.filePath, data.input), error => {
    const diagnostic = safeSyncFailure(error)
    assert.equal(diagnostic.put.multipartState, 'complete-unconfirmed')
    assert.equal(diagnostic.put.put.cosErrorCode, 'RequestTimeout')
    assert.equal(diagnostic.put.put.multipartOperation, 'complete')
    return true
  })
  assert.equal(transport.calls.filter(call => call.method === 'POST').length, 2)
  assert.equal(transport.calls.filter(call => call.method === 'DELETE').length, 0)
  assert.equal(transport.calls.at(-1).method, 'GET')
})

test('part retries retain the original deadline and stop after another worker fails', async t => {
  const data = await fixture(t, PART_BYTES * 4)
  for (const reason of ['deadline', 'sibling']) {
    const handle = await fs.open(data.filePath, 'r')
    let clock = 0
    let active = 0
    let release
    const sibling = new Promise(resolve => { release = resolve })
    let enterFirstPart
    const firstPartStarted = new Promise(resolve => { enterFirstPart = resolve })
    const operations = []
    const timeout = new Error('retryable timeout')
    const terminal = new Error('terminal failure')
    try {
      await assert.rejects(uploadMultipart({ handle, stat: await handle.stat(), hash: { bytes: data.body.length, sha256: data.input.expectedSha256 }, bucket: config.bucket, key, concurrency: 4,
        monotonicNow: () => clock, failure: error => error, shouldRetryPart: error => error === timeout,
        request: async function (operation, method, query, body) {
          operations.push([operation, query.partNumber])
          if (operation === 'init') return { body: initXml() }
          if (operation === 'abort') { assert.equal(active, 0); return {} }
          assert.equal(operation, 'part')
          active += 1
          try {
            if (query.partNumber === '1') {
              enterFirstPart()
              if (reason === 'sibling') await sibling
              else clock = 75 * 60 * 1000
              throw timeout
            }
            if (query.partNumber === '2' && reason === 'sibling') {
              await firstPartStarted
              setImmediate(release)
              throw terminal
            }
            return { bytes: 0, headers: { etag: `"${digest(body, 'md5')}"` } }
          } finally { active -= 1 }
        },
      }), reason === 'deadline' ? /总时间限制/ : /terminal failure/)
      assert.equal(operations.filter(([operation, number]) => operation === 'part' && number === '1').length, 1)
      assert.equal(operations.filter(([operation]) => operation === 'complete').length, 0)
      assert.deepEqual(operations.at(-1), ['abort', undefined])
    } finally { await handle.close() }
  }
})

test('an existing conflicting immutable object is fully read and never starts multipart', async t => {
  const data = await fixture(t)
  const transport = memoryMultipart({ existing: Buffer.alloc(data.body.length, 90) })
  await assert.rejects(store(transport).publishFile(key, data.filePath, data.input), /SHA256/)
  assert.deepEqual(transport.calls.map(call => call.method), ['HEAD', 'GET'])
})

test('a completed object with corrupt public content fails the unchanged full readback gate', async t => {
  const data = await fixture(t)
  const transport = memoryMultipart({ corruptReadback: true })
  await assert.rejects(store(transport).publishFile(key, data.filePath, data.input), /公共下载核验失败/)
  assert.equal(transport.calls.filter(call => call.method === 'DELETE').length, 0)
})

test('part buffers bind to the prehashed inode snapshot before any complete', async t => {
  const data = await fixture(t, PART_BYTES * 2)
  const handle = await fs.open(data.filePath, 'r')
  t.after(() => handle.close())
  const stat = await handle.stat()
  const operations = []
  await assert.rejects(uploadMultipart({ handle, stat, hash: { bytes: data.body.length, sha256: data.input.expectedSha256 }, bucket: config.bucket, key, concurrency: 4,
    failure: error => error,
    request: async function (operation) {
      operations.push(operation)
      if (operation === 'init') { await fs.writeFile(data.filePath, Buffer.alloc(data.body.length, 70)); return { body: initXml() } }
      if (operation === 'abort') return {}
      throw new Error('unexpected publication')
    },
  }), /源文件内容发生变化/)
  assert.deepEqual(operations, ['init', 'abort'])
})

test('all protected workflows expose disabled-by-default multipart without granting new credentials', async () => {
  for (const name of ['publish-release.yml', 'sync-chatgpt-official-cos.yml', 'sync-claude-official-cos.yml', 'sync-published-manager-cos.yml']) {
    const text = await fs.readFile(path.join(__dirname, '../.github/workflows', name), 'utf8')
    assert.match(text, /XINGMANG_COS_MULTIPART_ENABLED: \$\{\{ vars\.XINGMANG_COS_MULTIPART_ENABLED \|\| 'false' \}\}/)
    assert.match(text, /XINGMANG_COS_MULTIPART_CONCURRENCY: \$\{\{ vars\.XINGMANG_COS_MULTIPART_CONCURRENCY \|\| '8' \}\}/)
  }
})

test('disabled large files, enabled small files and latest JSON preserve the single PUT path', async t => {
  const data = await fixture(t)
  const disabled = memoryMultipart()
  await store(disabled, false).publishFile(key, data.filePath, data.input)
  assert.deepEqual(disabled.calls.map(call => call.method), ['HEAD', 'PUT', 'GET'])
  const smallData = await fixture(t, 123)
  const small = memoryMultipart()
  await store(small).publishFile(key, smallData.filePath, smallData.input)
  assert.deepEqual(small.calls.map(call => call.method), ['HEAD', 'PUT', 'GET'])
  const latest = memoryMultipart()
  await store(latest).publishJson('chatgpt/latest.json', { schemaVersion: 1 }, { overwrite: true })
  assert.deepEqual(latest.calls.map(call => call.method), ['HEAD', 'PUT', 'GET'])
  assert.equal(latest.calls[1].headers['x-cos-forbid-overwrite'], undefined)
})

test('dispatch can finish beyond thirty minutes but stops at the seventy-five minute boundary', async t => {
  const data = await fixture(t, PART_BYTES + 123)
  for (const elapsedMs of [31 * 60 * 1000, 75 * 60 * 1000 - 1, 75 * 60 * 1000]) {
    const handle = await fs.open(data.filePath, 'r')
    const stat = await handle.stat()
    let clock = 0
    const operations = []
    try {
      const run = uploadMultipart({ handle, stat, hash: { bytes: data.body.length, sha256: data.input.expectedSha256 }, bucket: config.bucket, key, concurrency: 4,
        monotonicNow: () => clock, failure: error => error,
        request: async function (operation, method, query, body) {
          operations.push(operation)
          if (operation === 'init') { clock = elapsedMs; return { body: initXml() } }
          if (operation === 'part') return { bytes: 0, headers: { etag: `"${digest(body, 'md5')}"` } }
          if (operation === 'complete') return { body: completeXml() }
          return {}
        },
      })
      if (elapsedMs < 75 * 60 * 1000) { await run; assert.ok(operations.includes('complete')) }
      else { await assert.rejects(run, /总时间限制/); assert.deepEqual(operations, ['init', 'abort']) }
    } finally { await handle.close() }
  }
})

test('wrong initiation identity never authorizes abort for an unowned upload id', async t => {
  const data = await fixture(t, 123)
  const handle = await fs.open(data.filePath, 'r')
  try {
    const operations = []
    await assert.rejects(uploadMultipart({ handle, stat: await handle.stat(), hash: { bytes: data.body.length, sha256: data.input.expectedSha256 }, bucket: config.bucket, key, concurrency: 4,
      failure: error => error, request: async function (operation) { operations.push(operation); return { body: Buffer.from(initXml().toString().replace(config.bucket, 'wrong-bucket')) } },
    }), /身份不匹配/)
    assert.deepEqual(operations, ['init'])
  } finally { await handle.close() }
})
