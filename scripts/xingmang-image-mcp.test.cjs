const assert = require('node:assert/strict')
const http = require('node:http')
const { copyFile, mkdir, mkdtemp, realpath, writeFile, rm, symlink } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const serverPath = path.resolve(__dirname, '..', 'bundled-skills', 'xingmang-ai', 'scripts', 'mcp-server.mjs')
const fixture = Buffer.from('fixture-image').toString('base64')
const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')])

function createLineReader(child) {
  let pending = ''
  const lines = []
  const waiters = []
  child.stdout.on('data', (chunk) => {
    pending += chunk.toString('utf8')
    let index
    while ((index = pending.indexOf('\n')) >= 0) {
      const line = JSON.parse(pending.slice(0, index))
      pending = pending.slice(index + 1)
      const waiter = waiters.shift()
      if (waiter) waiter(line)
      else lines.push(line)
    }
  })
  return function next() {
    if (lines.length) return Promise.resolve(lines.shift())
    return new Promise((resolve) => waiters.push(resolve))
  }
}

/**
 * Starts a fake relay and the MCP server against it. `respond` receives the
 * request and decides the reply, so each test can script its own relay.
 */
async function withServer(config, respond, run, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xingmang-image-mcp-'))
  const configPath = path.join(root, 'config.json')
  const requests = []
  const httpServer = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const request = {
        url: req.url,
        authorization: req.headers.authorization,
        googleKey: req.headers['x-goog-api-key'],
        originalUrl: req.headers['x-test-original-url'],
        contentType: req.headers['content-type'] || '',
        body: Buffer.concat(chunks),
      }
      requests.push(request)
      const reply = respond(request)
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const port = httpServer.address().port
  await writeFile(configPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, ...config }))
  const argv = [serverPath]
  if (options.mockFetch) {
    // Intercept every fetch before loading the MCP module. Production-looking
    // test origins must never reach DNS, TLS or a real account backend.
    const preloadPath = path.join(root, 'mock-fetch.mjs')
    await writeFile(preloadPath, `const originalFetch = globalThis.fetch
globalThis.fetch = function (input, init) {
  const originalUrl = new URL(input)
  return originalFetch(${JSON.stringify(`http://127.0.0.1:${port}`)} + originalUrl.pathname, {
    ...init, headers: { ...init.headers, 'x-test-original-url': originalUrl.href },
  })
}
`)
    argv.unshift('--import', pathToFileURL(preloadPath).href)
  }
  const child = spawn(process.execPath, argv, {
    env: {
      ...process.env,
      XINGMANG_IMAGE_CONFIG_PATH: configPath,
      XINGMANG_IMAGE_MCP_ALLOW_INSECURE_LOCAL: options.mockFetch ? '' : '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const next = createLineReader(child)
  const closed = new Promise((resolve) => child.once('close', resolve))
  let id = 0
  async function call(method, params = {}) {
    id += 1
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    let timer
    try {
      return await Promise.race([next(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('MCP test response timed out')), 5000)
      })])
    } finally { clearTimeout(timer) }
  }
  try {
    await run({ call, requests, root, child, next })
  } finally {
    child.kill()
    await closed
    await new Promise((resolve) => httpServer.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
}

function ok() {
  return { status: 200, body: { data: [{ b64_json: fixture }] } }
}

test('MCP server accepts only the registered HTTPS origins', async () => {
  for (const baseUrl of ['https://xm.solov.cc', 'https://api.solov.cc', 'https://xm-direct.solov.cc']) {
    await withServer({ apiKey: 'sk-fixture-not-real', baseUrl }, ok, async ({ call, requests }) => {
      const result = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'fixture' } })
      assert.equal(result.result.isError, undefined, baseUrl)
      assert.equal(result.result.content[0].data, fixture)
      assert.equal(requests[0].originalUrl, `${baseUrl}/v1/images/generations`)
      assert.equal(requests[0].authorization, 'Bearer sk-fixture-not-real')
    }, { mockFetch: true })
  }
})

test('MCP server refuses unregistered scheme host port credentials and URL suffixes before sending a key', async () => {
  // 38.147.105.28:8443 是服务端关掉的临时测试入口，直连改走 xm-direct.solov.cc 以后也不再放行。
  for (const baseUrl of ['https://38.147.105.28:8443', 'http://xm.solov.cc', 'https://xm.solov.cc:8443',
    'https://api.solov.cc:8443', 'https://xm-direct.solov.cc:8443',
    'https://38.147.105.28', 'https://38.147.105.28:8444', 'http://38.147.105.28:8443',
    'https://38.147.105.29:8443', 'https://xm.solov.cc.evil.example', 'https://anything.solov.cc',
    'https://user:password@38.147.105.28:8443', 'https://38.147.105.28:8443?key=fixture',
    'https://38.147.105.28:8443#fragment']) {
    await withServer({ apiKey: 'sk-fixture-not-real', baseUrl }, ok, async ({ call, requests }) => {
      const result = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'fixture' } })
      assert.equal(result.result.isError, true, baseUrl)
      assert.match(result.result.content[0].text, /服务地址无效/)
      assert.equal(requests.length, 0)
    }, { mockFetch: true })
  }
})

test('MCP server exposes image tool and returns MCP image content', async () => {
  await withServer({ apiKey: 'sk-test-not-real' }, ok, async ({ call, requests }) => {
    const initialized = await call('initialize')
    assert.equal(initialized.result.serverInfo.name, 'xingmang-image')
    const listed = await call('tools/list')
    assert.equal(listed.result.tools[0].name, 'generate_image')
    assert.ok(listed.result.tools[0].inputSchema.properties.images)
    const generated = await call('tools/call', {
      name: 'generate_image',
      arguments: { prompt: 'a blue mug', model: 'gpt-image-2.5-flare' },
    })
    assert.equal(generated.result.content[0].type, 'image')
    assert.equal(generated.result.content[0].data, fixture)
    assert.equal(requests[0].url, '/v1/images/generations')
    const body = JSON.parse(requests[0].body.toString('utf8'))
    assert.equal(body.model, 'gpt-image-2.5-flare')
    assert.equal(body.n, 1)
  })
})

test('MCP server edits an existing image through the edits endpoint', async () => {
  await withServer({ apiKey: 'sk-test-not-real' }, ok, async ({ call, requests, root }) => {
    const imagePath = path.join(root, 'photo.png')
    await writeFile(imagePath, pngBytes)
    const edited = await call('tools/call', {
      name: 'generate_image',
      arguments: { prompt: 'make the sky purple', images: [imagePath] },
    })
    assert.equal(edited.result.isError, undefined)
    assert.equal(edited.result.content[0].data, fixture)
    assert.equal(requests[0].url, '/v1/images/edits')
    assert.match(requests[0].contentType, /^multipart\/form-data/)
    const text = requests[0].body.toString('latin1')
    assert.match(text, /name="image"; filename="photo.png"/)
    assert.match(text, /make the sky purple/)
    assert.ok(requests[0].body.includes(pngBytes))
  })
})

test('MCP server refuses to upload a file that is not an image', async () => {
  await withServer({ apiKey: 'sk-test-not-real' }, ok, async ({ call, requests, root }) => {
    const secretPath = path.join(root, 'id_rsa')
    await writeFile(secretPath, '-----BEGIN OPENSSH PRIVATE KEY-----')
    const refused = await call('tools/call', {
      name: 'generate_image',
      arguments: { prompt: 'edit it', images: [secretPath] },
    })
    assert.equal(refused.result.isError, true)
    assert.match(refused.result.content[0].text, /不是 PNG、JPEG、WebP/)
    assert.equal(requests.length, 0)
  })
})

test('MCP server refuses relative paths and symbolic links as edit sources', { skip: process.platform === 'win32' }, async () => {
  await withServer({ apiKey: 'sk-test-not-real' }, ok, async ({ call, requests, root }) => {
    const target = path.join(root, 'real.png')
    const link = path.join(root, 'link.png')
    await writeFile(target, pngBytes)
    await symlink(target, link)
    const linked = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'x', images: [link] } })
    assert.equal(linked.result.isError, true)
    const relative = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'x', images: ['real.png'] } })
    assert.equal(relative.result.isError, true)
    assert.match(relative.result.content[0].text, /完整路径/)
    assert.equal(requests.length, 0)
  })
})

test('MCP server tries the Codex key first and falls back to the image key when it is refused', async () => {
  const config = { codexApiKey: 'sk-codex-not-real', apiKey: 'sk-image-not-real' }
  function respond(request) {
    if (request.authorization === 'Bearer sk-codex-not-real') {
      return { status: 403, body: { error: { message: 'group has no image model' } } }
    }
    return ok()
  }
  await withServer(config, respond, async ({ call, requests }) => {
    const generated = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
    assert.equal(generated.result.content[0].data, fixture)
    assert.deepEqual(requests.map((request) => request.authorization), [
      'Bearer sk-codex-not-real',
      'Bearer sk-image-not-real',
    ])
  })
})

test('MCP server draws with the model Xingmang picked for the account and lists it as the default', async () => {
  await withServer({ apiKey: 'sk-test-not-real', model: 'gpt-image-2.5-flare' }, ok, async ({ call, requests }) => {
    const listed = await call('tools/list')
    assert.equal(listed.result.tools[0].inputSchema.properties.model.default, 'gpt-image-2.5-flare')
    const generated = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
    assert.equal(generated.result.isError, undefined)
    assert.match(generated.result.content[1].text, /gpt-image-2\.5-flare/)
    assert.equal(JSON.parse(requests[0].body.toString('utf8')).model, 'gpt-image-2.5-flare')
  })
})

test('MCP server ignores a configured model outside the OpenAI allow-list', async () => {
  await withServer({ apiKey: 'sk-test-not-real', model: 'jimeng_high_aes_general_v21_L' }, ok, async ({ call, requests }) => {
    const listed = await call('tools/list')
    assert.equal(listed.result.tools[0].inputSchema.properties.model.default, 'gpt-image-2')
    await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
    assert.equal(JSON.parse(requests[0].body.toString('utf8')).model, 'gpt-image-2')
  })
})

test('MCP server draws with a newer OpenAI image model instead of swapping it back to gpt-image-2', async () => {
  await withServer({ apiKey: 'sk-test-not-real', model: 'gpt-image-3' }, ok, async ({ call, requests }) => {
    const listed = await call('tools/list')
    const modelSchema = listed.result.tools[0].inputSchema.properties.model
    assert.equal(modelSchema.default, 'gpt-image-3')
    assert.equal(modelSchema.enum, undefined)
    const picked = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
    assert.equal(picked.result.isError, undefined)
    assert.match(picked.result.content[1].text, /gpt-image-3/)
    const named = await call('tools/call', {
      name: 'generate_image',
      arguments: { prompt: 'a cat', model: 'gpt-image-3-mini' },
    })
    assert.equal(named.result.isError, undefined)
    const refused = await call('tools/call', {
      name: 'generate_image',
      arguments: { prompt: 'a cat', model: 'jimeng_high_aes_general_v21_L' },
    })
    assert.equal(refused.result.isError, true)
    assert.match(refused.result.content[0].text, /不认识图片模型「jimeng_high_aes_general_v21_L」/)
    assert.match(refused.result.content[0].text, /gpt-image-2\.6-flare/)
    assert.match(refused.result.content[0].text, /nano-banana-2/)
    assert.match(refused.result.content[0].text, /grok-imagine-image/)
    assert.deepEqual(requests.map((request) => JSON.parse(request.body.toString('utf8')).model), ['gpt-image-3', 'gpt-image-3-mini'])
  })
})

test('MCP server falls back to gpt-image-2 when the picked model is refused by the relay', async () => {
  const config = { codexApiKey: 'sk-codex-not-real', apiKey: 'sk-image-not-real', model: 'gpt-image-2.5-flare' }
  function respond(request) {
    const body = JSON.parse(request.body.toString('utf8'))
    if (body.model === 'gpt-image-2.5-flare') {
      return { status: 503, body: { error: { message: 'no available channel for gpt-image-2.5-flare' } } }
    }
    return ok()
  }
  await withServer(config, respond, async ({ call, requests }) => {
    const generated = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
    assert.equal(generated.result.isError, undefined)
    assert.match(generated.result.content[1].text, /已用 gpt-image-2 画好图片/)
    assert.deepEqual(requests.map((request) => [
      request.authorization,
      JSON.parse(request.body.toString('utf8')).model,
    ]), [
      ['Bearer sk-codex-not-real', 'gpt-image-2.5-flare'],
      ['Bearer sk-image-not-real', 'gpt-image-2.5-flare'],
      ['Bearer sk-codex-not-real', 'gpt-image-2'],
    ])
  })
})

test('MCP server keeps a model the AI named on purpose and does not swap it', async () => {
  function respond() {
    return { status: 500, body: { error: { message: 'model price not configured' } } }
  }
  await withServer({ apiKey: 'sk-test-not-real', model: 'gpt-image-2.5-flare' }, respond, async ({ call, requests }) => {
    const failed = await call('tools/call', {
      name: 'generate_image',
      arguments: { prompt: 'a cat', model: 'gpt-image-2.5-sunburst' },
    })
    assert.equal(failed.result.isError, true)
    assert.match(failed.result.content[0].text, /price not configured/)
    assert.deepEqual(requests.map((request) => JSON.parse(request.body.toString('utf8')).model), ['gpt-image-2.5-sunburst'])
  })
})

test('MCP server redacts keys echoed back in upstream errors', async () => {
  function respond() {
    return { status: 400, body: { error: { message: 'bad key sk-leaked-value in request' } } }
  }
  await withServer({ apiKey: 'sk-test-not-real' }, respond, async ({ call, requests }) => {
    const failed = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
    assert.equal(failed.result.isError, true)
    assert.doesNotMatch(failed.result.content[0].text, /sk-leaked-value/)
    assert.equal(requests.length, 1)
  })
})

test('MCP server rejects gpt-image-2 sizes that are not multiples of 16', async () => {
  await withServer({ apiKey: 'sk-test-not-real' }, ok, async ({ call, requests }) => {
    const refused = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'x', size: '1000x1000' } })
    assert.equal(refused.result.isError, true)
    assert.equal(requests.length, 0)
  })
})

const jpegBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('fake-jpeg-body')])

function geminiOk() {
  return { status: 200, body: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpegBytes.toString('base64') } }] } }] } }
}

function grokOk() {
  return { status: 200, body: { data: [{ b64_json: jpegBytes.toString('base64'), mime_type: 'image/jpeg' }] } }
}

function jsonBody(request) {
  return JSON.parse(request.body.toString('utf8'))
}

test('MCP server falls through the account default chain in order and stops at the end of it', async () => {
  function refuseNewModels(request) {
    return jsonBody(request).model === 'gpt-image-2'
      ? ok()
      : { status: 503, body: { error: { message: 'no available channel' } } }
  }
  const chain = { apiKey: 'sk-test-not-real', model: 'gpt-image-2.6-flare', fallbackModels: ['gpt-image-2.5-flare', 'gpt-image-2'] }
  await withServer(chain, refuseNewModels, async ({ call, requests }) => {
    const generated = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
    assert.equal(generated.result.isError, undefined)
    assert.match(generated.result.content[1].text, /已用 gpt-image-2 画好图片/)
    assert.deepEqual(requests.map((request) => jsonBody(request).model), ['gpt-image-2.6-flare', 'gpt-image-2.5-flare', 'gpt-image-2'])
  })
  // The account lists nothing else: do not spend a request on a model it does not have.
  await withServer({ ...chain, fallbackModels: [] }, refuseNewModels, async ({ call, requests }) => {
    const failed = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
    assert.equal(failed.result.isError, true)
    assert.deepEqual(requests.map((request) => jsonBody(request).model), ['gpt-image-2.6-flare'])
  })
})

test('MCP server converts 1K 2K 4K with an aspect ratio into gpt-image-2 sizes and defaults to high quality', async () => {
  await withServer({ apiKey: 'sk-test-not-real' }, ok, async ({ call, requests }) => {
    const cases = [
      [{}, '1024x1024'],
      [{ size: '1K', aspect: '16:9' }, '1280x720'],
      [{ size: '2K', aspect: '16:9' }, '2048x1152'],
      [{ size: '4k', aspect: '16:9' }, '3840x2160'],
      [{ size: '4K', aspect: '1:1' }, '2880x2880'],
      [{ size: '2K', aspect: '2:3' }, '1344x2016'],
      [{ aspect: '9:16' }, '720x1280'],
      [{ size: '1536x864' }, '1536x864'],
    ]
    for (const [options] of cases) {
      const generated = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'x', ...options } })
      assert.equal(generated.result.isError, undefined, JSON.stringify(options))
    }
    assert.deepEqual(requests.map((request) => jsonBody(request).size), cases.map(([, size]) => size))
    assert.equal(jsonBody(requests[0]).quality, 'high')
    const both = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'x', size: '1536x864', aspect: '16:9' } })
    assert.equal(both.result.isError, true)
    const badAspect = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'x', aspect: '5:7' } })
    assert.equal(badAspect.result.isError, true)
    assert.equal(requests.length, cases.length)
  })
})

test('MCP server draws Nano Banana through the Gemini native endpoint with only the image key', async () => {
  const config = { codexApiKey: 'sk-codex-not-real', apiKey: 'sk-image-not-real' }
  await withServer(config, geminiOk, async ({ call, requests, root }) => {
    const generated = await call('tools/call', {
      name: 'generate_image',
      arguments: { prompt: 'a lighthouse', model: 'nano-banana-2', size: '2K', aspect: '16:9' },
    })
    assert.equal(generated.result.isError, undefined)
    assert.equal(generated.result.content[0].mimeType, 'image/jpeg')
    assert.equal(generated.result.content[0].data, jpegBytes.toString('base64'))
    assert.match(generated.result.content[1].text, /已用 nano-banana-2 画好图片/)
    assert.equal(requests[0].url, '/v1beta/models/nano-banana-2:generateContent')
    assert.equal(requests[0].googleKey, 'sk-image-not-real')
    assert.equal(requests[0].authorization, undefined)
    const body = jsonBody(requests[0])
    assert.deepEqual(body.generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '2K' } })
    assert.deepEqual(body.contents[0].parts, [{ text: 'a lighthouse' }])

    const imagePath = path.join(root, 'photo.png')
    await writeFile(imagePath, pngBytes)
    const edited = await call('tools/call', {
      name: 'generate_image',
      arguments: { prompt: 'make it night', model: 'nano-banana-pro', size: '1536x1024', images: [imagePath, imagePath] },
    })
    assert.equal(edited.result.isError, undefined)
    const editBody = jsonBody(requests[1])
    assert.deepEqual(editBody.generationConfig.imageConfig, { aspectRatio: '3:2', imageSize: '1K' })
    assert.deepEqual(editBody.contents[0].parts.slice(1), [
      { inlineData: { mimeType: 'image/png', data: pngBytes.toString('base64') } },
      { inlineData: { mimeType: 'image/png', data: pngBytes.toString('base64') } },
    ])
  })
})

test('MCP server refuses Nano Banana and Grok without an image key before sending anything', async () => {
  await withServer({ codexApiKey: 'sk-codex-not-real' }, geminiOk, async ({ call, requests }) => {
    for (const model of ['nano-banana-2', 'grok-imagine-image']) {
      const refused = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'x', model } })
      assert.equal(refused.result.isError, true)
      assert.match(refused.result.content[0].text, /只能用图片模型分组/)
    }
    assert.equal(requests.length, 0)
  })
})

test('MCP server says why Nano Banana returned no image', async () => {
  function refusal() {
    return { status: 200, body: { candidates: [{ content: { parts: [{ text: 'I cannot draw that.' }] }, finishReason: 'STOP' }] } }
  }
  await withServer({ apiKey: 'sk-image-not-real' }, refusal, async ({ call }) => {
    const failed = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'x', model: 'gemini-3.1-flash-image' } })
    assert.equal(failed.result.isError, true)
    assert.match(failed.result.content[0].text, /没有返回图片：I cannot draw that\./)
  })
})

test('MCP server draws Grok images through the Images API asking for base64 and no size', async () => {
  await withServer({ codexApiKey: 'sk-codex-not-real', apiKey: 'sk-image-not-real' }, grokOk, async ({ call, requests }) => {
    const generated = await call('tools/call', {
      name: 'generate_image',
      arguments: { prompt: 'a lighthouse', model: 'grok-imagine-image', aspect: '1:1' },
    })
    assert.equal(generated.result.isError, undefined)
    assert.equal(generated.result.content[0].mimeType, 'image/jpeg')
    assert.match(generated.result.content[1].text, /已用 grok-imagine-image 画好图片（Grok 不能指定尺寸和比例/)
    assert.equal(requests[0].url, '/v1/images/generations')
    assert.equal(requests[0].authorization, 'Bearer sk-image-not-real')
    assert.deepEqual(jsonBody(requests[0]), { model: 'grok-imagine-image', prompt: 'a lighthouse', n: 1, response_format: 'b64_json' })
  })
})

test('MCP server tells the AI that retired GPT Image 1 models are gone', async () => {
  await withServer({ apiKey: 'sk-test-not-real' }, ok, async ({ call, requests }) => {
    for (const model of ['gpt-image-1', 'gpt-image-1.5', 'gpt-image-1-mini']) {
      const refused = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'x', model } })
      assert.equal(refused.result.isError, true)
      assert.match(refused.result.content[0].text, new RegExp(`${model.replace(/\./g, '\\.')} 已经下线`))
    }
    assert.equal(requests.length, 0)
  })
})

test('MCP server sends several reference images as image[]', async () => {
  await withServer({ apiKey: 'sk-test-not-real' }, ok, async ({ call, requests, root }) => {
    const first = path.join(root, 'a.png')
    const second = path.join(root, 'b.png')
    await writeFile(first, pngBytes)
    await writeFile(second, pngBytes)
    const edited = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'merge', images: [first, second] } })
    assert.equal(edited.result.isError, undefined)
    const text = requests[0].body.toString('latin1')
    assert.match(text, /name="image\[\]"; filename="a.png"/)
    assert.match(text, /name="image\[\]"; filename="b.png"/)
  })
})

test('MCP server keeps answering after an oversized request line', async () => {
  await withServer({ apiKey: 'sk-test-not-real' }, ok, async ({ child, next, call }) => {
    child.stdin.write('x'.repeat(300 * 1024))
    const rejected = await next()
    assert.match(rejected.error.message, /过大/)
    child.stdin.write('tail-of-the-oversized-line\n')
    const pong = await call('ping')
    assert.deepEqual(pong.result, {})
  })
})

const generatePath = path.resolve(__dirname, '..', 'bundled-skills', 'xingmang-ai', 'scripts', 'generate.mjs')

/**
 * Runs the skill's fallback CLI from a copied skill directory against a fake
 * relay. Every fetch is redirected before the script loads, so the production
 * origin in config.json never reaches DNS or a real backend.
 */
async function runGenerate(config, respond, args) {
  // generate.mjs only runs main() when argv[1] matches its own resolved URL, and
  // macOS tmpdir sits behind the /var -> /private/var symlink.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'xingmang-image-generate-')))
  const requests = []
  const httpServer = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const request = {
        url: req.url,
        authorization: req.headers.authorization,
        googleKey: req.headers['x-goog-api-key'],
        contentType: req.headers['content-type'] || '',
        body: Buffer.concat(chunks),
      }
      requests.push(request)
      const reply = respond(request)
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const port = httpServer.address().port
  try {
    await mkdir(path.join(root, 'scripts'))
    await copyFile(generatePath, path.join(root, 'scripts', 'generate.mjs'))
    await writeFile(path.join(root, 'config.json'), JSON.stringify({ baseUrl: 'https://xm.solov.cc', ...config }))
    const preloadPath = path.join(root, 'mock-fetch.mjs')
    await writeFile(preloadPath, `const originalFetch = globalThis.fetch
