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
  // Typed to match UpdateClient's `Promise<unknown>` return so mockImplementationOnce
  // can be swapped for any Promise-returning implementation used in the tests below,
  // not just ones resolving with `undefined`.
  checkForUpdates = vi.fn<() => Promise<unknown>>(async () => undefined)
  downloadUpdate = vi.fn<() => Promise<unknown>>(async () => undefined)
  quitAndInstall = vi.fn()
}

class FakeMacUpdater extends FakeUpdater {
  readonly nativeUpdater = new EventEmitter()
  readonly nativeCheckForUpdates = vi.fn()
  readonly nativeQuitAndInstall = vi.fn()
  private squirrelDownloadedUpdate = false

  constructor() {
    super()
    this.nativeUpdater.on('error', (error) => this.emit('error', error))
    this.nativeUpdater.on('update-downloaded', () => {
      this.squirrelDownloadedUpdate = true
    })
    this.quitAndInstall.mockImplementation(() => {
      if (this.squirrelDownloadedUpdate) {
        this.nativeQuitAndInstall()
        return
      }
      this.nativeUpdater.on('update-downloaded', () => this.nativeQuitAndInstall())
      this.nativeCheckForUpdates()
    })
  }
}

const macInstallHandoffFor = (client: FakeMacUpdater) => ({
  nativeUpdateDownloadedListenerCount: () => (
    client.nativeUpdater.listenerCount('update-downloaded')
  ),
  retryNativeCheck: () => client.nativeCheckForUpdates(),
})

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

  it('is disabled for an explicitly marked local packaged build', async () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      localBuild: true,
      enableDevelopmentUpdates: true,
    })

    await expect(service.startup()).resolves.toMatchObject({
      phase: 'disabled',
      development: true,
    })
    await expect(service.check()).rejects.toThrow('开发环境未启用')
    expect(client.checkForUpdates).not.toHaveBeenCalled()
    expect(client.forceDevUpdateConfig).toBe(false)
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
    const check: { resolve: (() => void) | null } = { resolve: null }
    client.checkForUpdates.mockImplementationOnce(() => new Promise<void>((resolve) => {
      check.resolve = resolve
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
    check.resolve?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(service.getState().phase).toBe('downloaded')
  })

  it('preserves an available event that arrives before the check promise settles', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeUpdater()
      const check: { resolve: (() => void) | null } = { resolve: null }
      client.checkForUpdates.mockImplementationOnce(() => new Promise<void>((resolve) => {
        check.resolve = resolve
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
      check.resolve?.()
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

  it('retries a proxy connection failure through the updater session in direct mode', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_PROXY_CONNECTION_FAILED'))
    const retryWithoutProxy = vi.fn(async () => {
      client.checkForUpdates.mockImplementationOnce(async () => {
        client.emit('update-not-available', updateInfo('1.0.0'))
      })
    })
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      retryWithoutProxy,
    })

    await expect(service.check()).resolves.toMatchObject({
      phase: 'not-available',
      availableVersion: null,
      error: null,
    })
    expect(retryWithoutProxy).toHaveBeenCalledOnce()
    expect(client.checkForUpdates).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('reports an actionable error when latest.yml is routed to the website SPA', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockRejectedValueOnce(new Error(
      'YAMLException: unexpected token "<" while parsing <!doctype html>',
    ))
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      platform: 'win32',
    })

    await service.check()

    expect(service.getState()).toMatchObject({
      phase: 'error',
      error: {
        code: 'UPDATE_ERROR',
        message: '更新服务器返回了网页而不是 latest.yml，请检查静态更新目录配置',
      },
    })
  })

  it('names the macOS channel file when the update route returns HTML', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockRejectedValueOnce(new Error(
      'YAMLException: unexpected token "<" while parsing <!doctype html>',
    ))
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      platform: 'darwin',
    })

    await service.check()

    expect(service.getState().error?.message).toBe(
      '更新服务器返回了网页而不是 latest-mac.yml，请检查静态更新目录配置',
    )
  })

  it('turns a missing macOS channel manifest into actionable publisher guidance', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockRejectedValueOnce({
      code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
      message: 'Cannot find latest-mac.yml in the latest release artifacts',
    })
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      platform: 'darwin',
    })

    await service.check()

    expect(service.getState()).toMatchObject({
      phase: 'error',
      error: {
        code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
        message: '更新服务器尚未发布 macOS 更新清单 latest-mac.yml，请联系发布者补齐更新文件',
      },
    })
  })

  it('turns a plain HTTP 404 for the macOS channel manifest into publisher guidance', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockRejectedValueOnce(new Error(
      'HttpError: 404 Not Found for https://updates.example.test/xingmang-manager/latest-mac.yml',
    ))
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      platform: 'darwin',
    })

    await service.check()

    expect(service.getState()).toMatchObject({
      phase: 'error',
      error: {
        code: 'UPDATE_ERROR',
        message: '更新服务器尚未发布 macOS 更新清单 latest-mac.yml，请联系发布者补齐更新文件',
      },
    })
  })

  it('keeps a 404 for another resource generic when prose names the macOS channel manifest', async () => {
    const client = new FakeUpdater()
    const error = 'HttpError: 404 method: GET url: https://updates.example.test/xingmang-manager/release-notes.txt; expected latest-mac.yml'
    client.checkForUpdates.mockRejectedValueOnce(new Error(error))
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      platform: 'darwin',
    })

    await service.check()

    expect(service.getState()).toMatchObject({
      phase: 'error',
      error: { code: 'UPDATE_ERROR', message: error },
    })
  })

  it('keeps a 404 generic when a later URL names the macOS channel manifest', async () => {
    const client = new FakeUpdater()
    const error = 'HttpError: 404 method: GET url: https://updates.example.test/release-notes.txt; manifest URL: https://updates.example.test/latest-mac.yml'
    client.checkForUpdates.mockRejectedValueOnce(new Error(error))
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      platform: 'darwin',
    })

    await service.check()

    expect(service.getState()).toMatchObject({
      phase: 'error',
      error: { code: 'UPDATE_ERROR', message: error },
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
    const download: { finish: (() => void) | null } = { finish: null }
    client.checkForUpdates.mockImplementationOnce(async () => {
      client.emit('update-available', updateInfo())
    })
    client.downloadUpdate.mockImplementationOnce(() => new Promise<void>((resolve) => {
      download.finish = resolve
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
    download.finish?.()
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
        platform: 'win32',
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
        platform: 'win32',
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
        platform: 'win32',
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
        platform: 'win32',
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

  it('reports a macOS handoff timeout and reuses its listener when retrying', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeMacUpdater()
      const service = createUpdaterService(client, {
        currentVersion: '1.0.0',
        isPackaged: true,
        platform: 'darwin',
        installLaunchTimeoutMs: 25,
        macInstallHandoff: macInstallHandoffFor(client),
      })
      const updateDownloadedListenerCount = client.listenerCount('update-downloaded')
      const errorListenerCount = client.listenerCount('error')
      expect(updateDownloadedListenerCount).toBe(1)
      expect(errorListenerCount).toBe(1)

      client.emit('update-downloaded', updateInfo())
      await vi.advanceTimersByTimeAsync(300)
      expect(client.quitAndInstall).toHaveBeenCalledTimes(1)
      expect(client.nativeCheckForUpdates).toHaveBeenCalledTimes(1)
      expect(service.getState()).toMatchObject({ phase: 'downloaded', error: null })

      await vi.advanceTimersByTimeAsync(25)
      expect(service.getState()).toMatchObject({
        phase: 'downloaded',
        error: { code: 'UPDATE_INSTALL_LAUNCH_TIMEOUT' },
      })
      expect(service.install()).toEqual({ accepted: true })
      expect(client.quitAndInstall).toHaveBeenCalledTimes(1)
      expect(client.nativeCheckForUpdates).toHaveBeenCalledTimes(2)
      expect(service.getState()).toMatchObject({ phase: 'downloaded', error: null })
      expect(client.listenerCount('update-downloaded')).toBe(updateDownloadedListenerCount)
      expect(client.listenerCount('error')).toBe(errorListenerCount)

      service.dispose()
      expect(client.listenerCount('update-downloaded')).toBe(0)
      expect(client.listenerCount('error')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reuses one native macOS install handoff when retrying after an updater error', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeMacUpdater()
      const baselineNativeDownloadedListeners = client.nativeUpdater.listenerCount('update-downloaded')
      const service = createUpdaterService(client, {
        currentVersion: '1.0.0',
        isPackaged: true,
        platform: 'darwin',
        macInstallHandoff: macInstallHandoffFor(client),
      })

      client.emit('update-downloaded', updateInfo())
      await vi.advanceTimersByTimeAsync(300)
      expect(client.quitAndInstall).toHaveBeenCalledTimes(1)
      expect(client.nativeCheckForUpdates).toHaveBeenCalledTimes(1)
      expect(client.nativeUpdater.listenerCount('update-downloaded')).toBe(
        baselineNativeDownloadedListeners + 1,
      )

      client.nativeUpdater.emit('error', {
        code: 'SQUIRREL_INSTALL_FAILED',
        message: 'native install failed',
      })
      expect(service.getState()).toMatchObject({
        phase: 'downloaded',
        error: { code: 'SQUIRREL_INSTALL_FAILED' },
      })

      expect(service.install()).toEqual({ accepted: true })
      expect(client.quitAndInstall).toHaveBeenCalledTimes(1)
      expect(client.nativeCheckForUpdates).toHaveBeenCalledTimes(2)
      expect(client.nativeUpdater.listenerCount('update-downloaded')).toBe(
        baselineNativeDownloadedListeners + 1,
      )

      client.nativeUpdater.emit('update-downloaded')
      expect(client.nativeQuitAndInstall).toHaveBeenCalledTimes(1)
      service.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reuses a macOS handoff whose native check throws after registering its listener', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeMacUpdater()
      const baselineNativeDownloadedListeners = client.nativeUpdater.listenerCount('update-downloaded')
      client.nativeCheckForUpdates
        .mockImplementationOnce(() => {
          throw new Error('native check failed')
        })
        .mockImplementationOnce(() => undefined)
      const service = createUpdaterService(client, {
        currentVersion: '1.0.0',
        isPackaged: true,
        platform: 'darwin',
        macInstallHandoff: macInstallHandoffFor(client),
      })

      client.emit('update-downloaded', updateInfo())
      await vi.advanceTimersByTimeAsync(300)
      expect(service.getState()).toMatchObject({
        phase: 'downloaded',
        error: { message: 'native check failed' },
      })
      expect(client.nativeUpdater.listenerCount('update-downloaded')).toBe(
        baselineNativeDownloadedListeners + 1,
      )

      expect(service.install()).toEqual({ accepted: true })
      expect(client.quitAndInstall).toHaveBeenCalledTimes(1)
      expect(client.nativeCheckForUpdates).toHaveBeenCalledTimes(2)
      expect(client.nativeUpdater.listenerCount('update-downloaded')).toBe(
        baselineNativeDownloadedListeners + 1,
      )

      client.nativeUpdater.emit('update-downloaded')
      expect(client.nativeQuitAndInstall).toHaveBeenCalledTimes(1)
      service.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries the upstream macOS handoff when it throws before registering a listener', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeMacUpdater()
      const baselineNativeDownloadedListeners = client.nativeUpdater.listenerCount('update-downloaded')
      client.quitAndInstall
        .mockImplementationOnce(() => {
          throw new Error('pre-registration failure')
        })
        .mockImplementationOnce(() => {
          client.nativeUpdater.on('update-downloaded', () => client.nativeQuitAndInstall())
          client.nativeCheckForUpdates()
        })
      const service = createUpdaterService(client, {
        currentVersion: '1.0.0',
        isPackaged: true,
        platform: 'darwin',
        macInstallHandoff: macInstallHandoffFor(client),
      })

      client.emit('update-downloaded', updateInfo())
      await vi.advanceTimersByTimeAsync(300)
      expect(service.getState()).toMatchObject({
        phase: 'downloaded',
        error: { message: 'pre-registration failure' },
      })
      expect(client.nativeUpdater.listenerCount('update-downloaded')).toBe(
        baselineNativeDownloadedListeners,
      )

      expect(service.install()).toEqual({ accepted: true })
      expect(client.quitAndInstall).toHaveBeenCalledTimes(2)
      expect(client.nativeCheckForUpdates).toHaveBeenCalledTimes(1)
      expect(client.nativeUpdater.listenerCount('update-downloaded')).toBe(
        baselineNativeDownloadedListeners + 1,
      )
      service.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps duplicate native macOS errors retryable after the handoff starts', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeMacUpdater()
      const service = createUpdaterService(client, {
        currentVersion: '1.0.0',
        isPackaged: true,
        platform: 'darwin',
        macInstallHandoff: macInstallHandoffFor(client),
      })

      client.emit('update-downloaded', updateInfo())
      await vi.advanceTimersByTimeAsync(300)
      client.nativeUpdater.emit('error', {
        code: 'SQUIRREL_INSTALL_FAILED',
        message: 'native install failed',
      })
      client.nativeUpdater.emit('error', {
        code: 'SQUIRREL_INSTALL_FAILED_AGAIN',
        message: 'duplicate native install failure',
      })

      expect(service.getState()).toMatchObject({
        phase: 'downloaded',
        error: {
          code: 'SQUIRREL_INSTALL_FAILED_AGAIN',
          message: 'duplicate native install failure',
        },
      })
      expect(service.install()).toEqual({ accepted: true })
      expect(client.quitAndInstall).toHaveBeenCalledTimes(1)
      expect(client.nativeCheckForUpdates).toHaveBeenCalledTimes(2)
      service.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the Windows error transition after an installer launch failure', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeUpdater()
      client.quitAndInstall.mockImplementationOnce(() => {
        throw new Error('installer spawn failed')
      })
      const service = createUpdaterService(client, {
        currentVersion: '1.0.0',
        isPackaged: true,
        platform: 'win32',
      })

      client.emit('update-downloaded', updateInfo())
      await vi.advanceTimersByTimeAsync(300)
      expect(service.getState()).toMatchObject({
        phase: 'downloaded',
        error: { message: 'installer spawn failed' },
      })

      client.emit('error', { code: 'UPDATE_ERROR', message: 'updater failed again' })
      expect(service.getState()).toMatchObject({
        phase: 'error',
        error: { code: 'UPDATE_ERROR', message: 'updater failed again' },
      })
      service.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
