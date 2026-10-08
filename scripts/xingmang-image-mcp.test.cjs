const assert = require('node:assert/strict')
const http = require('node:http')
const { mkdtemp, writeFile, rm, symlink } = require('node:fs/promises')
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
