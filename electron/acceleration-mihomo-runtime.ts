import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { trustedCommandEnvironment } from './command-runner'
import { copyBoundedFileExclusive, readBoundedFile } from './bounded-file'
import { readDirectoryEntries } from './bounded-directory'
import { assertNoReparseComponents, assertSafeDataFile, ensureSafeDataDirectory, removeSafeDataFile, writeAtomicSafeUtf8File } from './safe-local-data'
import { buildIsolatedMihomoConfig, type AccelerationClashProfile } from './acceleration-clash-config'
import type { AccelerationLine } from './acceleration-contract'
import { assertMacosAccelerationBinary } from './acceleration-binary'

const PROBE_HOST = 'www.gstatic.com'
const PROBE_URL = `https://${PROBE_HOST}/generate_204`
const MAX_CORE_BYTES = 100 * 1024 * 1024
const MAX_CONTROLLER_BYTES = 64 * 1024
const MAX_RUNTIME_ENTRIES = 4096
const SESSION_DIRECTORY_PATTERN = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SESSION_FILE_NAMES = ['config.yaml', 'mihomo', 'mihomo.exe', 'cache.db', 'cache.db-shm', 'cache.db-wal']

// Session directories created by this process. A sweep of leftovers must never
// touch a session another runtime instance in this process still owns.
const liveSessionDirectories = new Set<string>()

export interface MihomoRuntimeResult {
  line: AccelerationLine
  proxyPort: number
}

export interface MihomoRuntime {
  start(profile: AccelerationClashProfile, lineId?: string): Promise<MihomoRuntimeResult>
  stop(): Promise<void>
  isRunning(): boolean
}

export interface MihomoRuntimeOptions {
  corePath: string
  coreSha256: string
  /** Caller must provide a private user-data directory, never the source Clash directory. */
  runtimeDirectory: string
  onUnexpectedExit?: () => void | Promise<void>
}

interface RuntimeSession {
  directory: string
  directoryCreated: boolean
  configPath: string
  executablePath: string
  controllerPort: number
  controllerSecret: string
  proxyPort: number
  abort: AbortController
  child: ChildProcess | null
  exited: boolean
  exitPromise: Promise<void>
  resolveExit: () => void
  stopping: boolean
  result: MihomoRuntimeResult | null
}

interface ControllerReply {
  status: number
  body: string
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal)
}

function abortError(signal: AbortSignal): Error {
  return new Error(signal.reason instanceof Error && signal.reason.message === '加速内核意外退出' ? '加速内核意外退出' : '加速连接已取消')
}

function waitDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal))
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    function abort(): void {
      clearTimeout(timer)
      reject(abortError(signal))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

interface LoopbackPortReservation {
  proxyPort: number
  controllerPort: number
  /** Idempotent, so the start path can release before spawning and again while unwinding. */
  release(): Promise<void>
}

/**
 * Keep both listeners bound until the core is about to take them over. Closing
 * them at allocation time left the numbers free for the whole core copy and
 * hash verification, so any local process could have taken the proxy port in
 * that multi-second window. Holding them narrows the exposure to the spawn
 * itself, and `confirmCorePorts` afterwards has the authenticated controller
 * state which ports the core is actually running on.
 */
async function reserveLoopbackPorts(): Promise<LoopbackPortReservation> {
  const servers = [net.createServer(), net.createServer()]
  async function release(): Promise<void> {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
      if (!server.listening) return resolve()
      server.close(() => resolve())
    })))
  }
  try {
    const ports: number[] = []
    for (const server of servers) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('无法分配加速内核本地端口')
      ports.push(address.port)
    }
    return { proxyPort: ports[0], controllerPort: ports[1], release }
  } catch {
    await release()
    throw new Error('无法分配加速内核本地端口')
  }
}

function coreEnvironment(): NodeJS.ProcessEnv {
  const env = trustedCommandEnvironment()
  for (const key of Object.keys(env)) {
    if (/^(?:https?_proxy|all_proxy|no_proxy|clash_.*|mihomo_.*|sslkeylogfile|godebug)$/i.test(key)) delete env[key]
  }
  return env
}

