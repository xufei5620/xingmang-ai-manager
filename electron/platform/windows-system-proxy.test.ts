import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { runCommand } from '../command-runner'
import { buildWindowsLoopbackProxySnapshot, createWindowsSystemProxy, parseWindowsProxySnapshot, type WindowsProxySnapshot } from './windows-system-proxy'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }) })

function originalSnapshot(): WindowsProxySnapshot {
  return {
    flags: 13, server: 'legacy.example.test:8080', bypass: '*.internal.example.test', autoConfigUrl: 'https://pac.example.test/config',
    registry: { ProxyEnable: 0, ProxyServer: 'legacy.example.test:8080', ProxyOverride: null, AutoConfigURL: 'https://pac.example.test/config' },
  }
}

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-proxy-lease-'))
  directories.push(directory)
  const journalPath = path.join(directory, 'system-proxy.json')
  const lockPath = `${journalPath}.lock`
  const before = originalSnapshot()
  let current = structuredClone(before)
  let ownerTime: string | null = '134022112340000000'
  let failApply: 'before' | 'after' | null = null
  let lockDepth = 0
  let lockQueue: Promise<unknown> = Promise.resolve()
  const mutations: WindowsProxySnapshot[] = []
  const execute = vi.fn<typeof runCommand>(async (spec, options) => {
    expect(lockDepth).toBe(1)
    const request = JSON.parse(Buffer.from(options!.env!.XINGMANG_SYSTEM_PROXY_REQUEST!, 'base64').toString('utf8'))
    let output: unknown
    if (request.operation === 'inspect') output = { owner: { pid: process.pid, startedAt: '134022112340000000' }, snapshot: current }
    else if (request.operation === 'owner') output = { startedAt: ownerTime }
    else if (request.operation === 'apply') {
      if (JSON.stringify(current) !== JSON.stringify(request.expected)) output = { changed: false, snapshot: current }
      else {
        expect(fs.existsSync(journalPath)).toBe(true)
        expect(fs.existsSync(lockPath)).toBe(true)
        if (failApply === 'before') { failApply = null; throw new Error('sensitive-proxy-operation-error') }
        current = structuredClone(request.desired)
        mutations.push(structuredClone(current))
        if (failApply === 'after') { failApply = null; throw new Error('sensitive-proxy-operation-error') }
        output = { changed: true, snapshot: current }
      }
    } else throw new Error('unexpected command')
    return { executable: spec.executable, argv: [...spec.argv], exitCode: 0, signal: null, stdout: JSON.stringify(output), stderr: '', outputBytes: 0, durationMs: 0 }
  })
  const withOperationLock = async <T,>(operation: () => Promise<T>): Promise<T> => {
    const pending = lockQueue.then(async () => {
      lockDepth += 1
      try { return await operation() } finally { lockDepth -= 1 }
    })
    lockQueue = pending.catch(() => undefined)
    return pending
  }
  const options = { journalPath, platform: 'win32' as const, runCommand: execute, powerShellExecutable: () => 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', commandEnvironment: () => ({}), withOperationLock }
  const service = createWindowsSystemProxy(options)
  return {
    directory, journalPath, lockPath, before, service, options, execute, mutations,
    get current() { return current },
    set current(value: WindowsProxySnapshot) { current = value },
    set ownerTime(value: string | null) { ownerTime = value },
    set failApply(value: 'before' | 'after' | null) { failApply = value },
  }
}

