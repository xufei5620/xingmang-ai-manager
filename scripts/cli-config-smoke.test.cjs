const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  FAKE_KEY,
  REPLY_TEXT,
  cliEnvironment,
  diffShapes,
  judgeRun,
  leftoverHosts,
  parseArguments,
  pointConfigAtRelay,
  requestShape,
  swapOrigins,
} = require('./cli-config-smoke.cjs')
const { credentialVerdict, decodeFrames, encodeFrame, isModelRequest, startFakeRelay } = require('./cli-config-smoke-relay.cjs')

function httpRecord(overrides = {}) {
  return {
    transport: 'http',
    method: 'POST',
    path: '/v1/messages',
    query: '',
    headers: ['authorization', 'content-type'],
    credential: 'expected',
    anthropicBeta: [],
    openaiBeta: [],
    model: 'claude-opus-5-5',
    bodyKeys: ['messages', 'model'],
    stream: true,
    ...overrides,
  }
}

const passing = { code: 0, timedOut: false, output: `${REPLY_TEXT}\n` }

test('swapOrigins replaces every occurrence of each origin and counts them', () => {
  const result = swapOrigins('a https://xm.solov.cc/v1 b https://xm.solov.cc c https://api.solov.cc', ['https://xm.solov.cc'], 'http://127.0.0.1:9')
  assert.equal(result.count, 2)
  assert.equal(result.text, 'a http://127.0.0.1:9/v1 b http://127.0.0.1:9 c https://api.solov.cc')
  assert.deepEqual(swapOrigins('nothing here', ['https://xm.solov.cc'], 'x'), { text: 'nothing here', count: 0 })
})

test('pointConfigAtRelay rewrites only the files that carry the site origin', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-config-smoke-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const settings = path.join(directory, 'settings.json')
  const agents = path.join(directory, 'AGENTS.md')
  fs.writeFileSync(settings, '{"env":{"ANTHROPIC_BASE_URL":"https://xm.solov.cc"}}')
  fs.writeFileSync(agents, '始终用简体中文回复')
  const total = pointConfigAtRelay([settings, agents, path.join(directory, 'missing.toml')], {
    claude: 'https://xm.solov.cc',
    codex: 'https://xm.solov.cc/v1',
  }, 'http://127.0.0.1:1234')
  assert.equal(total, 1)
  assert.equal(fs.readFileSync(settings, 'utf8'), '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1234"}}')
  assert.equal(fs.readFileSync(agents, 'utf8'), '始终用简体中文回复')
})

test('leftoverHosts names every production host still present after the swap', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-config-smoke-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const config = path.join(directory, 'config.toml')
  fs.writeFileSync(config, 'base_url = "http://127.0.0.1:1/v1"\nxai_api_base_url = "https://xm-direct.solov.cc/v1"\n')
  assert.deepEqual(leftoverHosts([config], ['xm.solov.cc', 'xm-direct.solov.cc', 'api.solov.cc']), ['xm-direct.solov.cc'])
  assert.deepEqual(leftoverHosts([path.join(directory, 'missing')], ['xm.solov.cc']), [])
})

test('the CLI environment carries none of the runner variables that could redirect or rescue a run', (t) => {
  const saved = { ...process.env }
  t.after(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
    Object.assign(process.env, saved)
  })
  process.env.ANTHROPIC_BASE_URL = 'https://elsewhere.example'
  process.env.OPENAI_API_KEY = 'sk-real'
  process.env.HTTPS_PROXY = 'http://proxy.example'
  const env = cliEnvironment('/tmp/home', { isRoot: false })
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH'])
  assert.equal(env.HOME, '/tmp/home')
  // Claude Code refuses its skip-permissions mode as root unless told it is a sandbox.
  assert.equal(cliEnvironment('/tmp/home', { isRoot: true }).IS_SANDBOX, '1')
})

test('judgeRun passes a run that reached the relay with the written key and model', () => {
  assert.deepEqual(judgeRun(passing, [httpRecord({ method: 'HEAD', path: '/api/hello', credential: 'missing' }), httpRecord()], 'claude-opus-5-5'), [])
})

