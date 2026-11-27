const assert = require('node:assert/strict')
const http = require('node:http')
const { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, writeFile, rm, symlink } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const test = require('node:test')
// Independent decoders for the previews the server makes with its own encoders. These two come with
// Playwright (already a dev dependency) through an internal path; if a Playwright upgrade moves it,
// the require fails loudly here rather than the previews going unchecked.
const { PNG, jpegjs } = require('playwright-core/lib/utilsBundle')

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
  // The server reports the real path of where it saved the image, and macOS tmpdir sits behind a symlink.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'xingmang-image-mcp-')))
  const configPath = path.join(root, 'config.json')
  // The server saves every finished image. It gets a working directory and a home of its own, so
  // nothing lands in this repository or in the real pictures folder of whoever runs the tests.
  const home = path.join(root, 'home')
  const work = path.join(root, 'work')
  await mkdir(home)
  await mkdir(work)
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
      // A test that returns nothing drops the connection without an answer.
      if (!reply) return void req.socket.destroy()
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
  if (options.clock) {
    // The file name carries the second the image was saved in. A test that is about two images
    // landing in the same second pins the server's clock instead of hoping the runner is fast.
    const clockPath = path.join(root, 'fixed-clock.mjs')
    await writeFile(clockPath, `const RealDate = Date
const fixed = new RealDate(${options.clock.join(', ')}).getTime()
globalThis.Date = class extends RealDate {
  constructor(...args) {
    if (args.length) super(...args)
    else super(fixed)
  }
}
`)
    argv.unshift('--import', pathToFileURL(clockPath).href)
  }
  const child = spawn(process.execPath, argv, {
    // 'home' stands for a desktop app that starts the server outside any project.
    cwd: options.cwd === 'home' ? home : work,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      OneDrive: '',
      OneDriveConsumer: '',
      OneDriveCommercial: '',
      XINGMANG_IMAGE_CONFIG_PATH: configPath,
      XINGMANG_IMAGE_MCP_ALLOW_INSECURE_LOCAL: options.mockFetch ? '' : '1',
      ...(options.env ? options.env({ root, home, work }) : {}),
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
    await run({ call, requests, root, child, next, home, work })
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
    assert.equal(generated.result.isError, undefined, JSON.stringify({ result: generated.result, requests: requests.map((request) => [request.authorization, request.body.toString('utf8').slice(0, 80)]) }))
    assert.match(generated.result.content[1].text, /^已用 gpt-image-2 画好。/)
    assert.match(generated.result.content[1].text, /gpt-image-2\.5-flare 目前无法使用，已改用 gpt-image-2。$/)
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

test('MCP server moves a named GPT image model to the account defaults only when that model cannot be used', async () => {
  const config = { apiKey: 'sk-test-not-real', model: 'gpt-image-2.6-flare', fallbackModels: ['gpt-image-2.5-flare', 'gpt-image-2'] }
  // What the relay really answers when the AI names gpt-image-2.5 and this account does not have it.
  function onlyDefaults(request) {
    return request.url.includes('generateContent') || !config.fallbackModels.concat(config.model).includes(jsonBody(request).model)
      ? { status: 503, body: { error: { message: 'No available compatible accounts' } } }
      : ok()
  }
  await withServer(config, onlyDefaults, async ({ call, requests }) => {
    const moved = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat', model: 'gpt-image-2.5' } })
    assert.equal(moved.result.isError, undefined)
    assert.match(moved.result.content[1].text, /^已用 gpt-image-2\.6-flare 画好。/)
    assert.match(moved.result.content[1].text, /gpt-image-2\.5 目前无法使用，已改用 gpt-image-2\.6-flare。$/)
    assert.deepEqual(requests.map((request) => jsonBody(request).model), ['gpt-image-2.5', 'gpt-image-2.6-flare'])
    // Another vendor's model costs and looks different: a named one is never traded for a GPT image model.
    requests.length = 0
    const kept = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat', model: 'nano-banana-2' } })
    assert.equal(kept.result.isError, true)
    assert.equal(requests.length, 1)
    assert.match(requests[0].url, /nano-banana-2:generateContent/)
  })
  // A named model that is refused for what was asked, not for the model: nothing else is tried.
  function moderated() {
    return { status: 400, body: { error: { code: 'content_policy_violation', message: '图片内容审核未通过' } } }
  }
  await withServer(config, moderated, async ({ call, requests }) => {
    const refused = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat', model: 'gpt-image-2.5-sunburst' } })
    assert.equal(refused.result.isError, true)
    assert.match(refused.result.content[0].text, /图片内容审核未通过/)
    assert.deepEqual(requests.map((request) => jsonBody(request).model), ['gpt-image-2.5-sunburst'])
  })
  // A default the requested size does not fit is left out, instead of refusing the size for the model that was asked for.
  function nothingAvailable() {
    return { status: 503, body: { error: { message: 'No available compatible accounts' } } }
  }
  await withServer({ ...config, model: 'gpt-image-3', fallbackModels: ['gpt-image-2'] }, nothingAvailable, async ({ call, requests }) => {
    const odd = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat', model: 'gpt-image-4', size: '1000x1000' } })
    assert.equal(odd.result.isError, true)
    assert.match(odd.result.content[0].text, /No available compatible accounts/)
    assert.deepEqual(requests.map((request) => jsonBody(request).model), ['gpt-image-4', 'gpt-image-3'])
  })
})

test('MCP server changes model only when the relay says this model cannot be used right now', async () => {
  const config = {
    codexApiKey: 'sk-codex-not-real',
    apiKey: 'sk-image-not-real',
    model: 'gpt-image-2.6-flare',
    fallbackModels: ['gpt-image-2.5-flare', 'gpt-image-2'],
  }
  function attempts(requests) {
    return requests.map((request) => `${request.authorization.slice('Bearer sk-'.length, -'-not-real'.length)} ${jsonBody(request).model}`)
  }
  // Content moderation, a bad argument, a missing reference image: another model answers the same.
  for (const refusal of [
    { status: 400, body: { error: { message: '图片内容审核未通过，请修改描述后重试', code: 'content_policy_violation' } } },
    { status: 400, body: { error: { message: '未找到目标图片' } } },
    { status: 500, body: { error: { message: 'upstream exploded' } } },
    { status: 502, body: '<html>Bad Gateway</html>' },
  ]) {
    await withServer(config, () => refusal, async ({ call, requests }) => {
      const failed = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
      assert.equal(failed.result.isError, true)
      assert.deepEqual(attempts(requests), ['codex gpt-image-2.6-flare'], JSON.stringify(refusal))
    })
  }
  // A dead key or a rate limit is worth the other key, never another model.
  for (const status of [401, 429, 503]) {
    await withServer(config, () => ({ status, body: { error: { message: 'try again later' } } }), async ({ call, requests }) => {
      const failed = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
      assert.equal(failed.result.isError, true)
      assert.deepEqual(attempts(requests), ['codex gpt-image-2.6-flare', 'image gpt-image-2.6-flare'], String(status))
    })
  }
  // The model is gone upstream (404, no key change) or has no channel in either group (503, both keys).
  function retired(request) {
    const model = jsonBody(request).model
    if (model === 'gpt-image-2.6-flare') return { status: 404, body: { error: { message: 'The model does not exist', code: 'model_not_found' } } }
    if (model === 'gpt-image-2.5-flare') return { status: 503, body: { error: { message: '当前分组 default 下对于模型 gpt-image-2.5-flare 无可用渠道', code: 'model_not_found' } } }
    return ok()
  }
  await withServer(config, retired, async ({ call, requests }) => {
    const generated = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
    assert.equal(generated.result.isError, undefined)
    assert.match(generated.result.content[1].text, /gpt-image-2\.6-flare 目前无法使用，已改用 gpt-image-2。/)
    assert.deepEqual(attempts(requests), [
      'codex gpt-image-2.6-flare',
      'codex gpt-image-2.5-flare',
      'image gpt-image-2.5-flare',
      'codex gpt-image-2',
    ])
  })
  // No answer at all: the other key and the other models would not connect either.
  await withServer(config, () => null, async ({ call, requests }) => {
    const failed = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
    assert.equal(failed.result.isError, true)
    assert.match(failed.result.content[0].text, /连不上图片服务/)
    assert.equal(requests.length, 1)
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

// new-api v1.0.0-rc.24 service/billing_session.go：钱包余额不够这一次预扣时的原话。
function insufficientBalance() {
  return {
    status: 403,
    body: { error: { message: '预扣费额度失败, 用户剩余额度: ＄0.137692, 需要预扣费额度: ＄0.200000', type: 'new_api_error', code: 'insufficient_user_quota' } },
  }
}

const insufficientBalanceSentence = '当前账号余额不足，无法生成这张图片（需要 $0.20，剩余 $0.14）。请在管理工具中充值后重试。'

test('MCP server stops at the first request when the account balance is too low', async () => {
  // Both keys belong to the same account and every model costs money: one refusal is the answer.
  const config = {
    codexApiKey: 'sk-codex-not-real',
    apiKey: 'sk-image-not-real',
    model: 'gpt-image-2.6-flare',
    fallbackModels: ['gpt-image-2.5-flare', 'gpt-image-2'],
  }
  await withServer(config, insufficientBalance, async ({ call, requests, child }) => {
    let log = ''
    child.stderr.on('data', (chunk) => { log += chunk })
    const failed = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
    assert.equal(failed.result.isError, true)
    assert.deepEqual(failed.result.content, [{ type: 'text', text: insufficientBalanceSentence }])
    assert.equal(requests.length, 1)
    assert.match(log, /余额不足（HTTP 403）/)
  })
})

test('MCP server still switches keys when only the first key hit its own spending limit', async () => {
  // A key's own cap is not the account balance: the other key may well have room.
  function respond(request) {
    if (request.authorization === 'Bearer sk-codex-not-real') {
      return { status: 403, body: { error: { message: 'token quota is not enough, token remain quota: ＄0.010000, need quota: ＄0.200000', code: 'pre_consume_token_quota_failed' } } }
    }
    return ok()
  }
  await withServer({ codexApiKey: 'sk-codex-not-real', apiKey: 'sk-image-not-real' }, respond, async ({ call, requests }) => {
    const generated = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
    assert.equal(generated.result.isError, undefined)
    assert.deepEqual(requests.map((request) => request.authorization), ['Bearer sk-codex-not-real', 'Bearer sk-image-not-real'])
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
    assert.match(generated.result.content[1].text, /^已用 gpt-image-2 画好。/)
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
      // Width and height already say the ratio: an aspect that agrees with them is simply not needed.
      [{ size: '1536x864', aspect: '16:9' }, '1536x864'],
      [{ size: '800x800', aspect: '1:1' }, '800x800'],
      // Rounding to multiples of 16 moves the ratio a little; that still counts as the same ratio.
      [{ size: '1920x1088', aspect: '16:9' }, '1920x1088'],
    ]
    for (const [options] of cases) {
      const generated = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'x', ...options } })
      assert.equal(generated.result.isError, undefined, JSON.stringify(options))
    }
    assert.deepEqual(requests.map((request) => jsonBody(request).size), cases.map(([, size]) => size))
    assert.equal(jsonBody(requests[0]).quality, 'high')
    const both = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'x', size: '1024x768', aspect: '16:9' } })
    assert.equal(both.result.isError, true)
    assert.equal(both.result.content[0].text, 'size 写的 1024x768 比例是 4:3，aspect 写的是 16:9，两边不一致。请只保留其中一个，或把两边改成同一个比例。')
    const badAspect = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'x', aspect: '5:7' } })
    assert.equal(badAspect.result.isError, true)
    assert.equal(requests.length, cases.length)
  })
})

