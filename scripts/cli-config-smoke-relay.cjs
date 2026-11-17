// 主链路冒烟（scripts/cli-config-smoke.cjs）用的本地假中转。只在 127.0.0.1 上听，只认一把假密钥，
// 不转发任何请求。它要回答的只有两件事：真的 CLI 读了星芒写的那份配置以后，请求有没有送到这里、
// 带没带对密钥和型号；以及请求长什么样（路径、请求头、请求体字段、WebSocket 消息类型），留给抬版本
// 时新旧两版对照用。
//
// Codex 在星芒的配置下先走 WebSocket（supports_websockets = true），连不上要重试五次才退回 HTTPS。
// 所以这里也接 WebSocket，并且照 new-api 的做法只认 response.create 和 response.cancel：别的消息类型
// 回一个 400 的 error 事件，同时记下来。2026-11-06 Codex 中途发 response.interrupt 被中转回 400、
// 这一轮白跑（#1572），就是这一类。
//
// Nothing here may reach the network: the server binds the loopback interface
// only, answers from fixed templates, and the WebSocket half is a minimal
// RFC 6455 codec (no extensions, so permessage-deflate offers are declined by
// omission and every frame stays plain text).
const crypto = require('node:crypto')
const http = require('node:http')

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_BODY_BYTES = 4 * 1024 * 1024
// new-api 的 Responses WebSocket 只认这两种客户端消息（2026-11-06 对照 rc.47 与 main e034390）。
const ACCEPTED_WEBSOCKET_TYPES = new Set(['response.create', 'response.cancel'])
// Request headers that carry no shape information and change on every run.
const VOLATILE_HEADERS = new Set(['content-length', 'host', 'connection', 'sec-websocket-key'])
// 这几个请求头的值本身就是「这一版 CLI 打开了哪些功能」，抬版本对照时要看值，不只看名字。
const FEATURE_HEADERS = ['anthropic-version', 'x-codex-beta-features']

/** 请求里带的是不是这把假密钥：Authorization: Bearer、x-api-key 两种写法都认。 */
function credentialVerdict(headers, key) {
  const values = [headers.authorization, headers['x-api-key']].filter((value) => typeof value === 'string' && value)
  if (values.length === 0) return 'missing'
  return values.some((value) => value === key || value === `Bearer ${key}`) ? 'expected' : 'other'
}

function splitList(value) {
  return typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean).sort() : []
}

function parseJson(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function pathOf(url) {
  return String(url || '').split('?')[0]
}

/** 记一条 HTTP 请求。密钥本身不记，只记带的是不是那把。 */
function describeHttpRequest(request, body, key) {
  const parsed = parseJson(body)
  return {
    transport: 'http',
    method: request.method,
    path: pathOf(request.url),
    query: String(request.url || '').includes('?') ? String(request.url).split('?')[1] : '',
    headers: Object.keys(request.headers).filter((name) => !VOLATILE_HEADERS.has(name)).sort(),
    credential: credentialVerdict(request.headers, key),
    anthropicBeta: splitList(request.headers['anthropic-beta']),
    openaiBeta: splitList(request.headers['openai-beta']),
    featureFlags: FEATURE_HEADERS.flatMap((name) => splitList(request.headers[name]).map((value) => `${name}=${value}`)),
    model: parsed && typeof parsed.model === 'string' ? parsed.model : null,
    bodyKeys: parsed ? Object.keys(parsed).sort() : [],
    stream: parsed ? parsed.stream === true : false,
  }
}

function isModelRequest(entry) {
  if (entry.transport === 'websocket') return entry.messageTypes.includes('response.create')
  return entry.method === 'POST' && ['/v1/messages', '/v1/responses', '/v1/chat/completions'].includes(entry.path)
}

function responseObject(id, model, status, output, usage) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: model || 'unknown',
    output,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    metadata: {},
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage: usage || null,
    user: null,
  }
}

