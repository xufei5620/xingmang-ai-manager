import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import type net from 'node:net'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { ConnectionOptions } from 'node:tls'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse, stringify } from 'yaml'
import { parseClashAccelerationProfile } from './acceleration-clash-config'
import { createMihomoRuntime, type MihomoRuntime } from './acceleration-mihomo-runtime'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), tlsConnect: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: mocks.spawn }))
vi.mock('node:tls', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:tls')>()
  return { ...original, default: { ...original, connect: mocks.tlsConnect }, connect: mocks.tlsConnect }
})

interface FakeSettings {
  acceptInvalidAuth: boolean
  failDelays: boolean
  holdDelays: boolean
  wrongSelection: boolean
  oversizedFirstDelay: boolean
  resistStop: boolean
  tlsStatus: number
}

class FakeTlsSocket extends EventEmitter {
  destroyed = false
  write = vi.fn((_request: string) => {
    queueMicrotask(() => this.emit('data', Buffer.from(`HTTP/1.1 ${settings.tlsStatus} Test\r\nContent-Length: 0\r\n\r\n`)))
    return true
  })
  destroy(): this {
    this.destroyed = true
    return this
  }
}

class FakeChild extends EventEmitter {
  pid = 800_001
  readonly servers: http.Server[] = []
  readonly sockets = new Set<net.Socket>()
  readonly routes: string[] = []
  readonly secrets: string[] = []
  configPath = ''
  selected = 'line-1'
  activeDelays = 0
  maximumActiveDelays = 0
  exited = false
  kill = vi.fn((_signal?: string) => {
    if (settings.resistStop) return false
    void this.exit()
    return true
  })

  async exit(): Promise<void> {
    if (this.exited) return
    this.exited = true
    for (const socket of this.sockets) socket.destroy()
    await Promise.all(this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    this.emit('exit', 0, null)
  }

  start(config: Record<string, unknown>): void {
    const controller = http.createServer((request, response) => {
      this.routes.push(`${request.method} ${request.url}`)
      this.secrets.push(String(request.headers.authorization ?? ''))
      if (!settings.acceptInvalidAuth && request.headers.authorization !== `Bearer ${config.secret}`) {
        response.writeHead(401).end('{}')
        return
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/version') {
        response.writeHead(200).end('{"version":"test-core"}')
      } else if (url.pathname.endsWith('/delay')) {
        this.activeDelays += 1
        this.maximumActiveDelays = Math.max(this.maximumActiveDelays, this.activeDelays)
        if (settings.holdDelays) return
        setTimeout(() => {
          this.activeDelays -= 1
          if (settings.failDelays) response.writeHead(503).end('{"message":"private-upstream-error"}')
          else if (settings.oversizedFirstDelay && url.pathname.includes('line-1/')) response.writeHead(200).end('x'.repeat(70 * 1024))
          else response.writeHead(200).end(JSON.stringify({ delay: url.pathname.includes('line-2/') ? 20 : 100 }))
        }, 20)
      } else if (url.pathname === '/proxies/XINGMANG' && request.method === 'PUT') {
        let body = ''
        request.on('data', (chunk) => { body += chunk })
        request.on('end', () => {
          this.selected = JSON.parse(body).name
          response.writeHead(204).end()
        })
      } else if (url.pathname === '/proxies/XINGMANG') {
        response.writeHead(200).end(JSON.stringify({ now: settings.wrongSelection ? 'unconfirmed' : this.selected }))
      } else response.writeHead(404).end('{}')
    })
    const proxy = http.createServer((_request, response) => response.writeHead(405).end())
    proxy.on('connect', (request, socket) => {
      this.routes.push(`CONNECT ${request.url}`)
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    })
    for (const server of [controller, proxy]) {
      server.on('connection', (socket) => {
        this.sockets.add(socket)
        socket.once('close', () => this.sockets.delete(socket))
      })
      this.servers.push(server)
    }
    controller.listen(Number(String(config['external-controller']).split(':').at(-1)), '127.0.0.1')
    proxy.listen(Number(config['mixed-port']), '127.0.0.1')
  }
}

let root: string
let corePath: string
let coreSha256: string
let settings: FakeSettings
let children: FakeChild[]
let runtimes: MihomoRuntime[]

function profile() {
  return parseClashAccelerationProfile(stringify({
    proxies: Array.from({ length: 4 }, (_, index) => ({
      type: 'hysteria2', name: `Japan test ${index}`, server: `node${index}.example.com`,
      port: 443, password: `test-only-password-${index}`,
    })),
  }))
}

function runtime(onUnexpectedExit?: () => void): MihomoRuntime {
  const value = createMihomoRuntime({ corePath, coreSha256, runtimeDirectory: path.join(root, 'runtime'), onUnexpectedExit })
  runtimes.push(value)
  return value
}

async function remainingSessions(): Promise<string[]> {
  return fs.readdir(path.join(root, 'runtime')).catch(() => [])
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-acceleration-runtime-'))
  corePath = path.join(root, 'source-core.exe')
  const core = Buffer.from('test-only-not-an-executable')
  await fs.writeFile(corePath, core)
  coreSha256 = createHash('sha256').update(core).digest('hex')
  settings = { acceptInvalidAuth: false, failDelays: false, holdDelays: false, wrongSelection: false, oversizedFirstDelay: false, resistStop: false, tlsStatus: 204 }
  children = []
  runtimes = []
  mocks.spawn.mockReset().mockImplementation((_executable: string, args: string[]) => {
    const child = new FakeChild()
    children.push(child)
    child.configPath = args[args.indexOf('-f') + 1]
    void fs.readFile(child.configPath, 'utf8').then((yaml) => child.start(parse(yaml)))
    return child as unknown as ChildProcess
  })
  mocks.tlsConnect.mockReset().mockImplementation((_options: ConnectionOptions) => {
    const socket = new FakeTlsSocket()
    setTimeout(() => socket.emit('secureConnect'), 0)
    return socket
  })
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  settings.resistStop = false
  await Promise.all(runtimes.map((value) => value.stop().catch(() => undefined)))
  await Promise.all(children.map((child) => child.exit()))
  await fs.rm(root, { recursive: true, force: true })
})