test('judgeRun reports each way a run can fail', () => {
  assert.match(judgeRun({ code: 1, timedOut: true, output: '' }, [httpRecord()], 'claude-opus-5-5', 1000).join(), /1 秒内没跑完/)
  assert.match(judgeRun({ code: 2, timedOut: false, output: '' }, [httpRecord()], 'claude-opus-5-5').join(), /退出码 2/)
  assert.match(judgeRun(passing, [httpRecord({ method: 'HEAD', path: '/api/hello' })], 'claude-opus-5-5').join(), /没有一条对话请求/)
  assert.match(judgeRun(passing, [httpRecord({ credential: 'other' })], 'claude-opus-5-5').join(), /不是星芒写进配置的那把密钥/)
  assert.match(judgeRun(passing, [httpRecord({ model: 'claude-haiku' })], 'claude-opus-5-5').join(), /型号是 claude-haiku/)
  assert.match(judgeRun({ ...passing, output: 'something else' }, [httpRecord()], 'claude-opus-5-5').join(), /没有假中转的回答/)
  const websocket = httpRecord({
    transport: 'websocket', method: 'GET', path: '/v1/responses', model: null,
    messageTypes: ['response.create', 'response.interrupt'], rejectedTypes: ['response.interrupt'], models: ['gpt-6-astra'],
  })
  assert.match(judgeRun(passing, [websocket], 'gpt-6-astra').join(), /中转不认的消息：response\.interrupt/)
})

test('requestShape keeps only what does not change between runs, and diffShapes lists what moved', () => {
  const before = requestShape([httpRecord({ anthropicBeta: ['a-1'], headers: ['authorization', 'x-old'] })])
  const after = requestShape([
    httpRecord({ anthropicBeta: ['a-1', 'b-2'], headers: ['authorization', 'x-new'], bodyKeys: ['messages', 'model', 'thinking'] }),
    httpRecord({ method: 'HEAD', path: '/api/hello', headers: ['x-new'], bodyKeys: [] }),
  ])
  assert.deepEqual(after.endpoints, ['http HEAD /api/hello', 'http POST /v1/messages'])
  const changes = Object.fromEntries(diffShapes(before, after).map((change) => [change.field, change]))
  assert.deepEqual(changes.anthropicBeta.added, ['b-2'])
  assert.deepEqual(changes.headers.added, ['x-new'])
  assert.deepEqual(changes.headers.removed, ['x-old'])
  assert.deepEqual(changes.bodyKeys.added, ['/v1/messages thinking'])
  assert.deepEqual(changes.endpoints.added, ['http HEAD /api/hello'])
  assert.deepEqual(diffShapes(after, after), [])
})

test('parseArguments accepts only the two documented options', () => {
  assert.deepEqual(parseArguments(['--compare-with', 'abc123', '--report', 'out.json']), { compareWith: 'abc123', report: 'out.json' })
  assert.throws(() => parseArguments(['--sites', 'all']), /不认识的参数/)
})

test('credentialVerdict recognises the fake key in either header and nothing else', () => {
  assert.equal(credentialVerdict({ authorization: `Bearer ${FAKE_KEY}` }, FAKE_KEY), 'expected')
  assert.equal(credentialVerdict({ 'x-api-key': FAKE_KEY }, FAKE_KEY), 'expected')
  assert.equal(credentialVerdict({ authorization: 'Bearer sk-other' }, FAKE_KEY), 'other')
  assert.equal(credentialVerdict({}, FAKE_KEY), 'missing')
})

test('the WebSocket codec round-trips payloads across all three length encodings', () => {
  for (const size of [0, 5, 125, 126, 65535, 65536, 70000]) {
    const payload = crypto.randomBytes(size)
    const { frames, rest } = decodeFrames(encodeFrame(0x2, payload))
    assert.equal(rest.length, 0)
    assert.equal(frames.length, 1)
    assert.equal(frames[0].opcode, 0x2)
    assert.ok(frames[0].payload.equals(payload), `payload of ${size} bytes`)
  }
  // A frame split across two reads waits for the rest instead of misparsing.
  const whole = encodeFrame(0x1, 'hello')
  const first = decodeFrames(whole.subarray(0, 3))
  assert.equal(first.frames.length, 0)
  assert.equal(decodeFrames(Buffer.concat([first.rest, whole.subarray(3)])).frames[0].payload.toString(), 'hello')
})

function postJson(origin, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (response) => {
      let text = ''
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => resolve({ status: response.statusCode, text }))
    })
    request.on('error', reject)
    request.end(JSON.stringify(body))
  })
}

function maskedTextFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const mask = crypto.randomBytes(4)
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]))
  const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff])
  return Buffer.concat([header, mask, masked])
}

