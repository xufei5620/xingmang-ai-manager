const assert = require('node:assert/strict')
const http = require('node:http')
const { mkdtemp, writeFile, rm } = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const test = require('node:test')

const serverPath = path.resolve(__dirname, '..', 'bundled-skills', 'xingmang-ai', 'scripts', 'mcp-server.mjs')
const fixture = Buffer.from('fixture-image').toString('base64')

function readLine(child) {
  return new Promise((resolve, reject) => {
    let pending = ''
    const onData = (chunk) => {
      pending += chunk.toString('utf8')
      const index = pending.indexOf('\n')
      if (index < 0) return
      child.stdout.off('data', onData)
      try { resolve(JSON.parse(pending.slice(0, index))) } catch (error) { reject(error) }
    }
    child.stdout.on('data', onData)
    child.once('error', reject)
  })
}

test('MCP server exposes image tool and returns MCP image content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xingmang-image-mcp-'))
  const configPath = path.join(root, 'config.json')
  let received = null
  const httpServer = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ b64_json: fixture }] }))
    })
  })
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const port = httpServer.address().port
  await writeFile(configPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-test-not-real' }))
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      XINGMANG_IMAGE_CONFIG_PATH: configPath,
      XINGMANG_IMAGE_MCP_ALLOW_INSECURE_LOCAL: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n')
    const initialized = await readLine(child)
    assert.equal(initialized.result.serverInfo.name, 'xingmang-image')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n')
    const listed = await readLine(child)
    assert.equal(listed.result.tools[0].name, 'generate_image')
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'generate_image', arguments: { prompt: 'a blue mug', model: 'gpt-image-2.5-flare' } },
    }) + '\n')
    const generated = await readLine(child)
    assert.equal(generated.result.content[0].type, 'image')
    assert.equal(generated.result.content[0].data, fixture)
    assert.equal(received.model, 'gpt-image-2.5-flare')
    assert.equal(received.n, 1)
  } finally {
    child.kill()
    await new Promise(resolve => child.once('close', resolve))
    await new Promise(resolve => httpServer.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