describe('Windows system proxy lease', () => {
  it('persists the full original state before enabling and restores PAC, WPAD and absent registry values', async () => {
    const f = fixture()
    await f.service.enable(18765)
    expect(f.current).toEqual(buildWindowsLoopbackProxySnapshot(18765))
    expect(JSON.parse(fs.readFileSync(f.journalPath, 'utf8'))).toMatchObject({ version: 1, before: f.before, applied: f.current, owner: { pid: process.pid, startedAt: '134022112340000000' } })
    expect(f.current.flags & 12).toBe(0)
    await f.service.restore()
    expect(f.current).toEqual(f.before)
    expect(fs.existsSync(f.journalPath)).toBe(false)
    expect(fs.existsSync(f.lockPath)).toBe(false)
    expect(f.mutations).toHaveLength(2)
  })

  it('keeps repeated enable and restore idempotent and refuses a port switch while active', async () => {
    const f = fixture()
    await Promise.all([f.service.enable(18765), f.service.enable(18765)])
    expect(f.mutations).toHaveLength(1)
    await expect(f.service.enable(18766)).rejects.toThrow('请先停止当前加速')
    await f.service.restore()
    await f.service.restore()
    expect(f.mutations).toHaveLength(2)
  })

  it('does not overwrite settings changed later by Clash or the user', async () => {
    const f = fixture()
    await f.service.enable(18765)
    const clash = buildWindowsLoopbackProxySnapshot(7897)
    f.current = clash
    await f.service.restore()
    expect(f.current).toEqual(clash)
    expect(f.mutations).toHaveLength(1)
    expect(fs.existsSync(f.journalPath)).toBe(false)
  })

  it.each(['before', 'after'] as const)('rolls back a failed enable %s the OS write and reports a safe error', async (failure) => {
    const f = fixture()
    f.failApply = failure
    await expect(f.service.enable(18765)).rejects.toThrow('系统代理启用失败，原设置已保留。')
    expect(f.current).toEqual(f.before)
    expect(fs.existsSync(f.journalPath)).toBe(false)
    expect(fs.existsSync(f.lockPath)).toBe(false)
  })

  it('keeps the lease when later edits still depend on its active local endpoint', async () => {
    const f = fixture()
    await f.service.enable(18765)
    f.current = { ...f.current, bypass: 'new-user-bypass', registry: { ...f.current.registry, ProxyOverride: 'new-user-bypass' } }
    await expect(f.service.restore()).rejects.toThrow('仍指向加速端口')
    expect(f.current.bypass).toBe('new-user-bypass')
    expect(fs.existsSync(f.journalPath)).toBe(true)
    expect(fs.existsSync(f.lockPath)).toBe(true)
    f.current = f.before
    await f.service.restore()
    expect(fs.existsSync(f.journalPath)).toBe(false)
  })

  it('refuses a second live owner and serializes simultaneous acquisition around the journal', async () => {
    const f = fixture()
    const other = createWindowsSystemProxy(f.options)
    const results = await Promise.allSettled([f.service.enable(18765), other.enable(18766)])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    const saved = fs.readFileSync(f.journalPath, 'utf8')
    await expect(other.recover()).rejects.toThrow('另一实例正在使用系统代理')
    await expect(other.restore()).rejects.toThrow('另一实例正在使用系统代理')
    expect(fs.readFileSync(f.journalPath, 'utf8')).toBe(saved)
    expect(f.current).toEqual(buildWindowsLoopbackProxySnapshot(18765))
    await f.service.restore()
  })

  it.each([null, '134022112349999999'])('recovers only a dead owner or a reused PID with a different creation time: %s', async (time) => {
    const f = fixture()
    await f.service.enable(18765)
    f.ownerTime = time
    await createWindowsSystemProxy(f.options).recover()
    expect(f.current).toEqual(f.before)
    expect(fs.existsSync(f.journalPath)).toBe(false)
    expect(fs.existsSync(f.lockPath)).toBe(false)
  })

  it('recovers an abandoned pre-write lease without changing the OS', async () => {
    const f = fixture()
    fs.writeFileSync(f.lockPath, JSON.stringify({ version: 1, id: '74f03e7f-3d83-40f5-8e56-0b6d86f98fd2', owner: { pid: 77, startedAt: '134022112340000000' } }), 'utf8')
    f.ownerTime = null
    await f.service.recover()
    expect(f.mutations).toHaveLength(0)
    expect(fs.existsSync(f.lockPath)).toBe(false)
  })

  it('retains the journal when restoration fails so a later stop can retry', async () => {
    const f = fixture()
    await f.service.enable(18765)
    f.failApply = 'before'
    await expect(f.service.restore()).rejects.toThrow('Windows 系统代理操作未完成')
    expect(fs.existsSync(f.journalPath)).toBe(true)
    expect(fs.existsSync(f.lockPath)).toBe(true)
    await f.service.restore()
    expect(f.current).toEqual(f.before)
  })

  it('fails closed on corrupt or mismatched recovery data without printing source text', async () => {
    const f = fixture()
    await f.service.enable(18765)
    fs.writeFileSync(f.journalPath, '{secret:https://user:password@example.test}', 'utf8')
    await expect(f.service.restore()).rejects.toThrow('系统代理恢复记录损坏，已保留原文件。')
    expect(f.mutations).toHaveLength(1)
    expect(fs.readFileSync(f.journalPath, 'utf8')).toContain('password')
  })

  it('uses a fixed encoded script and passes proxy strings only as data in the sanitized environment', async () => {
    const f = fixture()
    f.current = { ...f.before, autoConfigUrl: 'https://example.test/$(Start-Process calc);x', registry: { ...f.before.registry, AutoConfigURL: 'https://example.test/$(Start-Process calc);x' } }
    await f.service.enable(18765)
    for (const [command, options] of f.execute.mock.calls) {
      expect(command.executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
      expect(command.argv.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
      const script = Buffer.from(command.argv[4], 'base64').toString('utf16le')
      expect(script).not.toContain('Start-Process calc')
      expect(script).toContain('InternetQueryOptionW')
      expect(script).toContain('InternetSetOptionW')
      expect(script).toContain('DefaultDllImportSearchPaths(DllImportSearchPath.System32)')
      expect(script).not.toContain('DefaultConnectionSettings')
      expect(options).toMatchObject({ trustedOnly: true, windowsHide: true, timeoutMs: 15_000, maxOutputBytes: 96 * 1024 })
    }
    await f.service.restore()
  })

  it('validates ports, platform and journal paths before requesting native changes', async () => {
    const f = fixture()
    expect(() => f.service.enable(80)).toThrow('本地代理端口无效')
    expect(() => createWindowsSystemProxy({ journalPath: '../untrusted.json' })).toThrow('绝对路径')
    await expect(createWindowsSystemProxy({ ...f.options, platform: 'darwin' }).enable(18765)).rejects.toThrow('当前系统暂不支持')
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('rejects unrecognized proxy flags and invalid registry values', () => {
    expect(() => parseWindowsProxySnapshot({ ...originalSnapshot(), flags: 16 })).toThrow('系统代理状态无效')
    expect(() => parseWindowsProxySnapshot({ ...originalSnapshot(), registry: { ProxyEnable: 'yes' } })).toThrow('系统代理状态无效')
  })
})