globalThis.fetch = function (input, init) {
  return originalFetch(${JSON.stringify(`http://127.0.0.1:${port}`)} + new URL(input).pathname, init)
}
`)
    // A function lets a test drop reference images into the throwaway root first.
    const extra = typeof args === 'function' ? await args(root) : args
    const child = spawn(process.execPath, [
      '--import', pathToFileURL(preloadPath).href,
      path.join(root, 'scripts', 'generate.mjs'),
      '--prompt', 'a cat', '--out', path.join(root, 'out.png'), ...extra,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const code = await new Promise((resolve) => child.once('close', resolve))
    return { code, stdout, stderr, requests }
  } finally {
    await new Promise((resolve) => httpServer.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
}

function requestedModels(requests) {
  return requests.map((request) => JSON.parse(request.body.toString('utf8')).model)
}

test('generate script uses the model Xingmang picked and falls back to gpt-image-2 when the relay refuses it', async () => {
  const picked = await runGenerate({ apiKey: 'sk-test-not-real', model: 'gpt-image-2.5-flare' }, ok, [])
  assert.equal(picked.code, 0, picked.stderr)
  assert.deepEqual(requestedModels(picked.requests), ['gpt-image-2.5-flare'])

  function refuseNewModel(request) {
    const model = JSON.parse(request.body.toString('utf8')).model
    return model === 'gpt-image-2' ? ok() : { status: 503, body: { error: { message: 'no available channel' } } }
  }
  const fallback = await runGenerate({ apiKey: 'sk-test-not-real', model: 'gpt-image-2.5-flare' }, refuseNewModel, [])
  assert.equal(fallback.code, 0, fallback.stderr)
  assert.deepEqual(requestedModels(fallback.requests), ['gpt-image-2.5-flare', 'gpt-image-2'])
  assert.match(fallback.stderr, /已改用 gpt-image-2/)
})

test('generate script refuses models it cannot draw with and lists the ones it can', async () => {
  const refused = await runGenerate({ apiKey: 'sk-test-not-real' }, ok, ['--model', 'jimeng_high_aes_general_v21_L'])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /不认识图片模型「jimeng_high_aes_general_v21_L」。能用的有：/)
  assert.match(refused.stderr, /gpt-image-2\.6-flare/)
  assert.match(refused.stderr, /nano-banana-pro/)
  assert.match(refused.stderr, /grok-imagine-image/)
  assert.equal(refused.requests.length, 0)

  const retired = await runGenerate({ apiKey: 'sk-test-not-real' }, ok, ['--model', 'gpt-image-1.5'])
  assert.equal(retired.code, 1)
  assert.match(retired.stderr, /gpt-image-1\.5 已经下线/)
  assert.equal(retired.requests.length, 0)

  const legacy = await runGenerate({ apiKey: 'sk-test-not-real' }, ok, [])
  assert.equal(legacy.code, 0, legacy.stderr)
  assert.deepEqual(requestedModels(legacy.requests), ['gpt-image-2'])
  assert.equal(legacy.requests[0].url, '/v1/images/generations')
})

test('generate script prints only the path on stdout and names the model on stderr', async () => {
  const done = await runGenerate({ apiKey: 'sk-test-not-real', model: 'gpt-image-2.6-flare', fallbackModels: [] }, ok, [])
  assert.equal(done.code, 0, done.stderr)
  assert.equal(done.stdout.trim().split('\n').length, 1)
  assert.match(done.stdout.trim(), /out\.png$/)
  assert.match(done.stderr, /已用 gpt-image-2\.6-flare 出图/)
  assert.deepEqual(jsonBody(done.requests[0]), { model: 'gpt-image-2.6-flare', prompt: 'a cat', n: 1, size: '1024x1024', quality: 'high' })
})

test('generate script exits with code 1 and only the real error when the relay refuses', async () => {
  function refuse() {
    return { status: 400, body: { error: { message: 'prompt rejected sk-leaked-value' } } }
  }
  const failed = await runGenerate({ apiKey: 'sk-test-not-real' }, refuse, [])
  assert.equal(failed.code, 1)
  assert.equal(failed.stdout, '')
  assert.match(failed.stderr, /prompt rejected/)
  assert.doesNotMatch(failed.stderr, /sk-leaked-value|Assertion/)
})

test('generate script falls through the account default chain in order', async () => {
  function refuseNewModels(request) {
    return jsonBody(request).model === 'gpt-image-2' ? ok() : { status: 503, body: { error: { message: 'no available channel' } } }
  }
  const config = { apiKey: 'sk-test-not-real', model: 'gpt-image-2.6-flare', fallbackModels: ['gpt-image-2.5-flare', 'gpt-image-2'] }
  const fallen = await runGenerate(config, refuseNewModels, [])
  assert.equal(fallen.code, 0, fallen.stderr)
  assert.deepEqual(requestedModels(fallen.requests), ['gpt-image-2.6-flare', 'gpt-image-2.5-flare', 'gpt-image-2'])
  assert.match(fallen.stderr, /gpt-image-2\.6-flare 没能出图，已改用 gpt-image-2。/)
  assert.match(fallen.stderr, /已用 gpt-image-2 出图/)

  const named = await runGenerate(config, refuseNewModels, ['--model', 'gpt-image-2.5-flare'])
  assert.equal(named.code, 1)
  assert.deepEqual(requestedModels(named.requests), ['gpt-image-2.5-flare'])
})

test('generate script converts size tiers, aspect ratios and background', async () => {
  const wide = await runGenerate({ apiKey: 'sk-test-not-real' }, ok, ['--size', '2K', '--aspect', '16:9', '--background', 'transparent', '--quality', 'low'])
  assert.equal(wide.code, 0, wide.stderr)
  assert.deepEqual(jsonBody(wide.requests[0]), {
    model: 'gpt-image-2', prompt: 'a cat', n: 1, size: '2048x1152', quality: 'low', background: 'transparent',
  })
  const uhd = await runGenerate({ apiKey: 'sk-test-not-real' }, ok, ['--size', '4K', '--aspect', '16:9'])
  assert.equal(jsonBody(uhd.requests[0]).size, '3840x2160')
  const both = await runGenerate({ apiKey: 'sk-test-not-real' }, ok, ['--size', '1536x864', '--aspect', '16:9'])
  assert.equal(both.code, 1)
  assert.equal(both.requests.length, 0)
  const odd = await runGenerate({ apiKey: 'sk-test-not-real' }, ok, ['--size', '1000x1000'])
  assert.equal(odd.code, 1)
  assert.match(odd.stderr, /16 的倍数/)
})

test('generate script edits with several reference images as image[]', async () => {
  const edited = await runGenerate({ apiKey: 'sk-test-not-real' }, ok, async (root) => {
    await writeFile(path.join(root, 'a.png'), pngBytes)
    await writeFile(path.join(root, 'b.jpg'), jpegBytes)
    return ['--image', path.join(root, 'a.png'), '--image', path.join(root, 'b.jpg')]
  })
  assert.equal(edited.code, 0, edited.stderr)
  assert.equal(edited.requests[0].url, '/v1/images/edits')
  const text = edited.requests[0].body.toString('latin1')
  assert.match(text, /name="image\[\]"; filename="a.png"\r\nContent-Type: image\/png/)
  assert.match(text, /name="image\[\]"; filename="b.jpg"\r\nContent-Type: image\/jpeg/)
  assert.match(text, /name="quality"\r\n\r\nhigh/)

  const notImage = await runGenerate({ apiKey: 'sk-test-not-real' }, ok, async (root) => {
    await writeFile(path.join(root, 'notes.png'), 'not an image')
    return ['--image', path.join(root, 'notes.png')]
  })
  assert.equal(notImage.code, 1)
  assert.match(notImage.stderr, /不是 PNG、JPEG、WebP/)
  assert.equal(notImage.requests.length, 0)
})

test('generate script draws Nano Banana through the Gemini native endpoint with the image key', async () => {
  const config = { codexApiKey: 'sk-codex-not-real', apiKey: 'sk-image-not-real' }
  const drawn = await runGenerate(config, geminiOk, ['--model', 'nano-banana-pro', '--size', '2K', '--aspect', '9:16'])
  assert.equal(drawn.code, 0, drawn.stderr)
  assert.equal(drawn.requests.length, 1)
  assert.equal(drawn.requests[0].url, '/v1beta/models/nano-banana-pro:generateContent')
  assert.equal(drawn.requests[0].googleKey, 'sk-image-not-real')
  assert.deepEqual(jsonBody(drawn.requests[0]).generationConfig, {
    responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16', imageSize: '2K' },
  })
  // The answer is a JPEG, so the .png the AI asked for becomes .jpg.
  assert.match(drawn.stdout.trim(), /out\.jpg$/)
  assert.match(drawn.stderr, /已用 nano-banana-pro 出图/)

  const edited = await runGenerate(config, geminiOk, async (root) => {
    await writeFile(path.join(root, 'a.png'), pngBytes)
    return ['--model', 'gemini-3.1-flash-image', '--image', path.join(root, 'a.png')]
  })
  assert.equal(edited.code, 0, edited.stderr)
  assert.deepEqual(jsonBody(edited.requests[0]).contents[0].parts, [
    { text: 'a cat' },
    { inlineData: { mimeType: 'image/png', data: pngBytes.toString('base64') } },
  ])

  const noKey = await runGenerate({ codexApiKey: 'sk-codex-not-real' }, geminiOk, ['--model', 'nano-banana-2'])
  assert.equal(noKey.code, 1)
  assert.match(noKey.stderr, /只能用图片模型分组的 Key/)
  assert.equal(noKey.requests.length, 0)
})

test('generate script draws Grok through the Images API and says size is not supported', async () => {
  const drawn = await runGenerate({ codexApiKey: 'sk-codex-not-real', apiKey: 'sk-image-not-real' }, grokOk, [
    '--model', 'grok-imagine-image', '--aspect', '1:1',
  ])
  assert.equal(drawn.code, 0, drawn.stderr)
  assert.deepEqual(drawn.requests.map((request) => request.authorization), ['Bearer sk-image-not-real'])
  assert.deepEqual(jsonBody(drawn.requests[0]), { model: 'grok-imagine-image', prompt: 'a cat', n: 1, response_format: 'b64_json' })
  assert.match(drawn.stderr, /Grok 不能指定尺寸和比例/)
  assert.match(drawn.stdout.trim(), /out\.jpg$/)
})

test('generate script size helpers keep exact ratios inside the gpt-image-2 pixel limits', async () => {
  const { tierDimensions, resolveImageSize, outputPathFor, defaultModelChain } = await import(pathToFileURL(generatePath).href)
  for (const tier of ['1K', '2K', '4K']) {
    for (const aspect of ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']) {
      const { width, height } = tierDimensions(tier, aspect)
      const [ratioWidth, ratioHeight] = aspect.split(':').map(Number)
      assert.equal(width % 16, 0, `${tier} ${aspect}`)
      assert.equal(height % 16, 0, `${tier} ${aspect}`)
      assert.equal(width * ratioHeight, height * ratioWidth, `${tier} ${aspect}`)
      assert.ok(width * height >= 655_360 && width * height <= 8_294_400, `${tier} ${aspect}`)
      assert.ok(Math.max(width, height) <= 3840, `${tier} ${aspect}`)
    }
  }
  assert.deepEqual(tierDimensions('2K', '16:9'), { width: 2048, height: 1152 })
  assert.deepEqual(tierDimensions('4K', '16:9'), { width: 3840, height: 2160 })
  assert.deepEqual(resolveImageSize('gemini', '3840x2160', ''), { imageSize: '4K', aspectRatio: '16:9' })
  assert.deepEqual(resolveImageSize('gemini', '', ''), { imageSize: '1K', aspectRatio: '1:1' })
  assert.throws(() => resolveImageSize('gemini', '1000x700', ''), /不是能用的比例/)
  assert.deepEqual(resolveImageSize('grok', '2K', '16:9'), {})
  assert.equal(outputPathFor('/tmp/x.png', jpegBytes), path.resolve('/tmp/x.jpg'))
  assert.equal(outputPathFor('/tmp/x.jpeg', jpegBytes), path.resolve('/tmp/x.jpeg'))
  assert.equal(outputPathFor('/tmp/x', pngBytes), path.resolve('/tmp/x.png'))
  assert.deepEqual(defaultModelChain({ model: 'gpt-image-2.6-flare', fallbackModels: null }), ['gpt-image-2.6-flare', 'gpt-image-2'])
  assert.deepEqual(defaultModelChain({ model: '', fallbackModels: null }), ['gpt-image-2'])
})