function controllerRequest(
  session: RuntimeSession,
  method: 'GET' | 'PUT',
  route: string,
  body?: string,
  secret = session.controllerSecret,
  timeoutMs = 8000,
): Promise<ControllerReply> {
  return new Promise((resolve, reject) => {
    let settled = false
    let received = 0
    const chunks: Buffer[] = []
    const request = http.request({
      host: '127.0.0.1', port: session.controllerPort, method, path: route,
      agent: false, signal: session.abort.signal,
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }),
      },
    })
    const timer = setTimeout(() => fail(), timeoutMs)
    function fail(): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.destroy()
      reject(session.abort.signal.aborted ? abortError(session.abort.signal) : new Error('加速内核控制请求失败'))
    }
    request.once('error', fail)
    request.once('response', (response) => {
      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > MAX_CONTROLLER_BYTES) {
          response.destroy()
          fail()
        } else chunks.push(chunk)
      })
      response.once('aborted', fail)
      response.once('error', fail)
      response.once('end', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    request.end(body)
  })
}

function parseControllerObject(reply: ControllerReply): Record<string, unknown> {
  if (reply.status !== 200) throw new Error('加速内核控制请求失败')
  try {
    const value: unknown = JSON.parse(reply.body)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid')
    return value as Record<string, unknown>
  } catch {
    throw new Error('加速内核返回了无效状态')
  }
}

async function awaitController(session: RuntimeSession): Promise<void> {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    assertNotAborted(session.abort.signal)
    if (session.exited) throw new Error('加速内核启动失败')
    try {
      const version = parseControllerObject(await controllerRequest(session, 'GET', '/version', undefined, undefined, 1000))
      if (typeof version.version !== 'string' || !version.version) throw new Error('invalid')
      const unauthorized = await controllerRequest(session, 'GET', '/version', undefined, randomBytes(32).toString('hex'), 1000)
      if (unauthorized.status !== 401) throw new Error('加速内核控制接口未启用身份验证')
      return
    } catch (error) {
      if (error instanceof Error && error.message === '加速内核控制接口未启用身份验证') throw error
      await waitDelay(100, session.abort.signal)
    }
  }
  throw new Error('加速内核未能及时启动')
}

/**
 * The reserved numbers only describe what the core was asked to serve. Ask the
 * authenticated controller which ports it is running on before any traffic is
 * routed, so a core that started with a stale or rewritten configuration is
 * never mistaken for the listener we are about to trust. A same-uid process
 * that really forwards traffic stays outside the threat model (see T5).
 */
async function confirmCorePorts(session: RuntimeSession): Promise<void> {
  const configs = parseControllerObject(await controllerRequest(session, 'GET', '/configs'))
  if (configs['mixed-port'] !== session.proxyPort) throw new Error('加速内核端口校验失败')
}

function safeLine(node: AccelerationClashProfile['nodes'][number], index: number): AccelerationLine {
  const regions: Record<string, string> = {
    HK: '香港', TW: '台湾', JP: '日本', SG: '新加坡', US: '美国', KR: '韩国', GB: '英国',
    DE: '德国', CA: '加拿大', AU: '澳大利亚', NL: '荷兰', FR: '法国', IN: '印度', MY: '马来西亚', TH: '泰国',
  }
  const region = Object.hasOwn(regions, node.region) ? node.region : 'GLOBAL'
  return { id: node.id, name: `${regions[region] ?? '全球'}线路 ${index + 1}`, region, latencyMs: null }
}

/** Return display-only line metadata. Node credentials remain in the profile. */
export function accelerationLinesFromProfile(profile: AccelerationClashProfile): AccelerationLine[] {
  return profile.nodes.map(safeLine)
}

