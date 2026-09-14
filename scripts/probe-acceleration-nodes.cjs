// Operator-only diagnostic. Never import a customer's entire Clash configuration
// into the desktop runtime, and never print upstream credentials or core logs.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const http = require('node:http')
const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { setTimeout: delay } = require('node:timers/promises')

const PROBE_URL = 'https://www.gstatic.com/generate_204'
const MAX_RESPONSE_BYTES = 4096

function parseArguments(args) {
  const result = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!['--config', '--core', '--report'].includes(flag) || !value || value.startsWith('--') || result[flag]) {
      throw new Error('用法：node scripts/probe-acceleration-nodes.cjs --config <YAML绝对路径> --core <Mihomo绝对路径> [--report <脱敏报告绝对路径>]')
    }
    if (!path.isAbsolute(value)) throw new Error('配置、内核和报告必须使用绝对路径。')
    result[flag] = value
  }
  if (!result['--config'] || !result['--core']) throw new Error('必须指定 --config 和 --core。')
  if (result['--report'] && [result['--config'], result['--core']].some((input) => path.resolve(input).toLowerCase() === path.resolve(result['--report']).toLowerCase())) {
    throw new Error('报告不能覆盖输入文件。')
  }
  return result
}

async function reservePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法分配独立测试端口。')
  return { port: address.port, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) }
}

function requestController(port, secret, requestPath, timeoutMs = 8500) {
  // Fixed loopback origin, no proxy environment, redirects, arbitrary response
  // bodies or upstream messages. delay endpoints may return sensitive errors.
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('线路探测失败或超时。'))
    const request = http.get({
      hostname: '127.0.0.1', port, path: requestPath,
      headers: { Authorization: `Bearer ${secret}` }, agent: false,
    })
    const timer = setTimeout(() => request.destroy(new Error('timeout')), timeoutMs)
    request.once('error', fail)
    request.once('close', () => clearTimeout(timer))
    request.once('response', (response) => {
      let size = 0
      const chunks = []
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy()
          request.destroy(new Error('size'))
        } else chunks.push(chunk)
      })
      response.once('error', fail)
      response.once('end', () => {
        if (response.statusCode !== 200) {
          reject(Object.assign(new Error('线路探测失败或超时。'), { statusCode: response.statusCode }))
          return
        }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { fail() }
      })
    })
  })
}

function startCore(corePath, directory, configPath, env) {
  const child = spawn(corePath, ['-d', directory, '-f', configPath], {
    cwd: directory, env, shell: false, windowsHide: true, stdio: 'ignore',
  })
  let ended = false
  const closed = new Promise((resolve) => {
    child.on('error', () => {
      // Failed kill can also emit error; it does not prove a running process
      // exited. Only a failed spawn with no PID is safe to treat as absent.
      if (child.pid === undefined) { ended = true; resolve() }
    })
    child.once('close', () => { ended = true; resolve() })
  })
  return {
    ended: () => ended,
    async stop() {
      if (ended) return
      child.kill()
      await Promise.race([closed, delay(1500, undefined, { ref: false })])
      if (!ended) child.kill('SIGKILL')
      await Promise.race([closed, delay(3000, undefined, { ref: false })])
      if (!ended) throw new Error('测试内核退出尚未确认，请检查测试进程。')
    },
  }
}

async function waitForCore(core, port, secret) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    if (core.ended()) throw new Error('独立内核启动失败，现有 Clash 未改动。')
    try {
      const response = await requestController(port, secret, '/version', 600)
      if (typeof response.version === 'string') {
        try {
          await requestController(port, randomBytes(32).toString('hex'), '/version', 600)
        } catch (error) {
          // A no-auth controller ignores our random Bearer header; only a 401
          // for a different secret confirms this listener enforces ownership.
          if (error.statusCode === 401) return
        }
        throw new Error('控制端口身份验证失败。')
      }
    } catch { /* Wait only for this authenticated loopback endpoint. */ }
    await delay(150)
  }
  throw new Error('独立内核就绪超时，现有 Clash 未改动。')
}

async function probeProfile(profile, port, secret, isInterrupted = () => false) {
  const results = new Array(profile.nodes.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < profile.nodes.length && !isInterrupted()) {
      const index = nextIndex++
      const node = profile.nodes[index]
      let latencyMs = null
      try {
        const response = await requestController(port, secret,
          `/proxies/${encodeURIComponent(node.id)}/delay?timeout=6000&url=${encodeURIComponent(PROBE_URL)}`)
        if (Number.isSafeInteger(response.delay) && response.delay > 0 && response.delay <= 6000) latencyMs = response.delay
      } catch { /* Report failure without serializing raw core errors. */ }
      results[index] = { id: node.id, latencyMs, reachable: latencyMs !== null }
    }
  }
  await Promise.all([worker(), worker(), worker()])
  if (isInterrupted()) throw new Error('节点检查已中断。')
  return results
}

