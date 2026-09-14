import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccelerationDevelopmentHost, parseAccelerationDevelopmentConfig, parseAccelerationEntitlementSource, readAccelerationDevelopmentConfig } from './acceleration-development-host'

const mocks = vi.hoisted(() => ({ fork: vi.fn(), spawn: vi.fn(), read: vi.fn(), environment: vi.fn() }))
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), fork: mocks.fork, spawn: mocks.spawn }))
vi.mock('./safe-local-data', async (original) => ({ ...await original<typeof import('./safe-local-data')>(), readSafeUtf8File: mocks.read }))
vi.mock('./command-runner', async (original) => ({ ...await original<typeof import('./command-runner')>(), trustedCommandEnvironment: mocks.environment }))

const config = { version: 1 as const, corePath: path.resolve('private', 'mihomo.exe'), coreSha256: 'a'.repeat(64), profilePath: path.resolve('private', 'nodes.yaml') }
const dataDirectory = path.resolve('private', 'app-data')

class FakeWorker extends EventEmitter {
  connected = true
  autoInit = true
  autoDispose = true
  sent: Array<Record<string, unknown>> = []
  send = vi.fn((message: Record<string, unknown>, callback: (error: Error | null) => void) => {
    this.sent.push(message)
    callback(null)
    if (message.operation === 'init' && this.autoInit || message.operation === 'dispose' && this.autoDispose) {
      this.respond(Number(message.id), true)
    }
    return true
  })
  disconnect = vi.fn(() => { this.connected = false; this.emit('disconnect') })
  respond(id: number, ok: boolean, value?: unknown) { this.emit('message', { id, ok, value }) }
}

