import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { updateNetworkFailureMessages } from './network-failure'
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

// Chromium surfaces an unreachable proxy as a structured net error code; the
// message alone must never be enough to take the session off the proxy.
const proxyConnectionError = () => Object.assign(
  new Error('net::ERR_PROXY_CONNECTION_FAILED'),
  { code: 'ERR_PROXY_CONNECTION_FAILED' },
)

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

  it('lets the host finish its quit cleanup before launching the installer', async () => {
    const client = new FakeUpdater()
    let release!: () => void
    const prepareInstallQuit = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      unsignedChannel: true,
      prepareInstallQuit,
    })
    client.emit('update-downloaded', updateInfo())
    expect(service.install()).toEqual({ accepted: true })
    expect(prepareInstallQuit).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(client.quitAndInstall).not.toHaveBeenCalled()
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.quitAndInstall).toHaveBeenCalledWith(true, true)
    service.dispose()
  })

  it('launches synchronously when the host is already quitting', () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      unsignedChannel: true,
      prepareInstallQuit: () => undefined,
    })
    client.emit('update-downloaded', updateInfo())
    service.install()
    expect(client.quitAndInstall).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('reports a failed quit preparation as an install failure and lets the host stand back up', async () => {
    const client = new FakeUpdater()
    const installQuitAborted = vi.fn()
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      unsignedChannel: true,
      prepareInstallQuit: () => Promise.reject(new Error('窗口已关闭，无法安装更新')),
      installQuitAborted,
    })
    client.emit('update-downloaded', updateInfo())
    service.install()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(client.quitAndInstall).not.toHaveBeenCalled()
    expect(installQuitAborted).toHaveBeenCalledOnce()
    expect(service.getState()).toMatchObject({ phase: 'downloaded', failedStep: 'install' })
    service.dispose()
  })

  it('lets the host stand back up when the installer never starts', async () => {
    const client = new FakeUpdater()
    const installQuitAborted = vi.fn()
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      unsignedChannel: true,
      installLaunchTimeoutMs: 20,
      prepareInstallQuit: () => Promise.resolve(),
      installQuitAborted,
    })
    client.emit('update-downloaded', updateInfo())
    service.install()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(client.quitAndInstall).toHaveBeenCalledOnce()
    expect(installQuitAborted).toHaveBeenCalledOnce()
    expect(service.getState()).toMatchObject({ phase: 'downloaded', failedStep: 'install' })
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
    client.checkForUpdates.mockRejectedValueOnce(proxyConnectionError())
    const order: string[] = []
    const retryWithoutProxy = vi.fn(async () => {
      order.push('direct')
      client.checkForUpdates.mockImplementationOnce(async () => {
        order.push('request')
        client.emit('update-not-available', updateInfo('1.0.0'))
      })
    })
    const restoreProxy = vi.fn(async () => { order.push('restore') })
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      retryWithoutProxy,
      restoreProxy,
    })

    await expect(service.check()).resolves.toMatchObject({
      phase: 'not-available',
      availableVersion: null,
      error: null,
    })
    expect(retryWithoutProxy).toHaveBeenCalledOnce()
    expect(client.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['direct', 'request', 'restore'])
    service.dispose()
  })

  it('unwraps a proxy connection failure reported through an error cause', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockRejectedValueOnce(
      new Error('无法获取更新信息', { cause: proxyConnectionError() }),
    )
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

    await expect(service.check()).resolves.toMatchObject({ phase: 'not-available' })
    expect(retryWithoutProxy).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('does not leave the updater session off-proxy when the retry also fails', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockRejectedValueOnce(proxyConnectionError())
    client.checkForUpdates.mockRejectedValueOnce(new Error('依旧连不上'))
    const retryWithoutProxy = vi.fn(async () => {})
    const restoreProxy = vi.fn(async () => {})
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      retryWithoutProxy,
      restoreProxy,
    })

    await expect(service.check()).resolves.toMatchObject({ phase: 'error' })
    expect(restoreProxy).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('keeps reporting the update error when restoring the proxy throws', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockRejectedValueOnce(proxyConnectionError())
    client.checkForUpdates.mockRejectedValueOnce(new Error('依旧连不上'))
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      retryWithoutProxy: async () => {},
      restoreProxy: async () => { throw new Error('恢复代理失败') },
    })

    const state = await service.check()
    expect(state.phase).toBe('error')
    expect(state.error?.message).toContain('依旧连不上')
    service.dispose()
  })

  it('never switches to direct mode for text that merely mentions the proxy error', async () => {
    const client = new FakeUpdater()
    // A mirror's HTML error body or a release note is attacker- or
    // operator-controlled text; it must not be able to drop the user's proxy.
    client.checkForUpdates.mockRejectedValueOnce(
      new Error('更新源返回异常: net::ERR_PROXY_CONNECTION_FAILED / proxy connection failed'),
    )
    const retryWithoutProxy = vi.fn(async () => {})
    const restoreProxy = vi.fn(async () => {})
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      retryWithoutProxy,
      restoreProxy,
    })

    await expect(service.check()).resolves.toMatchObject({ phase: 'error' })
    expect(retryWithoutProxy).not.toHaveBeenCalled()
    expect(restoreProxy).not.toHaveBeenCalled()
    expect(client.checkForUpdates).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('restores the proxy after a direct-mode download retry', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockImplementationOnce(async () => {
      client.emit('update-available', updateInfo())
    })
    client.downloadUpdate.mockRejectedValueOnce(proxyConnectionError())
    const restoreProxy = vi.fn(async () => {})
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      unsignedChannel: true,
      retryWithoutProxy: async () => {
        client.downloadUpdate.mockImplementationOnce(async () => {
          client.emit('update-downloaded', updateInfo())
        })
      },
      restoreProxy,
    })

    await service.check()
    await expect(service.download()).resolves.toMatchObject({ phase: 'downloaded' })
    expect(restoreProxy).toHaveBeenCalledOnce()
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