/** 一次 Responses 回答的全部事件，HTTP 的 SSE 和 WebSocket 共用。 */
function responsesEvents(model, text) {
  const id = `resp_${crypto.randomBytes(6).toString('hex')}`
  const itemId = `msg_${crypto.randomBytes(6).toString('hex')}`
  const part = { type: 'output_text', text, annotations: [] }
  const item = { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [part] }
  const usage = {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 2,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 12,
  }
  const events = [
    { type: 'response.created', response: responseObject(id, model, 'in_progress', []) },
    { type: 'response.in_progress', response: responseObject(id, model, 'in_progress', []) },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: itemId, output_index: 0, content_index: 0, part: { ...part, text: '' } },
    { type: 'response.output_text.delta', item_id: itemId, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', item_id: itemId, output_index: 0, content_index: 0, text },
    { type: 'response.content_part.done', item_id: itemId, output_index: 0, content_index: 0, part },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: responseObject(id, model, 'completed', [item], usage) },
  ]
  return { events: events.map((event, index) => ({ ...event, sequence_number: index })), final: events[events.length - 1].response }
}

function anthropicMessage(model, text) {
  return {
    id: `msg_${crypto.randomBytes(6).toString('hex')}`,
    type: 'message',
    role: 'assistant',
    model: model || 'unknown',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 2 },
  }
}

function writeJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function writeSse(response, events) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  response.end()
}

function answerAnthropic(response, parsed, text) {
  const message = anthropicMessage(parsed && parsed.model, text)
  if (!parsed || parsed.stream !== true) return writeJson(response, 200, message)
  writeSse(response, [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ])
}

function answerChatCompletions(response, parsed, text) {
  const id = `chatcmpl_${crypto.randomBytes(6).toString('hex')}`
  const model = (parsed && parsed.model) || 'unknown'
  const created = Math.floor(Date.now() / 1000)
  if (!parsed || parsed.stream !== true) {
    return writeJson(response, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const delta of [{ role: 'assistant', content: text }, {}]) {
    const finish = Object.keys(delta).length === 0 ? 'stop' : null
    response.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
  }
  response.end('data: [DONE]\n\n')
}

/** 把一段 WebSocket 帧编成服务端发出的样子：不加掩码、不分片。 */
function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  let header
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length])
  } else if (data.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  return Buffer.concat([header, data])
}

/**
 * 从缓冲区里拆出完整的帧。返回拆出的帧和没用完的字节；帧不完整就留到下次。
 * 客户端发来的帧按 RFC 6455 一定带掩码，这里照解。
 */
function decodeFrames(buffer) {
  const frames = []
  let offset = 0
  while (buffer.length - offset >= 2) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    let length = second & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (buffer.length - cursor < 2) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (buffer.length - cursor < 8) break
      length = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }
    const masked = (second & 0x80) !== 0
    const maskLength = masked ? 4 : 0
    if (buffer.length - cursor < maskLength + length) break
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null
    cursor += maskLength
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length))
    if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
    frames.push({ fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload })
    offset = cursor + length
  }
  return { frames, rest: buffer.subarray(offset) }
}

function acceptKey(key) {
  return crypto.createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64')
}

/**
 * 起假中转。返回 origin（给配置里换地址用）、requests（按到达顺序记下的每一条请求）、close()。
 * replyText 是每次回答的全文，CLI 把它打出来就说明这一轮走完了。
 */
