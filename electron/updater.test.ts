import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { updateNetworkFailureMessages } from './network-failure'
import { createUpdaterService, decideUpdateOffer, resolveGatedRequiredVersion, downloadRateWindowMs, recordDownloadProgressSample, resolveAverageDownloadRate, resolveDownloadSecondsRemaining, describeUnrecognizedUpdateFailure, isOlderVersion, requiredUpdateDiskBytes, resolveRequiredVersion, resolveUpdateDiskShortfall, resolveUpdatePackageBytes, updateDiskFallbackBytes, updateDiskMinimumBytes, type UpdateClient, type UpdaterService } from './updater'

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
  isUserWithinRollout?: UpdateClient['isUserWithinRollout']
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

// 下载好之后要用户点「重启安装」才会装（全面检测 Q42），这里替用户点这一下。
// 安装没能启动时 install() 会抛错，各用例断言的是之后的快照。
function clickInstall(service: UpdaterService): void {
  try {
    service.install()
  } catch {
    // asserted through the snapshot
  }
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

  it('checks and downloads during startup but waits for the user before restarting', async () => {
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
    expect(client.quitAndInstall).not.toHaveBeenCalled()
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
        message: '网络有点慢，这次没来得及查完有没有新版本。星芒会在后台接着查，不影响现在使用。',
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

  it('hands a late background download failure to the host instead of leaving it unhandled', async () => {
    const client = new FakeUpdater()
    const check: { resolve: (() => void) | null } = { resolve: null }
    client.checkForUpdates.mockImplementationOnce(() => new Promise<void>((resolve) => {
      check.resolve = resolve
    }))
    const reportBackgroundError = vi.fn()
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      startupCheckTimeoutMs: 10,
      reportBackgroundError,
    })
    const listenerFailure = new Error('listener failed')
    service.subscribe((snapshot) => {
      if (snapshot.phase === 'downloading') throw listenerFailure
    })
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      await expect(service.startup()).resolves.toMatchObject({ error: { code: 'STARTUP_UPDATE_TIMEOUT' } })
      client.emit('update-available', updateInfo('1.2.0'))
      check.resolve?.()
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(reportBackgroundError).toHaveBeenCalledWith(listenerFailure)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
      service.dispose()
    }
  })

  it('hands a development-mode background download failure to the host', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockImplementationOnce(async () => {
      client.emit('update-available', updateInfo('1.2.0'))
    })
    const reportBackgroundError = vi.fn()
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: false,
      enableDevelopmentUpdates: true,
      reportBackgroundError,
    })
    const listenerFailure = new Error('listener failed')
    service.subscribe((snapshot) => {
      if (snapshot.phase === 'downloading') throw listenerFailure
    })
    await expect(service.startup()).resolves.toMatchObject({ phase: 'available' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reportBackgroundError).toHaveBeenCalledWith(listenerFailure)
    service.dispose()
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

  // Q42：签名通道（Mac）以前下载完 0.3 秒就自己退出重装，不管用户手上在做什么。
  it('never restarts on its own after a verified download, on any platform', async () => {
    for (const platform of ['darwin', 'win32'] as const) {
      const client = new FakeUpdater()
      const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true, platform })
      expect(() => service.install()).toThrow('尚未下载')
      client.emit('update-downloaded', updateInfo())
      await new Promise((resolve) => setTimeout(resolve, 350))
      expect(service.getState()).toMatchObject({ phase: 'downloaded', error: null })
      expect(client.quitAndInstall).not.toHaveBeenCalled()
      expect(service.install()).toEqual({ accepted: true })
      expect(service.install()).toEqual({ accepted: true })
      expect(client.quitAndInstall).toHaveBeenCalledTimes(1)
      expect(client.quitAndInstall).toHaveBeenCalledWith(true, true)
      service.dispose()
    }
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
    service.install()

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
        message: '更新服务器这会儿返回的内容不对，不是你这边的问题。稍后再试；还不行请找客服。',
        detail: '更新服务器返回了网页而不是 latest.yml',
      },
    })
  })

  it('names the macOS channel file for support when the update route returns HTML', async () => {
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

    expect(service.getState().error?.detail).toBe('更新服务器返回了网页而不是 latest-mac.yml')
    // 文件名、「静态更新目录」是给发布那头看的，客户在三处失败提示里都只看到人话。
    expect(service.getState().error?.message).not.toMatch(/[A-Za-z]/)
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
        message: '更新服务器上这一版的更新文件还没放好，不是你这边的问题。稍后再试；急着用请找客服。',
        detail: '更新服务器缺少更新清单 latest-mac.yml',
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
        message: '更新服务器上这一版的更新文件还没放好，不是你这边的问题。稍后再试；急着用请找客服。',
        detail: '更新服务器缺少更新清单 latest-mac.yml',
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
      error: { code: 'UPDATE_ERROR', detail: error },
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
      error: { code: 'UPDATE_ERROR', detail: error },
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
      clickInstall(service)
      expect(service.getState()).toMatchObject({
        phase: 'downloaded',
        error: { detail: 'installer spawn failed' },
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
      clickInstall(service)
      expect(service.getState()).toMatchObject({
        phase: 'downloaded',
        error: { detail: 'installer spawn failed' },
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
      clickInstall(service)
      clickInstall(service)
      await vi.advanceTimersByTimeAsync(25)
      expect(client.quitAndInstall).toHaveBeenCalledTimes(1)
      expect(service.getState()).toMatchObject({
        phase: 'downloaded',
        error: { code: 'UPDATE_INSTALL_LAUNCH_TIMEOUT', message: expect.stringContaining('点「重新安装」') },
      })
      // 强制更新那道门里软件用不了、也没有更新页，这句不许再把人往那儿指。
      expect(service.getState().error?.message).not.toMatch(/照常能用|「更新」页/)
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
      clickInstall(disposedService)
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
      clickInstall(service)
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
      clickInstall(service)
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
      clickInstall(service)
      expect(service.getState()).toMatchObject({
        phase: 'downloaded',
        error: { detail: 'native check failed' },
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
      clickInstall(service)
      expect(service.getState()).toMatchObject({
        phase: 'downloaded',
        error: { detail: 'pre-registration failure' },
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
      clickInstall(service)
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
          detail: 'duplicate native install failure',
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
      clickInstall(service)
      expect(service.getState()).toMatchObject({
        phase: 'downloaded',
        error: { detail: 'installer spawn failed' },
      })

      client.emit('error', { code: 'UPDATE_ERROR', message: 'updater failed again' })
      expect(service.getState()).toMatchObject({
        phase: 'error',
        error: { code: 'UPDATE_ERROR', detail: 'updater failed again' },
      })
      service.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('service status from the update feed', () => {
  it('carries a maintenance notice into every snapshot and announces only changes', () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true })
    const seen: unknown[] = []
    service.subscribe((state) => seen.push(state.serviceMaintenance))
    expect(service.getState().serviceMaintenance).toBeNull()

    service.setServiceStatus({ maintenance: { message: '升级中' } })
    service.setServiceStatus({ maintenance: { message: '升级中' } })
    expect(service.getState()).toMatchObject({ phase: 'idle', serviceMaintenance: { message: '升级中' } })
    service.setServiceStatus(null)
    expect(service.getState().serviceMaintenance).toBeNull()
    expect(seen).toEqual([{ message: '升级中' }, null])
    service.dispose()
  })

  it('does not disturb an update failure the user is looking at', () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true })
    client.emit('error', { code: 'UPDATE_ERROR', message: 'broken' })
    service.setServiceStatus({ maintenance: { message: null } })
    expect(service.getState()).toMatchObject({
      phase: 'error',
      failedStep: 'check',
      error: { code: 'UPDATE_ERROR' },
      serviceMaintenance: { message: null },
    })
    service.dispose()
  })
})

describe('minimum version from the update feed', () => {
  it('requires an update only when this version is readably older than the minimum', () => {
    expect(resolveRequiredVersion('0.2.12', '0.2.13')).toBe('0.2.13')
    expect(resolveRequiredVersion('0.2.13', '0.2.13')).toBeNull()
    expect(resolveRequiredVersion('0.3.0', '0.2.13')).toBeNull()
    expect(resolveRequiredVersion('0.2.12', null)).toBeNull()
    expect(resolveRequiredVersion('0.2.12', 'latest')).toBeNull()
    expect(resolveRequiredVersion('dev', '0.2.13')).toBeNull()
  })

  it('marks the snapshot and checks at once when the minimum appears after a quiet check', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockImplementation(async () => {
      client.emit('update-not-available', updateInfo('1.0.0'))
    })
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true })
    await service.check()
    expect(client.checkForUpdates).toHaveBeenCalledTimes(1)
    expect(service.getState().requiredVersion).toBeNull()

    client.checkForUpdates.mockImplementationOnce(async () => {
      client.emit('update-available', updateInfo('1.1.0'))
    })
    service.setServiceStatus({ maintenance: null, minimumVersion: '1.1.0' })
    service.setServiceStatus({ maintenance: null, minimumVersion: '1.1.0' })
    await vi.waitFor(() => expect(service.getState().phase).toBe('available'))
    expect(client.checkForUpdates).toHaveBeenCalledTimes(2)
    expect(service.getState()).toMatchObject({ requiredVersion: '1.1.0', availableVersion: '1.1.0' })

    service.setServiceStatus(null)
    expect(service.getState().requiredVersion).toBeNull()
    service.dispose()
  })

  it('lets a machine below the minimum past a staged rollout', async () => {
    const client = new FakeUpdater()
    client.isUserWithinRollout = async (info: { stagingPercentage?: number }) => (info.stagingPercentage ?? 100) >= 50
    const offered: boolean[] = []
    let status = { maintenance: null, rollout: { version: '1.1.0', percent: 0 }, minimumVersion: null as string | null }
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true, refreshServiceStatus: async () => status })
    client.checkForUpdates.mockImplementation(async () => {
      offered.push(await client.isUserWithinRollout!(updateInfo('1.1.0')))
      client.emit('update-not-available', updateInfo('1.0.0'))
    })
    await service.check()
    status = { ...status, minimumVersion: '1.1.0' }
    await service.check()
    expect(offered).toEqual([false, true])
    service.dispose()
  })

  it('never requires an update where none can be installed', () => {
    const development = createUpdaterService(new FakeUpdater(), { currentVersion: '1.0.0', isPackaged: false, enableDevelopmentUpdates: true })
    development.setServiceStatus({ maintenance: null, minimumVersion: '1.1.0' })
    expect(development.getState().requiredVersion).toBeNull()
    development.dispose()
    const local = createUpdaterService(new FakeUpdater(), { currentVersion: '1.0.0', isPackaged: true, localBuild: true })
    local.setServiceStatus({ maintenance: null, minimumVersion: '1.1.0' })
    expect(local.getState().requiredVersion).toBeNull()
    local.dispose()
  })
})

