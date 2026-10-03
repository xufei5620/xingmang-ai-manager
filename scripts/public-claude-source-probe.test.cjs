const assert = require('node:assert/strict')
const { Readable, Writable } = require('node:stream')
const test = require('node:test')
const { probeClaudeSources } = require('./public-claude-source-probe.cjs')

function transport(headResponse) {
  const calls = []
  function requestImpl(url, options, callback) {
    calls.push({ url, method: options.method })
    assert.ok(['HEAD', 'GET'].includes(options.method))
    assert.equal(options.headers.authorization, undefined)
    assert.equal(options.headers.cookie, undefined)
    if (options.method === 'GET') assert.ok(url.href.endsWith('/Packages'))
    else assert.equal(options.headers['user-agent'], 'xingmang-official-offline-sync/1')
    const request = new Writable({ write(chunk, encoding, done) { assert.fail('no request body'); done() } })
    request.on('finish', () => {
      if (options.method === 'HEAD') {
        const selected = headResponse(url)
        const response = Readable.from([])
        response.statusCode = selected.status
        response.headers = { ...(selected.location ? { location: selected.location } : {}), 'content-length': '64' }
        callback(response)
        return
      }
      const architecture = url.pathname.includes('binary-amd64') ? 'amd64' : 'arm64'
      const body = Buffer.from(`Package: claude-desktop\nVersion: 1.2.3\nArchitecture: ${architecture}\nSize: 64\nSHA256: ${'a'.repeat(64)}\nFilename: pool/main/c/claude-desktop/claude-desktop_1.2.3_${architecture}.deb\n`)
      const response = Readable.from([body])
      response.statusCode = 200
      response.headers = { 'content-length': String(body.length) }
      response.complete = false
      response.on('end', () => { response.complete = true })
      callback(response)
    })
    return request
  }
  return { requestImpl, calls }
}

test('four blocked package HEADs and two valid APT indexes remain a source-only result', async () => {
  const mock = transport(() => ({ status: 403 }))
  const rows = await probeClaudeSources(mock)
  assert.equal(mock.calls.filter((call) => call.method === 'HEAD').length, 4)
  assert.equal(mock.calls.filter((call) => call.method === 'GET').length, 2)
  assert.equal(rows.filter((row) => row.phase === 'head' && row.status === 403 && row.locationPresent === false).length, 4)
  assert.equal(rows.filter((row) => row.phase === 'apt-parse' && row.code === 'parse-ok').length, 2)
  assert.ok(rows.filter((row) => row.phase === 'apt-parse').every((row) => row.packageSize === 64 && row.sha256 === 'a'.repeat(64) && row.version === '1.2.3'))
})

test('unknown signed CDN redirects stop without another request or disclosure of paths and query values', async () => {
  const mock = transport(() => ({ status: 302, location: 'https://unknown.blob.core.windows.net/SECRET.msix?sig=SECRET' }))
  const rows = await probeClaudeSources(mock)
  assert.equal(mock.calls.filter((call) => call.method === 'HEAD').length, 4)
  const stopped = rows.filter((row) => row.phase === 'redirect-stop')
  assert.equal(stopped.length, 4)
  assert.ok(stopped.every((row) => row.host === 'unknown.blob.core.windows.net' && row.queryPresent === true && row.path === undefined))
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|sig=|https:\/\//)
})

test('known host and legal path redirects use HEAD only and disclose query presence rather than SAS values', async () => {
  const mock = transport((url) => url.hostname === 'claude.ai'
    ? { status: 302, location: 'https://downloads.claude.ai/releases/1.2.3/package.msix?sig=SECRET' }
    : { status: 200 })
  const rows = await probeClaudeSources(mock)
  assert.equal(mock.calls.filter((call) => call.method === 'HEAD').length, 8)
  assert.ok(rows.some((row) => row.phase === 'head' && row.status === 200 && row.host === 'downloads.claude.ai'
    && row.path === '/releases/1.2.3/package.msix' && row.queryPresent === true))
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|sig=/)
})

test('GET response-only mode skips APT and destroys package responses before reading any body', async () => {
  const calls = []
  function requestImpl(url, options, callback) {
    calls.push(url)
    assert.equal(options.method, 'GET')
    assert.equal(options.headers['user-agent'], 'xingmang-official-offline-sync/1')
    assert.equal(options.headers.cookie, undefined)
    assert.equal(options.headers.authorization, undefined)
    const request = new Writable({ write(chunk, encoding, done) { assert.fail('no upload'); done() } })
    request.on('finish', () => {
      const response = new Readable({ read() { assert.fail('package body must never be consumed') } })
      response.statusCode = url.pathname.includes('/win32/') ? 405 : 403
      response.headers = { 'content-length': '132' }
      callback(response)
      assert.equal(response.destroyed, true)
    })
    return request
  }
  const rows = await probeClaudeSources({ requestImpl, method: 'GET', metadata: false })
  assert.equal(calls.length, 4)
  assert.ok(calls.every((url) => url.hostname === 'claude.ai' && !url.pathname.endsWith('/Packages')))
  assert.ok(rows.every((row) => row.phase === 'get-response-headers' && row.sameAsPriorHead === true && row.declaredBytesSafe === 132))
})
