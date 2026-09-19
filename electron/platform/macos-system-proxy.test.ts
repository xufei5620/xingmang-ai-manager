import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { describe, it, expect, vi } from 'vitest'
import { createMacosSystemProxy, planMacosProxyHelperCleanup, prepareMacosProxyHelper } from './macos-system-proxy'

function transport() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true, unref: () => undefined })
  const requests: Record<string, unknown>[] = []
  child.stdin.on('data', data => requests.push(JSON.parse(String(data))))
  return { child, requests, reply(index: number, ok = true) { child.stdout.write(JSON.stringify({ id: requests[index].id, ok, error: 'authorization' }) + '\n') } }
}

describe('macOS system proxy adapter', () => {
  it('launches the verified copy instead of the protected project executable', async () => {
    const t = transport()
    const prepare = vi.fn(async () => '/application-data/helpers/verified-helper')
    const spawn = vi.fn(() => t.child)
    const proxy = createMacosSystemProxy({ journalPath: '/safe/journal', helperPath: '/Desktop/project/helper', validateHelper: () => {}, prepareHelper: prepare, spawnHelper: spawn })
    const pending = proxy.recover()
    await new Promise(resolve => setImmediate(resolve))
    expect(prepare).toHaveBeenCalledWith('/Desktop/project/helper')
    expect(spawn).toHaveBeenCalledWith('/application-data/helpers/verified-helper', ['--journal', '/safe/journal'])
    t.reply(0)
    await pending
  })

  it('copies helper bytes into separate private directories without replacing running versions', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xm-proxy-helper-test-')))
    try {
      const source = path.join(root, 'source')
      const cache = path.join(root, 'cache')
      await fs.writeFile(source, 'first trusted helper', { mode: 0o700 })
      const first = await prepareMacosProxyHelper(source, cache)
      expect(first.startsWith(`${cache}${path.sep}`)).toBe(true)
      expect(await fs.readFile(first, 'utf8')).toBe('first trusted helper')
      const original = await fs.stat(first)
      expect(await prepareMacosProxyHelper(source, cache)).not.toBe(first)
      expect((await fs.stat(first)).ino).toBe(original.ino)
      await fs.writeFile(source, 'second trusted helper')
      const second = await prepareMacosProxyHelper(source, cache)
      expect(second).not.toBe(first)
      expect(await fs.readFile(first, 'utf8')).toBe('first trusted helper')
      expect(await fs.readFile(second, 'utf8')).toBe('second trusted helper')
      if (process.platform !== 'win32') expect((await fs.stat(second)).mode & 0o777).toBe(0o500)
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('ignores an interrupted old cache entry and rejects unsafe source links', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xm-proxy-helper-test-')))
    try {
      const source = path.join(root, 'source')
      const cache = path.join(root, 'cache')
      const bytes = Buffer.from('trusted helper')
      await fs.writeFile(source, bytes, { mode: 0o700 })
      const directory = path.join(cache, createHash('sha256').update(bytes).digest('hex'))
      await fs.mkdir(directory, { recursive: true })
      await fs.writeFile(path.join(directory, 'macos-system-proxy'), 'altered', { mode: 0o700 })
      const prepared = await prepareMacosProxyHelper(source, cache)
      expect(await fs.readFile(prepared)).toEqual(bytes)
      expect(await fs.readFile(path.join(directory, 'macos-system-proxy'), 'utf8')).toBe('altered')
      await fs.link(source, path.join(root, 'linked-source'))
      await expect(prepareMacosProxyHelper(source, cache)).rejects.toThrow('单链接')
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('plans removal of retired copies only, keeping the new one and the newest survivors', () => {
    const digest = 'a'.repeat(64)
    const day = 24 * 60 * 60 * 1000
    const now = 100 * day
    const copies = [
      { name: `${digest}-new`, modifiedAtMs: now },
      { name: `${digest}-young`, modifiedAtMs: now - day / 2 },
      { name: `${digest}-recent`, modifiedAtMs: now - 3 * day },
      { name: `${digest}-older`, modifiedAtMs: now - 5 * day },
      { name: `${digest}-oldest`, modifiedAtMs: now - 9 * day },
      { name: 'unrelated-directory', modifiedAtMs: 0 },
    ]
    expect(planMacosProxyHelperCleanup(copies, `${digest}-new`, now)).toEqual([`${digest}-older`, `${digest}-oldest`])
    expect(planMacosProxyHelperCleanup(copies, `${digest}-new`, now, 0)).toEqual([`${digest}-recent`, `${digest}-older`, `${digest}-oldest`])
    expect(planMacosProxyHelperCleanup(copies, `${digest}-oldest`, now, 0, 10 * day)).toEqual([])
  })

  it('removes retired helper copies after preparing a new one', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xm-proxy-helper-test-')))
    try {
      const source = path.join(root, 'source')
      const cache = path.join(root, 'cache')
      const unrelated = path.join(cache, 'unrelated-directory')
      await fs.writeFile(source, 'trusted helper', { mode: 0o700 })
      const retired: string[] = []
      for (let index = 0; index < 4; index += 1) retired.push(path.dirname(await prepareMacosProxyHelper(source, cache)))
      await fs.mkdir(unrelated, { recursive: true })
      const day = 24 * 60 * 60 * 1000
      for (const [index, directory] of retired.entries()) {
        const stamp = new Date(Date.now() - (10 - index) * day)
        await fs.utimes(directory, stamp, stamp)
      }
      const fresh = path.dirname(await prepareMacosProxyHelper(source, cache))
      const present = async (directory: string) => fs.access(directory).then(() => true, () => false)
      expect(await Promise.all(retired.map(present))).toEqual([false, false, true, true])
      expect(await present(fresh)).toBe(true)
      expect(await present(unrelated)).toBe(true)
      // The copy just prepared is young, so the next start keeps it and retires
      // the oldest survivor instead.
      const next = path.dirname(await prepareMacosProxyHelper(source, cache))
      expect(await Promise.all([retired[2], retired[3], fresh, next].map(present))).toEqual([false, true, true, true])
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  it('still returns a verified helper when sweeping old copies fails', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'xm-proxy-helper-test-')))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const source = path.join(root, 'source')
      const cache = path.join(root, 'cache')
      await fs.writeFile(source, 'trusted helper', { mode: 0o700 })
      const retired: string[] = []
      for (let index = 0; index < 3; index += 1) retired.push(path.dirname(await prepareMacosProxyHelper(source, cache)))
      const stamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
      for (const directory of retired) await fs.utimes(directory, stamp, stamp)
      const removal = vi.spyOn(fs, 'rm').mockRejectedValue(new Error('清理被拒绝'))
      try {
        const prepared = await prepareMacosProxyHelper(source, cache)
        expect(await fs.readFile(prepared, 'utf8')).toBe('trusted helper')
      } finally { removal.mockRestore() }
      const present = await Promise.all(retired.map(directory => fs.access(directory).then(() => true, () => false)))
      expect(present).toEqual([true, true, true])
      expect(warn.mock.calls[0]?.[0]).toContain('旧组件副本清理失败')
    } finally {
      warn.mockRestore()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('serializes RPCs and maps only fixed error text', async () => {
    const t = transport()
    const proxy = createMacosSystemProxy({ journalPath: '/safe/journal', helperPath: '/safe/helper', validateHelper: () => {}, prepareHelper: async source => source, spawnHelper: () => t.child })
    const first = proxy.enable(17890)
    const second = proxy.restore()
    await new Promise(resolve => setImmediate(resolve))
    expect(t.requests).toHaveLength(1)
    t.reply(0)
    await first
    await new Promise(resolve => setImmediate(resolve))
    expect(t.requests[1].op).toBe('restore')
    t.reply(1, false)
    await expect(second).rejects.toThrow('系统代理授权未完成')
  })
  it('rejects invalid ports before spawning', async () => {
    const proxy = createMacosSystemProxy({ journalPath: '/safe/journal', helperPath: '/safe/helper', spawnHelper: () => { throw Error('must not spawn') } })
    await expect(proxy.enable(0)).rejects.toThrow('代理端口无效')
  })
  it('closes stdin on bounded transport timeout for native recovery', async () => {
    const t = transport()
    const proxy = createMacosSystemProxy({ journalPath: '/safe/journal', helperPath: '/safe/helper', timeoutMs: 10, validateHelper: () => {}, prepareHelper: async source => source, spawnHelper: () => t.child })
    await expect(proxy.enable(17890)).rejects.toThrow('系统代理操作超时')
    expect(t.child.stdin.writableEnded).toBe(true)
  })
  it('rejects oversized replies and closes the native input', async () => {
    const t = transport()
    const proxy = createMacosSystemProxy({ journalPath: '/safe/journal', helperPath: '/safe/helper', validateHelper: () => {}, prepareHelper: async source => source, spawnHelper: () => t.child })
    const pending = proxy.recover()
    await new Promise(resolve => setImmediate(resolve))
    t.child.stdout.write('x'.repeat(8193))
    await expect(pending).rejects.toThrow('系统代理组件返回异常')
    expect(t.child.stdin.writableEnded).toBe(true)
  })
  it('reports unexpected helper exit without exposing raw output', async () => {
    const t = transport()
    const proxy = createMacosSystemProxy({ journalPath: '/safe/journal', helperPath: '/safe/helper', validateHelper: () => {}, prepareHelper: async source => source, spawnHelper: () => t.child })
    const pending = proxy.restore()
    await new Promise(resolve => setImmediate(resolve))
    t.child.emit('exit', 1)
    await expect(pending).rejects.toThrow('系统代理组件已退出')
  })

  it('waits for the timed out helper to exit before recovering with a new helper', async () => {
    const first = transport(), second = transport()
    let launches = 0
    const proxy = createMacosSystemProxy({ journalPath: '/safe/journal', helperPath: '/safe/helper', timeoutMs: 30, validateHelper: () => {}, prepareHelper: async source => source, spawnHelper: () => ++launches === 1 ? first.child : second.child })
    await expect(proxy.enable(17890)).rejects.toThrow('系统代理操作超时')
    const recovery = proxy.restore()
    let finished = false
    void recovery.then(() => { finished = true }, () => { finished = true })
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(launches).toBe(1)
    expect(finished).toBe(false)
    first.reply(0)
    expect(finished).toBe(false)
    first.child.emit('exit', 0)
    await new Promise(resolve => setImmediate(resolve))
    expect(launches).toBe(2)
    expect(second.requests[0].op).toBe('restore')
    second.reply(0)
    await recovery
  })

})
