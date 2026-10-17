import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as TOML from '@iarna/toml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { createCodexDesktopService, type CodexDesktopService } from './codex-desktop-service'
import { readCodexDesktopLocale } from './codex-desktop-locale'
import { createSystemService, writeQueuedWithin, type DesktopAppStatus } from './system-service'

vi.mock('./codex-desktop-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('./codex-desktop-service')>(),
  createCodexDesktopService: vi.fn(),
}))

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/** 一条只排一个的队：第一项做完才轮到下一项，和 system-service 的 serializeConfigWrite 一样。 */
function createQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = tail.then(operation, operation)
    tail = next.catch(() => undefined)
    return next
  }
}

function hold() {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  return { held, release }
}

describe('writeQueuedWithin', () => {
  it('runs the write once the queue frees up within the wait', async () => {
    const enqueue = createQueue()
    const busy = hold()
    void enqueue(() => busy.held)
    const write = vi.fn(() => 'written')

    const queued = writeQueuedWithin(enqueue, write, 1_000, 'gave up')
    await Promise.resolve()
    expect(write).not.toHaveBeenCalled()
    busy.release()

    await expect(queued).resolves.toBe('written')
    expect(write).toHaveBeenCalledOnce()
  })

  it('gives up when the queue stays busy and never runs the write afterwards', async () => {
    vi.useFakeTimers()
    const enqueue = createQueue()
    const busy = hold()
    void enqueue(() => busy.held)
    const write = vi.fn(() => 'written')

    const queued = writeQueuedWithin(enqueue, write, 3_000, '保存配置还没做完，这次打开先不写')
    const settled = expect(queued).rejects.toThrow('保存配置还没做完，这次打开先不写')
    await vi.advanceTimersByTimeAsync(3_000)
    await settled
    busy.release()
    await enqueue(async () => undefined)

    expect(write).not.toHaveBeenCalled()
  })

  it('waits for a write that already started instead of abandoning it halfway', async () => {
    vi.useFakeTimers()
    const enqueue = createQueue()
    const writing = hold()
    const write = vi.fn(async () => {
      await writing.held
      return 'written'
    })

    const queued = writeQueuedWithin(enqueue, write, 3_000, 'gave up')
    await vi.advanceTimersByTimeAsync(5_000)
    writing.release()

    await expect(queued).resolves.toBe('written')
  })

  it('passes a failed write through unchanged', async () => {
    const enqueue = createQueue()
    await expect(writeQueuedWithin(enqueue, () => {
      throw new Error('Codex config.toml 无法解析')
    }, 1_000, 'gave up')).rejects.toThrow('Codex config.toml 无法解析')
  })
})

function createFixture(platform: NodeJS.Platform) {
  // Canonicalize macOS's /var -> /private/var before the real safe-local-data writer sees it.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-config-write-queue-')))
  temporaryDirectories.push(root)
  const userHome = path.join(root, 'home')
  const codexHome = path.join(root, 'codex')
  const workspace = path.join(root, 'workspace')
  const configPath = path.join(codexHome, 'config.toml')
  const installDirectory = path.join(root, 'Codex package')
  fs.mkdirSync(userHome, { recursive: true })
  fs.mkdirSync(codexHome, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  // The Windows launch only fills in Chinese when the package ships it.
  const appRoot = path.join(installDirectory, 'app', 'resources', 'app.asar')
  for (const [file, content] of [
    [path.join(appRoot, 'webview', 'assets', 'zh-CN-fixture.js'), 'export default {}'],
    [path.join(appRoot, 'native-menu-locales', 'zh-CN.json'), '{}'],
    [path.join(installDirectory, 'app', 'locales', 'zh-CN.pak'), 'fixture'],
  ] as const) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content, 'utf8')
  }
  const desktop: DesktopAppStatus = {
    installed: true,
    version: '26.901.0.0',
    appVersion: '26.901.0.0',
    path: path.join(installDirectory, 'Codex.exe'),
    installDirectory,
    running: false,
    mirrorVersion: null,
    mirrorUpdateAvailable: null,
    mirrorError: null,
  }
  const inspect = vi.fn(async () => ({ ...desktop }))
  const launch = vi.fn<CodexDesktopService['launchCodexDesktop']>(async (mode) => ({
    restarted: mode === 'restart',
    status: { ...desktop, running: true },
  }))
  vi.mocked(createCodexDesktopService).mockReturnValue({
    inspectCodexDesktop: inspect,
    inspectCodexDesktopUpdate: inspect,
    launchCodexDesktop: launch,
    installCodexDesktop: vi.fn(),
    cancelCodexDesktopInstall: vi.fn(() => ({ cancelled: true, reason: null })),
    uninstallCodexDesktop: vi.fn(),
    resetCodexDesktop: vi.fn(),
  })
  const relayFetch = vi.fn<typeof fetch>(async () => Response.json({ data: [{ id: 'fixture-model' }] }))
  const store = new AppSettingsStore(path.join(root, 'settings.json'), userHome)
  const service = createSystemService(store, {
    platform,
    managerDataDirectory: root,
    providerRoots: { userHome, codexHome },
    codexEnv: { CODEX_HOME: codexHome },
    relayFetch,
    runCommand: vi.fn(async () => { throw new Error('Config write queue test must not execute host commands') }),
  })
  const target = { isDestroyed: () => false, send: vi.fn() }

  function readConfig(): Record<string, unknown> {
    return TOML.parse(fs.readFileSync(configPath, 'utf8'))
  }

  /** 已经连着星芒的 Codex 配置，去掉 keys 这几项，修改时间拨回去：之后谁改一下都看得出来。 */
  async function seedRelayConfig(...keys: string[]): Promise<void> {
    await service.saveConfig({ provider: 'codex', apiKey: 'sk-first-fixture', model: 'fixture-model', mode: 'reset' }, false)
    const kept = fs.readFileSync(configPath, 'utf8').split(/\r?\n/)
      .filter((line) => !keys.some((key) => line.startsWith(`${key} =`)))
    fs.writeFileSync(configPath, kept.join('\n'), 'utf8')
    for (const key of keys) expect(readConfig()[key]).toBeUndefined()
    const past = new Date('2020-01-01T00:00:00.000Z')
    fs.utimesSync(configPath, past, past)
  }

  /** 换一把 Key 保存（模型名单缓存认 Key），停在查模型那一步，直到 release。 */
  async function startSaveHeldAtModelQuery() {
    const query = hold()
    relayFetch.mockImplementationOnce(async () => {
      await query.held
      return Response.json({ data: [{ id: 'fixture-model' }] })
    })
    const calls = relayFetch.mock.calls.length
    const saving = service.saveConfig({ provider: 'codex', apiKey: 'sk-second-fixture', model: 'fixture-model', mode: 'merge' }, false)
    await vi.waitFor(() => expect(relayFetch).toHaveBeenCalledTimes(calls + 1))
    return { saving, release: query.release }
  }

  return { configPath, workspace, store, service, launch, target, readConfig, seedRelayConfig, startSaveHeldAtModelQuery }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