async function selectAvailableLine(session: RuntimeSession, lines: AccelerationLine[], preferredId?: string): Promise<AccelerationLine> {
  if (preferredId) {
    const preferred = lines.find((line) => line.id === preferredId)
    if (!preferred) throw new Error('加速线路不存在')
    const query = new URLSearchParams({ url: PROBE_URL, timeout: '6000' })
    const reply = parseControllerObject(await controllerRequest(session, 'GET', `/proxies/${encodeURIComponent(preferred.id)}/delay?${query}`))
    if (typeof reply.delay !== 'number' || !Number.isSafeInteger(reply.delay) || reply.delay < 0 || reply.delay > 6000) {
      throw new Error('所选加速线路不可用')
    }
    const updated = { ...preferred, latencyMs: reply.delay }
    const switched = await controllerRequest(session, 'PUT', '/proxies/XINGMANG', JSON.stringify({ name: preferred.id }))
    if (switched.status !== 204) throw new Error('加速线路切换失败')
    return updated
  }
  let nextIndex = 0
  const candidates: AccelerationLine[] = []
  async function worker(): Promise<void> {
    while (nextIndex < lines.length) {
      assertNotAborted(session.abort.signal)
      const line = lines[nextIndex++]
      try {
        const query = new URLSearchParams({ url: PROBE_URL, timeout: '6000' })
        const reply = parseControllerObject(await controllerRequest(session, 'GET', `/proxies/${encodeURIComponent(line.id)}/delay?${query}`))
        if (typeof reply.delay === 'number' && Number.isSafeInteger(reply.delay) && reply.delay >= 0 && reply.delay <= 6000) {
          candidates.push({ ...line, latencyMs: reply.delay })
        }
      } catch {
        assertNotAborted(session.abort.signal)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, lines.length) }, () => worker()))
  candidates.sort((left, right) => (left.latencyMs ?? Infinity) - (right.latencyMs ?? Infinity) || left.id.localeCompare(right.id))
  const selected = candidates[0]
  if (!selected) throw new Error('暂无可用加速线路，请检查节点连接')
  const updated = await controllerRequest(session, 'PUT', '/proxies/XINGMANG', JSON.stringify({ name: selected.id }))
  if (updated.status !== 204) throw new Error('加速线路切换失败')
  const confirmed = parseControllerObject(await controllerRequest(session, 'GET', '/proxies/XINGMANG'))
  if (confirmed.now !== selected.id) throw new Error('加速线路切换未确认')
  return selected
}

/** Verify an actual CONNECT + authenticated TLS request through the local proxy listener. */
function probeProxy(session: RuntimeSession): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let proxySocket: net.Socket | null = null
    let secureSocket: tls.TLSSocket | null = null
    let received = Buffer.alloc(0)
    const request = http.request({
      host: '127.0.0.1', port: session.proxyPort, method: 'CONNECT', path: `${PROBE_HOST}:443`,
      headers: { Host: `${PROBE_HOST}:443` }, agent: false,
    })
    const timer = setTimeout(() => finish(false), 12_000)
    function finish(success: boolean): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      session.abort.signal.removeEventListener('abort', abort)
      secureSocket?.destroy()
      proxySocket?.destroy()
      request.destroy()
      if (success) resolve()
      else reject(session.abort.signal.aborted ? abortError(session.abort.signal) : new Error('加速代理连通性验证失败'))
    }
    function abort(): void { finish(false) }
    if (session.abort.signal.aborted) return finish(false)
    session.abort.signal.addEventListener('abort', abort, { once: true })
    request.once('error', () => finish(false))
    request.once('connect', (response, socket, head) => {
      proxySocket = socket
      socket.once('error', () => finish(false))
      if (settled || response.statusCode !== 200 || head.length !== 0) return finish(false)
      secureSocket = tls.connect({ socket, servername: PROBE_HOST, rejectUnauthorized: true, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] })
      secureSocket.once('error', () => finish(false))
      secureSocket.once('end', () => finish(false))
      secureSocket.once('secureConnect', () => {
        secureSocket?.write(`GET /generate_204 HTTP/1.1\r\nHost: ${PROBE_HOST}\r\nConnection: close\r\n\r\n`)
      })
      secureSocket.on('data', (chunk: Buffer) => {
        if (settled) return
        if (received.length + chunk.length > 4096) return finish(false)
        received = Buffer.concat([received, chunk])
        if (received.includes('\r\n\r\n')) finish(/^HTTP\/1\.[01] 204(?: |\r\n)/.test(received.toString('latin1')))
      })
    })
    request.end()
  })
}

