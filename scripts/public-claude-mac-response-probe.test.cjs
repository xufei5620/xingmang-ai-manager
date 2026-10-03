const assert = require('node:assert/strict')
const { test } = require('node:test')
const { Writable, Readable } = require('node:stream')
const { probeMacInitialHeaders, summarizeHeaders } = require('./public-claude-mac-response-probe.cjs')

test('reports only header presence and challenge classification while destroying both fixed initial GET bodies', async () => {
  const calls = []
  function requestImpl(url, options, callback) {
    calls.push(url.href)
    assert.equal(options.method, 'GET')
    assert.deepEqual(options.headers, { 'accept-encoding': 'identity', 'user-agent': 'xingmang-official-offline-sync/1' })
    const request = new Writable({ write() { assert.fail('no request body') } })
    request.on('finish', function () {
      const response = new Readable({ read() { assert.fail('response body must not be consumed') } })
      response.statusCode = 403
      response.headers = { Location: '', 'www-authenticate': ['SECRET'], 'proxy-authenticate': 'SECRET', refresh: 'SECRET', 'CF-Mitigated': 'challenge', 'set-cookie': 'SECRET' }
      callback(response)
      assert.equal(response.destroyed, true)
    })
    return request
  }
  const rows = await probeMacInitialHeaders({ requestImpl })
  assert.deepEqual(calls, [
    'https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect',
    'https://claude.ai/api/desktop/darwin/universal/pkg/latest/redirect',
  ])
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.status, 403)
    assert.equal(row.method, 'GET')
    assert.equal(row.bodyBytesConsumed, 0)
    assert.deepEqual(row.fields, { location: true, wwwAuthenticate: true, proxyAuthenticate: true, refresh: true, cfMitigated: true })
    assert.equal(row.cfMitigatedClass, 'challenge')
  }
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|set-cookie|https:\/\//)
})

test('does not misclassify absent, invalid, or other challenge values and never logs their content', () => {
  assert.equal(summarizeHeaders({}).cfMitigatedClass, 'absent')
  assert.equal(summarizeHeaders({ 'cf-mitigated': [] }).cfMitigatedClass, 'invalid')
  const result = summarizeHeaders({ location: null, 'cf-mitigated': 'SECRET' })
  assert.equal(result.fields.location, true)
  assert.equal(result.cfMitigatedClass, 'other')
  assert.doesNotMatch(JSON.stringify(result), /SECRET/)
})

test('bounds a nonresponding initial request and does not retry or expose raw errors', async () => {
  const calls = []
  function requestImpl(url) {
    calls.push(url.href)
    return new Writable({ write() { assert.fail('no upload') } })
  }
  const rows = await probeMacInitialHeaders({ requestImpl, timeoutMs: 5 })
  assert.equal(calls.length, 2)
  assert.ok(rows.every(row => row.status === null && row.code === 'response-header-timeout' && row.bodyBytesConsumed === 0))
})