describe('system-service config writes outside the save queue (#1061 item 1)', () => {
  it('lets a save that is querying models finish before a Codex Desktop launch fills permission defaults', async () => {
    const fixture = createFixture('darwin')
    await fixture.seedRelayConfig('approval_policy', 'sandbox_mode')
    const save = await fixture.startSaveHeldAtModelQuery()

    const launching = fixture.service.launchCodexDesktop('open', fixture.target)
    await settle()
    // Nothing was written while the save waited, so its snapshot check still holds.
    expect(fixture.readConfig().approval_policy).toBeUndefined()
    expect(fixture.launch).not.toHaveBeenCalled()
    save.release()

    await expect(save.saving).resolves.toBeDefined()
    await launching
    expect(fixture.launch).toHaveBeenCalledOnce()
    expect(fixture.readConfig()).toMatchObject({ approval_policy: 'on-request', sandbox_mode: 'workspace-write' })
  })

  it('queues the automatic Chinese locale of a Windows launch behind a save', async () => {
    const fixture = createFixture('win32')
    await fixture.seedRelayConfig()
    const save = await fixture.startSaveHeldAtModelQuery()

    const launching = fixture.service.launchCodexDesktop('open', fixture.target)
    await settle()
    expect(readCodexDesktopLocale(fs.readFileSync(fixture.configPath, 'utf8'))).toBeNull()
    save.release()

    await expect(save.saving).resolves.toBeDefined()
    await launching
    expect(readCodexDesktopLocale(fs.readFileSync(fixture.configPath, 'utf8'))).toBe('zh-CN')
    expect(fixture.launch).toHaveBeenCalledOnce()
  })

  it('waits for an in-flight save before trusting the Codex workspace', async () => {
    const fixture = createFixture('darwin')
    await fixture.store.update({ version: 2, workspace: fixture.workspace })
    await fixture.seedRelayConfig()
    const save = await fixture.startSaveHeldAtModelQuery()

    const trusting = fixture.service.trustCodexWorkspace(fixture.target)
    await settle()
    expect(fixture.readConfig().projects).toBeUndefined()
    save.release()

    await expect(save.saving).resolves.toBeDefined()
    await expect(trusting).resolves.toMatchObject({ changed: true, restarted: false })
    expect(fixture.readConfig().projects).toEqual({ [fixture.workspace]: { trust_level: 'trusted' } })
  })

  it('waits for an in-flight save before switching the Codex Desktop language', async () => {
    const fixture = createFixture('darwin')
    await fixture.seedRelayConfig()
    const save = await fixture.startSaveHeldAtModelQuery()

    const switching = fixture.service.setCodexDesktopLocale('system', fixture.target)
    await settle()
    expect(readCodexDesktopLocale(fs.readFileSync(fixture.configPath, 'utf8'))).toBeNull()
    save.release()

    await expect(save.saving).resolves.toBeDefined()
    await expect(switching).resolves.toMatchObject({ configuredLocale: 'system' })
  })

  it('hands other main-process config writers the same queue as saving', async () => {
    const fixture = createFixture('darwin')
    await fixture.seedRelayConfig()
    const save = await fixture.startSaveHeldAtModelQuery()
    const write = vi.fn(async () => 'registered')

    const queued = fixture.service.serializeToolConfigWrite?.(write)
    await settle()
    expect(queued).toBeDefined()
    expect(write).not.toHaveBeenCalled()
    save.release()

    await expect(save.saving).resolves.toBeDefined()
    await expect(queued).resolves.toBe('registered')
  })
})
