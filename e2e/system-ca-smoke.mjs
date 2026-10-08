// xm 三线路的工具同路径探测（electron/tool-path-probe.ts）在主进程里用 tls.getCACertificates('system')
// 把系统根证书也加进信任列表：只靠系统根证书才握手成功的，判成「安全软件接管」照样算通。这个接口
// Linux 上实测过；Windows 读证书库、macOS 读钥匙串是另外两套平台代码，只有这里能演。
//
// 做法：现场生成一张一次性的测试根证书和它签的 localhost 证书，把根装进跑道机器的系统证书库（只动
// CI 机器），起一个本机 HTTPS 服务，再让 Electron 主进程去连：只信 Node 自带根证书必须失败，加上
// 系统根证书必须成功。探测模块是在 worker 线程里读系统根证书的（同步调用会卡主进程），这里也照样
// 在主进程起一个 worker 读一遍，必须读到同一张根；顺带打出同步调用花了多久，留个数。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { X509Certificate, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32' && process.platform !== 'darwin') {
  console.log('SKIP: system root certificate smoke only runs on Windows and macOS')
  process.exit(0)
}

const require = createRequire(import.meta.url)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = require(path.join(repo, 'node_modules/electron'))
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xm-system-ca-smoke-')))
const commonName = `Xingmang CI Throwaway Root ${randomBytes(6).toString('hex')}`

// Every external command is bounded: a keychain or certificate-store call that waits for an
// authorization dialog nobody can answer must fail the step, not hang it.
function run(command, args) {
  return execFileSync(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30_000 })
}

function writeConfig(name, subject, extensions) {
  fs.writeFileSync(path.join(root, name), [
    '[req]', 'distinguished_name = dn', 'prompt = no', '',
    '[dn]', `CN = ${subject}`, '',
    '[ext]', ...extensions, '',
  ].join('\n'))
}

function createCertificates() {
  writeConfig('root.cnf', commonName, [
    'basicConstraints = critical,CA:TRUE',
    'keyUsage = critical,keyCertSign,cRLSign',
    'subjectKeyIdentifier = hash',
  ])
  writeConfig('leaf.cnf', 'localhost', [
    'basicConstraints = critical,CA:FALSE',
    'keyUsage = critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage = serverAuth',
    'subjectAltName = DNS:localhost,IP:127.0.0.1',
  ])
  run('openssl', ['req', '-x509', '-new', '-nodes', '-newkey', 'rsa:2048', '-sha256', '-days', '2',
    '-keyout', 'root.key', '-out', 'root.pem', '-config', 'root.cnf', '-extensions', 'ext'])
  run('openssl', ['req', '-new', '-nodes', '-newkey', 'rsa:2048', '-sha256',
    '-keyout', 'leaf.key', '-out', 'leaf.csr', '-config', 'leaf.cnf'])
  run('openssl', ['x509', '-req', '-in', 'leaf.csr', '-CA', 'root.pem', '-CAkey', 'root.key',
    '-set_serial', `0x${randomBytes(8).toString('hex')}`, '-sha256', '-days', '2',
    '-extfile', 'leaf.cnf', '-extensions', 'ext', '-out', 'leaf.pem'])
  return new X509Certificate(fs.readFileSync(path.join(root, 'root.pem')))
}

function installRoot() {
  const file = path.join(root, 'root.pem')
  if (process.platform === 'win32') run('certutil', ['-addstore', '-f', 'Root', file])
  else run('sudo', ['security', 'add-trusted-cert', '-d', '-r', 'trustRoot', '-k', '/Library/Keychains/System.keychain', file])
}