describe('unsigned release channel', () => {
  it('reports the unsigned channel in every snapshot it hands the renderer', () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      unsignedChannel: true,
    })

    expect(service.getState().unsignedChannel).toBe(true)
    expect(createUpdaterService(new FakeUpdater(), { currentVersion: '1.0.0', isPackaged: true })
      .getState().unsignedChannel).toBe(false)
    service.dispose()
  })

  it('stops startup at the discovered version instead of downloading it unattended', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockImplementationOnce(async () => {
      client.emit('update-available', updateInfo())
    })
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      unsignedChannel: true,
    })

    await expect(service.startup()).resolves.toMatchObject({
      phase: 'available',
      availableVersion: '1.1.0',
    })
    expect(client.downloadUpdate).not.toHaveBeenCalled()
    service.dispose()
  })

  it('downloads only when the user asks and still waits before installing', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockImplementationOnce(async () => {
      client.emit('update-available', updateInfo())
    })
    client.downloadUpdate.mockImplementationOnce(async () => {
      client.emit('update-downloaded', updateInfo())
    })
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      unsignedChannel: true,
    })

    await service.check()
    await expect(service.download()).resolves.toMatchObject({ phase: 'downloaded' })
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(client.quitAndInstall).not.toHaveBeenCalled()

    expect(service.install()).toEqual({ accepted: true })
    expect(client.quitAndInstall).toHaveBeenCalledWith(true, true)
    service.dispose()
  })

  it('does not release a startup download the slow-check path would otherwise begin', async () => {
    const client = new FakeUpdater()
    let releaseCheck = () => {}
    client.checkForUpdates.mockImplementationOnce(() => new Promise((resolve) => {
      releaseCheck = () => {
        client.emit('update-available', updateInfo())
        resolve(undefined)
      }
    }))
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      unsignedChannel: true,
      startupCheckTimeoutMs: 5,
    })

    await expect(service.startup()).resolves.toMatchObject({ phase: 'error' })
    releaseCheck()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.downloadUpdate).not.toHaveBeenCalled()
    service.dispose()
  })
})