describe('withdrawn versions and staged rollout', () => {
  it('never offers a withdrawn version and only gates automatic checks on the rollout', () => {
    const base = { currentVersion: '0.2.9', badVersions: ['0.2.10'], rollout: { version: '0.2.11', percent: 20 }, manual: false }
    expect(decideUpdateOffer({ ...base, version: '0.2.10' })).toEqual({ offer: false })
    expect(decideUpdateOffer({ ...base, version: 'v0.2.10', manual: true })).toEqual({ offer: false })
    expect(decideUpdateOffer({ ...base, version: '0.2.11' })).toEqual({ offer: true, stagingPercentage: 20 })
    expect(decideUpdateOffer({ ...base, version: '0.2.11', manual: true })).toEqual({ offer: true })
    expect(decideUpdateOffer({ ...base, version: '0.2.12' })).toEqual({ offer: true })
    // 本机就在撤回名单上：放量不拦，它得尽快离开这个版本。
    expect(decideUpdateOffer({ ...base, currentVersion: '0.2.10', version: '0.2.11' })).toEqual({ offer: true })
  })

  it('never rolls back below the floor, whatever the feed says', () => {
    const base = { currentVersion: '0.3.0', badVersions: ['0.3.0'], rollout: null, manual: true }
    expect(decideUpdateOffer({ ...base, version: '0.2.9' })).toEqual({ offer: true })
    expect(decideUpdateOffer({ ...base, version: '0.2.8' })).toEqual({ offer: false })
    expect(decideUpdateOffer({ ...base, version: '0.2.12', rollbackFloor: '0.2.12' })).toEqual({ offer: true })
    expect(decideUpdateOffer({ ...base, version: '0.2.11', rollbackFloor: '0.2.12' })).toEqual({ offer: false })
  })

  it('compares plain release versions', () => {
    expect(isOlderVersion('0.2.9', '0.2.10')).toBe(true)
    expect(isOlderVersion('0.2.10', '0.2.9')).toBe(false)
    expect(isOlderVersion('1.0.0', '1.0.0')).toBe(false)
    expect(isOlderVersion('garbage', '1.0.0')).toBe(false)
  })

  it('reads the status file before every check and allows a downgrade only off a withdrawn version', async () => {
    const client = new FakeUpdater()
    const statuses = [
      { maintenance: null, badVersions: [], rollout: null },
      { maintenance: null, badVersions: ['1.0.0'], rollout: null },
    ]
    const refreshServiceStatus = vi.fn(async () => statuses.shift() ?? null)
    const allowDowngradeSeen: boolean[] = []
    client.checkForUpdates.mockImplementation(async () => {
      allowDowngradeSeen.push(client.allowDowngrade)
      client.emit('update-not-available', updateInfo('1.0.0'))
    })
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true, refreshServiceStatus })

    await service.check()
    expect(service.getState().currentVersionWithdrawn).toBe(false)
    client.checkForUpdates.mockImplementationOnce(async () => {
      allowDowngradeSeen.push(client.allowDowngrade)
      client.emit('update-available', updateInfo('0.9.0'))
    })
    await service.check()
    expect(refreshServiceStatus).toHaveBeenCalledTimes(2)
    expect(allowDowngradeSeen).toEqual([false, true])
    expect(service.getState()).toMatchObject({
      phase: 'available',
      availableVersion: '0.9.0',
      rollback: true,
      currentVersionWithdrawn: true,
    })
    service.dispose()
  })

  it('keeps checking when the status file cannot be read', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockImplementationOnce(async () => {
      client.emit('update-available', updateInfo('1.1.0'))
    })
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      refreshServiceStatus: async () => { throw new Error('offline') },
    })
    await expect(service.check()).resolves.toMatchObject({ phase: 'available', availableVersion: '1.1.0', rollback: false })
    expect(client.allowDowngrade).toBe(false)
    service.dispose()
  })

  it('routes electron-updater rollout checks through the status file and back to its own staging logic', async () => {
    const client = new FakeUpdater()
    const defaultRollout = vi.fn(async (info: { stagingPercentage?: number }) => (info.stagingPercentage ?? 100) >= 50)
    client.isUserWithinRollout = defaultRollout
    let status = { maintenance: null, badVersions: ['1.2.0'], rollout: { version: '1.1.0', percent: 20 } }
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true, refreshServiceStatus: async () => status })
    const hook = client.isUserWithinRollout
    expect(hook).not.toBe(defaultRollout)
    const offered: boolean[] = []
    client.checkForUpdates.mockImplementation(async () => {
      offered.push(await hook!(updateInfo('1.1.0')))
      offered.push(await hook!(updateInfo('1.2.0')))
      client.emit('update-not-available', updateInfo('1.0.0'))
    })

    await service.check()
    await service.check({ manual: true })
    status = { ...status, rollout: { version: '1.1.0', percent: 80 } }
    await service.check()
    expect(offered).toEqual([false, false, true, false, true, false])
    expect(defaultRollout).toHaveBeenCalledWith(expect.objectContaining({ version: '1.1.0', stagingPercentage: 20 }))
    service.dispose()
  })

  it('takes back an offer that is withdrawn after it was found or downloaded', async () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true, platform: 'darwin' })
    client.emit('update-downloaded', updateInfo('1.1.0'))
    expect(service.getState().phase).toBe('downloaded')
    service.setServiceStatus({ maintenance: null, badVersions: ['1.1.0'], rollout: null })
    expect(service.getState()).toMatchObject({ phase: 'idle', availableVersion: null, error: null })
    expect(() => service.install()).toThrow('尚未下载')

    client.emit('update-downloaded', updateInfo('1.1.0'))
    expect(service.getState()).toMatchObject({ phase: 'idle', availableVersion: null })
    expect(client.quitAndInstall).not.toHaveBeenCalled()
    service.dispose()
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
    expect(service.getState().error).toMatchObject({ code: 'UPDATE_PACKAGE_DIGEST_MISMATCH', detail: expect.stringContaining('SHA-512') })
    expect(service.getState().error?.message).not.toMatch(/[A-Za-z]/)
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
    expect(service.getState().error).toMatchObject({ code: 'UPDATE_PACKAGE_DIGEST_MISSING', detail: expect.stringContaining('SHA-512') })
    expect(service.getState().error?.message).not.toMatch(/[A-Za-z]/)
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
      message: expect.stringContaining('重新下载'),
      detail: expect.stringContaining('更新安装包存在多个硬链接'),
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
      clickInstall(service)
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
      error: { message: expect.stringContaining('更新文件还没放好'), detail: '更新服务器缺少更新清单 latest.yml' },
    })
    service.dispose()
  })

  it('carries the installed release through every snapshot without letting listeners mutate it', async () => {
    const client = new FakeUpdater()
    const installedRelease = { justUpdated: true, previousVersion: '0.9.0', notes: ['一条改动。'] }
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true, installedRelease })
    const seen: unknown[] = []
    service.subscribe((snapshot) => {
      seen.push(structuredClone(snapshot.installedRelease))
      snapshot.installedRelease?.notes?.push('被改动')
    })

    const first = service.getState()
    expect(first.installedRelease).toEqual(installedRelease)
    first.installedRelease?.notes?.push('被改动')
    client.emit('update-not-available', updateInfo('1.0.0'))

    expect(seen).toEqual([installedRelease])
    expect(service.getState().installedRelease).toEqual({ justUpdated: true, previousVersion: '0.9.0', notes: ['一条改动。'] })
    // 旧调用方不传时快照里是 null，界面照旧只显示待下载版本的说明。
    expect(createUpdaterService(new FakeUpdater(), { currentVersion: '1.0.0', isPackaged: true }).getState().installedRelease).toBeNull()
    service.dispose()
  })
})