// Header-only pictures: the tool reads an input image's size from its header and never decodes it,
// so a 4032x3024 photo does not have to be 12 million real pixels here.
function pngHeader(width, height) {
  const header = Buffer.alloc(25)
  header.writeUInt32BE(13, 0)
  header.write('IHDR', 4, 'latin1')
  header.writeUInt32BE(width, 8)
  header.writeUInt32BE(height, 12)
  header[16] = 8
  header[17] = 2
  return Buffer.concat([pngBytes.subarray(0, 8), header, Buffer.from('fake-png-body')])
}

// A JPEG as a phone writes it: an Exif APP1 segment with the orientation tag (when given) before the frame header.
function jpegHeader(width, height, orientation, byteOrder = 'MM') {
  const parts = [Buffer.from([0xff, 0xd8])]
  if (orientation) {
    const tiff = Buffer.alloc(26)
    const little = byteOrder === 'II'
    function short(value, at) {
      if (little) tiff.writeUInt16LE(value, at)
      else tiff.writeUInt16BE(value, at)
    }
    function long(value, at) {
      if (little) tiff.writeUInt32LE(value, at)
      else tiff.writeUInt32BE(value, at)
    }
    tiff.write(byteOrder, 0, 'latin1')
    short(42, 2)
    long(8, 4)
    short(1, 8)
    short(0x0112, 10)
    short(3, 12)
    long(1, 14)
    short(orientation, 18)
    long(0, 22)
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
    const marker = Buffer.from([0xff, 0xe1, 0, 0])
    marker.writeUInt16BE(payload.length + 2, 2)
    parts.push(marker, payload)
  }
  const frame = Buffer.alloc(19)
  frame[0] = 0xff
  frame[1] = 0xc0
  frame.writeUInt16BE(17, 2)
  frame[4] = 8
  frame.writeUInt16BE(height, 5)
  frame.writeUInt16BE(width, 7)
  frame[9] = 3
  parts.push(frame, Buffer.from([0xff, 0xda, 0x00, 0x02]), Buffer.from('fake-scan'))
  return Buffer.concat(parts)
}