describe('downloaded package digest verification', () => {
  const downloadedFile = 'C:\\Users\\tester\\AppData\\Local\\xingmang-updater\\XingMang-AI-Manager-1.1.0-Setup.exe'
  const downloadedInfo = (overrides: Record<string, unknown> = {}) => ({
    ...updateInfo(),
    files: [{ url: 'XingMang-AI-Manager-1.1.0-Setup.exe', sha512: 'manifest-digest', size: 42 }],
    downloadedFile,
    ...overrides,
  })

  it('accepts the package once the recomputed digest matches the manifest', async () => {
    const client = new FakeUpdater()
    const verifyPackageDigest = vi.fn(async () => true)
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      verifyPackageDigest,
    })

    client.emit('update-downloaded', downloadedInfo())
    await vi.waitFor(() => expect(service.getState().phase).toBe('downloaded'))
    expect(verifyPackageDigest).toHaveBeenCalledWith(downloadedFile, 'manifest-digest')
    service.dispose()
  })

  it('picks the manifest entry belonging to the file that was downloaded', async () => {
    const client = new FakeUpdater()
    const verifyPackageDigest = vi.fn(async () => true)
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      verifyPackageDigest,
    })

    client.emit('update-downloaded', downloadedInfo({
      files: [
        { url: 'XingMang-AI-Manager-1.1.0-arm64.zip', sha512: 'other-digest', size: 7 },
        { url: 'XingMang%2DAI%2DManager-1.1.0-Setup.exe', sha512: 'wanted-digest', size: 42 },
      ],
    }))
    await vi.waitFor(() => expect(service.getState().phase).toBe('downloaded'))
    expect(verifyPackageDigest).toHaveBeenCalledWith(downloadedFile, 'wanted-digest')
    service.dispose()
  })

  it('refuses to install a package whose digest differs from the manifest', async () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      verifyPackageDigest: async () => false,
    })

    client.emit('update-downloaded', downloadedInfo())
    await vi.waitFor(() => expect(service.getState().phase).toBe('error'))
    expect(service.getState().error).toMatchObject({ code: 'UPDATE_PACKAGE_DIGEST_MISMATCH' })
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(client.quitAndInstall).not.toHaveBeenCalled()
    expect(() => service.install()).toThrow('尚未下载')
    service.dispose()
  })

  it('refuses a manifest that carries no digest for the downloaded package', async () => {
    const client = new FakeUpdater()
    const verifyPackageDigest = vi.fn(async () => true)
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      verifyPackageDigest,
    })

    client.emit('update-downloaded', downloadedInfo({
      files: [
        { url: 'XingMang-AI-Manager-1.1.0-arm64.zip', sha512: 'other-digest', size: 7 },
        { url: 'XingMang-AI-Manager-1.1.0-Setup.exe', sha512: '   ', size: 42 },
      ],
      sha512: '',
    }))
    await vi.waitFor(() => expect(service.getState().phase).toBe('error'))
    expect(service.getState().error).toMatchObject({ code: 'UPDATE_PACKAGE_DIGEST_MISSING' })
    expect(verifyPackageDigest).not.toHaveBeenCalled()
    service.dispose()
  })

  it('refuses an update whose package location the updater never reported', async () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      verifyPackageDigest: async () => true,
    })

    client.emit('update-downloaded', downloadedInfo({ downloadedFile: '  ' }))
    await vi.waitFor(() => expect(service.getState().phase).toBe('error'))
    expect(service.getState().error).toMatchObject({ code: 'UPDATE_PACKAGE_PATH_MISSING' })
    service.dispose()
  })

  it('treats a verification that cannot be completed as a rejection', async () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      verifyPackageDigest: async () => { throw new Error('更新安装包存在多个硬链接') },
    })

    client.emit('update-downloaded', downloadedInfo())
    await vi.waitFor(() => expect(service.getState().phase).toBe('error'))
    expect(service.getState().error).toMatchObject({
      code: 'UPDATE_PACKAGE_DIGEST_FAILED',
      message: expect.stringContaining('更新安装包存在多个硬链接'),
    })
    service.dispose()
  })

  it('keeps the unverified digest path out of builds that configure no verifier', async () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true })

    client.emit('update-downloaded', downloadedInfo({ files: [] }))
    expect(service.getState().phase).toBe('downloaded')
    service.dispose()
  })

  // 断网点一次「检查更新」，原来会被告知「更新没有装上」还给一个「重新下载」按钮——
  // 更新其实根本没开始下。失败步骤和中文原因一起，是这套文案的唯一来源。
  it('reports a failed check as the check step with a Chinese network reason', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockRejectedValueOnce(
      Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED'), { code: 'ERR_INTERNET_DISCONNECTED' }),
    )
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true })

    const state = await service.check()
    expect(state).toMatchObject({
      phase: 'error',
      failedStep: 'check',
      // 原始 code 留给 runtime.jsonl，界面上一个英文都不剩。
      error: { code: 'ERR_INTERNET_DISCONNECTED', message: updateNetworkFailureMessages.offline },
    })
    expect(state.error?.message).not.toMatch(/net::/)
    service.dispose()
  })

  it('reports a failed download as the download step', async () => {
    const client = new FakeUpdater()
    client.downloadUpdate.mockRejectedValueOnce(
      Object.assign(new Error('read ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    )
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true })

    client.emit('update-available', updateInfo())
    const state = await service.download()
    expect(state).toMatchObject({
      phase: 'error',
      failedStep: 'download',
      error: { code: 'ETIMEDOUT', message: updateNetworkFailureMessages.timeout },
    })
    service.dispose()
  })

  it('reports a failed install as the install step and keeps the verified package', async () => {
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
      expect(service.getState()).toMatchObject({ phase: 'downloaded', failedStep: 'install' })
      service.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  // 安装包校验不过时本地那一份已经不可信，要重来的是下载而不是安装。
  it('sends a rejected package back to the download step', async () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      verifyPackageDigest: async () => false,
    })

    client.emit('update-downloaded', downloadedInfo())
    await vi.waitFor(() => expect(service.getState().phase).toBe('error'))
    expect(service.getState().failedStep).toBe('download')
    service.dispose()
  })

  // 界面按 failedStep 给按钮，所以「安装失败」这个说法只能出现在安装包还在的时候，
  // 否则「重新安装」会被主进程以「更新尚未下载并校验完成」当场顶回来。
  it('never claims an install failure once the package is gone', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeUpdater()
      const service = createUpdaterService(client, {
        currentVersion: '1.0.0',
        isPackaged: true,
        platform: 'win32',
      })

      client.emit('update-downloaded', updateInfo())
      client.emit('error', new Error('update file was removed'))
      expect(service.getState()).toMatchObject({ phase: 'error', failedStep: 'download' })
      service.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the failed step as soon as a later check succeeds', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'))
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true })

    expect(await service.check()).toMatchObject({
      failedStep: 'check',
      error: { message: updateNetworkFailureMessages.dns },
    })
    client.emit('update-not-available', updateInfo())
    expect(service.getState()).toMatchObject({ phase: 'not-available', error: null, failedStep: null })
    service.dispose()
  })

  // 更新清单缺失、服务器回网页这两条早就有中文说法了，网络归类不许把它们吃掉。
  it('leaves the manifest diagnoses alone when the failure is not a network one', async () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      platform: 'win32',
    })

    client.emit('error', Object.assign(new Error('not found'), {
      code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
    }))
    expect(service.getState()).toMatchObject({
      failedStep: 'check',
      error: { message: expect.stringContaining('尚未发布更新清单') },
    })
    service.dispose()
  })
})