describe('auto-update preference', () => {
  function availableOnCheck(client: FakeUpdater) {
    client.checkForUpdates.mockImplementation(async () => {
      client.emit('update-available', updateInfo())
    })
  }

  it('lets the unsigned channel download at startup once the publisher opted it in', async () => {
    const client = new FakeUpdater()
    availableOnCheck(client)
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      unsignedChannel: true,
      unsignedAutoUpdate: true,
    })
    expect(service.getState().autoUpdateSupported).toBe(true)
    await service.startup()
    expect(client.downloadUpdate).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('reports the unsigned channel as unsupported until it is opted in', () => {
    const service = createUpdaterService(new FakeUpdater(), {
      currentVersion: '1.0.0',
      isPackaged: true,
      unsignedChannel: true,
      readAutoUpdate: () => true,
    })
    expect(service.getState().autoUpdateSupported).toBe(false)
    expect(service.autoUpdateEnabled()).toBe(false)
    service.dispose()
  })

  it('only reports the new version at startup when the user turned auto-update off', async () => {
    const client = new FakeUpdater()
    availableOnCheck(client)
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      readAutoUpdate: () => false,
    })
    await expect(service.startup()).resolves.toMatchObject({ phase: 'available' })
    expect(client.downloadUpdate).not.toHaveBeenCalled()
    expect(service.autoUpdateEnabled()).toBe(false)
    service.dispose()
  })

  it('downloads after a scheduled check only while auto-update is on', async () => {
    const client = new FakeUpdater()
    availableOnCheck(client)
    let autoUpdate = false
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      readAutoUpdate: () => autoUpdate,
    })
    await expect(service.scheduledCheck()).resolves.toMatchObject({ phase: 'available' })
    expect(client.downloadUpdate).not.toHaveBeenCalled()
    autoUpdate = true
    await service.scheduledCheck()
    expect(client.downloadUpdate).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('starts the pending download as soon as the user turns auto-update on', async () => {
    const client = new FakeUpdater()
    availableOnCheck(client)
    let autoUpdate = false
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      readAutoUpdate: () => autoUpdate,
    })
    await service.check()
    await service.autoUpdateChanged()
    expect(client.downloadUpdate).not.toHaveBeenCalled()
    autoUpdate = true
    await service.autoUpdateChanged()
    expect(client.downloadUpdate).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('never installs on its own even with auto-update on; the host picks the moment', async () => {
    const client = new FakeUpdater()
    availableOnCheck(client)
    client.downloadUpdate.mockImplementation(async () => {
      client.emit('update-downloaded', updateInfo())
    })
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true, readAutoUpdate: () => true })
    await service.startup()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(service.getState().phase).toBe('downloaded')
    expect(client.quitAndInstall).not.toHaveBeenCalled()
    expect(service.autoUpdateEnabled()).toBe(true)
    service.dispose()
  })

  it('skips a scheduled download for a version the publisher has withdrawn', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockImplementation(async () => {
      const info = updateInfo()
      if (await client.isUserWithinRollout?.(info) === false) {
        client.emit('update-not-available', info)
        return
      }
      client.emit('update-available', info)
    })
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      readAutoUpdate: () => true,
      refreshServiceStatus: async () => ({ maintenance: null, badVersions: ['1.1.0'], rollout: null }),
    })
    await expect(service.scheduledCheck()).resolves.toMatchObject({ phase: 'not-available' })
    expect(client.downloadUpdate).not.toHaveBeenCalled()
    service.dispose()
  })
})