async function removeSessionDirectory(directory: string): Promise<void> {
  assertNoReparseComponents(directory, '加速运行目录')
  for (const name of SESSION_FILE_NAMES) {
    await removeSafeDataFile(path.join(directory, name), '加速运行文件')
  }
  try {
    await fs.promises.rmdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('加速运行文件清理失败')
  }
}

async function cleanupSessionFiles(session: RuntimeSession): Promise<void> {
  // Stay registered while the core is alive: only a confirmed exit makes the
  // directory a leftover that a later sweep is allowed to remove.
  if (!session.exited) throw new Error('加速内核仍在运行，不能清理连接配置')
  try {
    if (session.directoryCreated) await removeSessionDirectory(session.directory)
  } finally {
    liveSessionDirectories.delete(session.directory)
  }
}

/**
 * A session directory holds the node password in cleartext next to a private
 * core copy, and only the stop path used to remove it. A SIGKILL, a power loss
 * or a stop that timed out therefore left both behind for good, so every start
 * sweeps what earlier runs abandoned. A directory that cannot be removed - a
 * Windows core outliving its parent still holds its own image open - is left
 * for a later attempt instead of failing the start. Recursive removal stays out
 * of this: each file goes through the same reparse and single-link checks the
 * stop path uses. A runtime directory holding more than MAX_RUNTIME_ENTRIES
 * entries is left untouched - the sweep runs on every start, so a genuine
 * backlog never reaches that, and refusing to enumerate an unexpectedly large
 * directory beats deleting inside it blindly.
 */
async function purgeStaleSessionDirectories(runtimeDirectory: string): Promise<number> {
  let entries: fs.Dirent[]
  try {
    entries = await readDirectoryEntries(runtimeDirectory, MAX_RUNTIME_ENTRIES, '加速运行目录')
  } catch {
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SESSION_DIRECTORY_PATTERN.test(entry.name)) continue
    const directory = path.join(runtimeDirectory, entry.name)
    if (liveSessionDirectories.has(directory)) continue
    try {
      await removeSessionDirectory(directory)
      removed += 1
    } catch {
      // Intentionally silent: a leftover we cannot remove must not block acceleration.
    }
  }
  return removed
}

async function waitForExit(session: RuntimeSession, timeoutMs: number): Promise<boolean> {
  if (session.exited) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([session.exitPromise, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs) })])
    return session.exited
  } finally {
    clearTimeout(timer)
  }
}

async function stopSession(session: RuntimeSession): Promise<void> {
  session.stopping = true
  session.abort.abort()
  if (session.child && !session.exited) {
    try { session.child.kill('SIGTERM') } catch { /* Exit confirmation remains authoritative. */ }
    if (!await waitForExit(session, 4000)) {
      try { session.child.kill('SIGKILL') } catch { /* Keep live-process configuration for a later stop retry. */ }
      if (!await waitForExit(session, 2000)) {
        session.stopping = false
        throw new Error('加速内核仍在运行，请重试停止加速')
      }
    }
  }
  await cleanupSessionFiles(session)
}