// What an edit asks the relay for when the AI leaves size or aspect out (yoyo 2026-11-27「改图保持原尺寸」):
// the blank part follows the first picture, which used to come back as a 1024x1024 square every time.
// The MCP server and the generate script run the same table, so the two cannot drift apart.
const editSizeCases = [
  { name: 'portrait photo keeps its shape and up to 2K', images: [pngHeader(3024, 4032)], size: '1536x2048' },
  { name: 'phone photo stored on its side, Exif says turn it', images: [jpegHeader(4032, 3024, 6)], size: '1536x2048' },
  { name: 'little-endian Exif, turned the other way', images: [jpegHeader(4032, 3024, 8, 'II')], size: '1536x2048' },
  { name: 'upside down is still landscape', images: [jpegHeader(4032, 3024, 3)], size: '2048x1536' },
  { name: 'landscape JPEG without Exif', images: [jpegHeader(4032, 3024)], size: '2048x1536' },
  { name: 'phone screenshot, a ratio outside the list', images: [pngHeader(1170, 2532)], size: '944x2048' },
  { name: 'a picture between 1K and 2K keeps its own size', images: [pngHeader(1080, 1920)], size: '1088x1920' },
  { name: 'a picture smaller than 1K still comes back at 1K', images: [pngHeader(512, 512)], size: '1024x1024' },
  { name: 'a tier alone keeps the picture ratio', images: [pngHeader(3024, 4032)], args: { size: '4K' }, size: '2480x3312' },
  { name: 'an aspect alone keeps the picture sharpness', images: [pngHeader(3024, 4032)], args: { aspect: '16:9' }, size: '2048x1152' },
  { name: 'tier and aspect both written are drawn as written', images: [pngHeader(3024, 4032)], args: { size: '1K', aspect: '1:1' }, size: '1024x1024' },
  { name: 'width and height written are drawn as written', images: [pngHeader(3024, 4032)], args: { size: '1536x1024' }, size: '1536x1024' },
  { name: 'only the first picture decides', images: [pngHeader(4032, 3024), pngHeader(1170, 2532)], size: '2048x1536' },
  { name: 'a header that cannot be read keeps the old default', images: [pngBytes], size: '1024x1024' },
]