describe('plain-language install failures', () => {
  it('says the Windows installer did not start and points at the retry button', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeUpdater()
      const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true, platform: 'win32', installLaunchTimeoutMs: 25 })
      client.emit('update-downloaded', updateInfo())
      clickInstall(service)
      await vi.advanceTimersByTimeAsync(25)
      const message = service.getState().error?.message ?? ''
      expect(message).toContain('授权窗口')
      // 这句在强制更新门里也会出现，门里没有更新页：只点三处都有的「重新安装」。
      expect(message).not.toContain('「更新」页')
      expect(message).toContain('「重新安装」')
      expect(message).not.toContain('检查更新')
      service.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves the consent window out of the macOS wording', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeUpdater()
      const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true, platform: 'linux', installLaunchTimeoutMs: 25 })
      client.emit('update-downloaded', updateInfo())
      clickInstall(service)
      await vi.advanceTimersByTimeAsync(25)
      expect(service.getState().error?.message).not.toContain('授权窗口')
      service.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops a version that failed to auto-install last time at the install step', () => {
    const client = new FakeUpdater()
    const asked: string[] = []
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      platform: 'win32',
      previousAutoInstallFailure: (version) => { asked.push(version); return '新版本上次没装上' },
    })
    client.emit('update-downloaded', updateInfo())
    expect(asked).toEqual(['1.1.0'])
    expect(service.getState()).toMatchObject({
      phase: 'downloaded',
      failedStep: 'install',
      error: { code: 'UPDATE_PREVIOUS_AUTO_INSTALL_FAILED', message: '新版本上次没装上' },
    })
    // 「重新安装」照样能用：点一下就清掉错误、拉起安装器。
    expect(service.install()).toEqual({ accepted: true })
    expect(client.quitAndInstall).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('downloads normally when the previous-failure check says nothing or throws', () => {
    for (const previousAutoInstallFailure of [() => null, () => { throw new Error('boom') }]) {
      const client = new FakeUpdater()
      const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true, platform: 'win32', previousAutoInstallFailure })
      client.emit('update-downloaded', updateInfo())
      expect(service.getState()).toMatchObject({ phase: 'downloaded', error: null, failedStep: null })
      service.dispose()
    }
  })

  it('keeps the raw English error for the log and shows plain words instead', async () => {
    const client = new FakeUpdater()
    const raw = "ENOENT: no such file or directory, open 'C:\\\\pending\\\\setup.exe'"
    client.checkForUpdates.mockRejectedValueOnce(Object.assign(new Error(raw), { code: 'ENOENT' }))
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true, platform: 'win32' })
    await service.check()
    expect(service.getState().error).toEqual({
      code: 'ENOENT',
      message: '下载好的安装包不完整或被删掉了，常见是安全软件拦了。重新下载一次就好。',
      detail: raw,
    })
  })
})

