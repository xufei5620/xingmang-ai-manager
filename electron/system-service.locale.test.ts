import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as TOML from '@iarna/toml'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './app-settings'
import { createCodexDesktopService, type CodexDesktopService } from './codex-desktop-service'
import { readCodexDesktopLocale } from './codex-desktop-locale'
import {
  createSystemService,
  type CodexDesktopLaunchResult,
  type DesktopAppStatus,
} from './system-service'

vi.mock('./codex-desktop-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('./codex-desktop-service')>(),
  createCodexDesktopService: vi.fn(),
}))

const temporaryDirectories: string[] = []
const customConfig = [
  '# 用户的自定义配置和注释应保留',
  'model = "custom-model"',
  'model_provider = "custom"',
  'approval_policy = "on-request"',
  '',
  '[desktop]',
  'theme = "dark" # 保留自定义主题',
  '',
  '[model_providers.custom]',
  'name = "Custom provider"',
  'base_url = "https://example.invalid/v1"',
  '',
].join('\n')

function createFixture(options: {
  platform?: NodeJS.Platform
  running?: boolean
  installed?: boolean
  config?: string
  resources?: boolean
} = {}) {
  // Canonicalize macOS's /var -> /private/var temporary root before using the
  // real safe-local-data writer. The test must not weaken its reparse guard.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-system-locale-')))
  temporaryDirectories.push(root)
  const platform = options.platform ?? 'win32'
  const codexHome = path.join(root, '自定义 Codex Home')
  const configPath = path.join(codexHome, 'config.toml')
  const installDirectory = path.join(root, platform === 'darwin' ? 'Codex.app' : 'Codex package')
  fs.mkdirSync(codexHome, { recursive: true })
  fs.writeFileSync(configPath, options.config ?? customConfig, 'utf8')
  if (options.resources !== false) {
    const appRoot = platform === 'darwin'
      ? path.join(installDirectory, 'Contents', 'Resources', 'app.asar')
      : path.join(installDirectory, 'app', 'resources', 'app.asar')
    const pakPath = platform === 'darwin'
      ? path.join(installDirectory, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Resources', 'zh_CN.lproj', 'locale.pak')
      : path.join(installDirectory, 'app', 'locales', 'zh-CN.pak')
    for (const [file, content] of [
      [path.join(appRoot, 'webview', 'assets', 'zh-CN-fixture.js'), 'export default {}'],
      [path.join(appRoot, 'native-menu-locales', 'zh-CN.json'), '{}'],
      [pakPath, 'fixture'],
    ]) {
      fs.mkdirSync(path.dirname(file!), { recursive: true })
      fs.writeFileSync(file!, content!, 'utf8')
    }
  }
  const desktop: DesktopAppStatus = {
    installed: options.installed ?? true,
    version: '26.901.0.0',
    appVersion: '26.901.0.0',
    path: path.join(installDirectory, 'Codex.exe'),
    installDirectory,
    running: options.running ?? true,
    mirrorVersion: null,
    mirrorUpdateAvailable: null,
    mirrorError: null,
  }
  const inspect = vi.fn(async () => ({ ...desktop }))
  const launch = vi.fn<CodexDesktopService['launchCodexDesktop']>(async (mode, _target, launchOptions) => ({
    restarted: mode === 'restart',
    status: { ...desktop, running: true },
    ...(launchOptions?.injectChinese ? { chineseLocale: { status: 'verified' as const } } : {}),
  }))
  vi.mocked(createCodexDesktopService).mockReturnValue({
    inspectCodexDesktop: inspect,
    inspectCodexDesktopUpdate: inspect,
    launchCodexDesktop: launch,
    installCodexDesktop: vi.fn(),
    uninstallCodexDesktop: vi.fn(),
  })
  const store = new AppSettingsStore(path.join(root, 'settings.json'), root)
  const service = createSystemService(store, {
    platform,
    providerRoots: { userHome: root, codexHome },
    codexEnv: { CODEX_HOME: codexHome },
    runCommand: vi.fn(async () => { throw new Error('Locale test must not execute host commands') }),
  })
  const target = { isDestroyed: () => false, send: vi.fn() }
  const readConfig = () => fs.readFileSync(configPath, 'utf8')
  return { root, codexHome, configPath, desktop, service, launch, target, readConfig }
}

afterEach(() => {
  vi.clearAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('system-service Codex Desktop locale workflow', () => {
  it('preserves custom configuration and credentials while applying and verifying Chinese', async () => {
    const fixture = createFixture()
    const authPath = path.join(fixture.codexHome, 'auth.json')
    const credentials = '{"tokens":{"access_token":"fixture-official-token"}}\n'
    fs.writeFileSync(authPath, credentials, 'utf8')

    const result = await fixture.service.setCodexDesktopLocale('zh-CN', fixture.target)

    expect(result).toMatchObject({
      configuredLocale: 'zh-CN',
      restarted: true,
      runtimeVerified: true,
      needsRestart: false,
      error: null,
    })
    expect(fixture.launch).toHaveBeenCalledWith('restart', fixture.target, expect.objectContaining({ injectChinese: true }))
    expect(TOML.parse(fixture.readConfig())).toEqual({
      ...TOML.parse(customConfig),
      desktop: { theme: 'dark', localeOverride: 'zh-CN' },
    })
    expect(fixture.readConfig()).toContain('# 用户的自定义配置和注释应保留')
    expect(fixture.readConfig()).toContain('theme = "dark" # 保留自定义主题')
    expect(fs.readFileSync(authPath, 'utf8')).toBe(credentials)
  })

  it('retries a failed runtime injection even though the Chinese preference is already saved', async () => {
    const fixture = createFixture()
    fixture.launch.mockResolvedValueOnce({
      restarted: true,
      status: fixture.desktop,
      chineseLocale: { status: 'failed', message: '桌面端已经打开，但没有确认汉化成功' },
    })

    const failed = await fixture.service.setCodexDesktopLocale('zh-CN', fixture.target)
    expect(failed).toMatchObject({ configuredLocale: 'zh-CN', runtimeVerified: false, needsRestart: true })
    expect(failed.warning).toContain('没有确认汉化成功')
    const savedConfig = fixture.readConfig()
    const oldTimestamp = new Date('2020-01-01T00:00:00.000Z')
    fs.utimesSync(fixture.configPath, oldTimestamp, oldTimestamp)
    const beforeRetry = fs.statSync(fixture.configPath).mtimeMs

    const retried = await fixture.service.setCodexDesktopLocale('zh-CN', fixture.target)

    expect(retried).toMatchObject({ configuredLocale: 'zh-CN', restarted: true, runtimeVerified: true, needsRestart: false })
    expect(fixture.launch).toHaveBeenCalledTimes(2)
    expect(fixture.launch).toHaveBeenLastCalledWith('restart', fixture.target, expect.objectContaining({ injectChinese: true }))
    expect(fixture.readConfig()).toBe(savedConfig)
    expect(fs.statSync(fixture.configPath).mtimeMs).toBe(beforeRetry)
  })

  it.each([
    { status: 'restart-required' as const, message: '请完整退出桌面端后重新打开' },
    undefined,
  ])('does not mistake an unverified launch for a successful translation: %j', async (chineseLocale) => {
    const fixture = createFixture()
    const launchResult: CodexDesktopLaunchResult = { restarted: true, status: fixture.desktop, chineseLocale }
    fixture.launch.mockResolvedValueOnce(launchResult)

    const result = await fixture.service.setCodexDesktopLocale('zh-CN', fixture.target)

    expect(result).toMatchObject({ configuredLocale: 'zh-CN', runtimeVerified: false, needsRestart: true })
    expect(result.warning).toBeTruthy()
  })

  it('keeps a saved preference pending when Desktop is closed, then applies it on ordinary open', async () => {
    const fixture = createFixture({ running: false })

    const result = await fixture.service.setCodexDesktopLocale('zh-CN', fixture.target)

    expect(result).toMatchObject({ configuredLocale: 'zh-CN', restarted: false, runtimeVerified: false, needsRestart: true })
    expect(fixture.launch).not.toHaveBeenCalled()
    expect(await fixture.service.setCodexDesktopLocale('zh-CN', fixture.target)).toMatchObject({
      restarted: false, runtimeVerified: false, needsRestart: true,
    })

    await fixture.service.launchCodexDesktop('open', fixture.target)

    expect(fixture.launch).toHaveBeenCalledOnce()
    expect(fixture.launch).toHaveBeenCalledWith('open', fixture.target, expect.objectContaining({ injectChinese: true }))
  })

  it('saves a macOS preference as pending without invoking the unsupported automatic restart', async () => {
    const fixture = createFixture({ platform: 'darwin' })

    const result = await fixture.service.setCodexDesktopLocale('zh-CN', fixture.target)

    expect(result).toMatchObject({ configuredLocale: 'zh-CN', restarted: false, runtimeVerified: false, needsRestart: true })
    expect(fixture.launch).not.toHaveBeenCalled()
    expect(readCodexDesktopLocale(fixture.readConfig())).toBe('zh-CN')
  })

  it('persists an explicit system language choice so the next open does not turn Chinese back on', async () => {
    const fixture = createFixture({ config: `${customConfig}\n[other]\nvalue = 1\n` })

    const result = await fixture.service.setCodexDesktopLocale('system', fixture.target)

    expect(result.configuredLocale).toBe('system')
    expect(readCodexDesktopLocale(fixture.readConfig())).toBe('system')
    expect(fixture.launch).toHaveBeenCalledWith('restart', fixture.target, expect.objectContaining({ injectChinese: false }))
    const savedConfig = fixture.readConfig()
    fixture.launch.mockClear()

    await fixture.service.launchCodexDesktop('open', fixture.target)

    expect(fixture.launch).toHaveBeenCalledWith('open', fixture.target, expect.objectContaining({ injectChinese: false }))
    expect(fixture.readConfig()).toBe(savedConfig)
  })

  it('automatically saves Chinese only for an unset preference with complete local resources', async () => {
    const fixture = createFixture({ running: false })

    await fixture.service.launchCodexDesktop('open', fixture.target)

    expect(readCodexDesktopLocale(fixture.readConfig())).toBe('zh-CN')
    expect(fixture.readConfig()).toContain('base_url = "https://example.invalid/v1"')
    expect(fixture.launch).toHaveBeenCalledWith('open', fixture.target, expect.objectContaining({ injectChinese: true }))
  })

  it('rejects a malformed configuration before changing the file or restarting Desktop', async () => {
    const config = 'model = "custom-model"\n[desktop\n'
    const fixture = createFixture({ config })

    await expect(fixture.service.setCodexDesktopLocale('zh-CN', fixture.target)).rejects.toThrow('无法解析')

    expect(fixture.readConfig()).toBe(config)
    expect(fixture.launch).not.toHaveBeenCalled()
  })

  it('rejects an unreadable non-file configuration without treating it as a missing preference', async () => {
    const fixture = createFixture()
    fs.unlinkSync(fixture.configPath)
    fs.mkdirSync(fixture.configPath)

    await expect(fixture.service.setCodexDesktopLocale('zh-CN', fixture.target)).rejects.toThrow('普通文件')

    expect(fs.statSync(fixture.configPath).isDirectory()).toBe(true)
    expect(fixture.launch).not.toHaveBeenCalled()
  })

  it.each([
    { resources: false, installed: true, error: '没有本地简体中文资源' },
    { resources: true, installed: false, error: '未检测到 Codex Desktop' },
  ])('does not save a preference when the local installation cannot support it: %j', async ({ error, ...options }) => {
    const fixture = createFixture(options)

    await expect(fixture.service.setCodexDesktopLocale('zh-CN', fixture.target)).rejects.toThrow(error)

    expect(fixture.readConfig()).toBe(customConfig)
    expect(fixture.launch).not.toHaveBeenCalled()
  })
})