export function createMihomoRuntime(options: MihomoRuntimeOptions): MihomoRuntime {
  if (!path.isAbsolute(options.corePath) || !path.isAbsolute(options.runtimeDirectory) || !/^[a-f0-9]{64}$/i.test(options.coreSha256)) {
    throw new Error('加速内核路径或校验值无效')
  }
  let current: RuntimeSession | null = null
  let serial = Promise.resolve()
  let startPromise: Promise<MihomoRuntimeResult> | null = null
  let startingAbort: AbortController | null = null

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = serial.then(operation)
    serial = result.then(() => undefined, () => undefined)
    return result
  }

  async function startInner(profile: AccelerationClashProfile, abort: AbortController, preferredId?: string): Promise<MihomoRuntimeResult> {
    assertNotAborted(abort.signal)
    if (current?.result && !current.exited && !current.abort.signal.aborted) return { ...current.result, line: { ...current.result.line } }
    if (current) {
      await stopSession(current)
      current = null
    }
    await purgeStaleSessionDirectories(options.runtimeDirectory)
    const reservation = await reserveLoopbackPorts()
    const directory = path.join(options.runtimeDirectory, `session-${randomUUID()}`)
    const controllerSecret = randomBytes(32).toString('hex')
    const lines = accelerationLinesFromProfile(profile)
    let resolveExit: () => void = () => undefined
    const exitPromise = new Promise<void>((resolve) => { resolveExit = resolve })
    const session: RuntimeSession = {
      directory, directoryCreated: false, configPath: path.join(directory, 'config.yaml'),
      executablePath: path.join(directory, process.platform === 'win32' ? 'mihomo.exe' : 'mihomo'),
      proxyPort: reservation.proxyPort, controllerPort: reservation.controllerPort,
      controllerSecret, abort, child: null, exited: true, exitPromise, resolveExit, stopping: false, result: null,
    }
    current = session
    try {
      assertNotAborted(abort.signal)
      const yaml = buildIsolatedMihomoConfig(profile, { mixedPort: session.proxyPort, controllerPort: session.controllerPort, controllerSecret })
      ensureSafeDataDirectory(options.runtimeDirectory, '加速运行目录')
      await fs.promises.mkdir(directory, { mode: 0o700 })
      session.directoryCreated = true
      liveSessionDirectories.add(directory)
      assertNoReparseComponents(directory, '加速运行目录')
      await copyBoundedFileExclusive(options.corePath, session.executablePath, MAX_CORE_BYTES, '加速内核')
      const copiedCore = await readBoundedFile(session.executablePath, MAX_CORE_BYTES, '加速内核')
      if (createHash('sha256').update(copiedCore).digest('hex') !== options.coreSha256.toLowerCase()) throw new Error('加速内核校验失败')
      if (process.platform === 'darwin') assertMacosAccelerationBinary(copiedCore, process.arch)
      if (process.platform !== 'win32') await fs.promises.chmod(session.executablePath, 0o700)
      await writeAtomicSafeUtf8File(session.configPath, yaml, '加速连接配置')
      assertNotAborted(abort.signal)
      assertSafeDataFile(session.executablePath, '加速内核')
      await reservation.release()
      const child = spawn(session.executablePath, ['-d', directory, '-f', session.configPath], {
        shell: false, windowsHide: true, detached: false, cwd: directory,
        env: coreEnvironment(), stdio: ['ignore', 'ignore', 'ignore'],
      })
      session.child = child
      session.exited = false
      function onExit(): void {
        if (session.exited) return
        session.exited = true
        session.resolveExit()
        session.abort.abort(new Error('加速内核意外退出'))
        if (!session.result || session.stopping) return
        session.result = null
        void Promise.resolve().then(() => options.onUnexpectedExit?.()).catch(() => undefined)
        void enqueue(async () => {
          await cleanupSessionFiles(session)
          if (current === session) current = null
        }).catch(() => undefined)
      }
      child.once('exit', onExit)
      child.once('error', () => {
        // A failed spawn has no process to await; later errors cannot establish
        // that a previously spawned process has exited.
        if (!child.pid) onExit()
      })
      await awaitController(session)
      await confirmCorePorts(session)
      const line = await selectAvailableLine(session, lines, preferredId)
      await probeProxy(session)
      assertNotAborted(abort.signal)
      if (session.exited) throw new Error('加速内核已退出')
      session.result = { line, proxyPort: session.proxyPort }
      return { ...session.result, line: { ...line } }
    } catch (error) {
      await reservation.release()
      await stopSession(session)
      if (current === session) current = null
      if (error instanceof Error && /^加速|^暂无可用加速线路/.test(error.message)) throw error
      throw new Error('加速内核启动失败')
    }
  }

  return {
    start(profile, lineId) {
      if (startPromise) return startPromise
      const abort = new AbortController()
      startingAbort = abort
      const operation = enqueue(() => startInner(profile, abort, lineId))
      startPromise = operation
      void operation.finally(() => {
        if (startPromise === operation) startPromise = null
        if (startingAbort === abort) startingAbort = null
      }).catch(() => undefined)
      return operation
    },
    stop() {
      startingAbort?.abort()
      if (current) {
        current.stopping = true
        current.abort.abort()
      }
      return enqueue(async () => {
        if (!current) return
        await stopSession(current)
        current = null
      })
    },
    isRunning() {
      return Boolean(current?.child && !current.exited)
    },
  }
}