describe('describeUnrecognizedUpdateFailure', () => {
  it('sorts common English failures into plain words', () => {
    expect(describeUnrecognizedUpdateFailure('ENOSPC: no space left on device, write')).toContain('磁盘空间不够')
    expect(describeUnrecognizedUpdateFailure('EPERM: operation not permitted, rename')).toContain('安全软件')
    expect(describeUnrecognizedUpdateFailure('EBUSY: resource busy or locked')).toContain('被占用')
    expect(describeUnrecognizedUpdateFailure('sha512 checksum mismatch')).toContain('重新下载')
    // 更新页、首页气泡、强制更新门三处都会显示这句；门和气泡里没有「查看日志」按钮。
    expect(describeUnrecognizedUpdateFailure('Something odd happened')).toContain('找客服')
    expect(describeUnrecognizedUpdateFailure('Something odd happened')).not.toContain('查看日志')
  })

  it('keeps messages that are already Chinese and empty input as they are', () => {
    expect(describeUnrecognizedUpdateFailure('更新尚未下载并校验完成')).toBe('更新尚未下载并校验完成')
    expect(describeUnrecognizedUpdateFailure('')).toBe('')
  })

  it('never puts English letters on screen', () => {
    for (const source of ['ENOSPC', 'EACCES: permission denied', 'ENOENT', 'weird']) {
      expect(describeUnrecognizedUpdateFailure(source)).not.toMatch(/[A-Za-z]/)
    }
  })
})

describe('disk space before downloading an update', () => {
  const MB = 1024 ** 2
  const sizedInfo = (size: number) => ({ ...updateInfo(), files: [{ url: 'setup.exe', sha512: 'x', size }] })

  it('estimates the space from the largest package in the manifest', () => {
    expect(resolveUpdatePackageBytes(sizedInfo(150 * MB))).toBe(150 * MB)
    expect(resolveUpdatePackageBytes({ files: [{ url: 'a.zip', sha512: 'x', size: 90 * MB }, { url: 'a.dmg', sha512: 'y', size: 120 * MB }] })).toBe(120 * MB)
    expect(resolveUpdatePackageBytes({ files: [{ url: 'a.exe', sha512: 'x' }] })).toBeNull()
    expect(resolveUpdatePackageBytes(null)).toBeNull()
    expect(requiredUpdateDiskBytes(200 * MB)).toBe(600 * MB)
    expect(requiredUpdateDiskBytes(50 * MB)).toBe(updateDiskMinimumBytes)
    expect(requiredUpdateDiskBytes(null)).toBe(updateDiskFallbackBytes)
  })

  it('lets the download through when the free space cannot be read', () => {
    expect(resolveUpdateDiskShortfall(null, 600 * MB)).toBeNull()
    expect(resolveUpdateDiskShortfall(Number.NaN, 600 * MB)).toBeNull()
    expect(resolveUpdateDiskShortfall(600 * MB, 600 * MB)).toBeNull()
    expect(resolveUpdateDiskShortfall(380 * MB, 600 * MB)).toEqual({ neededBytes: 600 * MB, freeBytes: 380 * MB })
  })

  it('keeps the release offered and skips the scheduled download while the disk is too full', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockImplementation(async () => { client.emit('update-available', sizedInfo(200 * MB)) })
    let freeBytes = 380 * MB
    const skipped = vi.fn()
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      readAutoUpdate: () => true,
      readFreeDiskBytes: async () => freeBytes,
      diskShortfallSkipped: skipped,
    })
    const blocked = await service.scheduledCheck()
    expect(blocked).toMatchObject({ phase: 'available', error: null, failedStep: null, diskShortfall: { neededBytes: 600 * MB, freeBytes: 380 * MB } })
    expect(client.downloadUpdate).not.toHaveBeenCalled()
    expect(skipped).toHaveBeenCalledWith({ neededBytes: 600 * MB, freeBytes: 380 * MB }, '1.1.0')

    // 下一轮定时检查：空间清出来了，照常自己下，不用用户再点。
    freeBytes = 2048 * MB
    const resumed = await service.scheduledCheck()
    expect(client.downloadUpdate).toHaveBeenCalledOnce()
    expect(resumed.diskShortfall).toBeNull()
    service.dispose()
  })

  it('downloads anyway when the user insists', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockImplementation(async () => { client.emit('update-available', sizedInfo(200 * MB)) })
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      readAutoUpdate: () => false,
      readFreeDiskBytes: async () => 100 * MB,
    })
    await service.check()
    await expect(service.download()).resolves.toMatchObject({ phase: 'available', diskShortfall: { freeBytes: 100 * MB } })
    expect(client.downloadUpdate).not.toHaveBeenCalled()
    await service.download({ ignoreDiskSpace: true })
    expect(client.downloadUpdate).toHaveBeenCalledOnce()
    expect(service.getState().diskShortfall).toBeNull()
    service.dispose()
  })

  it('downloads as before when reading the disk throws', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockImplementation(async () => { client.emit('update-available', sizedInfo(200 * MB)) })
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      readAutoUpdate: () => true,
      readFreeDiskBytes: async () => { throw new Error('statfs failed') },
    })
    await service.scheduledCheck()
    expect(client.downloadUpdate).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('clears the shortfall once the phase moves on', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockImplementation(async () => { client.emit('update-available', sizedInfo(200 * MB)) })
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      readAutoUpdate: () => false,
      readFreeDiskBytes: async () => 100 * MB,
    })
    await service.check()
    await service.download()
    expect(service.getState().diskShortfall).not.toBeNull()
    client.emit('error', new Error('boom'))
    expect(service.getState()).toMatchObject({ phase: 'error', diskShortfall: null })
    service.dispose()
  })
})