async function flush() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
function setup(worker = new FakeWorker(), extraConfig: Record<string, unknown> = {}) {
  mocks.fork.mockReturnValue(worker)
  const host = createAccelerationDevelopmentHost({ config: { ...config, ...extraConfig }, dataDirectory })
  return { worker, host }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  mocks.fork.mockReset()
  mocks.spawn.mockReset()
  mocks.read.mockReset().mockResolvedValue(null)
  mocks.environment.mockReset().mockReturnValue({ PATH: 'trusted-path', SystemRoot: 'C:\\Windows' })
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('development acceleration manifest', () => {
  it.each(['win32', 'darwin', 'linux'])('does not inspect any user manifest in packaged builds on %s', async (platform) => {
    mocks.read.mockRejectedValue(new Error('must-not-read'))
    expect(await readAccelerationDevelopmentConfig({ isPackaged: true, platform, dataDirectory: 'invalid-even-if-present' })).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.fork).not.toHaveBeenCalled()
  })

  it.each(['darwin', 'linux', 'unknown'])('does not enable the Windows adapter on development %s', async (platform) => {
    expect(await readAccelerationDevelopmentConfig({ isPackaged: false, platform, dataDirectory })).toBeNull()
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('reads only the bounded manifest and projects paths and normalized SHA-256', async () => {
    mocks.read.mockResolvedValue(JSON.stringify({ ...config, coreSha256: 'AB'.repeat(32), yaml: 'private-secret' }))
    expect(await readAccelerationDevelopmentConfig({ isPackaged: false, platform: 'win32', dataDirectory })).toEqual({ ...config, coreSha256: 'ab'.repeat(32) })
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(path.join(dataDirectory, 'acceleration-development.json'), '本机加速配置', 16 * 1024)
  })

  it('leaves an absent manifest disabled and sanitizes JSON, filesystem and manifest errors', async () => {
    expect(await readAccelerationDevelopmentConfig({ isPackaged: false, platform: 'win32', dataDirectory })).toBeNull()
    for (const source of ['private-secret', JSON.stringify({ ...config, coreSha256: 'private-secret' })]) {
      mocks.read.mockResolvedValueOnce(source)
      await expect(readAccelerationDevelopmentConfig({ isPackaged: false, platform: 'win32', dataDirectory })).rejects.toThrow(/^本机加速配置无效。$/)
    }
    mocks.read.mockRejectedValueOnce(new Error('private-secret-path'))
    await expect(readAccelerationDevelopmentConfig({ isPackaged: false, platform: 'win32', dataDirectory })).rejects.toThrow(/^本机加速配置无效。$/)
  })

  it('rejects relative, control-character and oversized paths, invalid versions and invalid digests', () => {
    for (const invalid of [
      null, [], {}, { ...config, version: 2 },
      { ...config, corePath: 'mihomo.exe' }, { ...config, profilePath: 'nodes.yaml' },
      { ...config, corePath: `${config.corePath}\n` }, { ...config, profilePath: `${config.profilePath}\0` },
      { ...config, corePath: path.resolve('x'.repeat(4097)) },
      { ...config, coreSha256: 'a'.repeat(63) }, { ...config, coreSha256: 'g'.repeat(64) },
      { ...config, profileSha256: 'a'.repeat(63) }, { ...config, profileSha256: null },
    ]) expect(() => parseAccelerationDevelopmentConfig(invalid)).toThrow(/^本机加速配置无效。$/)
    expect(() => createAccelerationDevelopmentHost({ config, dataDirectory: 'relative' })).toThrow('数据目录无效')
    expect(mocks.fork).not.toHaveBeenCalled()
  })

  it('pins an optional profile digest and accepts only the local device entitlement override', () => {
    expect(parseAccelerationDevelopmentConfig({ ...config, profileSha256: 'AB'.repeat(32) }).profileSha256).toBe('ab'.repeat(32))
    expect(parseAccelerationEntitlementSource(undefined)).toBeUndefined()
    expect(parseAccelerationEntitlementSource('local-device')).toBe('local-device')
    for (const value of [null, 'server', 'local-development', 20, {}]) {
      expect(() => parseAccelerationEntitlementSource(value)).toThrow('时长来源无效')
    }
  })
})

describe('development acceleration worker host', () => {
  it('spawns the fixed packaged helper through the hardened Electron entry without RunAsNode', async () => {
    const worker = new FakeWorker()
    mocks.spawn.mockReturnValue(worker)
    mocks.environment.mockImplementation(() => ({ PATH: 'trusted-path', SystemRoot: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1' }))
    const pinnedConfig = { ...config, profileSha256: 'b'.repeat(64) }
    const host = createAccelerationDevelopmentHost({ config: pinnedConfig, dataDirectory, packaged: true })
    const first = host.getAccelerationState('xm-account:1')
    const second = host.stopAcceleration('xm-account:1')
    await flush()
    expect(mocks.fork).not.toHaveBeenCalled()
    expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(process.execPath, ['--xingmang-acceleration-worker'], {
      detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { PATH: 'trusted-path', SystemRoot: 'C:\\Windows' },
    })
    expect(worker.sent[0]).toEqual({ id: 1, operation: 'init', config: pinnedConfig, dataDirectory, entitlementSource: 'local-device' })
    worker.respond(3, true, { phase: 'idle' })
    worker.respond(2, true, { phase: 'idle' })
    await Promise.all([first, second])
    await host.dispose()
    expect(worker.disconnect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails closed for an unpinned packaged profile and a failed packaged initialization', async () => {
    expect(() => createAccelerationDevelopmentHost({ config, dataDirectory, packaged: true })).toThrow('完整性校验')
    expect(mocks.spawn).not.toHaveBeenCalled()
    const worker = new FakeWorker()
    worker.autoInit = false
    mocks.spawn.mockReturnValue(worker)
    const host = createAccelerationDevelopmentHost({ config: { ...config, profileSha256: 'b'.repeat(64) }, dataDirectory, packaged: true, entitlementSource: 'local-device' })
    const failure = expect(host.getAccelerationState('xm-account:1')).rejects.toThrow('初始化未完成')
    worker.respond(1, false)
    await failure
    expect(worker.disconnect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lazily forks a hidden Node worker with a trusted environment and sends paths without YAML content', async () => {
    const { worker, host } = setup(undefined, { yaml: 'private-secret', nodes: [{ password: 'private-secret' }] })
    expect(mocks.fork).not.toHaveBeenCalled()
    const request = host.startAcceleration('xm-account:1', 'system-proxy')
    await flush()
    expect(mocks.fork).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('acceleration-development-worker.js'), [], {
      execPath: process.execPath, execArgv: [], detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { PATH: 'trusted-path', SystemRoot: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(worker.sent).toEqual([
      { id: 1, operation: 'init', config, dataDirectory },
      { id: 2, operation: 'start', scope: 'xm-account:1', mode: 'system-proxy' },
    ])
    expect(JSON.stringify(worker.sent)).not.toContain('private-secret')
    expect(mocks.read).not.toHaveBeenCalled()
    worker.respond(2, true, { scope: 'xm-account:1', phase: 'active' })
    expect(await request).toEqual({ scope: 'xm-account:1', phase: 'active' })
    await host.dispose()
    expect(worker.disconnect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shares one initialization across concurrent calls and matches responses by request id', async () => {
    const { worker, host } = setup()
    const first = host.getAccelerationState('xm-account:1')
    const second = host.stopAcceleration('xm-account:1')
    await flush()
    expect(mocks.fork).toHaveBeenCalledOnce()
    expect(worker.sent.map((message) => message.operation)).toEqual(['init', 'get', 'stop'])
    worker.respond(3, true, { phase: 'idle' })
    worker.respond(2, true, { phase: 'active' })
    expect(await first).toEqual({ phase: 'active' })
    expect(await second).toEqual({ phase: 'idle' })
    expect(vi.getTimerCount()).toBe(0)
    await host.dispose()
  })

  it.each(['disconnect', 'error', 'exit'])('rejects every pending request immediately on worker %s', async (event) => {
    const { worker, host } = setup()
    const result = Promise.allSettled([host.getAccelerationState('xm-account:1'), host.getAccelerationState('xm-account:1')])
    await flush()
    if (event === 'exit' || event === 'disconnect') worker.connected = false
    worker.emit(event, event === 'error' ? new Error('private-worker-secret') : 1)
    for (const response of await result) {
      expect(response.status).toBe('rejected')
      if (response.status === 'rejected') expect(response.reason.message).toBe('本机加速进程已断开，请重新打开软件。')
    }
    expect(vi.getTimerCount()).toBe(0)
    worker.respond(2, true, { stale: true })
    expect(vi.getTimerCount()).toBe(0)
    if (event === 'error') expect(worker.disconnect).toHaveBeenCalledOnce()
  })

  it.each(['throw', 'callback'])('sanitizes send %s failures, clears pending timers and disconnects for cleanup', async (kind) => {
    const { worker, host } = setup()
    const initial = host.getAccelerationState('xm-account:1')
    await flush()
    worker.respond(2, true, {})
    await initial
    worker.send.mockImplementationOnce((_message, callback) => {
      if (kind === 'throw') throw new Error('private-send-secret')
      callback(new Error('private-send-secret'))
      return false
    })
    await expect(host.startAcceleration('xm-account:1', 'system-proxy')).rejects.toThrow(/^本机加速进程通信失败。$/)
    expect(worker.disconnect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disconnects on timeout so the worker can restore network and rejects all outstanding calls', async () => {
    const { worker, host } = setup()
    const results = Promise.allSettled([host.startAcceleration('xm-account:1', 'system-proxy'), host.getAccelerationState('xm-account:1')])
    await flush()
    await vi.advanceTimersByTimeAsync(90_000)
    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(worker.disconnect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disconnects after rejected initialization even when dispose is retried', async () => {
    const worker = new FakeWorker()
    worker.autoInit = false
    const { host } = setup(worker)
    const request = host.getAccelerationState('xm-account:1')
    const rejected = expect(request).rejects.toThrow(/^本机加速进程初始化未完成。$/)
    worker.respond(1, false, { error: 'private-init-secret' })
    await rejected
    expect(worker.disconnect).toHaveBeenCalledOnce()
    await expect(host.dispose()).rejects.toThrow('初始化未完成')
    await expect(host.dispose()).rejects.toThrow('初始化未完成')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('disconnects after a failed dispose response to trigger independent worker recovery retries', async () => {
    const { worker, host } = setup()
    const initial = host.getAccelerationState('xm-account:1')
    await flush()
    worker.respond(2, true, {})
    await initial
    worker.autoDispose = false
    const disposal = host.dispose()
    const result = expect(disposal).rejects.toThrow(/^本机加速操作未完成，请重新检查线路。$/)
    await flush()
    worker.respond(3, false, { error: 'private-cleanup-secret' })
    await result
    expect(worker.disconnect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await expect(host.startAcceleration('xm-account:1', 'system-proxy')).rejects.toThrow('服务已关闭')
  })

  it('ignores malformed or unknown messages and sanitizes errors returned for known requests', async () => {
    const { worker, host } = setup()
    const pending = host.getAccelerationState('xm-account:1')
    const result = expect(pending).rejects.toThrow(/^本机加速操作未完成，请重新检查线路。$/)
    await flush()
    for (const message of [null, [], { id: '2', ok: true }, { id: 200, ok: true }]) worker.emit('message', message)
    expect(vi.getTimerCount()).toBe(1)
    worker.respond(2, false, { error: 'private-error-secret' })
    await result
    expect(vi.getTimerCount()).toBe(0)
    await host.dispose()
  })

  it('sanitizes fork exceptions and can dispose an unused host without spawning anything', async () => {
    const { host } = setup()
    mocks.fork.mockImplementationOnce(() => { throw new Error('private-executable-path') })
    await expect(host.getAccelerationState('xm-account:1')).rejects.toThrow(/^本机加速进程启动失败。$/)
    await host.dispose()
    expect(mocks.fork).toHaveBeenCalledOnce()
    const unused = createAccelerationDevelopmentHost({ config, dataDirectory })
    await unused.dispose()
    expect(mocks.fork).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lets an isolated worker finish cleanup after its Windows parent exits abruptly', async () => {
    vi.useRealTimers()
    const { spawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const { worker, host } = setup()
    const request = host.getAccelerationState('xm-account:1')
    await flush()
    worker.respond(2, true, {})
    await request
    const configuredOptions = mocks.fork.mock.calls[0][2] as { detached?: boolean }
    await host.dispose()
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xm-worker-crash-test-'))
    const workerPath = path.join(directory, 'worker.cjs')
    const parentPath = path.join(directory, 'parent.cjs')
    const reportPath = path.join(directory, 'events.log')
    try {
      // These fixtures use only marker files and timers: no Mihomo, OS proxy,
      // real backend, account or network access is involved.
      await fs.writeFile(workerPath, `
const fs = require('node:fs')
const report = process.argv[2]
const write = value => fs.appendFileSync(report, value + '\\n')
const keepalive = setInterval(() => {}, 100)
setTimeout(() => process.exit(2), 5000).unref()
process.on('disconnect', () => {
  write('disconnected')
  setTimeout(() => { write('restored'); clearInterval(keepalive); process.exit(0) }, 100)
})
process.send('ready')
`, 'utf8')
      await fs.writeFile(parentPath, `
const { fork } = require('node:child_process')
const worker = fork(process.argv[2], [process.argv[3]], {
  detached: ${configuredOptions.detached === true}, windowsHide: true,
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [],
})
worker.on('message', () => process.exit(0))
`, 'utf8')
      const parentExit = await new Promise<number | null>((resolve, reject) => {
        const parent = spawn(process.execPath, [parentPath, workerPath, reportPath], { windowsHide: true, stdio: 'ignore' })
        const timeout = setTimeout(() => { parent.kill(); reject(new Error('Fake parent did not exit')) }, 4000)
        parent.once('error', (error) => { clearTimeout(timeout); reject(error) })
        parent.once('exit', (code) => { clearTimeout(timeout); resolve(code) })
      })
      expect(parentExit).toBe(0)
      let events = ''
      const deadline = Date.now() + 3000
      while (Date.now() < deadline) {
        events = await fs.readFile(reportPath, 'utf8').catch(() => '')
        if (events.includes('restored')) break
        await delay(25)
      }
      expect(events).toBe('disconnected\nrestored\n')
    } finally {
      expect(path.dirname(directory)).toBe(path.resolve(os.tmpdir()))
      expect(path.basename(directory)).toMatch(/^xm-worker-crash-test-/)
      await fs.rm(directory, { recursive: true, force: true })
    }
  }, 10_000)
})
