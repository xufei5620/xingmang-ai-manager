// 临时验收（核完就删）：拿测试包里装着的加速内核和节点，用产品自己的运行时代码真连一次自建的洛杉矶线路，
// 看连接、只把 GPT 送去线路、断开、重连、内核被杀后再连是不是都对。不改系统代理，不打印节点密码。
// 用法：node scripts/tmp-acceleration-line-acceptance.cjs <解开的安装包 resources 目录>
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const tls = require('node:tls')
const { execFileSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const { readBundledAccelerationConfig } = require(path.join(root, 'dist-electron', 'acceleration-bundled-config.js'))
const { readAccelerationWorkerProfile } = require(path.join(root, 'dist-electron', 'acceleration-worker-profile.js'))
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
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
        + 'User-Agent: Mozilla/5.0 (xingmang acceptance)\r\nAccept: */*\r\nConnection: close\r\n\r\n'))
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

function traceIp(text) {
  return /^ip=([0-9a-f.:]+)\s*$/m.exec(text)?.[1] ?? null
}

async function directIp() {
  const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(20_000) })
  return traceIp(await response.text())
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

function killCore() {
  if (process.platform === 'win32') execFileSync('taskkill', ['/F', '/IM', 'mihomo.exe'], { stdio: 'ignore' })
  else execFileSync('pkill', ['-9', '-x', 'mihomo'], { stdio: 'ignore' })
}

async function routedChecks(port, runnerIp) {
  await check('ChatGPT 走线路：chatgpt.com 看到的出口是洛杉矶服务器', async () => {
    const reply = await getViaProxy(port, 'https://chatgpt.com/cdn-cgi/trace')
    expectThat(isLineExit(traceIp(reply.text)), `出口 ${traceIp(reply.text) ?? '未知'}，HTTP ${reply.status}`)
    return `出口 ${traceIp(reply.text)}`
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
  await check('别的网站直连：www.cloudflare.com 看到的是这台机器自己的出口', async () => {
    const reply = await getViaProxy(port, 'https://www.cloudflare.com/cdn-cgi/trace')
    const ip = traceIp(reply.text)
    expectThat(ip && !isLineExit(ip) && (!runnerIp || ip === runnerIp), `出口 ${ip ?? '未知'}`)
    return '没走线路'
  })
  await check('别的网站照常打得开：www.google.com、example.com', async () => {
    const google = await getViaProxy(port, 'https://www.google.com/')
    const example = await getViaProxy(port, 'https://example.com/')
    expectThat(google.status > 0 && google.status < 500 && example.status === 200, `Google ${google.status}，example ${example.status}`)
    return `Google ${google.status}，example ${example.status}`
  })
  await check('8 个并发请求经线路都成功', async () => {
    const replies = await Promise.all(Array.from({ length: 8 }, () => getViaProxy(port, 'https://chatgpt.com/cdn-cgi/trace')))
    const good = replies.filter((reply) => isLineExit(traceIp(reply.text))).length
    expectThat(good === 8, `${good}/8`)
    return '8/8'
  })
}

async function portClosed(port) {
  try { await getViaProxy(port, 'https://chatgpt.com/cdn-cgi/trace', 5_000); return false } catch { return true }
}

async function main() {
  const resourcesPath = path.resolve(process.argv[2] ?? '')
  const manifest = JSON.parse(fs.readFileSync(path.join(resourcesPath, 'acceleration', 'manifest.json'), 'utf8'))
  const config = await readBundledAccelerationConfig({
    isPackaged: true, platform: process.platform, architecture: process.arch, resourcesPath, bundledMetadata: manifest,
  })
  // 打包时节点会被改名成「美国线路 1」这类（stage-acceleration-bundle），文件摘要跟仓库里的不同，所以看内容。
  const profile = await readAccelerationWorkerProfile(config)
  const servers = profile.nodes.map((node) => `${node.connection.server}:${node.connection.port}`)
  record('安装包里只有洛杉矶这一条线路', servers.length === 1 && servers[0] === `${LINE_SERVER}:443`,
    profile.nodes.map((node) => `${node.label} ${node.connection.server}:${node.connection.port}`).join('，'))

  const runnerIp = await directIp().catch(() => null)
  const runtimeDirectory = path.join(process.env.RUNNER_TEMP ?? root, 'xm-accel-acceptance')
  fs.mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 })
  let unexpectedExits = 0
  const runtime = createMihomoRuntime({
    corePath: config.corePath, coreSha256: config.coreSha256, runtimeDirectory,
    onUnexpectedExit: () => { unexpectedExits += 1 },
  })

  let started = Date.now()
  let session = null
  await check('连接：自动选线并通过连通验证', async () => {
    session = await runtime.start(profile)
    return `${session.line.name}，测速 ${session.line.latencyMs} ms，用时 ${Date.now() - started} ms`
  })
  if (session) {
    await routedChecks(session.proxyPort, runnerIp)
    const firstPort = session.proxyPort
    await check('断开：内核停掉、本机端口关闭', async () => {
      await runtime.stop()
      expectThat(!runtime.isRunning(), '内核还在跑')
      expectThat(await portClosed(firstPort), '端口还开着')
      return '已断开'
    })

    started = Date.now()
    await check('重连：再连一次照样通', async () => {
      const again = await runtime.start(profile)
      const reply = await getViaProxy(again.proxyPort, 'https://chatgpt.com/cdn-cgi/trace')
      expectThat(isLineExit(traceIp(reply.text)), `出口 ${traceIp(reply.text) ?? '未知'}`)
      return `用时 ${Date.now() - started} ms`
    })

    await check('内核被意外杀掉：运行时察觉到并收尾', async () => {
      killCore()
      for (let waited = 0; waited < 10_000 && (unexpectedExits === 0 || runtime.isRunning()); waited += 250) await delay(250)
      expectThat(unexpectedExits === 1 && !runtime.isRunning(), `意外退出 ${unexpectedExits} 次，还在跑：${runtime.isRunning()}`)
      return '已察觉'
    })

    started = Date.now()
    await check('被杀以后再连：照样通', async () => {
      const again = await runtime.start(profile)
      const reply = await getViaProxy(again.proxyPort, 'https://chatgpt.com/cdn-cgi/trace')
      expectThat(isLineExit(traceIp(reply.text)), `出口 ${traceIp(reply.text) ?? '未知'}`)
      return `用时 ${Date.now() - started} ms`
    })
    await runtime.stop().catch(() => undefined)
  }

  console.log(`线路出口：${[...exits].filter((ip) => isLineExit(ip)).join('、')}`)
  const failed = results.filter((result) => !result.ok)
  const summary = [`### ${process.platform} ${process.arch}：${results.length - failed.length}/${results.length} 通过`, '',
    '| 结果 | 项目 | 说明 |', '|---|---|---|',
    ...results.map((result) => `| ${result.ok ? '✅' : '❌'} | ${result.name} | ${result.detail ?? ''} |`), '']
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n'))
  process.exitCode = failed.length ? 1 : 0
}

main().catch((error) => {
  console.error(`验收没跑完：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