describe('download progress smoothing', () => {
  it('waits for a few seconds of samples before reporting a speed', () => {
    let samples = recordDownloadProgressSample([], { at: 0, transferred: 0 })
    samples = recordDownloadProgressSample(samples, { at: 1_000, transferred: 2_000_000 })
    expect(resolveAverageDownloadRate(samples)).toBeNull()
    samples = recordDownloadProgressSample(samples, { at: 3_000, transferred: 3_000_000 })
    expect(resolveAverageDownloadRate(samples)).toBe(1_000_000)
  })

  it('averages over the recent window instead of jumping with each burst', () => {
    let samples: ReturnType<typeof recordDownloadProgressSample> = []
    for (let second = 0; second <= 20; second += 1) {
      // 一秒快一秒慢，平均每秒 1 MB。
      const transferred = second * 1_000_000 + (second % 2 ? 400_000 : 0)
      samples = recordDownloadProgressSample(samples, { at: second * 1_000, transferred })
    }
    expect(samples[0].at).toBe(20_000 - downloadRateWindowMs)
    expect(resolveAverageDownloadRate(samples)).toBe(1_000_000)
  })

  it('starts over when the download restarts from a smaller amount', () => {
    let samples = recordDownloadProgressSample([], { at: 0, transferred: 0 })
    samples = recordDownloadProgressSample(samples, { at: 5_000, transferred: 5_000_000 })
    samples = recordDownloadProgressSample(samples, { at: 6_000, transferred: 100 })
    expect(samples).toEqual([{ at: 6_000, transferred: 100 }])
    expect(resolveAverageDownloadRate(samples)).toBeNull()
  })

  it('reports no speed while nothing is moving', () => {
    let samples = recordDownloadProgressSample([], { at: 0, transferred: 500 })
    samples = recordDownloadProgressSample(samples, { at: 5_000, transferred: 500 })
    expect(resolveAverageDownloadRate(samples)).toBeNull()
  })

  it('estimates the remaining seconds only when it knows the total and the speed', () => {
    expect(resolveDownloadSecondsRemaining(1_000, 1_000, 41_500)).toBe(41)
    expect(resolveDownloadSecondsRemaining(null, 1_000, 41_000)).toBeNull()
    expect(resolveDownloadSecondsRemaining(1_000, 1_000, 0)).toBeNull()
    expect(resolveDownloadSecondsRemaining(1_000, 41_000, 41_000)).toBeNull()
  })

  it('publishes the smoothed speed and remaining time on the update snapshot', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(0)
      const client = new FakeUpdater()
      const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true })
      const checking = service.check()
      client.emit('update-available', updateInfo())
      await checking
      let finish: () => void = () => undefined
      client.downloadUpdate.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
      const downloading = service.download()
      const total = 100_000_000
      client.emit('download-progress', { percent: 0, bytesPerSecond: 0, transferred: 0, total, delta: 0 })
      expect(service.getState().progress).toMatchObject({ transferred: 0, total, averageBytesPerSecond: null, secondsRemaining: null })
      for (let second = 1; second <= 4; second += 1) {
        vi.setSystemTime(second * 1_000)
        client.emit('download-progress', { percent: second * 2, bytesPerSecond: 9_999_999, transferred: second * 2_000_000, total, delta: 2_000_000 })
      }
      expect(service.getState().progress).toMatchObject({
        transferred: 8_000_000,
        bytesPerSecond: 9_999_999,
        averageBytesPerSecond: 2_000_000,
        secondsRemaining: 46,
      })
      finish()
      await downloading
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('launch install notice', () => {
  const notice = { version: '1.1.0', title: '星芒AI马上更新', body: '几秒后开始安装', installAt: 5_000 }

  it('carries the notice only while that version waits downloaded', () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true })
    service.setLaunchInstallNotice(notice)
    expect(service.getState().launchInstallNotice).toBeNull()

    client.emit('update-downloaded', updateInfo('1.1.0'))
    service.setLaunchInstallNotice({ ...notice, version: '1.2.0' })
    expect(service.getState().launchInstallNotice).toBeNull()
    service.setLaunchInstallNotice(notice)
    expect(service.getState().launchInstallNotice).toEqual(notice)
    service.setLaunchInstallNotice(null)
    expect(service.getState().launchInstallNotice).toBeNull()
    service.dispose()
  })

  it('drops the notice when the installer fails to start', async () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, {
      currentVersion: '1.0.0',
      isPackaged: true,
      unsignedChannel: true,
      prepareInstallQuit: () => Promise.reject(new Error('窗口已关闭，无法安装更新')),
      installQuitAborted: vi.fn(),
    })
    client.emit('update-downloaded', updateInfo('1.1.0'))
    service.setLaunchInstallNotice(notice)
    service.install()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(service.getState()).toMatchObject({ phase: 'downloaded', failedStep: 'install', launchInstallNotice: null })
    service.dispose()
  })

  it('drops the notice when a new check moves the phase away from downloaded', () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true })
    client.emit('update-downloaded', updateInfo('1.1.0'))
    service.setLaunchInstallNotice(notice)
    client.emit('checking-for-update')
    expect(service.getState().launchInstallNotice).toBeNull()
    service.dispose()
  })
})

