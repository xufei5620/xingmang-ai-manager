// 临时（核完就删）：拿线上 0.2.22 Windows 安装包里装着的加速节点，在 Linux runner 上用产品自己的运行时代码和同版本的
// 官方 Linux 内核真连一次自建的洛杉矶线路，看线路还活不活、是不是只把 GPT 送去线路。不改系统代理，不打印节点密码。
// 用法：node scripts/tmp-acceleration-line-check.cjs <解开的安装包 resources 目录> <Linux 内核路径>
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const tls = require('node:tls')
const { createHash } = require('node:crypto')

const root = path.resolve(__dirname, '..')
const { parseClashAccelerationProfile } = require(path.join(root, 'dist-electron', 'acceleration-clash-config.js'))
const { createMihomoRuntime } = require(path.join(root, 'dist-electron', 'acceleration-mihomo-runtime.js'))

const LINE_SERVER = '179.255.133.164'
// 服务器出站有 IPv4 也有 IPv6：IPv6 落在它所在机房（DMIT，2605:52c0::/32）的段里，同样算走了线路。
const LINE_IPV6_PREFIX = '2605:52c0:'
const results = []
const exits = new Set()

function isLineExit(ip) {
  if (ip) exits.add(ip)
  return ip === LINE_SERVER || (typeof ip === 'string' && ip.toLowerCase().startsWith(LINE_IPV6_PREFIX))
}

