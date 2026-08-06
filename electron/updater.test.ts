import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createUpdaterService, type UpdateClient } from './updater'

class FakeUpdater extends EventEmitter implements UpdateClient {
  autoDownload = true
  autoInstallOnAppQuit = true
  autoRunAppAfterInstall = false
  allowPrerelease = true
  allowDowngrade = true
  disableWebInstaller = false
  forceDevUpdateConfig = false
  logger: unknown = console
  checkForUpdates = vi.fn(async () => undefined)
  downloadUpdate = vi.fn(async () => undefined)
  quitAndInstall = vi.fn()
}

const updateInfo = (version = '1.1.0') => ({
  version,
  files: [],
  path: '',
  sha512: '',
  releaseDate: '2026-07-24T00:00:00.000Z',
  releaseName: `Version ${version}`,
  releaseNotes: 'Changes',
})

describe('updater service', () => {
  it('is disabled while unpackaged and configures conservative updater options', async () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: false })

    expect(service.getState().phase).toBe('disabled')
    expect(client).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      autoRunAppAfterInstall: true,
      allowPrerelease: false,
      allowDowngrade: false,
      disableWebInstaller: true,
      forceDevUpdateConfig: false,
      logger: null,
    })
    await expect(service.check()).rejects.toThrow('开发环境未启用')
  })

  it('normalizes check, available, progress and downloaded events', async () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true })
    const changes: string[] = []
    service.subscribe((state) => changes.push(state.phase))

    const checking = service.check()
    client.emit('update-available', updateInfo())
    await checking
    expect(service.getState()).toMatchObject({
      phase: 'available',
      availableVersion: '1.1.0',
      releaseName: 'Version 1.1.0',
      releaseNotesText: 'Changes',
    })

    const downloading = service.download()
    client.emit('download-progress', {
      percent: 47.5,
      bytesPerSecond: 1024,
      transferred: 475,
      total: 1000,
      delta: 10,
    })
    client.emit('update-downloaded', updateInfo())
    await downloading
    expect(service.getState().phase).toBe('downloaded')
    expect(changes).toContain('downloading')
  })

  it('checks, downloads and restarts automatically during startup when an update is available', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockImplementationOnce(async () => {
      client.emit('update-available', updateInfo())
    })
    client.downloadUpdate.mockImplementationOnce(async () => {
      client.emit('update-downloaded', updateInfo())
    })
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true })

    await expect(service.startup()).resolves.toMatchObject({
      phase: 'downloaded',
      availableVersion: '1.1.0',
    })
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(client.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(client.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(client.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('continues startup when the update check exceeds its deadline', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockImplementationOnce(() => new Promise(() => undefined))
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      startupCheckTimeoutMs: 10,
    })

    await expect(service.startup()).resolves.toMatchObject({
      phase: 'error',
      error: {
        code: 'STARTUP_UPDATE_TIMEOUT',
        message: '启动更新检查超时，已继续打开主程序',
      },
    })
    expect(client.downloadUpdate).not.toHaveBeenCalled()
  })

  it('continues a timed-out check and downloads a release discovered late', async () => {
    const client = new FakeUpdater()
    let resolveCheck: (() => void) | null = null
    client.checkForUpdates.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveCheck = resolve
    }))
    client.downloadUpdate.mockImplementationOnce(async () => {
      client.emit('update-downloaded', updateInfo('1.2.0'))
    })
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      startupCheckTimeoutMs: 10,
    })

    await expect(service.startup()).resolves.toMatchObject({
      phase: 'error',
      error: { code: 'STARTUP_UPDATE_TIMEOUT' },
    })
    client.emit('update-available', updateInfo('1.2.0'))
    resolveCheck?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(service.getState().phase).toBe('downloaded')
  })

  it('preserves an available event that arrives before the check promise settles', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeUpdater()
      let resolveCheck: (() => void) | null = null
      client.checkForUpdates.mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveCheck = resolve
      }))
      client.downloadUpdate.mockImplementationOnce(async () => {
        client.emit('update-downloaded', updateInfo('1.3.0'))
      })
      const service = createUpdaterService(client, {
        currentVersion: '1.0.0',
        isPackaged: true,
        startupCheckTimeoutMs: 10,
      })

      const startup = service.startup()
      client.emit('update-available', updateInfo('1.3.0'))
      await vi.advanceTimersByTimeAsync(10)

      await expect(startup).resolves.toMatchObject({
        phase: 'downloaded',
        availableVersion: '1.3.0',
        error: null,
      })
      expect(client.downloadUpdate).toHaveBeenCalledTimes(1)
      resolveCheck?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(client.downloadUpdate).toHaveBeenCalledTimes(1)
      service.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('automatically restarts to install a verified downloaded update in a packaged app', async () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true })
    expect(() => service.install()).toThrow('尚未下载')
    client.emit('update-downloaded', updateInfo())
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(client.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(service.install()).toEqual({ accepted: true })
    expect(client.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('launches the verified installer inside the configured environment guard', async () => {
    const client = new FakeUpdater()
    const guardedLaunch = vi.fn((launch: () => void) => launch())
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      installEnvironmentGuard: guardedLaunch,
    })

    client.emit('update-downloaded', updateInfo())
    await new Promise((resolve) => setTimeout(resolve, 350))

    expect(guardedLaunch).toHaveBeenCalledOnce()
    expect(client.quitAndInstall).toHaveBeenCalledWith(true, true)
    service.dispose()
  })

  it('keeps a downloaded update ready instead of replacing it during a scheduled check', async () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true })
    client.emit('update-downloaded', updateInfo())

    await expect(service.check()).resolves.toMatchObject({ phase: 'downloaded' })
    expect(client.checkForUpdates).not.toHaveBeenCalled()
  })

  it('redacts updater errors and detaches listeners', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockRejectedValueOnce(new Error(
      'https://user:password@example.test/latest.yml?token=secret sk-private-value',
    ))
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true })
    await service.check()
    const state = service.getState()
    expect(state.phase).toBe('error')
    expect(JSON.stringify(state)).not.toContain('password')
    expect(JSON.stringify(state)).not.toContain('secret')
    expect(JSON.stringify(state)).not.toContain('sk-private-value')
    service.dispose()
    expect(client.listenerCount('error')).toBe(0)
  })

  it('reports an actionable error when latest.yml is routed to the website SPA', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockRejectedValueOnce(new Error(
      'YAMLException: unexpected token "<" while parsing <!doctype html>',
    ))
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true })

    await service.check()

    expect(service.getState()).toMatchObject({
      phase: 'error',
      error: {
        code: 'UPDATE_ERROR',
        message: '更新服务器返回了网页而不是 latest.yml，请检查静态更新目录配置',
      },
    })
  })

  it('enables dev config for explicit testing but blocks installation', () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: false,
      enableDevelopmentUpdates: true,
    })
    expect(client.forceDevUpdateConfig).toBe(true)
    client.emit('update-downloaded', updateInfo())
    expect(() => service.install()).toThrow('开发环境禁止')
  })

  it('does not hold the development startup screen while a test update downloads', async () => {
    const client = new FakeUpdater()
    let finishDownload: (() => void) | null = null
    client.checkForUpdates.mockImplementationOnce(async () => {
      client.emit('update-available', updateInfo())
    })
    client.downloadUpdate.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishDownload = resolve
    }))
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: false,
      enableDevelopmentUpdates: true,
    })

    await expect(service.startup()).resolves.toMatchObject({
      phase: 'available',
      development: true,
    })
    expect(client.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(service.getState().phase).toBe('downloading')
    finishDownload?.()
  })

  it('keeps a verified package retryable when launching the installer fails', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeUpdater()
      client.quitAndInstall
        .mockImplementationOnce(() => {
          throw new Error('installer spawn failed')
        })
        .mockImplementationOnce(() => undefined)
      const service = createUpdaterService(client, {
        currentVersion: '1.0.0',
        isPackaged: true,
      })

      client.emit('update-downloaded', updateInfo())
      await vi.advanceTimersByTimeAsync(300)
      expect(service.getState()).toMatchObject({
        phase: 'downloaded',
        error: { message: 'installer spawn failed' },
      })
      expect(service.install()).toEqual({ accepted: true })
      expect(client.quitAndInstall).toHaveBeenCalledTimes(2)
      expect(service.getState().error).toBeNull()
      service.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows a manual check to re-enter checking after an install failure', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeUpdater()
      client.quitAndInstall.mockImplementationOnce(() => {
        throw new Error('installer spawn failed')
      })
      const service = createUpdaterService(client, {
        currentVersion: '1.0.0',
        isPackaged: true,
      })

      client.emit('update-downloaded', updateInfo())
      await vi.advanceTimersByTimeAsync(300)
      expect(service.getState()).toMatchObject({
        phase: 'downloaded',
        error: { message: 'installer spawn failed' },
      })

      await expect(service.check()).resolves.toMatchObject({ phase: 'checking', error: null })
      expect(client.checkForUpdates).toHaveBeenCalledTimes(1)
      service.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a launch timeout, permits retry, and cancels duplicate install timers on dispose', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeUpdater()
      const service = createUpdaterService(client, {
        currentVersion: '1.0.0',
        isPackaged: true,
        installLaunchTimeoutMs: 25,
      })

      client.emit('update-downloaded', updateInfo())
      client.emit('update-downloaded', updateInfo())
      await vi.advanceTimersByTimeAsync(325)
      expect(client.quitAndInstall).toHaveBeenCalledTimes(1)
      expect(service.getState()).toMatchObject({
        phase: 'downloaded',
        error: { code: 'UPDATE_INSTALL_LAUNCH_TIMEOUT' },
      })
      expect(service.install()).toEqual({ accepted: true })
      expect(client.quitAndInstall).toHaveBeenCalledTimes(2)
      service.dispose()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(client.quitAndInstall).toHaveBeenCalledTimes(2)

      const disposedClient = new FakeUpdater()
      const disposedService = createUpdaterService(disposedClient, {
        currentVersion: '1.0.0',
        isPackaged: true,
      })
      disposedClient.emit('update-downloaded', updateInfo())
      disposedClient.emit('update-downloaded', updateInfo())
      disposedService.dispose()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(disposedClient.quitAndInstall).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