function multipartField(request, name) {
  const match = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`).exec(request.body.toString('latin1'))
  return match ? match[1] : null
}

test('MCP server edits follow the first picture for the size and aspect the AI left out', async () => {
  await withServer({ apiKey: 'sk-test-not-real' }, ok, async ({ call, requests, root }) => {
    for (const [index, item] of editSizeCases.entries()) {
      const images = []
      for (const [order, bytes] of item.images.entries()) {
        const imagePath = path.join(root, `edit-${index}-${order}.img`)
        await writeFile(imagePath, bytes)
        images.push(imagePath)
      }
      const edited = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'x', images, ...item.args } })
      assert.equal(edited.result.isError, undefined, item.name)
      assert.equal(requests.at(-1).url, '/v1/images/edits', item.name)
      assert.equal(multipartField(requests.at(-1), 'size'), item.size, item.name)
    }
    // A new picture has nothing to follow and stays 1K square.
    await call('tools/call', { name: 'generate_image', arguments: { prompt: 'x' } })
    assert.equal(jsonBody(requests.at(-1)).size, '1024x1024')
  })
})

test('MCP server edits with Nano Banana pick the nearest listed ratio and the tier of the first picture', async () => {
  const config = { codexApiKey: 'sk-codex-not-real', apiKey: 'sk-image-not-real' }
  await withServer(config, geminiOk, async ({ call, requests, root }) => {
    const cases = [
      [pngHeader(3024, 4032), {}, { aspectRatio: '3:4', imageSize: '2K' }],
      [pngHeader(1170, 2532), {}, { aspectRatio: '9:16', imageSize: '2K' }],
      [jpegHeader(4032, 3024, 6), {}, { aspectRatio: '3:4', imageSize: '2K' }],
      [pngHeader(800, 600), {}, { aspectRatio: '4:3', imageSize: '1K' }],
      [pngHeader(3024, 4032), { size: '4K' }, { aspectRatio: '3:4', imageSize: '4K' }],
      [pngHeader(3024, 4032), { aspect: '1:1' }, { aspectRatio: '1:1', imageSize: '2K' }],
    ]
    for (const [index, [bytes, args, expected]] of cases.entries()) {
      const imagePath = path.join(root, `banana-${index}.img`)
      await writeFile(imagePath, bytes)
      const edited = await call('tools/call', {
        name: 'generate_image',
        arguments: { prompt: 'x', model: 'nano-banana-2', images: [imagePath], ...args },
      })
      assert.equal(edited.result.isError, undefined, JSON.stringify(expected))
      assert.deepEqual(jsonBody(requests.at(-1)).generationConfig.imageConfig, expected)
    }
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
    assert.match(generated.result.content[1].text, /^已用 nano-banana-2 画好。文件：.+\.jpg。/)
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
    // A rounded size has no usable ratio of its own; the aspect that agrees with it supplies one.
    const rounded = await call('tools/call', {
      name: 'generate_image',
      arguments: { prompt: 'a lighthouse', model: 'nano-banana-2', size: '1920x1088', aspect: '16:9' },
    })
    assert.equal(rounded.result.isError, undefined)
    assert.deepEqual(jsonBody(requests[2]).generationConfig.imageConfig, { aspectRatio: '16:9', imageSize: '2K' })
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

test('MCP server turns a relay error without a reason into a plain sentence and logs the original only', async () => {
  // new-api fills an empty upstream reason with the error type name (Mac acceptance R9: Grok edits showed "openai_error").
  function respond(request) {
    if (request.url === '/v1/images/edits') return { status: 400, body: { error: { message: 'openai_error', type: 'openai_error' } } }
    if (jsonBody(request).model === 'gpt-image-2.5-sunburst') return { status: 502, body: '<html>Bad Gateway</html>' }
    return { status: 400, body: { code: 'Client specified an invalid argument', error: 'Prompt is too long' } }
  }
  await withServer({ codexApiKey: 'sk-codex-not-real', apiKey: 'sk-image-not-real' }, respond, async ({ call, child, root }) => {
    let log = ''
    child.stderr.on('data', (chunk) => { log += chunk })
    const imagePath = path.join(root, 'photo.png')
    await writeFile(imagePath, pngBytes)
    const edit = await call('tools/call', {
      name: 'generate_image',
      arguments: { prompt: 'make the sky purple', model: 'grok-imagine-image', images: [imagePath] },
    })
    assert.equal(edit.result.isError, true)
    assert.equal(edit.result.content[0].text, 'grok-imagine-image 这次没能改图，图片服务没说原因。可以换回默认的 GPT 图片模型再试一次。')

    const draw = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat', model: 'gpt-image-2.5-sunburst' } })
    assert.equal(draw.result.isError, true)
    assert.equal(draw.result.content[0].text, 'gpt-image-2.5-sunburst 这次没能出图，图片服务没说原因。可以稍后再试一次。')

    // A reason the upstream wrote as a plain string still reaches the AI word for word.
    const said = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat', model: 'grok-imagine-image' } })
    assert.equal(said.result.isError, true)
    assert.equal(said.result.content[0].text, 'Prompt is too long')

    assert.match(log, /HTTP 400：openai_error/)
    assert.match(log, /HTTP 502：没有内容/)
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
    assert.match(generated.result.content[1].text, /^已用 grok-imagine-image 画好。文件：.+不要重新生成。Grok 不能指定尺寸和比例，这张图按它的默认尺寸生成。$/)
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
async function runGenerate(config, respond, args, options = {}) {
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
      // A test that returns nothing drops the connection without an answer.
      if (!reply) return void req.socket.destroy()
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
    // Nothing listens on the port any more: the same refusal a command sandbox without network gives.
    if (options.unreachable) await new Promise((resolve) => httpServer.close(resolve))
    const child = spawn(process.execPath, [
      '--import', pathToFileURL(preloadPath).href,
      path.join(root, 'scripts', 'generate.mjs'),
      '--prompt', 'a cat', '--out', path.join(root, 'out.png'), ...extra,
    ], {
      env: { ...process.env, CODEX_SANDBOX_NETWORK_DISABLED: '', ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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

test('generate script stops at the first request when the account balance is too low', async () => {
  const config = {
    codexApiKey: 'sk-codex-not-real',
    apiKey: 'sk-image-not-real',
    model: 'gpt-image-2.6-flare',
    fallbackModels: ['gpt-image-2.5-flare', 'gpt-image-2'],
  }
  const failed = await runGenerate(config, insufficientBalance, [])
  assert.equal(failed.code, 1)
  assert.equal(failed.stdout, '')
  assert.equal(failed.stderr.trim(), insufficientBalanceSentence)
  assert.equal(failed.requests.length, 1)
})

test('generate script and the MCP server agree on what counts as an empty balance and how to say it', async () => {
  const { isInsufficientBalance, insufficientBalanceMessage } = await import(pathToFileURL(generatePath).href)
  for (const [status, code, message] of [
    [403, 'insufficient_user_quota', ''],
    [403, '', '用户额度不足, 剩余额度: ＄0.000000'],
    [403, '', '预扣费额度失败, 用户剩余额度: ＄0.137692, 需要预扣费额度: ＄0.200000'],
    [403, '', '订阅额度不足或未配置订阅: no active subscription'],
    [403, 'INSUFFICIENT_BALANCE', 'Insufficient account balance'],
  ]) {
    assert.equal(isInsufficientBalance(status, code, message), true, `${status} ${code} ${message}`)
  }
  for (const [status, code, message] of [
    // The key's own cap, an upstream channel out of credit, and the same words on a status that is not a refusal.
    [403, 'pre_consume_token_quota_failed', 'token quota is not enough, token remain quota: ＄0.010000'],
    [403, '', '令牌额度不足'],
    [429, 'insufficient_quota', 'You exceeded your current quota'],
    [500, 'insufficient_user_quota', '用户额度不足'],
    [403, '', undefined],
  ]) {
    assert.equal(isInsufficientBalance(status, code, message), false, `${status} ${code} ${message}`)
  }
  assert.equal(insufficientBalanceMessage('预扣费额度失败, 用户剩余额度: ＄0.137692, 需要预扣费额度: ＄0.200000'), insufficientBalanceSentence)
  assert.equal(insufficientBalanceMessage('用户额度不足, 剩余额度: ＄0.05'), '当前账号余额不足，无法生成这张图片（剩余 $0.05）。请在管理工具中充值后重试。')
  // Rounding must never print a remaining amount that looks sufficient.
  assert.equal(
    insufficientBalanceMessage('预扣费额度失败, 用户剩余额度: ＄0.199000, 需要预扣费额度: ＄0.200000'),
    '当前账号余额不足，无法生成这张图片（需要 $0.20，剩余 $0.19）。请在管理工具中充值后重试。',
  )
  // Numbers without a currency sign may be quota units, and a missing reason has no numbers at all.
  for (const said of ['用户额度不足, 剩余额度: 68846', 'Insufficient account balance', '', undefined, 42]) {
    assert.equal(insufficientBalanceMessage(said), '当前账号余额不足，无法生成这张图片。请在管理工具中充值后重试。', String(said))
  }
  const generate = await readFile(generatePath, 'utf8')
  const server = await readFile(serverPath, 'utf8')
  for (const shared of [
    'const INSUFFICIENT_BALANCE_STATUSES = new Set([401, 402, 403, 429])',
    'const INSUFFICIENT_BALANCE_PATTERN = /insufficient_user_quota|用户额度不足|预扣费额度失败|订阅额度不足|user quota is not enough|INSUFFICIENT_BALANCE|insufficient account balance/i',
    'const needed = centsOf(/需要预扣费额度[:：]\\s*[＄$]\\s*(\\d+(?:\\.\\d+)?)/.exec(text))',
    'const remainingMatch = /剩余额度[:：]\\s*[＄$]\\s*(-?\\d+(?:\\.\\d+)?)/.exec(text)',
    'return `当前账号余额不足，无法生成这张图片${amounts}。请在管理工具中充值后重试。`',
  ]) {
    assert.ok(generate.includes(shared), shared)
    assert.ok(server.includes(shared), shared)
  }
})

test('generate script exits with code 3 and a fixed diagnosis when the command cannot reach the network', async () => {
  const config = {
    codexApiKey: 'sk-codex-not-real',
    apiKey: 'sk-image-not-real',
    model: 'gpt-image-2.6-flare',
    fallbackModels: ['gpt-image-2'],
  }
  const blocked = await runGenerate(config, ok, [], { unreachable: true })
  assert.equal(blocked.code, 3)
  assert.equal(blocked.stdout, '')
  assert.equal(blocked.stderr.trim(), '无法连接图片服务：这条命令可能被沙箱禁止联网，也可能是当前网络不通。请允许这条命令联网后重新运行一次；仍然失败请检查网络。')

  // Codex marks commands it runs without network; then the reason is not a guess.
  const sandboxed = await runGenerate(config, ok, [], { unreachable: true, env: { CODEX_SANDBOX_NETWORK_DISABLED: '1' } })
  assert.equal(sandboxed.code, 3)
  assert.equal(sandboxed.stderr.trim(), '无法连接图片服务：这条命令被沙箱禁止联网。请允许这条命令联网后重新运行一次。')

  // The request went out and no answer came back: it may have been drawn and charged, so this is
  // not the "run it again with network" exit code, and neither the other key nor the next model is tried.
  const dropped = await runGenerate(config, () => null, [])
  assert.equal(dropped.code, 1)
  assert.equal(dropped.stderr.trim(), '与图片服务的连接中途断开，这次请求可能已经送达并扣费。请先在管理工具的用量记录中确认，再决定是否重新生成。')
  assert.equal(dropped.requests.length, 1)

  // Every other failure keeps exit code 1.
  const refused = await runGenerate(config, () => ({ status: 400, body: { error: { message: 'bad prompt' } } }), [])
  assert.equal(refused.code, 1)
})

test('generate script turns a relay error without a reason into a plain sentence', async () => {
  // new-api fills an empty upstream reason with the error type name (Mac acceptance R9: Grok edits showed "openai_error").
  function placeholder() {
    return { status: 400, body: { error: { message: 'openai_error', type: 'openai_error' } } }
  }
  const edit = await runGenerate({ codexApiKey: 'sk-codex-not-real', apiKey: 'sk-image-not-real' }, placeholder, async (root) => {
    await writeFile(path.join(root, 'a.png'), pngBytes)
    return ['--model', 'grok-imagine-image', '--image', path.join(root, 'a.png')]
  })
  assert.equal(edit.code, 1)
  assert.equal(edit.stdout, '')
  assert.equal(edit.stderr.trim(), 'grok-imagine-image 这次没能改图，图片服务没说原因。可以换回默认的 GPT 图片模型再试一次。')
  assert.equal(edit.requests[0].url, '/v1/images/edits')

  function badGateway() {
    return { status: 502, body: '<html>Bad Gateway</html>' }
  }
  const config = { apiKey: 'sk-test-not-real', model: 'gpt-image-2.6-flare', fallbackModels: ['gpt-image-2'] }
  const draw = await runGenerate(config, badGateway, [])
  assert.equal(draw.code, 1)
  // A gateway error says nothing about the model, so the next one is not tried.
  assert.deepEqual(requestedModels(draw.requests), ['gpt-image-2.6-flare'])
  assert.equal(draw.stderr.trim(), 'gpt-image-2.6-flare 这次没能出图，图片服务没说原因。可以稍后再试一次。')

  // A reason the upstream wrote as a plain string still reaches the AI word for word.
  function plainString() {
    return { status: 400, body: { code: 'Client specified an invalid argument', error: 'Prompt is too long' } }
  }
  const said = await runGenerate({ apiKey: 'sk-image-not-real' }, plainString, ['--model', 'grok-imagine-image'])
  assert.equal(said.code, 1)
  assert.equal(said.stderr.trim(), 'Prompt is too long')
})

test('generate script and the MCP server agree on which relay errors say nothing', async () => {
  const { isUnexplainedUpstreamMessage, unexplainedFailureMessage } = await import(pathToFileURL(generatePath).href)
  for (const message of ['', '   ', 'openai_error', 'upstream_error', 'new_api_error', ' gemini_error ', 'claude_error', null, undefined, 42]) {
    assert.equal(isUnexplainedUpstreamMessage(message), true, String(message))
  }
  for (const message of ['model price not configured', '分组 图片模型 下模型 gpt-image-3 无可用渠道', 'insufficient_quota', 'error', 'HTTP 500']) {
    assert.equal(isUnexplainedUpstreamMessage(message), false, message)
  }
  assert.equal(unexplainedFailureMessage('nano-banana-2', 'gemini', false), 'nano-banana-2 这次没能出图，图片服务没说原因。可以换回默认的 GPT 图片模型再试一次。')
  const generate = await readFile(generatePath, 'utf8')
  const server = await readFile(serverPath, 'utf8')
  for (const shared of [
    'const PLACEHOLDER_ERROR_MESSAGE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*_error$/i',
    "const next = family === 'openai' ? '可以稍后再试一次。' : '可以换回默认的 GPT 图片模型再试一次。'",
    'return `${model} 这次没能${action}，图片服务没说原因。${next}`',
  ]) {
    assert.ok(generate.includes(shared), shared)
    assert.ok(server.includes(shared), shared)
  }
})

test('generate script falls through the account default chain in order', async () => {
  function refuseNewModels(request) {
    return jsonBody(request).model === 'gpt-image-2' ? ok() : { status: 503, body: { error: { message: 'no available channel' } } }
  }
  const config = { apiKey: 'sk-test-not-real', model: 'gpt-image-2.6-flare', fallbackModels: ['gpt-image-2.5-flare', 'gpt-image-2'] }
  const fallen = await runGenerate(config, refuseNewModels, [])
  assert.equal(fallen.code, 0, fallen.stderr)
  assert.deepEqual(requestedModels(fallen.requests), ['gpt-image-2.6-flare', 'gpt-image-2.5-flare', 'gpt-image-2'])
  assert.match(fallen.stderr, /gpt-image-2\.6-flare 目前无法使用，已改用 gpt-image-2。/)
  assert.match(fallen.stderr, /已用 gpt-image-2 出图/)

  // A named GPT image model that cannot be used right now moves to the account defaults as well, and says so.
  const named = await runGenerate(config, refuseNewModels, ['--model', 'gpt-image-2.5-flare'])
  assert.equal(named.code, 0, named.stderr)
  assert.deepEqual(requestedModels(named.requests), ['gpt-image-2.5-flare', 'gpt-image-2.6-flare', 'gpt-image-2'])
  assert.match(named.stderr, /gpt-image-2\.5-flare 目前无法使用，已改用 gpt-image-2。/)

  // Refused for what was asked, not for the model: the named model is the only one tried.
  function moderated() {
    return { status: 400, body: { error: { code: 'content_policy_violation', message: '图片内容审核未通过' } } }
  }
  const refused = await runGenerate(config, moderated, ['--model', 'gpt-image-2.5-sunburst'])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /图片内容审核未通过/)
  assert.deepEqual(requestedModels(refused.requests), ['gpt-image-2.5-sunburst'])

  // Another vendor's model costs and looks different: a named one is never traded for a GPT image model.
  function noChannel() {
    return { status: 503, body: { error: { message: '分组 图片模型 下模型 nano-banana-2 无可用渠道' } } }
  }
  const kept = await runGenerate(config, noChannel, ['--model', 'nano-banana-2'])
  assert.equal(kept.code, 1)
  assert.equal(kept.requests.length, 1)
  assert.match(kept.requests[0].url, /nano-banana-2:generateContent/)
})

test('generate script changes model only when the relay says this model cannot be used right now', async () => {
  const config = {
    codexApiKey: 'sk-codex-not-real',
    apiKey: 'sk-image-not-real',
    model: 'gpt-image-2.6-flare',
    fallbackModels: ['gpt-image-2.5-flare', 'gpt-image-2'],
  }
  function moderation() {
    return { status: 400, body: { error: { message: '图片内容审核未通过，请修改描述后重试', code: 'content_policy_violation' } } }
  }
  const refused = await runGenerate(config, moderation, [])
  assert.equal(refused.code, 1)
  assert.equal(refused.stderr.trim(), '图片内容审核未通过，请修改描述后重试')
  assert.deepEqual(requestedModels(refused.requests), ['gpt-image-2.6-flare'])

  const limited = await runGenerate(config, () => ({ status: 429, body: { error: { message: 'try again later' } } }), [])
  assert.equal(limited.code, 1)
  assert.deepEqual(limited.requests.map((request) => [request.authorization, jsonBody(request).model]), [
    ['Bearer sk-codex-not-real', 'gpt-image-2.6-flare'],
    ['Bearer sk-image-not-real', 'gpt-image-2.6-flare'],
  ])

  function retired(request) {
    return jsonBody(request).model === 'gpt-image-2.6-flare'
      ? { status: 404, body: { error: { message: 'The model does not exist', code: 'model_not_found' } } }
      : ok()
  }
  const moved = await runGenerate(config, retired, [])
  assert.equal(moved.code, 0, moved.stderr)
  assert.deepEqual(requestedModels(moved.requests), ['gpt-image-2.6-flare', 'gpt-image-2.5-flare'])
  assert.match(moved.stderr, /gpt-image-2\.6-flare 目前无法使用，已改用 gpt-image-2\.5-flare。/)
})

test('generate script and the MCP server agree on when a model counts as unavailable', async () => {
  const { isModelUnavailable } = await import(pathToFileURL(generatePath).href)
  for (const [status, code, message] of [
    [404, '', 'not found'],
    [503, 'model_not_found', '当前分组 default 下对于模型 gpt-image-3 无可用渠道'],
    [503, '', '分组 图片模型 下模型 gpt-image-3 无可用渠道'],
    [503, '', 'no available channel for gpt-image-2.5-flare'],
    [503, '', 'No available compatible accounts'],
    [500, 'model_price_error', '模型 gpt-image-3 倍率或价格未配置，请联系管理员设置'],
  ]) {
    assert.equal(isModelUnavailable(status, code, message), true, `${status} ${code} ${message}`)
  }
  for (const [status, code, message] of [
    [400, 'content_policy_violation', '图片内容审核未通过'],
    [400, '', '未找到目标图片'],
    [503, '', 'Service Unavailable'],
    [429, '', 'rate limited'],
    [502, '', undefined],
  ]) {
    assert.equal(isModelUnavailable(status, code, message), false, `${status} ${code} ${message}`)
  }
  const generate = await readFile(generatePath, 'utf8')
  const server = await readFile(serverPath, 'utf8')
  for (const shared of [
    "const MODEL_UNAVAILABLE_CODES = new Set(['model_not_found', 'model_price_error'])",
    'const MODEL_UNAVAILABLE_PATTERN = /model_not_found|无可用渠道|no available channel|no available compatible accounts|倍率或价格未配置|ratio or price not set/i',
    "return status === 404 || MODEL_UNAVAILABLE_CODES.has(code) || MODEL_UNAVAILABLE_PATTERN.test(typeof message === 'string' ? message : '')",
    '目前无法使用，已改用',
    'function modelsToTry(requested, family, chain, fits) {',
    '  if (requested === chain[0]) return chain',
    "  if (family !== 'openai') return [requested]",
    '  return [requested, ...chain.filter((model) => model !== requested && fits(model))]',
  ]) {
    assert.ok(generate.includes(shared), shared)
    assert.ok(server.includes(shared), shared)
  }
})

test('generate script converts size tiers, aspect ratios and background', async () => {
  const wide = await runGenerate({ apiKey: 'sk-test-not-real' }, ok, ['--size', '2K', '--aspect', '16:9', '--background', 'transparent', '--quality', 'low'])
  assert.equal(wide.code, 0, wide.stderr)
  assert.deepEqual(jsonBody(wide.requests[0]), {
    model: 'gpt-image-2', prompt: 'a cat', n: 1, size: '2048x1152', quality: 'low', background: 'transparent',
  })
  const uhd = await runGenerate({ apiKey: 'sk-test-not-real' }, ok, ['--size', '4K', '--aspect', '16:9'])
  assert.equal(jsonBody(uhd.requests[0]).size, '3840x2160')
  // Width and height already say the ratio: an aspect that agrees with them is simply not needed.
  for (const [size, aspect] of [['1536x864', '16:9'], ['800x800', '1:1'], ['1920x1088', '16:9']]) {
    const agreed = await runGenerate({ apiKey: 'sk-test-not-real' }, ok, ['--size', size, '--aspect', aspect])
    assert.equal(agreed.code, 0, agreed.stderr)
    assert.equal(jsonBody(agreed.requests[0]).size, size)
  }
  const both = await runGenerate({ apiKey: 'sk-test-not-real' }, ok, ['--size', '1024x768', '--aspect', '16:9'])
  assert.equal(both.code, 1)
  assert.equal(both.stderr.trim(), '--size 写的 1024x768 比例是 4:3，--aspect 写的是 16:9，两边不一致。请只保留其中一个，或把两边改成同一个比例。')
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
  assert.deepEqual(resolveImageSize('gemini', '1920x1088', '16:9'), { imageSize: '2K', aspectRatio: '16:9' })
  assert.throws(() => resolveImageSize('openai', '1023x767', '1:1'), /比例是 约 1\.33:1，--aspect 写的是 1:1/)
  assert.equal(outputPathFor('/tmp/x.png', jpegBytes), path.resolve('/tmp/x.jpg'))
  assert.equal(outputPathFor('/tmp/x.jpeg', jpegBytes), path.resolve('/tmp/x.jpeg'))
  assert.equal(outputPathFor('/tmp/x', pngBytes), path.resolve('/tmp/x.png'))
  assert.deepEqual(defaultModelChain({ model: 'gpt-image-2.6-flare', fallbackModels: null }), ['gpt-image-2.6-flare', 'gpt-image-2'])
  assert.deepEqual(defaultModelChain({ model: '', fallbackModels: null }), ['gpt-image-2'])
})

test('generate script edits follow the first picture for the size and aspect the AI left out, like the MCP server', async () => {
  for (const [index, item] of editSizeCases.entries()) {
    const edited = await runGenerate({ apiKey: 'sk-test-not-real' }, ok, async (root) => {
      const extra = []
      for (const [order, bytes] of item.images.entries()) {
        const imagePath = path.join(root, `edit-${index}-${order}.img`)
        await writeFile(imagePath, bytes)
        extra.push('--image', imagePath)
      }
      if (item.args?.size) extra.push('--size', item.args.size)
      if (item.args?.aspect) extra.push('--aspect', item.args.aspect)
      return extra
    })
    assert.equal(edited.code, 0, `${item.name}: ${edited.stderr}`)
    assert.equal(multipartField(edited.requests[0], 'size'), item.size, item.name)
  }
  const banana = await runGenerate({ codexApiKey: 'sk-codex-not-real', apiKey: 'sk-image-not-real' }, geminiOk, async (root) => {
    await writeFile(path.join(root, 'shot.png'), pngHeader(1170, 2532))
    return ['--model', 'nano-banana-2', '--image', path.join(root, 'shot.png')]
  })
  assert.equal(banana.code, 0, banana.stderr)
  assert.deepEqual(jsonBody(banana.requests[0]).generationConfig.imageConfig, { aspectRatio: '9:16', imageSize: '2K' })
})

test('generate script size helpers keep a picture ratio inside the gpt-image-2 limits and never trip on a broken header', async () => {
  const fc = require('fast-check')
  const { ratioDimensions, nearestAspect, originalDimensions } = await import(pathToFileURL(generatePath).href)
  // Any picture shape and any long side comes back as a size gpt-image-2 accepts, turned the same way as the picture.
  fc.assert(fc.property(
    fc.integer({ min: 1, max: 20_000 }), fc.integer({ min: 1, max: 20_000 }), fc.integer({ min: 16, max: 3840 }),
    (width, height, longSide) => {
      const picked = ratioDimensions(width / height, longSide)
      const long = Math.max(picked.width, picked.height)
      const short = Math.min(picked.width, picked.height)
      return picked.width % 16 === 0 && picked.height % 16 === 0
        && picked.width * picked.height >= 655_360 && picked.width * picked.height <= 8_294_400
        && long <= 3840 && long <= 3 * short
        && (width === height || picked.width === picked.height || (width > height) === (picked.width > picked.height))
    },
  ))
  assert.deepEqual(ratioDimensions(1, 2048), { width: 2048, height: 2048 })
  assert.deepEqual(ratioDimensions(3, 3840), { width: 3840, height: 1280 })
  assert.equal(nearestAspect(1170 / 2532), '9:16')
  assert.equal(nearestAspect(4032 / 3024), '4:3')
  assert.equal(nearestAspect(1), '1:1')
  // A header cut short anywhere, or random bytes behind a JPEG or PNG signature, gives a size or null and never throws:
  // a throw here would fail the whole edit instead of falling back to the old default.
  const phone = jpegHeader(4032, 3024, 6)
  for (let length = 0; length <= phone.length; length += 1) {
    const read = originalDimensions(phone.subarray(0, length))
    assert.ok(read === null || (read.width > 0 && read.height > 0), String(length))
  }
  assert.deepEqual(originalDimensions(phone), { width: 3024, height: 4032 })
  fc.assert(fc.property(
    fc.constantFrom(Buffer.from([0xff, 0xd8, 0xff, 0xe1]), pngBytes.subarray(0, 8)), fc.uint8Array({ maxLength: 96 }),
    (signature, rest) => {
      const read = originalDimensions(Buffer.concat([signature, Buffer.from(rest)]))
      return read === null || (read.width > 0 && read.height > 0)
    },
  ))
})

test('bundled image skill names neither the brand nor a site address where the AI or the user reads it', async () => {
  // 技能说明、工具说明和出错提示都会被 AI 读到、转述给客户，主语只用「当前账号」「管理工具」。
  // 站点地址只许留在画图工具的地址白名单（安全检查）和命令行脚本的兜底地址里。
  const skillRoot = path.resolve(__dirname, '..', 'bundled-skills', 'xingmang-ai')
  const siteAddresses = /https:\/\/[a-z0-9.-]*solov\.cc/g
  for (const file of ['SKILL.md', 'references.md']) {
    const text = await readFile(path.join(skillRoot, file), 'utf8')
    assert.doesNotMatch(text, /星芒/, file)
    assert.doesNotMatch(text, /solov\.cc/, file)
  }
  const expectedAddresses = {
    'generate.mjs': ['https://xm.solov.cc'],
    'mcp-server.mjs': ['https://xm.solov.cc', 'https://api.solov.cc', 'https://xm-direct.solov.cc'],
    'image-preview.mjs': null,
  }
  // No exception for the folder the finished images go to: its name ends up in the path the customer
  // is given, so it does not carry the brand either (yoyo, 2026-11-26).
  for (const [file, addresses] of Object.entries(expectedAddresses)) {
    const text = await readFile(path.join(skillRoot, 'scripts', file), 'utf8')
    assert.doesNotMatch(text, /星芒/, file)
    assert.deepEqual(text.match(siteAddresses), addresses, file)
  }
})

test('bundled image skill tells the AI the exact tool names and how to look for the tool before running the script', async () => {
  const skill = await readFile(path.resolve(__dirname, '..', 'bundled-skills', 'xingmang-ai', 'SKILL.md'), 'utf8')
  const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)[1]
  // Xingmang rewrites this one line for the legacy directory name; it has to stay on its own line.
  assert.match(frontMatter, /^name: images$/m)
  const description = frontMatter.slice(frontMatter.indexOf('description: >-') + 'description: >-'.length)
    .split('\n').map((line) => line.trim()).filter(Boolean).join(' ')
  // The description is all the AI sees before it opens the skill, so the tool has to be named there.
  assert.match(description, /优先调用画图工具 generate_image/)
  // Tools that load skills cap the description length; stay well inside it.
  assert.ok([...description].length <= 500, `description is ${[...description].length} characters`)
  for (const expected of [
    // Codex replaces the dash in the server name; Claude Code keeps it.
    'mcp__xingmang_image__generate_image',
    'mcp__xingmang-image__generate_image',
    '先用关键词 `xingmang` 搜索一次全部工具',
    '`ALL_TOOLS`',
  ]) {
    assert.ok(description.includes(expected) || skill.includes(expected), expected)
  }
  assert.ok(skill.indexOf('## 第一步：用画图工具') < skill.indexOf('## 第二步：没有画图工具时运行脚本'))
})

/**
 * A real PNG with a colour ramp (red grows to the right, green grows downwards) under noise, so it is
 * far too large to pass as its own preview and a decoded preview can be told from garbage.
 */
function rampPng(width, height, options = {}) {
  const png = new PNG({ width, height })
  let seed = 20261126
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const noise = (seed >> 16) & 0x3f
      const base = (y * width + x) * 4
      png.data[base] = Math.floor((x / width) * 192) + noise
      png.data[base + 1] = Math.floor((y / height) * 192) + noise
      png.data[base + 2] = 96 + noise
      // A disc in the middle on a fully transparent background, like a sticker cut-out.
      const outside = Math.hypot(x - width / 2, y - height / 2) > Math.min(width, height) * 0.4
      png.data[base + 3] = options.transparent && outside ? 0 : 255
    }
  }
  return PNG.sync.write(png)
}

function respondWithImage(bytes) {
  return function respond() {
    return { status: 200, body: { data: [{ b64_json: bytes.toString('base64') }] } }
  }
}

// Mean of one colour channel over a rectangle given as fractions of the picture.
function channelMean(image, channel, left, top, right, bottom) {
  let sum = 0
  let count = 0
  for (let y = Math.floor(top * image.height); y < Math.floor(bottom * image.height); y += 1) {
    for (let x = Math.floor(left * image.width); x < Math.floor(right * image.width); x += 1) {
      sum += image.data[(y * image.width + x) * 4 + channel]
      count += 1
    }
  }
  return sum / count
}

function savedPath(text) {
  return /文件：(.+?)。回复客户时请原样给出这个路径/.exec(text)[1]
}

const PREVIEW_MAX_BYTES = 300 * 1024

test('MCP server saves the original as a file and returns only a small JPEG preview with the fixed sentence', async () => {
  // 2K 16:9 and a 768x1024 portrait: the two sizes that showed up as raw JSON in the Codex desktop app.
  for (const [width, height, previewWidth, previewHeight] of [[2048, 1152, 1024, 576], [768, 1024, 768, 1024]]) {
    const original = rampPng(width, height)
    assert.ok(original.length > 1024 * 1024, 'the fixture is larger than what the desktop app still shows as a picture')
    await withServer({ apiKey: 'sk-test-not-real' }, respondWithImage(original), async ({ call, work }) => {
      const generated = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a ramp' } })
      assert.equal(generated.result.isError, undefined)
      assert.deepEqual(generated.result.content.map((entry) => entry.type), ['image', 'text'])

      const text = generated.result.content[1].text
      const filePath = savedPath(text)
      assert.equal(text, `已用 gpt-image-2 画好，${width}x${height}。文件：${filePath}。回复客户时请原样给出这个路径，不要自己拼路径；客户说看不到图时，告诉他文件在哪，不要重新生成。`)
      assert.equal(path.dirname(filePath), path.join(work, 'outputs'))
      assert.match(path.basename(filePath), /^\d{8}-\d{6}-gpt-image-2\.png$/)
      assert.ok((await readFile(filePath)).equals(original), 'the file is the untouched original')

      const preview = generated.result.content[0]
      assert.equal(preview.mimeType, 'image/jpeg')
      const previewBytes = Buffer.from(preview.data, 'base64')
      assert.ok(previewBytes.length <= PREVIEW_MAX_BYTES, `preview is ${previewBytes.length} bytes`)
      // What goes back into the conversation is an order of magnitude smaller than the original was.
      assert.ok(JSON.stringify(generated.result).length < original.length / 3)
      assert.ok(JSON.stringify(generated.result).length < 450 * 1024)
      const decoded = jpegjs.decode(previewBytes, { useTArray: true })
      assert.ok(Math.max(decoded.width, decoded.height) <= 1024)
      // Smaller than the first step only if the size cap forced it, and never a different shape.
      assert.ok(decoded.width <= previewWidth && decoded.height <= previewHeight)
      assert.ok(Math.abs(decoded.width * height - decoded.height * width) <= Math.max(width, height))
      // It is the same picture: red still grows to the right and green still grows downwards.
      assert.ok(channelMean(decoded, 0, 0.7, 0, 1, 1) - channelMean(decoded, 0, 0, 0, 0.3, 1) > 80)
      assert.ok(channelMean(decoded, 1, 0, 0.7, 1, 1) - channelMean(decoded, 1, 0, 0, 1, 0.3) > 80)
      assert.ok(Math.abs(channelMean(decoded, 2, 0, 0, 1, 1) - 127) < 12)
    })
  }
})

test('MCP server previews a transparent image as a smaller PNG that keeps the transparency', async () => {
  const original = rampPng(1536, 1536, { transparent: true })
  await withServer({ apiKey: 'sk-test-not-real' }, respondWithImage(original), async ({ call }) => {
    const generated = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a sticker', background: 'transparent' } })
    assert.equal(generated.result.isError, undefined)
    const preview = generated.result.content[0]
    assert.equal(preview.mimeType, 'image/png')
    const previewBytes = Buffer.from(preview.data, 'base64')
    assert.ok(previewBytes.length <= PREVIEW_MAX_BYTES, `preview is ${previewBytes.length} bytes`)
    const decoded = PNG.sync.read(previewBytes)
    assert.ok(Math.max(decoded.width, decoded.height) <= 1024)
    assert.equal(decoded.width, decoded.height)
    const centre = (Math.floor(decoded.height / 2) * decoded.width + Math.floor(decoded.width / 2)) * 4
    assert.equal(decoded.data[3], 0, 'the corner is still transparent')
    assert.equal(decoded.data[centre + 3], 255, 'the middle is still opaque')
    assert.ok(channelMean(decoded, 0, 0.6, 0.4, 0.8, 0.6) - channelMean(decoded, 0, 0.2, 0.4, 0.4, 0.6) > 40)
    assert.match(generated.result.content[1].text, /^已用 gpt-image-2 画好，1536x1536。文件：/)
    assert.ok((await readFile(savedPath(generated.result.content[1].text))).equals(original))
  })
})

test('MCP server never overwrites an earlier image and keeps each one under its own name', async () => {
  await withServer({ apiKey: 'sk-test-not-real', model: 'gpt-image-2.6-flare' }, ok, async ({ call, work }) => {
    const paths = []
    for (let index = 0; index < 3; index += 1) {
      const generated = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
      paths.push(savedPath(generated.result.content[1].text))
    }
    // All three were saved in the same second: the later ones get a suffix instead of replacing the first.
    assert.deepEqual(paths, [
      path.join(work, 'outputs', '20261126-173005-gpt-image-2.6-flare.png'),
      path.join(work, 'outputs', '20261126-173005-gpt-image-2.6-flare-2.png'),
      path.join(work, 'outputs', '20261126-173005-gpt-image-2.6-flare-3.png'),
    ])
    // The server closes each file before it answers, so the folder holds exactly these three.
    assert.deepEqual((await readdir(path.join(work, 'outputs'))).sort(), paths.map((filePath) => path.basename(filePath)).sort())
    for (const filePath of paths) assert.equal(await readFile(filePath, 'utf8'), 'fixture-image')
  }, { clock: [2026, 10, 26, 17, 30, 5] })
})

test('MCP server does not write through an outputs folder that is a link', async () => {
  // The server runs outside the command sandbox, and a sandboxed command may write inside the project:
  // it could turn outputs into a link that points anywhere. The image then goes to the pictures folder.
  await withServer({ apiKey: 'sk-test-not-real' }, ok, async ({ call, root, home, work }) => {
    const elsewhere = path.join(root, 'elsewhere')
    await mkdir(elsewhere)
    // A junction needs no privilege on Windows; other systems ignore the type and make a symbolic link.
    await symlink(elsewhere, path.join(work, 'outputs'), 'junction')
    const generated = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
    assert.notEqual(generated.result.isError, true)
    const filePath = savedPath(generated.result.content[1].text)
    assert.equal(path.dirname(filePath), path.join(home, 'Pictures', 'AI画图'))
    assert.equal(await readFile(filePath, 'utf8'), 'fixture-image')
    assert.deepEqual(await readdir(elsewhere), [])
  })
})

test('MCP server saves into the pictures folder when it was not started inside a project', async () => {
  // A desktop app starts the server in the home directory (or a system one): no outputs folder there.
  await withServer({ apiKey: 'sk-test-not-real' }, ok, async ({ call, home }) => {
    const generated = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
    const filePath = savedPath(generated.result.content[1].text)
    assert.equal(path.dirname(filePath), path.join(home, 'Pictures', 'AI画图'))
    assert.equal(await readFile(filePath, 'utf8'), 'fixture-image')
    assert.deepEqual(await readdir(home), ['Pictures'])
  }, { cwd: 'home' })

  // Windows with OneDrive backup: the pictures folder lives under OneDrive and carries its localized name.
  function oneDrive({ root }) {
    return { OneDrive: path.join(root, 'OneDrive') }
  }
  await withServer({ apiKey: 'sk-test-not-real' }, ok, async ({ call, root }) => {
    await mkdir(path.join(root, 'OneDrive', '图片'), { recursive: true })
    const generated = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
    assert.equal(path.dirname(savedPath(generated.result.content[1].text)), path.join(root, 'OneDrive', '图片', 'AI画图'))
  }, { cwd: 'home', env: oneDrive })

  // Inside a project, but something that is not a folder already has the name: nothing is replaced.
  await withServer({ apiKey: 'sk-test-not-real' }, ok, async ({ call, home, work }) => {
    await writeFile(path.join(work, 'outputs'), 'not a folder')
    const generated = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'a cat' } })
    assert.equal(path.dirname(savedPath(generated.result.content[1].text)), path.join(home, 'Pictures', 'AI画图'))
    assert.equal(await readFile(path.join(work, 'outputs'), 'utf8'), 'not a folder')
  })
})

test('MCP server tells the AI in the tool description that the image is saved as a file', async () => {
  await withServer({ apiKey: 'sk-test-not-real' }, ok, async ({ call }) => {
    const listed = await call('tools/list')
    const description = listed.result.tools[0].description
    assert.match(description, /图片会保存成文件，结果里给出文件路径和一张预览图。/)
    // The old promise is what made the AI assume the customer had already seen the picture.
    assert.doesNotMatch(description, /直接显示在对话里/)
    assert.equal(listed.result.tools[0].inputSchema.properties.out, undefined, 'the caller cannot choose where the file goes')
  })
})

test('bundled image skill gives Codex the exact call to copy and says how to hand the file to the customer', async () => {
  const skill = await readFile(path.resolve(__dirname, '..', 'bundled-skills', 'xingmang-ai', 'SKILL.md'), 'utf8')
  // The second line is what puts the preview and the sentence with the file path into the conversation.
  // Codex reaches MCP tools from code it writes itself, and left alone it often dropped the result.
  assert.ok(skill.includes([
    '```js',
    'const r = await tools.mcp__xingmang_image__generate_image({ prompt: "<描述>", images: ["<参考图完整路径，没有就删掉这一项>"] });',
    'for (const c of (r?.content || [])) c.type === "image" ? image(c) : c.type === "text" ? text(c.text) : null;',
    '```',
  ].join('\n')))
  // The call used to carry size: "1K", aspect: "1:1", and Codex copied them into every edit, so a portrait came back
  // as a 1024 square even after the tool learned to follow the picture (yoyo 2026-11-27「改图保持原尺寸」).
  assert.ok(skill.includes('改图时不要为了把参数写全而填 `1K`、`1:1`'))
  const finished = skill.slice(skill.indexOf('## 完成后'), skill.indexOf('## 失败时'))
  for (const rule of [
    '最终回复里逐张写出结果给的文件路径',
    '不要只列图片的名字',
    '`.codex/visualizations`',
    '只告诉他文件在哪里，不要重新生成',
  ]) {
    assert.ok(finished.includes(rule), rule)
  }
  // The tool no longer shows the picture by itself, so the skill must not promise that either.
  assert.doesNotMatch(skill, /直接显示在对话里/)
})
