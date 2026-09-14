const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const { test } = require('node:test')
const { parseArguments, requestController, probeProfile } = require('./probe-acceleration-nodes.cjs')

async function localController(t, handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })
  return server.address().port
}

function reply(response, body, status = 200, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  response.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function assertSanitizedFailure(error) {
  assert.equal(error.message, '线路探测失败或超时。')
  assert.equal(error.message.includes('private-upstream-secret'), false)
  return true
}

test('parseArguments accepts absolute input and a distinct report destination', () => {
  const config = path.resolve('private', 'nodes.yaml')
  const core = path.resolve('private', 'mihomo.exe')
  const report = path.resolve('artifacts', 'nodes-report.json')
  assert.deepEqual(parseArguments(['--core', core, '--report', report, '--config', config]), {
    '--core': core, '--report': report, '--config': config,
  })
  assert.deepEqual(parseArguments(['--config', config, '--core', core]), {
    '--config': config, '--core': core,
  })
})

test('parseArguments rejects duplicate, missing, unknown and relative arguments', () => {
  const config = path.resolve('nodes.yaml')
  const core = path.resolve('mihomo.exe')
  for (const args of [
    [], ['--config', config], ['--core', core],
    ['--config', config, '--core'],
    ['--config', config, '--core', core, '--config', config],
    ['--config', config, '--core', core, '--unknown', config],
    ['--config', 'nodes.yaml', '--core', core],
    ['--config', config, '--core', 'mihomo.exe'],
    ['--config', config, '--core', core, '--report', 'report.json'],
  ]) {
    assert.throws(() => parseArguments(args))
  }
})

test('parseArguments prevents reports from overwriting either input through path aliases', () => {
  const config = path.resolve('private', 'nodes.yaml')
  const core = path.resolve('private', 'mihomo.exe')
  for (const report of [
    config, core, config.toUpperCase(), core.toUpperCase(),
    path.join(path.dirname(config), 'nested', '..', path.basename(config)),
  ]) {
    assert.throws(() => parseArguments(['--config', config, '--core', core, '--report', report]),
      /报告不能覆盖输入文件/)
  }
})

test('requestController authenticates against fixed loopback without sharing a global HTTP agent', async (t) => {
  const received = []
  const port = await localController(t, (request, response) => {
    received.push({ host: request.headers.host, auth: request.headers.authorization, url: request.url })
    reply(response, { version: 'test-core' })
  })
  const options = []
  const originalGet = http.get
  t.mock.method(http, 'get', function (input, ...args) {
    options.push(input)
    return Reflect.apply(originalGet, this, [input, ...args])
  })
  assert.deepEqual(await requestController(port, 'local-test-secret', '/version', 1000), { version: 'test-core' })
  assert.deepEqual(received, [{ host: `127.0.0.1:${port}`, auth: 'Bearer local-test-secret', url: '/version' }])
  assert.equal(options.length, 1)
  assert.equal(options[0].hostname, '127.0.0.1')
  assert.equal(options[0].port, port)
  assert.equal(options[0].agent, false)
})

test('requestController refuses redirects instead of following them or exposing the response', async (t) => {
  let redirectedRequests = 0
  const destination = await localController(t, (_request, response) => {
    redirectedRequests += 1
    reply(response, { delay: 12 })
  })
  const port = await localController(t, (_request, response) => {
    reply(response, { error: 'private-upstream-secret' }, 302, {
      Location: `http://127.0.0.1:${destination}/private-upstream-secret`,
    })
  })
  await assert.rejects(requestController(port, 'test-secret', '/version', 1000), assertSanitizedFailure)
  assert.equal(redirectedRequests, 0)
})

test('requestController bounds response size even when the oversized body is valid JSON', async (t) => {
  const port = await localController(t, (_request, response) => {
    reply(response, { error: 'private-upstream-secret', padding: 'x'.repeat(5000) })
  })
  await assert.rejects(requestController(port, 'test-secret', '/version', 1000), assertSanitizedFailure)
})

test('requestController has a wall-clock deadline when the controller never completes a response', async (t) => {
  const port = await localController(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.write('{"error":"private-upstream-secret"')
  })
  await assert.rejects(requestController(port, 'test-secret', '/version', 40), assertSanitizedFailure)
})

test('requestController hides upstream error bodies, invalid JSON and truncated responses', async (t) => {
  const port = await localController(t, (request, response) => {
    if (request.url === '/status') reply(response, { error: 'private-upstream-secret' }, 500)
    else if (request.url === '/json') reply(response, 'private-upstream-secret')
    else {
      response.writeHead(200, { 'Content-Length': '1000' })
      response.write('private-upstream-secret')
      response.destroy()
    }
  })
  for (const endpoint of ['/status', '/json', '/truncated']) {
    await assert.rejects(requestController(port, 'test-secret', endpoint, 1000), assertSanitizedFailure)
  }
})

test('probeProfile projects only public node metadata and validated latency values', async (t) => {
  const delays = [18, 0, -1, 6001, 2.5, '10', null, 6000]
  const profile = {
    nodes: delays.map((_, index) => ({
      id: `node ${index}/+`, label: 'private-upstream-secret',
      server: 'private-upstream-secret', password: 'private-upstream-secret',
    })),
    privateConfiguration: 'private-upstream-secret',
  }
  const requests = []
  const port = await localController(t, (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const id = decodeURIComponent(url.pathname.slice('/proxies/'.length, -'/delay'.length))
    const index = profile.nodes.findIndex((node) => node.id === id)
    requests.push({ id, auth: request.headers.authorization, timeout: url.searchParams.get('timeout'), url: url.searchParams.get('url') })
    reply(response, { delay: delays[index], error: 'private-upstream-secret', server: 'private-upstream-secret' })
  })
  const results = await probeProfile(profile, port, 'probe-local-secret')
  assert.deepEqual(results, profile.nodes.map((node, index) => ({
    id: node.id,
    latencyMs: index === 0 ? 18 : index === 7 ? 6000 : null,
    reachable: index === 0 || index === 7,
  })))
  assert.equal(JSON.stringify(results).includes('private-upstream-secret'), false)
  assert.equal(requests.length, profile.nodes.length)
  for (const request of requests) {
    assert.equal(request.auth, 'Bearer probe-local-secret')
    assert.equal(request.timeout, '6000')
    assert.equal(request.url, 'https://www.gstatic.com/generate_204')
    assert.ok(profile.nodes.some((node) => node.id === request.id))
  }
})

test('probeProfile limits parallel probes, preserves order and reports failed nodes without raw errors', async (t) => {
  let active = 0
  let highestActive = 0
  const profile = { nodes: Array.from({ length: 7 }, (_, index) => ({ id: `node-${index}`, label: `线路 ${index + 1}` })) }
  const port = await localController(t, (request, response) => {
    const index = Number(new URL(request.url, 'http://127.0.0.1').pathname.match(/node-(\d+)/)[1])
    active += 1
    highestActive = Math.max(highestActive, active)
    setTimeout(() => {
      active -= 1
      if (index === 2) reply(response, { error: 'private-upstream-secret' }, 500)
      else reply(response, { delay: 20 + index })
    }, index % 2 ? 10 : 20)
  })
  const results = await probeProfile(profile, port, 'test-secret')
  assert.ok(highestActive > 1)
  assert.ok(highestActive <= 3)
  assert.deepEqual(results, profile.nodes.map((node, index) => ({
    id: node.id, latencyMs: index === 2 ? null : 20 + index, reachable: index !== 2,
  })))
  assert.equal(JSON.stringify(results).includes('private-upstream-secret'), false)
})