function startFakeRelay({ key, replyText }) {
  if (typeof key !== 'string' || key.length < 16) throw new Error('假中转要一把至少 16 个字符的假密钥')
  const requests = []
  const sockets = new Set()

  const server = http.createServer((request, response) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size <= MAX_BODY_BYTES) chunks.push(chunk)
    })
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const entry = describeHttpRequest(request, body, key)
      requests.push(entry)
      const parsed = parseJson(body)
      if (size > MAX_BODY_BYTES) return writeJson(response, 413, { error: { type: 'invalid_request_error', message: 'body too large' } })
      if (isModelRequest(entry) && entry.credential !== 'expected') {
        return writeJson(response, 401, { error: { type: 'authentication_error', message: '无效的令牌' } })
      }
      if (entry.method === 'GET' && entry.path === '/v1/models') {
        return writeJson(response, 200, { object: 'list', data: [] })
      }
      if (entry.method === 'POST' && entry.path === '/v1/messages/count_tokens') return writeJson(response, 200, { input_tokens: 10 })
      if (entry.method === 'POST' && entry.path === '/v1/messages') return answerAnthropic(response, parsed, replyText)
      if (entry.method === 'POST' && entry.path === '/v1/chat/completions') return answerChatCompletions(response, parsed, replyText)
      if (entry.method === 'POST' && entry.path === '/v1/responses') {
        const { events, final } = responsesEvents(parsed && parsed.model, replyText)
        return parsed && parsed.stream === true ? writeSse(response, events) : writeJson(response, 200, final)
      }
      // CLI 自己的连通性探测（Claude Code 的 HEAD /api/hello、Grok 的 GET /）：答 200，照样记下。
      if (entry.method === 'HEAD' || (entry.method === 'GET' && (entry.path === '/' || entry.path === '/api/hello'))) {
        response.writeHead(200)
        return response.end()
      }
      writeJson(response, 404, { error: { type: 'not_found_error', message: `fake relay has no ${entry.method} ${entry.path}` } })
    })
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  server.on('upgrade', (request, socket) => {
    const entry = {
      ...describeHttpRequest(request, '', key),
      transport: 'websocket',
      messageTypes: [],
      rejectedTypes: [],
      models: [],
      bodyKeys: [],
    }
    requests.push(entry)
    const websocketKey = request.headers['sec-websocket-key']
    if (entry.path !== '/v1/responses' || typeof websocketKey !== 'string' || entry.credential !== 'expected') {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n')
      return
    }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(websocketKey)}`,
      '', '',
    ].join('\r\n'))
    let pending = Buffer.alloc(0)
    let message = []
    socket.on('data', (chunk) => {
      const decoded = decodeFrames(Buffer.concat([pending, chunk]))
      pending = decoded.rest
      for (const frame of decoded.frames) {
        if (frame.opcode === 0x8) {
          socket.end(encodeFrame(0x8, frame.payload.subarray(0, 2)))
          return
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(0xa, frame.payload))
          continue
        }
        if (frame.opcode !== 0x0 && frame.opcode !== 0x1) continue
        message.push(frame.payload)
        if (!frame.fin) continue
        const parsed = parseJson(Buffer.concat(message).toString('utf8'))
        message = []
        const type = parsed && typeof parsed.type === 'string' ? parsed.type : '(unparsed)'
        entry.messageTypes.push(type)
        if (!ACCEPTED_WEBSOCKET_TYPES.has(type)) {
          entry.rejectedTypes.push(type)
          socket.write(encodeFrame(0x1, JSON.stringify({
            type: 'error',
            status: 400,
            error: { type: 'invalid_request_error', message: `unsupported websocket message type: ${type}` },
          })))
          continue
        }
        if (type !== 'response.create') continue
        if (parsed && typeof parsed.model === 'string') entry.models.push(parsed.model)
        entry.bodyKeys = [...new Set([...entry.bodyKeys, ...Object.keys(parsed).filter((name) => name !== 'type')])].sort()
        for (const event of responsesEvents(parsed.model, replyText).events) socket.write(encodeFrame(0x1, JSON.stringify(event)))
      }
    })
    socket.on('error', () => {})
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        origin: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy()
          server.close(() => done())
        }),
      })
    })
  })
}

module.exports = {
  ACCEPTED_WEBSOCKET_TYPES,
  credentialVerdict,
  decodeFrames,
  encodeFrame,
  isModelRequest,
  startFakeRelay,
}