function record(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

// GET through the local HTTP proxy listener exactly as a browser behind the system proxy would: CONNECT host:443, then TLS.
function getViaProxy(port, url, timeoutMs = 20_000) {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('timeout')) }, timeoutMs)
    let head = Buffer.alloc(0)
    socket.once('error', (error) => { clearTimeout(timer); reject(error) })
    socket.once('connect', () => socket.write(`CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\n\r\n`))
    function onHead(chunk) {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.off('data', onHead)
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString('latin1'))?.[1]
      if (status !== '200') { clearTimeout(timer); socket.destroy(); reject(new Error(`CONNECT ${status ?? '?'}`)); return }
      const secure = tls.connect({ socket, servername: target.hostname, ALPNProtocols: ['http/1.1'] })
      let body = Buffer.alloc(0)
      secure.once('error', (error) => { clearTimeout(timer); reject(error) })
      secure.once('secureConnect', () => secure.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.hostname}\r\n`
        + 'User-Agent: Mozilla/5.0 (xingmang line check)\r\nAccept: */*\r\nConnection: close\r\n\r\n'))
      secure.on('data', (data) => { if (body.length < 256 * 1024) body = Buffer.concat([body, data]) })
      secure.once('end', () => {
        clearTimeout(timer)
        const text = body.toString('utf8')
        resolve({ status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(text)?.[1] ?? 0), text })
      })
    }
    socket.on('data', onHead)
  })
}

function traceField(text, field) {
  return new RegExp(`^${field}=([^\\s]+)\\s*$`, 'm').exec(text)?.[1] ?? null
}

async function directIp() {
  const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(20_000) })
  return traceField(await response.text(), 'ip')
}

async function check(name, operation) {
  try {
    const detail = await operation()
    record(name, true, detail)
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error))
  }
}

function expectThat(condition, message) {
  if (!condition) throw new Error(message)
}

async function routedChecks(port, runnerIp) {
  await check('ChatGPT 走线路：chatgpt.com 看到的出口是洛杉矶服务器', async () => {
    const reply = await getViaProxy(port, 'https://chatgpt.com/cdn-cgi/trace')
    const ip = traceField(reply.text, 'ip')
    expectThat(isLineExit(ip), `出口 ${ip ?? '未知'}，HTTP ${reply.status}`)
    return `出口 ${ip}，地区 ${traceField(reply.text, 'loc') ?? '?'}，机房 ${traceField(reply.text, 'colo') ?? '?'}`
  })
  await check('ChatGPT 首页有响应（403 是 Cloudflare 人机页，算通）', async () => {
    const reply = await getViaProxy(port, 'https://chatgpt.com/')
    expectThat([200, 403].includes(reply.status), `HTTP ${reply.status}`)
    return `HTTP ${reply.status}`
  })
  await check('OpenAI API 未认证返回 401', async () => {
    const reply = await getViaProxy(port, 'https://api.openai.com/v1/models')
    expectThat(reply.status === 401, `HTTP ${reply.status}`)
    return 'HTTP 401'
  })
  await check('选线测速地址 www.gstatic.com/generate_204 返回 204', async () => {
    const reply = await getViaProxy(port, 'https://www.gstatic.com/generate_204')
    expectThat(reply.status === 204, `HTTP ${reply.status}`)
    return 'HTTP 204'
  })
  await check('Claude Desktop 下组件的 downloads.claude.ai 经线路有响应', async () => {
    const reply = await getViaProxy(port, 'https://downloads.claude.ai/')
    expectThat(reply.status > 0 && reply.status < 500, `HTTP ${reply.status}`)
    return `HTTP ${reply.status}`
  })
  await check('别的网站直连：www.cloudflare.com 看到的是这台机器自己的出口', async () => {
    const reply = await getViaProxy(port, 'https://www.cloudflare.com/cdn-cgi/trace')
    const ip = traceField(reply.text, 'ip')
    expectThat(ip && !isLineExit(ip) && (!runnerIp || ip === runnerIp), `出口 ${ip ?? '未知'}`)
    return '没走线路'
  })
  await check('8 个并发请求经线路都成功', async () => {
    const replies = await Promise.all(Array.from({ length: 8 }, () => getViaProxy(port, 'https://chatgpt.com/cdn-cgi/trace')))
    const good = replies.filter((reply) => isLineExit(traceField(reply.text, 'ip'))).length
    expectThat(good === 8, `${good}/8`)
    return '8/8'
  })
}

async function main() {
  const resourcesPath = path.resolve(process.argv[2] ?? '')
  const corePath = path.resolve(process.argv[3] ?? '')
  const directory = path.join(resourcesPath, 'acceleration')
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  const bytes = fs.readFileSync(path.join(directory, manifest.profileFile))
  const digest = createHash('sha256').update(bytes).digest('hex')
  record('安装包里的节点文件跟清单里的校验值一致', digest === manifest.profileSha256, digest.slice(0, 12))
  const profile = parseClashAccelerationProfile(bytes.toString('utf8'))
  const servers = profile.nodes.map((node) => `${node.connection.server}:${node.connection.port}`)
  record('安装包里只有洛杉矶这一条线路', servers.length === 1 && servers[0] === `${LINE_SERVER}:443`,
    profile.nodes.map((node) => `${node.label} ${node.connection.server}:${node.connection.port}`).join('，'))

  const runnerIp = await directIp().catch(() => null)
  const runtimeDirectory = path.join(process.env.RUNNER_TEMP ?? root, 'xm-accel-check')
  fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 })
  const coreSha256 = createHash('sha256').update(fs.readFileSync(corePath)).digest('hex')
  const runtime = createMihomoRuntime({ corePath, coreSha256, runtimeDirectory })

  const started = Date.now()
  let session = null
  await check('连接：自动选线并通过连通验证', async () => {
    session = await runtime.start(profile)
    return `${session.line.name}，测速 ${session.line.latencyMs} ms，用时 ${Date.now() - started} ms`
  })
  if (session) {
    await routedChecks(session.proxyPort, runnerIp)
    await check('断开：内核停掉', async () => {
      await runtime.stop()
      expectThat(!runtime.isRunning(), '内核还在跑')
      return '已断开'
    })
  }

  console.log(`线路出口：${[...exits].filter((ip) => isLineExit(ip)).join('、') || '无'}`)
  const failed = results.filter((result) => !result.ok)
  const summary = [`### 洛杉矶线路：${results.length - failed.length}/${results.length} 通过`, '',
    '| 结果 | 项目 | 说明 |', '|---|---|---|',
    ...results.map((result) => `| ${result.ok ? '✅' : '❌'} | ${result.name} | ${result.detail ?? ''} |`), '']
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n'))
  process.exitCode = failed.length ? 1 : 0
}

main().catch((error) => {
  console.error(`检查没跑完：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