function openWebSocket(origin, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}/v1/responses`, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        ...headers,
      },
    })
    request.on('upgrade', (response, socket) => resolve({ response, socket }))
    request.on('response', (response) => resolve({ response, socket: null }))
    request.on('error', reject)
    request.end()
  })
}

function readEvents(socket, until) {
  return new Promise((resolve) => {
    let pending = Buffer.alloc(0)
    const events = []
    socket.on('data', (chunk) => {
      const decoded = decodeFrames(Buffer.concat([pending, chunk]))
      pending = decoded.rest
      for (const frame of decoded.frames) events.push(JSON.parse(frame.payload.toString('utf8')))
      if (events.some(until)) resolve(events)
    })
  })
}

test('the fake relay answers Anthropic and Responses requests and records their shape', async (t) => {
  const relay = await startFakeRelay({ key: FAKE_KEY, replyText: REPLY_TEXT })
  t.after(() => relay.close())
  const auth = { authorization: `Bearer ${FAKE_KEY}`, 'anthropic-beta': 'b-2, a-1' }
  const streamed = await postJson(relay.origin, '/v1/messages?beta=true', { model: 'claude-opus-5-5', stream: true, messages: [] }, auth)
  assert.equal(streamed.status, 200)
  assert.match(streamed.text, /event: message_start/)
  assert.ok(streamed.text.includes(REPLY_TEXT))
  const responses = await postJson(relay.origin, '/v1/responses', { model: 'grok-4.6', stream: false, input: [] }, auth)
  const body = JSON.parse(responses.text)
  assert.equal(body.status, 'completed')
  assert.equal(typeof body.created_at, 'number')
  assert.equal(body.output[0].content[0].text, REPLY_TEXT)

  const [messages, responsesRecord] = relay.requests
  assert.equal(messages.path, '/v1/messages')
  assert.equal(messages.query, 'beta=true')
  assert.deepEqual(messages.anthropicBeta, ['a-1', 'b-2'])
  assert.equal(messages.model, 'claude-opus-5-5')
  assert.equal(messages.credential, 'expected')
  assert.equal(messages.headers.includes('host'), false, 'per-run headers are left out of the shape')
  assert.equal(JSON.stringify(relay.requests).includes(FAKE_KEY), false, 'the key itself is never recorded')
  assert.ok(isModelRequest(responsesRecord))
})

test('the fake relay turns away a model request without the written key', async (t) => {
  const relay = await startFakeRelay({ key: FAKE_KEY, replyText: REPLY_TEXT })
  t.after(() => relay.close())
  const response = await postJson(relay.origin, '/v1/responses', { model: 'gpt-6-astra', stream: true }, { authorization: 'Bearer sk-elsewhere-0000000000' })
  assert.equal(response.status, 401)
  assert.equal(relay.requests[0].credential, 'other')
})

test('the fake relay speaks Responses over WebSocket and rejects what new-api rejects', async (t) => {
  const relay = await startFakeRelay({ key: FAKE_KEY, replyText: REPLY_TEXT })
  t.after(() => relay.close())
  const { response, socket } = await openWebSocket(relay.origin, { Authorization: `Bearer ${FAKE_KEY}`, 'OpenAI-Beta': 'responses_websockets=2026-02-06' })
  assert.equal(response.statusCode, 101)
  t.after(() => socket.destroy())

  const completed = readEvents(socket, (event) => event.type === 'response.completed')
  socket.write(maskedTextFrame(JSON.stringify({ type: 'response.create', model: 'gpt-6-astra', input: [], stream: true })))
  const events = await completed
  assert.equal(events[0].type, 'response.created')
  assert.ok(events.some((event) => event.type === 'response.output_text.delta' && event.delta === REPLY_TEXT))

  const rejected = readEvents(socket, (event) => event.type === 'error')
  socket.write(maskedTextFrame(JSON.stringify({ type: 'response.interrupt' })))
  const error = (await rejected).find((event) => event.type === 'error')
  assert.equal(error.status, 400)

  const record = relay.requests[0]
  assert.equal(record.transport, 'websocket')
  assert.deepEqual(record.openaiBeta, ['responses_websockets=2026-02-06'])
  assert.deepEqual(record.messageTypes, ['response.create', 'response.interrupt'])
  assert.deepEqual(record.rejectedTypes, ['response.interrupt'])
  assert.deepEqual(record.models, ['gpt-6-astra'])
  assert.ok(record.bodyKeys.includes('input'))
  assert.match(judgeRun(passing, relay.requests, 'gpt-6-astra').join(), /response\.interrupt/)
})

test('the fake relay refuses a WebSocket upgrade without the written key', async (t) => {
  const relay = await startFakeRelay({ key: FAKE_KEY, replyText: REPLY_TEXT })
  t.after(() => relay.close())
  const { response, socket } = await openWebSocket(relay.origin, {})
  if (socket) socket.destroy()
  assert.equal(response.statusCode, 404)
  assert.equal(relay.requests[0].credential, 'missing')
})
