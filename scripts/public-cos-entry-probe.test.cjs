const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { Readable, Writable } = require('node:stream')
const test = require('node:test')
const { RESOURCES, MAX_PUBLIC_BYTES, publicRequest } = require('./public-entry-http.cjs')
const { probePublicEntries, writeEvidence } = require('./public-cos-entry-probe.cjs')

function document(kind) {
  if (kind === 'windows-metadata') return JSON.stringify({ schemaVersion: 1, packageIdentity: 'OpenAI.Codex', storeProductId: '9PLM9XGG6VKS', buildVersion: '26.930.2377.0' })
  if (kind === 'manager-index') return JSON.stringify({ schemaVersion: 1, product: 'xingmang-ai-manager', files: [{ token: 'SECRET' }] })
  if (kind === 'claude-index') return JSON.stringify({ schemaVersion: 1, product: 'claude-desktop', files: [{ token: 'SECRET' }] })
  if (kind === 'codex-index') return JSON.stringify({ schemaVersion: 1, product: 'chatgpt', platforms: { token: 'SECRET' } })
  if (kind === 'license-xml') return '<License xmlns="urn:schemas-microsoft-com:windows:store:licensing:ls"><ProductID>9PLM9XGG6VKS</ProductID><PFM>openai.codex_2p2nqsd0c76g0</PFM></License>'
  const architecture = kind === 'mac-arm64' ? 'arm64' : 'x64'
  return `<?xml version="1.0"?><rss><channel><item><sparkle:version>12776</sparkle:version><sparkle:shortVersionString>26.930.21537</sparkle:shortVersionString><enclosure url="https://persistent.oaistatic.com/codex-app-prod/ChatGPT-darwin-${architecture}-26.930.21537.zip" length="64" type="application/octet-stream" /></item></channel></rss>`
}

function mockTransport(override = function () { return null }) {
  const calls = []
  function requestImpl(url, options, callback) {
    const resource = RESOURCES.find((entry) => entry.url === url.href)
    assert.ok(resource)
    assert.ok(['HEAD', 'GET'].includes(options.method))
    assert.deepEqual(options.headers, { 'accept-encoding': 'identity' })
    assert.equal(options.maxHeaderSize, 16384)
    calls.push({ label: resource.label, method: options.method })
    const request = new Writable({ write(chunk, encoding, done) { assert.fail('public requests must never upload a body'); done() } })
    request.on('finish', () => {
      const selected = override(resource, options.method) || {}
      if (selected.error) { request.destroy(selected.error); return }
      const body = Buffer.from(selected.body ?? document(resource.kind))
      const stream = Readable.from(options.method === 'HEAD' ? [] : [body])
      stream.statusCode = selected.status ?? 200
      stream.headers = { 'content-length': String(selected.length ?? body.length) }
      stream.complete = false
      stream.on('end', () => { stream.complete = true })
      callback(stream)
    })
    return request
  }
  return { requestImpl, calls }
}

test('the public probe reads only seven fixed small resources and emits only five safe fields', async () => {
  const mock = mockTransport()
  const rows = await probePublicEntries(mock)
  assert.equal(mock.calls.length, 14)
  assert.equal(rows.length, 21)
  assert.ok(rows.filter((row) => row.phase === 'parse').every((row) => row.code === 'parse-ok'))
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ['bytes', 'code', 'label', 'phase', 'status'])
    assert.ok(row.bytes >= 0 && row.bytes <= MAX_PUBLIC_BYTES)
  }
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|Bearer|cookie|auth|https:|\?token/i)
})

test('public 403 and 404, transport failures and parse failures stay distinct without raw data', async () => {
  const mock = mockTransport((resource, method) => {
    if (resource.label === 'cos-manager-latest') return { status: method === 'HEAD' ? 403 : 404, body: 'SECRET forbidden body' }
    if (resource.label === 'cos-codex-latest') return { error: Object.assign(new Error('SECRET cookie'), { code: 'ECONNRESET' }) }
    if (resource.label === 'official-windows-metadata') return { body: 'SECRET malformed JSON' }
    return null
  })
  const rows = await probePublicEntries(mock)
  assert.ok(rows.some((row) => row.label === 'cos-manager-latest' && row.phase === 'head' && row.status === 403))
  assert.ok(rows.some((row) => row.label === 'cos-manager-latest' && row.phase === 'get' && row.status === 404))
  assert.ok(rows.some((row) => row.label === 'cos-codex-latest' && row.code === 'ECONNRESET' && row.status === null))
  assert.ok(rows.some((row) => row.label === 'official-windows-metadata' && row.phase === 'get' && row.status === 200))
  assert.ok(rows.some((row) => row.label === 'official-windows-metadata' && row.phase === 'parse' && row.code === 'parse-failed'))
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|cookie|malformed JSON/i)
})

test('oversized objects fail before body collection and unknown sources or writes cannot reach transport', async () => {
  const mock = mockTransport((resource) => resource.label === 'cos-manager-latest' ? { length: MAX_PUBLIC_BYTES + 1 } : null)
  const rows = await probePublicEntries(mock)
  assert.equal(rows.filter((row) => row.label === 'cos-manager-latest' && row.code === 'response-too-large').length, 2)
  await assert.rejects(publicRequest('unlisted-source', 'get', () => assert.fail('unknown source reached transport')))
  await assert.rejects(publicRequest('cos-manager-latest', 'PUT', () => assert.fail('upload reached transport')))
})

test('evidence writes stay in runner temp, do not inspect auth env, and refuse clobber or another path', async (t) => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'cos-public-probe-test-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const output = path.join(directory, 'cos-public-entry-probe-Linux.json')
  const values = { PUBLIC_PROBE_OUTPUT: output, RUNNER_TEMP: directory }
  const env = new Proxy(values, { get(value, key) { assert.ok(['PUBLIC_PROBE_OUTPUT', 'RUNNER_TEMP'].includes(key)); return value[key] } })
  const rows = [{ label: 'probe', phase: 'head', status: 200, code: 'ok', bytes: 0 }]
  await writeEvidence(rows, env)
  assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), rows)
  await assert.rejects(writeEvidence(rows, env), { code: 'EEXIST' })
  await assert.rejects(writeEvidence(rows, { ...values, PUBLIC_PROBE_OUTPUT: path.join(directory, 'other.json') }))
})

test('temporary workflow is scoped to one push branch and has no protected environment or secrets', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', '.github/workflows/cos-runner-public-probe.yml'), 'utf8')
  assert.match(source, /on:\s*\n  push:\s*\n    branches:\s*\n      - codex\/cos-runner-public-probe-20261003/)
  assert.doesNotMatch(source, /pull_request:|workflow_dispatch:|schedule:|^\s*environment:|secrets\./m)
  assert.match(source, /contents: read/)
  assert.match(source, /persist-credentials: false/)
  assert.match(source, /runner: \[windows-latest, ubuntu-latest\]/)
  assert.match(source, /node-version: 22/)
  const helper = await fs.readFile(path.join(__dirname, 'public-entry-http.cjs'), 'utf8')
  assert.doesNotMatch(helper, /COS_SECRET|readCosConfiguration|createCosStore|publishFile|process\.env/)
})