describe('system installer channel (Linux .deb)', () => {
  const debFile = '/home/tester/.cache/xingmang-ai-manager-updater/pending/XingMang-AI-Manager-1.1.0-linux-amd64.deb'
  const debInfo = (version = '1.1.0') => ({
    ...updateInfo(version),
    files: [{ url: `XingMang-AI-Manager-${version}-linux-amd64.deb`, sha512: 'deb-digest', size: 42 }],
    downloadedFile: debFile,
  })
  const linuxRuntime = (overrides: Record<string, unknown> = {}) => ({
    currentVersion: '1.0.0',
    isPackaged: true,
    platform: 'linux' as NodeJS.Platform,
    installMethod: 'system-installer' as const,
    verifyPackageDigest: vi.fn(async () => true),
    ...overrides,
  })

  it('keeps the Windows and macOS snapshot free of the install method', () => {
    const service = createUpdaterService(new FakeUpdater(), { currentVersion: '1.0.0', isPackaged: true })
    expect(Object.keys(service.getState())).not.toContain('installMethod')
    service.dispose()
  })

  it('disables an install electron-updater cannot update instead of checking forever', async () => {
    const client = new FakeUpdater()
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true, platform: 'linux', installMethod: 'manual' })
    expect(service.getState()).toMatchObject({ phase: 'disabled', installMethod: 'manual', development: false })
    await expect(service.startup()).resolves.toMatchObject({ phase: 'disabled' })
    await expect(service.check()).rejects.toThrow()
    expect(client.checkForUpdates).not.toHaveBeenCalled()
    service.setServiceStatus({ maintenance: { message: '维护中' }, minimumVersion: '9.9.9' })
    expect(service.getState()).toMatchObject({ requiredVersion: null, serviceMaintenance: { message: '维护中' } })
    service.dispose()
  })

  it('leaves checking when electron-updater resolves null without a single event', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockImplementation(async () => null)
    const service = createUpdaterService(client, linuxRuntime())
    await service.check()
    expect(service.getState()).toMatchObject({ phase: 'error', failedStep: 'check', error: { code: 'UPDATE_INACTIVE' } })
    // The next check is not swallowed by a stuck 'checking' phase.
    await service.check()
    expect(client.checkForUpdates).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('gates a Linux machine only once an install that satisfies the minimum is on offer', () => {
    const gate = (availableVersion: string | null, rollback = false, installMethod: 'system-installer' | null = 'system-installer') =>
      resolveGatedRequiredVersion({ minimumRequired: '1.2.0', installMethod, availableVersion, rollback })
    expect(gate(null)).toBeNull()
    expect(gate('1.1.0')).toBeNull()
    expect(gate('1.2.0')).toBe('1.2.0')
    expect(gate('1.3.0')).toBe('1.2.0')
    expect(gate('1.3.0', true)).toBeNull()
    expect(gate('nightly')).toBeNull()
    // Windows and macOS keep gating on the minimum alone.
    expect(gate(null, false, null)).toBe('1.2.0')
    expect(resolveGatedRequiredVersion({ minimumRequired: null, installMethod: 'system-installer', availableVersion: '1.3.0', rollback: false })).toBeNull()
  })

  it('does not lock Linux customers out while the feed has no Linux package', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockImplementation(async () => {
      const error = Object.assign(new Error('Cannot find latest-linux.yml in the latest release artifacts'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })
      client.emit('error', error)
      throw error
    })
    const service = createUpdaterService(client, linuxRuntime())
    service.setServiceStatus({ maintenance: null, minimumVersion: '1.2.0' })
    await vi.waitFor(() => expect(client.checkForUpdates).toHaveBeenCalled())
    await vi.waitFor(() => expect(service.getState().phase).toBe('error'))
    expect(service.getState().requiredVersion).toBeNull()

    client.checkForUpdates.mockImplementationOnce(async () => {
      client.emit('update-available', debInfo('1.2.0'))
    })
    await service.check()
    expect(service.getState()).toMatchObject({ phase: 'available', availableVersion: '1.2.0', requiredVersion: '1.2.0' })
    service.dispose()
  })

  it('keeps the Windows gate up even before any package is offered', async () => {
    const client = new FakeUpdater()
    client.checkForUpdates.mockImplementation(() => new Promise(() => undefined))
    const service = createUpdaterService(client, { currentVersion: '1.0.0', isPackaged: true, platform: 'win32' })
    service.setServiceStatus({ maintenance: null, minimumVersion: '1.2.0' })
    expect(service.getState()).toMatchObject({ phase: 'checking', requiredVersion: '1.2.0' })
    service.dispose()
  })

  it('still lets a Linux machine below the minimum past a staged rollout before its gate is up', async () => {
    const client = new FakeUpdater()
    client.isUserWithinRollout = async (info: { stagingPercentage?: number }) => (info.stagingPercentage ?? 100) >= 50
    const status = { maintenance: null, rollout: { version: '1.2.0', percent: 0 }, minimumVersion: '1.2.0' }
    const service = createUpdaterService(client, linuxRuntime({ refreshServiceStatus: async () => status }))
    const offered: boolean[] = []
    client.checkForUpdates.mockImplementation(async () => {
      offered.push(await client.isUserWithinRollout!(updateInfo('1.2.0')))
      client.emit('update-not-available', updateInfo('1.0.0'))
    })
    await service.check()
    expect(offered).toEqual([true])
    expect(service.getState().requiredVersion).toBeNull()
    service.dispose()
  })

  it('hands the verified package to the system installer, then quits, and never runs electron-updater install', async () => {
    const client = new FakeUpdater()
    const openSystemInstaller = vi.fn(async (_packagePath: string) => undefined)
    const quitAfterSystemInstaller = vi.fn()
    const prepareInstallQuit = vi.fn(async () => undefined)
    const runtime = linuxRuntime({ openSystemInstaller, quitAfterSystemInstaller, prepareInstallQuit })
    const service = createUpdaterService(client, runtime)
    client.emit('update-downloaded', debInfo())
    await vi.waitFor(() => expect(service.getState().phase).toBe('downloaded'))
    expect(runtime.verifyPackageDigest).toHaveBeenCalledWith(debFile, 'deb-digest')

    expect(service.install()).toEqual({ accepted: true })
    await vi.waitFor(() => expect(quitAfterSystemInstaller).toHaveBeenCalledOnce())
    expect(prepareInstallQuit).toHaveBeenCalledOnce()
    expect(openSystemInstaller).toHaveBeenCalledWith(debFile)
    expect(client.quitAndInstall).not.toHaveBeenCalled()
    expect(client.autoInstallOnAppQuit).toBe(false)
    service.dispose()
  })

  it('opens the installer before returning when the host is already quitting', () => {
    const client = new FakeUpdater()
    const openSystemInstaller = vi.fn(() => new Promise<void>(() => undefined))
    const service = createUpdaterService(client, linuxRuntime({ openSystemInstaller, prepareInstallQuit: () => undefined }))
    client.emit('update-downloaded', debInfo())
    return vi.waitFor(() => expect(service.getState().phase).toBe('downloaded')).then(() => {
      service.install()
      expect(openSystemInstaller).toHaveBeenCalledOnce()
      service.dispose()
    })
  })

  it('stays open and keeps the package for a retry when the installer cannot be opened', async () => {
    const client = new FakeUpdater()
    const quitAfterSystemInstaller = vi.fn()
    const installQuitAborted = vi.fn()
    const openSystemInstaller = vi.fn(async (_packagePath: string): Promise<void> => {
      throw Object.assign(new Error('没能打开这台电脑的安装程序。点「重新安装」再试一次；还不行请找客服。'), { code: 'UPDATE_SYSTEM_INSTALLER_FAILED' })
    })
    const service = createUpdaterService(client, linuxRuntime({ openSystemInstaller, quitAfterSystemInstaller, installQuitAborted, prepareInstallQuit: async () => undefined }))
    client.emit('update-downloaded', debInfo())
    await vi.waitFor(() => expect(service.getState().phase).toBe('downloaded'))
    service.install()
    await vi.waitFor(() => expect(service.getState().failedStep).toBe('install'))
    expect(service.getState()).toMatchObject({
      phase: 'downloaded',
      error: { code: 'UPDATE_SYSTEM_INSTALLER_FAILED', message: '没能打开这台电脑的安装程序。点「重新安装」再试一次；还不行请找客服。' },
    })
    expect(installQuitAborted).toHaveBeenCalledOnce()
    expect(quitAfterSystemInstaller).not.toHaveBeenCalled()

    openSystemInstaller.mockImplementationOnce(async () => undefined)
    service.install()
    await vi.waitFor(() => expect(quitAfterSystemInstaller).toHaveBeenCalledOnce())
    service.dispose()
  })

  it('sends a vanished package back to the download step', async () => {
    const client = new FakeUpdater()
    const installQuitAborted = vi.fn()
    const openSystemInstaller = vi.fn(async () => {
      throw Object.assign(new Error('gone'), { code: 'UPDATE_PACKAGE_PATH_MISSING' })
    })
    const service = createUpdaterService(client, linuxRuntime({ openSystemInstaller, installQuitAborted }))
    client.emit('update-downloaded', debInfo())
    await vi.waitFor(() => expect(service.getState().phase).toBe('downloaded'))
    service.install()
    await vi.waitFor(() => expect(service.getState().phase).toBe('error'))
    expect(service.getState()).toMatchObject({ failedStep: 'download', error: { code: 'UPDATE_PACKAGE_PATH_MISSING' } })
    expect(installQuitAborted).toHaveBeenCalledOnce()
    service.dispose()
  })

  it('never hands over a package that was not verified', async () => {
    const client = new FakeUpdater()
    const openSystemInstaller = vi.fn(async () => undefined)
    const service = createUpdaterService(client, linuxRuntime({ verifyPackageDigest: undefined, openSystemInstaller }))
    client.emit('update-downloaded', debInfo())
    expect(service.getState().phase).toBe('downloaded')
    expect(() => service.install()).toThrow()
    expect(openSystemInstaller).not.toHaveBeenCalled()
    expect(service.getState()).toMatchObject({ phase: 'error', failedStep: 'download' })
    service.dispose()
  })

  it('reports a quit that never happens after the installer window opened', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeUpdater()
      const service = createUpdaterService(client, linuxRuntime({
        openSystemInstaller: async () => undefined,
        quitAfterSystemInstaller: () => undefined,
        installLaunchTimeoutMs: 1_000,
      }))
      client.emit('update-downloaded', debInfo())
      await vi.waitFor(() => expect(service.getState().phase).toBe('downloaded'))
      service.install()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(service.getState()).toMatchObject({
        phase: 'downloaded',
        failedStep: 'install',
        error: { code: 'UPDATE_INSTALL_LAUNCH_TIMEOUT' },
      })
      expect(service.getState().error?.message).toContain('安装窗口已经打开')
      service.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
