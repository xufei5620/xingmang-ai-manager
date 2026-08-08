import { describe, expect, it, vi } from 'vitest'
import { platformCapabilitiesFor } from '../electron/platform-capabilities'
import { codexDesktopLaunchDecision, commitStartupPlatformCapabilities } from './app-shared'
import { createScanRequestTracker, runCoordinatedScan } from './scan-coordinator'
import { shouldBlockStartupForUpdate, shouldCheckUpdatesOnStartup } from './startup-settings'

interface Deferred<Value> {
  promise: Promise<Value>
  resolve(value: Value): void
  reject(reason: unknown): void
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('App scan coordination', () => {
  it('ignores an older scan that completes after the latest request', async () => {
    const tracker = createScanRequestTracker()
    const firstSystem = deferred<string>()
    const firstConfig = deferred<string>()
    const secondSystem = deferred<string>()
    const secondConfig = deferred<string>()
    const committed = { snapshot: '', config: '' }
    const loading: boolean[] = []

    const run = (system: Deferred<string>, config: Deferred<string>) => runCoordinatedScan({
      tracker,
      scanSystem: () => system.promise,
      readConfig: () => config.promise,
      onLoadingChange: (value) => loading.push(value),
      onSnapshot: (value) => { committed.snapshot = value },
      onConfig: (value) => { committed.config = value },
      onFailures: vi.fn(),
    })

    const firstRun = run(firstSystem, firstConfig)
    const secondRun = run(secondSystem, secondConfig)
    secondSystem.resolve('new-system')
    secondConfig.resolve('new-config')
    await secondRun

    firstSystem.resolve('old-system')
    firstConfig.resolve('old-config')
    await firstRun

    expect(committed).toEqual({ snapshot: 'new-system', config: 'new-config' })
    expect(loading.at(-1)).toBe(false)
  })

  it('keeps loading active when a stale request settles before the latest one', async () => {
    const tracker = createScanRequestTracker()
    const firstSystem = deferred<string>()
    const firstConfig = deferred<string>()
    const secondSystem = deferred<string>()
    const secondConfig = deferred<string>()
    const loading: boolean[] = []
    const options = {
      tracker,
      onLoadingChange: (value: boolean) => loading.push(value),
      onSnapshot: vi.fn(),
      onConfig: vi.fn(),
      onFailures: vi.fn(),
    }

    const firstRun = runCoordinatedScan({
      ...options,
      scanSystem: () => firstSystem.promise,
      readConfig: () => firstConfig.promise,
    })
    const secondRun = runCoordinatedScan({
      ...options,
      scanSystem: () => secondSystem.promise,
      readConfig: () => secondConfig.promise,
    })

    firstSystem.resolve('old-system')
    firstConfig.resolve('old-config')
    await firstRun
    expect(loading.at(-1)).toBe(true)

    secondSystem.resolve('new-system')
    secondConfig.resolve('new-config')
    await secondRun
    expect(loading.at(-1)).toBe(false)
  })

  it('commits a successful system scan when config loading fails', async () => {
    const tracker = createScanRequestTracker()
    const onSnapshot = vi.fn()
    const onConfig = vi.fn()
    const onFailures = vi.fn()

    const result = await runCoordinatedScan({
      tracker,
      scanSystem: async () => 'working-system',
      readConfig: async () => { throw new Error('config unavailable') },
      onLoadingChange: vi.fn(),
      onSnapshot,
      onConfig,
      onFailures,
    })

    expect(result).toEqual({ snapshot: 'working-system', config: null, current: true })
    expect(onSnapshot).toHaveBeenCalledWith('working-system')
    expect(onConfig).not.toHaveBeenCalled()
    expect(onFailures).toHaveBeenCalledWith([
      expect.objectContaining({ target: 'config' }),
    ])
  })
})

describe('startup settings', () => {
  it('checks for updates by default and respects an explicit opt-out', () => {
    expect(shouldCheckUpdatesOnStartup(null)).toBe(true)
    expect(shouldCheckUpdatesOnStartup({ checkUpdatesOnStartup: true })).toBe(true)
    expect(shouldCheckUpdatesOnStartup({ checkUpdatesOnStartup: false })).toBe(false)
  })

  it('only blocks startup for a packaged update that is being installed', () => {
    expect(shouldBlockStartupForUpdate({ development: false, phase: 'downloading', error: null })).toBe(true)
    expect(shouldBlockStartupForUpdate({ development: false, phase: 'downloaded', error: null })).toBe(true)
    expect(shouldBlockStartupForUpdate({ development: true, phase: 'downloaded', error: null })).toBe(false)
    expect(shouldBlockStartupForUpdate({
      development: false,
      phase: 'downloaded',
      error: { code: 'UPDATE_INSTALL_FAILED', message: '安装器启动失败' },
    })).toBe(false)
    expect(shouldBlockStartupForUpdate({ development: false, phase: 'error', error: null })).toBe(false)
  })
})

describe('startup platform gate', () => {
  it('does not continue startup until the platform capabilities are committed', async () => {
    const pending = deferred<ReturnType<typeof platformCapabilitiesFor>>()
    const commit = vi.fn()
    let continued = false
    const startup = (async () => {
      await commitStartupPlatformCapabilities(() => pending.promise, commit)
      continued = true
    })()

    await Promise.resolve()
    expect(continued).toBe(false)
    expect(commit).not.toHaveBeenCalled()

    const windows = platformCapabilitiesFor('win32', 'x64')
    pending.resolve(windows)
    await startup

    expect(commit).toHaveBeenCalledOnce()
    expect(commit).toHaveBeenCalledWith(windows)
    expect(continued).toBe(true)
  })

  it('propagates capability failures without committing the fallback as a real platform', async () => {
    const commit = vi.fn()

    await expect(commitStartupPlatformCapabilities(
      async () => { throw new Error('platform IPC unavailable') },
      commit,
    )).rejects.toThrow('platform IPC unavailable')
    expect(commit).not.toHaveBeenCalled()
  })
})

describe('Codex Desktop launch decision', () => {
  it('opens an already-running macOS app directly without offering restart', () => {
    expect(codexDesktopLaunchDecision(
      platformCapabilitiesFor('darwin', 'arm64'),
      true,
    )).toBe('open')
  })

  it('keeps the existing open-or-restart choice for a running Windows app', () => {
    expect(codexDesktopLaunchDecision(
      platformCapabilitiesFor('win32', 'x64'),
      true,
    )).toBe('choose')
  })

  it('opens directly when the app is not running on either platform', () => {
    expect(codexDesktopLaunchDecision(
      platformCapabilitiesFor('darwin', 'arm64'),
      false,
    )).toBe('open')
    expect(codexDesktopLaunchDecision(
      platformCapabilitiesFor('win32', 'x64'),
      false,
    )).toBe('open')
  })
})