async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args)
  let configModule
  let safe
  let trustedCommandEnvironment
  try {
    configModule = require('../dist-electron/acceleration-clash-config.js')
    safe = require('../dist-electron/safe-local-data.js')
    trustedCommandEnvironment = require('../dist-electron/command-runner.js').trustedCommandEnvironment
  } catch {
    throw new Error('请先运行 node node_modules/typescript/bin/tsc -p tsconfig.electron.json。')
  }
  const source = await safe.readSafeUtf8File(options['--config'], '加速节点配置', 512 * 1024)
  if (!source) throw new Error('未找到节点配置。')
  if (!safe.assertSafeDataFile(options['--core'], '加速内核')) throw new Error('未找到加速内核。')
  const profile = configModule.parseClashAccelerationProfile(source)
  const environment = trustedCommandEnvironment()
  safe.assertNoReparseComponents(os.tmpdir(), '加速测试目录')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-acceleration-probe-'))
  safe.assertNoReparseComponents(directory, '加速测试目录')
  const identity = fs.lstatSync(directory)
  let core
  let controller
  let report
  let interrupted = false
  function interrupt() {
    interrupted = true
    // Keep Node alive for the finally cleanup, rather than letting the default
    // signal exit orphan the core. Every outstanding request has a deadline.
    void core?.stop().catch(() => undefined)
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  try {
    controller = await reservePort()
    const secret = randomBytes(32).toString('hex')
    const configPath = path.join(directory, 'config.yaml')
    const config = configModule.buildIsolatedMihomoConfig(profile, {
      mixedPort: 0, controllerPort: controller.port, controllerSecret: secret,
    })
    await safe.writeAtomicSafeUtf8File(configPath, config, '独立测试配置')
    if (interrupted) throw new Error('节点检查已中断。')
    // The delay API opens the selected outbound directly. No local traffic
    // listener is needed; even a brief diagnostic must not expose a free proxy.
    await controller.close()
    const controllerPort = controller.port
    controller = null
    core = startCore(options['--core'], directory, configPath, environment)
    await waitForCore(core, controllerPort, secret)
    const nodes = await probeProfile(profile, controllerPort, secret, () => interrupted)
    report = {
      checkedAt: new Date().toISOString(), probeUrl: PROBE_URL,
      sourceNodeCount: profile.sourceNodeCount, usableNodeCount: profile.nodes.length,
      unsupportedNodeCount: profile.unsupportedNodeCount,
      metadataNodeCount: profile.metadataNodeCount, duplicateNodeCount: profile.duplicateNodeCount,
      insecureTlsNodeCount: profile.insecureTlsNodeCount,
      reachableNodeCount: nodes.filter((node) => node.reachable).length,
      systemProxyChanged: false, tunEnabled: false, mixedListenerEnabled: false, nodes,
    }
  } finally {
    try {
      try { await controller?.close() } finally { await core?.stop() }
      // Never delete a live core's config: stop must be confirmed first.
      safe.assertNoReparseComponents(directory, '加速测试目录')
      const current = fs.lstatSync(directory)
      if (current.ino !== identity.ino || current.dev !== identity.dev
        || path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())
        || !path.basename(directory).startsWith('xingmang-acceleration-probe-')) {
        throw new Error('测试目录身份变化，拒绝清理。')
      }
      fs.rmSync(directory, { recursive: true })
    } finally {
      process.removeListener('SIGINT', interrupt)
      process.removeListener('SIGTERM', interrupt)
    }
  }
  if (options['--report']) {
    safe.ensureSafeDataDirectory(path.dirname(options['--report']), '加速测试报告')
    await safe.writeAtomicSafeUtf8File(options['--report'], `${JSON.stringify(report, null, 2)}\n`, '加速测试报告')
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return report
}

if (require.main === module) {
  main().catch(() => {
    // Even parser/fs/spawn errors may contain private file content or paths.
    process.stderr.write('加速节点检查未完成：请核对参数、编译产物、配置格式和内核路径。原 Clash 配置及系统代理未修改。\n')
    process.exitCode = 1
  })
}

module.exports = { parseArguments, requestController, probeProfile, startCore, main }