function removeRoot(certificate) {
  try {
    if (process.platform === 'win32') {
      run('certutil', ['-delstore', 'Root', certificate.serialNumber])
    } else {
      // `security remove-trusted-cert` waits for an authorization dialog even under sudo and hung
      // the runner; deleting the certificate from the keychain is enough on a throwaway machine.
      run('sudo', ['security', 'delete-certificate', '-Z', certificate.fingerprint.replaceAll(':', ''), '/Library/Keychains/System.keychain'])
    }
  } catch (error) {
    console.warn(`could not remove the throwaway root: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function startServer() {
  const server = https.createServer({
    key: fs.readFileSync(path.join(root, 'leaf.key')),
    cert: fs.readFileSync(path.join(root, 'leaf.pem')),
  }, (request, response) => {
    response.writeHead(request.url === '/api/status' ? 200 : 404, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ success: request.url === '/api/status' }))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

const mainScript = `
const { app } = require('electron')
const https = require('node:https')
const tls = require('node:tls')
const { X509Certificate } = require('node:crypto')
const { Worker } = require('node:worker_threads')
const port = Number(process.argv.find((value) => value.startsWith('--xm-port=')).split('=')[1])
const fingerprint = process.argv.find((value) => value.startsWith('--xm-root=')).split('=')[1]

function connect(ca) {
  return new Promise((resolve) => {
    const request = https.request({
      host: '127.0.0.1', port, path: '/api/status', method: 'GET', servername: 'localhost', ca, agent: false, timeout: 10000,
    }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => resolve({ ok: response.statusCode === 200 && JSON.parse(body).success === true }))
    })
    request.on('timeout', () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
    request.on('error', (error) => resolve({ ok: false, code: error.code || error.name }))
    request.end()
  })
}

function readInWorker() {
  return new Promise((resolve, reject) => {
    const worker = new Worker(\`
const { parentPort } = require('node:worker_threads')
const tls = require('node:tls')
parentPort.postMessage(tls.getCACertificates('system'))
\`, { eval: true })
    worker.once('message', (value) => { resolve(value); void worker.terminate() })
    worker.once('error', reject)
  })
}

function fingerprintsOf(list) {
  const fingerprints = new Set()
  for (const pem of list) {
    try { fingerprints.add(new X509Certificate(pem).fingerprint256) } catch {}
  }
  return fingerprints
}

app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const available = typeof tls.getCACertificates === 'function'
  const started = performance.now()
  const system = available ? tls.getCACertificates('system') : []
  const firstCallMs = performance.now() - started
  const fromWorker = available ? await readInWorker() : []
  const result = {
    processType: process.type,
    node: process.versions.node,
    available,
    systemCount: system.length,
    firstCallMs: Math.round(firstCallMs * 10) / 10,
    rootInSystem: fingerprintsOf(system).has(fingerprint),
    workerCount: fromWorker.length,
    rootInWorker: fingerprintsOf(fromWorker).has(fingerprint),
    bundledOnly: await connect(tls.rootCertificates),
    withSystem: await connect([...tls.rootCertificates, ...system]),
  }
  process.send(result, () => app.quit())
})
`

function launchElectron(port, certificate) {
  const application = path.join(root, 'application')
  fs.mkdirSync(application, { recursive: true })
  fs.writeFileSync(path.join(application, 'package.json'), JSON.stringify({ name: 'xm-system-ca-smoke', version: '1.0.0', main: 'main.js' }))
  fs.writeFileSync(path.join(application, 'main.js'), mainScript)
  return new Promise((resolve, reject) => {
    const environment = { ...process.env }
    for (const key of Object.keys(environment)) {
      if (['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS'].includes(key.toUpperCase())) delete environment[key]
    }
    const child = spawn(electron, [application, `--xm-port=${port}`, `--xm-root=${certificate.fingerprint256}`, `--user-data-dir=${path.join(root, 'user-data')}`], {
      windowsHide: true, stdio: ['ignore', 'inherit', 'pipe', 'ipc'], env: environment,
    })
    let result
    let stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Electron did not report within 60 seconds')) }, 60_000)
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('message', (message) => { result = message })
    child.once('error', reject)
    child.once('close', (code) => {
      clearTimeout(timer)
      if (!result) reject(new Error(`Electron exited with ${code} without a result: ${stderr}`))
      else resolve(result)
    })
  })
}

const certificate = createCertificates()
let installed = false
let server
try {
  installRoot()
  installed = true
  server = await startServer()
  const result = await launchElectron(server.address().port, certificate)
  console.log(JSON.stringify({ platform: process.platform, ...result }))
  assert.equal(result.processType, 'browser', 'the probe must run in the Electron main process')
  assert.equal(result.available, true, 'tls.getCACertificates is missing from this Electron build')
  assert.equal(result.rootInSystem, true, "the throwaway root is not in tls.getCACertificates('system')")
  assert.equal(result.rootInWorker, true, 'a worker thread in the main process must read the same system roots')
  assert.equal(result.bundledOnly.ok, false, 'the handshake must fail with only the bundled roots')
  assert.equal(result.withSystem.ok, true, `the handshake must pass once the system roots are trusted (${result.withSystem.code ?? 'no code'})`)
  console.log(`tls.getCACertificates('system') took ${result.firstCallMs} ms synchronously on ${process.platform}`)
  console.log('PASS: Electron main process trusts system root certificates')
} finally {
  server?.closeAllConnections()
  server?.close()
  if (installed) removeRoot(certificate)
  fs.rmSync(root, { recursive: true, force: true })
}
process.exit(0)