describe('createMihomoRuntime', () => {
  it('starts a verified private core, selects the fastest line and proves the proxy path before returning', async () => {
    vi.stubEnv('HTTP_PROXY', 'http://private-proxy.example')
    vi.stubEnv('MIHOMO_TEST', 'untrusted-override')
    const value = runtime()
    const result = await value.start(profile())
    expect(result.line).toEqual({ id: 'line-2', name: '日本线路 2', region: 'JP', latencyMs: 20 })
    expect(result.proxyPort).toBeGreaterThan(1023)
    expect(value.isRunning()).toBe(true)
    const [executable, args, options] = mocks.spawn.mock.calls[0]
    expect(executable).not.toBe(corePath)
    expect(executable).toContain('session-')
    expect(await fs.readFile(executable)).toEqual(await fs.readFile(corePath))
    expect(options).toMatchObject({ shell: false, windowsHide: true, detached: false, stdio: ['ignore', 'ignore', 'ignore'] })
    expect(options.env).not.toHaveProperty('HTTP_PROXY')
    expect(options.env).not.toHaveProperty('MIHOMO_TEST')
    expect(JSON.stringify(args)).not.toContain('test-only-password')
    const config = parse(await fs.readFile(children[0].configPath, 'utf8'))
    expect(JSON.stringify(args)).not.toContain(config.secret)
    expect(config.tun).toEqual({ enable: false })
    expect(config['external-controller']).toMatch(/^127\.0\.0\.1:/)
    expect(config['bind-address']).toBe('127.0.0.1')
    expect(children[0].secrets.some((secret) => secret !== `Bearer ${config.secret}`)).toBe(true)
    expect(children[0].maximumActiveDelays).toBe(3)
    expect(children[0].routes).toContain('CONNECT www.gstatic.com:443')
    expect(mocks.tlsConnect).toHaveBeenCalledWith(expect.objectContaining({ servername: 'www.gstatic.com', rejectUnauthorized: true, minVersion: 'TLSv1.2' }))
    await value.stop()
    expect(value.isRunning()).toBe(false)
    expect(await remainingSessions()).toEqual([])
    expect(await fs.readFile(corePath, 'utf8')).toBe('test-only-not-an-executable')
  })

  it('coalesces repeated starts and stops without creating or killing another core', async () => {
    const value = runtime()
    const first = value.start(profile())
    expect(value.start(profile())).toBe(first)
    const original = await first
    const again = await value.start(profile())
    again.line.name = 'modified-by-caller'
    expect(original.line.name).toBe('日本线路 2')
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    await Promise.all([value.stop(), value.stop()])
    expect(children[0].kill).toHaveBeenCalledTimes(1)
  })

  it('cancels a queued start before any process or secret file is created', async () => {
    const value = runtime()
    const starting = value.start(profile())
    const stopped = value.stop()
    await expect(starting).rejects.toThrow('加速连接已取消')
    await stopped
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(await remainingSessions()).toEqual([])
  })

  it('cancels outstanding local controller requests and cleans its process during startup', async () => {
    settings.holdDelays = true
    const value = runtime()
    const starting = value.start(profile())
    const rejected = expect(starting).rejects.toThrow('加速连接已取消')
    await vi.waitFor(() => expect(children[0]?.routes.some((route) => route.includes('/delay?'))).toBe(true))
    await value.stop()
    await rejected
    expect(value.isRunning()).toBe(false)
    expect(await remainingSessions()).toEqual([])
  })

  it('rejects an incorrect core hash before executing anything', async () => {
    coreSha256 = '0'.repeat(64)
    await expect(runtime().start(profile())).rejects.toThrow('加速内核校验失败')
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(await remainingSessions()).toEqual([])
  })

  it('rejects a hardlinked source executable', async () => {
    await fs.link(corePath, path.join(root, 'other-core.exe'))
    await expect(runtime().start(profile())).rejects.toThrow('单链接普通文件')
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(await remainingSessions()).toEqual([])
  })

  it('rejects non-absolute paths and malformed checksums before doing file work', () => {
    expect(() => createMihomoRuntime({ corePath: 'mihomo.exe', coreSha256, runtimeDirectory: root })).toThrow('路径或校验值')
    expect(() => createMihomoRuntime({ corePath, coreSha256: 'not-a-checksum', runtimeDirectory: root })).toThrow('路径或校验值')
  })

  it('stops a controller that accepts the wrong secret', async () => {
    settings.acceptInvalidAuth = true
    const value = runtime()
    await expect(value.start(profile())).rejects.toThrow('未启用身份验证')
    expect(value.isRunning()).toBe(false)
    expect(await remainingSessions()).toEqual([])
  })

  it('fails closed if no nodes work and does not expose upstream error text', async () => {
    settings.failDelays = true
    const value = runtime()
    await expect(value.start(profile())).rejects.toThrow('暂无可用加速线路')
    expect(mocks.tlsConnect).not.toHaveBeenCalled()
    expect(await remainingSessions()).toEqual([])
  })

  it('bounds controller response bodies while allowing a different healthy line', async () => {
    settings.oversizedFirstDelay = true
    const value = runtime()
    expect((await value.start(profile())).line.id).toBe('line-2')
  })

  it('requires selection acknowledgement before opening the proxy connection', async () => {
    settings.wrongSelection = true
    await expect(runtime().start(profile())).rejects.toThrow('线路切换未确认')
    expect(mocks.tlsConnect).not.toHaveBeenCalled()
    expect(await remainingSessions()).toEqual([])
  })

  it('does not report connected when the real proxy request fails', async () => {
    settings.tlsStatus = 502
    const value = runtime()
    await expect(value.start(profile())).rejects.toThrow('代理连通性验证失败')
    expect(value.isRunning()).toBe(false)
    expect(await remainingSessions()).toEqual([])
  })

  it('notifies once and removes credentials after an unexpected confirmed exit', async () => {
    const onUnexpectedExit = vi.fn()
    const value = runtime(onUnexpectedExit)
    await value.start(profile())
    await children[0].exit()
    await vi.waitFor(() => expect(onUnexpectedExit).toHaveBeenCalledTimes(1))
    await value.stop()
    expect(value.isRunning()).toBe(false)
    expect(await remainingSessions()).toEqual([])
  })

  it('keeps configuration when a process refuses to stop and retries on the next stop', async () => {
    const value = runtime()
    await value.start(profile())
    settings.resistStop = true
    vi.useFakeTimers()
    const stopped = expect(value.stop()).rejects.toThrow('仍在运行')
    await vi.advanceTimersByTimeAsync(6100)
    await stopped
    expect(value.isRunning()).toBe(true)
    expect(await fs.readFile(children[0].configPath, 'utf8')).toContain('test-only-password')
    vi.useRealTimers()
    settings.resistStop = false
    await value.stop()
    expect(value.isRunning()).toBe(false)
    expect(await remainingSessions()).toEqual([])
  })
})
