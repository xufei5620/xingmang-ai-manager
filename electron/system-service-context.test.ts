import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import type { DownloadAccelerationLease } from './download-acceleration'
import { createServiceContext } from './system-service-context'
import type { SystemServiceOptions } from './system-service'

// #1070 第 2 步把 createSystemService 开头那段搬成了 createServiceContext。这里钉住各簇都会拿去用、
// 搬家时最容易悄悄变样的几条：缺省往严里取、管理员身份查 npm 元数据不换 fetch、下载加速的计数和归还、
// 日志里的失败原因不带用户目录、Windows 最新 PATH 的读取和交出、保存配置的排队。

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.unstubAllGlobals()
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function createContext(options: SystemServiceOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-service-context-'))
  temporaryDirectories.push(root)
  const store = new AppSettingsStore(path.join(root, 'settings.json'), root)
  return createServiceContext(store, {
    managerDataDirectory: root,
    providerRoots: { userHome: path.join(root, 'home'), codexHome: path.join(root, 'codex') },
    ...options,
  })
}

function lease(accelerated: boolean) {
  const release = vi.fn(async () => undefined)
  const value: DownloadAccelerationLease = { endpoint: null, accelerated, release }
  return { value, release }
}

describe('system service context', () => {
  it('fails closed when the host does not say how commands may run', () => {
    const context = createContext()

    expect(context.windowsExecutionMode).toBe('trusted-only')
    expect(context.platform).toBe(process.platform)
    expect(context.codexEnv.CODEX_HOME).toBe(context.providerRoots.codexHome)
  })

  it('keeps the elevated npm metadata lookup on the bundled certificate store', async () => {
    const globalFetch = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', globalFetch)
    const registryFetch = vi.fn(async () => new Response('{}'))

    const elevated = createContext({ platform: 'win32', windowsExecutionMode: 'trusted-only', registryFetch })
    await elevated.registryMetadataFetch('https://registry.npmjs.org/x')
    expect(registryFetch).not.toHaveBeenCalled()
    expect(globalFetch).toHaveBeenCalledTimes(1)

    const sameUser = createContext({ platform: 'win32', windowsExecutionMode: 'same-user', registryFetch })
    await sameUser.registryMetadataFetch('https://registry.npmjs.org/x')
    expect(registryFetch).toHaveBeenCalledTimes(1)
    expect(globalFetch).toHaveBeenCalledTimes(1)
  })

  it('counts an accelerated download only while it runs and always hands the lease back', async () => {
    const accelerated = lease(true)
    const context = createContext({ acquireDownloadAcceleration: async () => accelerated.value })
    const notes: string[] = []

    const seen = await context.withDownloadAcceleration((message) => notes.push(message), async () => context.acceleratedDownloadCount())
    expect(seen).toBe(1)
    expect(context.acceleratedDownloadCount()).toBe(0)
    expect(accelerated.release).toHaveBeenCalledTimes(1)
    expect(notes).toEqual(['正在准备下载加速', '已为本次下载启用加速线路（未改动系统代理）'])

    await expect(context.withDownloadAcceleration(null, async () => {
      throw new Error('下载失败')
    })).rejects.toThrow('下载失败')
    expect(context.acceleratedDownloadCount()).toBe(0)
    expect(accelerated.release).toHaveBeenCalledTimes(2)
  })

  it('still downloads when no accelerated line can be had', async () => {
    const direct = lease(false)
    const acquireFailing = vi.fn(async (): Promise<DownloadAccelerationLease> => {
      throw new Error('加速没起来')
    })
    const unavailable = createContext({ acquireDownloadAcceleration: acquireFailing })
    await expect(unavailable.withDownloadAcceleration(null, async () => 'done')).resolves.toBe('done')
    expect(acquireFailing).toHaveBeenCalledTimes(1)

    const notAccelerated = createContext({ acquireDownloadAcceleration: async () => direct.value })
    const seen = await notAccelerated.withDownloadAcceleration(null, async () => notAccelerated.acceleratedDownloadCount())
    expect(seen).toBe(0)
    expect(direct.release).toHaveBeenCalledTimes(1)
  })

  it('adds the file-in-use sentence only when the failure really is a locked file', async () => {
    const logged: string[] = []
    const context = createContext({ runtimeLog: { log: (_level, _source, event) => { logged.push(event) } } })

    await expect(context.describeOccupiedCliFailure('claude', new Error('下载失败'), '下载失败', null, '更新')).resolves.toBeNull()
    expect(logged).toEqual([])
  })

  it('keeps the user home out of a logged failure reason', () => {
    const context = createContext()
    const home = context.providerRoots.userHome

    const reason = context.credentialFailureReason(new Error(`EACCES: ${path.join(home, '.claude', 'settings.json')}`))

    expect(reason).not.toContain(home)
    expect(reason).toContain('settings.json')
    expect(context.credentialFailureReason('plain text')).toBe('plain text')
  })

  it('hands out the newest Windows PATH it read and reads it at most once every few seconds', async () => {
    const readWindowsLivePath = vi.fn(async () => 'C:\\Program Files\\PowerShell\\7')
    const context = createContext({
      platform: 'win32',
      readWindowsLivePath,
      resolveWindowsMachinePaths: () => ({
        systemRoot: 'C:\\Windows',
        system32: 'C:\\Windows\\System32',
        programFiles: 'C:\\Program Files',
        programFilesX86: null,
        programData: 'C:\\ProgramData',
      }),
    })
    expect(context.currentWindowsLivePath()).toBeNull()

    await Promise.all([context.refreshWindowsLivePath(), context.refreshWindowsLivePath()])
    await context.refreshWindowsLivePath()

    expect(context.currentWindowsLivePath()).toBe('C:\\Program Files\\PowerShell\\7')
    expect(readWindowsLivePath).toHaveBeenCalledTimes(1)
    expect(readWindowsLivePath).toHaveBeenCalledWith('C:\\Windows\\System32', process.env)
  })

  it('never reads the Windows PATH on other systems', async () => {
    const readWindowsLivePath = vi.fn(async () => 'C:\\x')
    const context = createContext({ platform: 'darwin', readWindowsLivePath })

    await context.refreshWindowsLivePath()

    expect(readWindowsLivePath).not.toHaveBeenCalled()
    expect(context.currentWindowsLivePath()).toBeNull()
  })

  it('runs queued config writes one after another even after one fails', async () => {
    const context = createContext()
    const order: string[] = []
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = context.serializeConfigWrite(async () => {
      order.push('first:start')
      await firstHeld
      order.push('first:end')
      throw new Error('写失败')
    })
    const second = context.serializeConfigWrite(async () => {
      order.push('second')
      return 'saved'
    })
    await Promise.resolve()
    expect(order).toEqual(['first:start'])
    releaseFirst()

    await expect(first).rejects.toThrow('写失败')
    await expect(second).resolves.toBe('saved')
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })
})
