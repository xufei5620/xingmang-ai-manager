import { describe, expect, it } from 'vitest'
import type { ProviderConfigSummary, ProviderId } from '../../../../electron/ipc-contract'
import { accountSwitchTarget, canUninstallTool, codexDesktopUpdateKind, configDirectoryMenuItem, connectionReady, externalInstallHint, isExternallyManagedInstall, presentTools, providerFor, recommendedVersionVerb, rollbackVersion, sourceFor, toolAvailability, toolInstallDirectory, updateCheckFailure, versionSubtitle, type ToolboxSnapshot, type ToolPresentation } from './model'
import {
  writeManualSourceMarker,
  type SourceMarkerStorage,
} from './source-marker'

function memoryStorage(): SourceMarkerStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

const relayConfig = (): ProviderConfigSummary => ({
  exists: true,
  hasApiKey: true,
  matchesRelay: true,
  baseUrl: 'https://xm.solov.cc/v1',
  actualBaseUrl: 'https://xm.solov.cc/v1',
  model: 'fixture-model',
  apiKeyPreview: 'sk-***',
  dataDirectory: 'C:\\fixture',
  dataDirectoryExists: true,
  files: [],
  updatedAt: null,
})

describe('renderer tool source', () => {
  it('only advertises uninstall when native status confirms it is available', () => {
    expect(canUninstallTool({ uninstall: { available: true, reason: null, manualCommand: null } })).toBe(true)
    expect(canUninstallTool({ uninstall: { available: false, reason: '外部安装', manualCommand: 'manual' } })).toBe(false)
    expect(canUninstallTool({ uninstall: undefined }, true)).toBe(true)
    expect(canUninstallTool(undefined)).toBe(false)
  })

  it('treats Grok as on its own account only when a Grok login exists', () => {
    const storage = memoryStorage()
    const blank = { ...relayConfig(), hasApiKey: false, matchesRelay: false, actualBaseUrl: '', exists: true }
    expect(sourceFor(blank, 'grok', storage)).toBe('missing')
    expect(sourceFor({ ...blank, grokLoginMode: 'oidc' }, 'grok', storage)).toBe('official')
  })

  it('distinguishes marked manual relay keys and keeps them launch-ready', () => {
    const storage = memoryStorage()
    const config = relayConfig()
    expect(sourceFor(config, 'codex', storage)).toBe('unknown')

    writeManualSourceMarker(storage, config.baseUrl, 'codex', true)
    expect(sourceFor(config, 'codex', storage)).toBe('manual')
    expect(connectionReady(config, 'codex', storage)).toBe(true)
    expect(providerFor('codexDesktop')).toBe('codex')
  })

  describe('a configuration this app wrote and someone else edited', () => {
    it('calls it changed instead of a third-party configuration', () => {
      const storage = memoryStorage()
      const config: ProviderConfigSummary = { ...relayConfig(), configurationOwnership: 'changed' }
      expect(sourceFor(config, 'codex', storage)).toBe('changed')
      // 连接判断照旧:配置还指着当前账号的服务,只是那把 Key 未必还对。
      expect(connectionReady(config, 'codex', storage)).toBe(true)
    })

    it('stays quiet once the user keeps the current configuration', () => {
      const storage = memoryStorage()
      const config: ProviderConfigSummary = { ...relayConfig(), configurationOwnership: 'changed' }
      writeManualSourceMarker(storage, config.baseUrl, 'codex', true)
      expect(sourceFor(config, 'codex', storage)).toBe('manual')
    })

    it('stays quiet when the edited key is one this account already has', () => {
      const storage = memoryStorage()
      expect(sourceFor({ ...relayConfig(), configurationOwnership: 'changed', configurationAccountMatched: true }, 'codex', storage)).toBe('account')
    })

    it('never overrides an official sign-in', () => {
      const storage = memoryStorage()
      expect(sourceFor({ ...relayConfig(), configurationOwnership: 'changed', codexAuthMode: 'chatgpt', actualBaseUrl: '' }, 'codex', storage)).toBe('official')
      expect(sourceFor({ ...relayConfig(), configurationOwnership: 'changed', authType: 'oauth-personal' }, 'gemini', storage)).toBe('official')
    })

    it('calls a ChatGPT sign-in over a config that still points at the account service changed, not official', () => {
      // Codex sends the ChatGPT token to whatever config.toml points at: this
      // half-switched state fails every request with 401 while looking official.
      const storage = memoryStorage()
      const halfSwitched = { ...relayConfig(), hasApiKey: false, matchesRelay: false, codexAuthMode: 'chatgpt' as const }
      expect(sourceFor(halfSwitched, 'codex', storage)).toBe('changed')
      expect(sourceFor({ ...halfSwitched, actualBaseUrl: 'https://xm.solov.cc/v1/' }, 'codex', storage)).toBe('changed')
      expect(connectionReady(halfSwitched, 'codex', storage)).toBe(false)
      expect(sourceFor({ ...halfSwitched, actualBaseUrl: '' }, 'codex', storage)).toBe('official')
    })

    it('falls back to the third-party reading once the configuration points elsewhere', () => {
      const storage = memoryStorage()
      expect(sourceFor({
        ...relayConfig(), configurationOwnership: 'changed',
        matchesRelay: false, actualBaseUrl: 'https://other.example/v1',
      }, 'codex', storage)).toBe('unknown')
    })
  })

  it('does not let a marker override official, third-party, or missing state', () => {
    const storage = memoryStorage()
    const config = relayConfig()
    writeManualSourceMarker(storage, config.baseUrl, 'codex', true)

    expect(
      sourceFor({ ...config, codexAuthMode: 'chatgpt', actualBaseUrl: '' }, 'codex', storage),
    ).toBe('official')
    expect(
      sourceFor(
        {
          ...config,
          matchesRelay: false,
          actualBaseUrl: 'https://other.example/v1',
        },
        'codex',
        storage,
      ),
    ).toBe('unknown')
    expect(
      sourceFor(
        {
          ...config,
          exists: false,
          hasApiKey: false,
          matchesRelay: false,
          actualBaseUrl: '',
          model: '',
        },
        'codex',
        storage,
      ),
    ).toBe('missing')
  })

  it('uses durable ownership and conservatively preserves unmarked keys when browser storage fails', () => {
    const broken: SourceMarkerStorage = { getItem: () => { throw new Error('unavailable') }, setItem() {}, removeItem() {} }
    expect(sourceFor(relayConfig(), 'codex', broken)).toBe('unknown')
    expect(sourceFor({ ...relayConfig(), configurationOwnership: 'manual' }, 'codex', null)).toBe('manual')
    expect(sourceFor({ ...relayConfig(), configurationOwnership: 'account' }, 'codex', broken)).toBe('account')
    expect(connectionReady(relayConfig(), 'codex', broken)).toBe(true)
  })

  it.each(['claude', 'codex', 'grok', 'gemini'] as ProviderId[])('recognizes a read-only account match for %s without changing its persisted ownership', (provider) => {
    const config = { ...relayConfig(), configurationOwnership: 'unknown' as const, configurationAccountMatched: true, authType: 'gemini-api-key' }
    expect(sourceFor(config, provider, null)).toBe('account')
    expect(connectionReady(config, provider, null)).toBe(true)
    expect(config.configurationOwnership).toBe('unknown')
    expect(sourceFor({ ...config, configurationAccountMatched: false }, provider, null)).toBe('unknown')
    expect(sourceFor({ ...config, matchesRelay: false }, provider, null)).toBe('unknown')
    expect(sourceFor({ ...config, hasApiKey: false }, provider, null)).not.toBe('account')
    expect(connectionReady({ ...config, model: '' }, provider, null)).toBe(false)
  })

  it('keeps official and manual choices above account matching, including an unknown key with a local manual marker', () => {
    const storage = memoryStorage()
    const matched = { ...relayConfig(), configurationOwnership: 'unknown' as const, configurationAccountMatched: true }
    writeManualSourceMarker(storage, matched.baseUrl, 'codex', true)
    expect(sourceFor(matched, 'codex', storage)).toBe('manual')
    expect(sourceFor({ ...matched, configurationOwnership: 'manual' }, 'codex', null)).toBe('manual')
    expect(sourceFor({ ...matched, configurationOwnership: 'account' }, 'codex', storage)).toBe('account')
    expect(sourceFor({ ...matched, codexAuthMode: 'chatgpt', actualBaseUrl: '' }, 'codex', storage)).toBe('official')
    expect(sourceFor({ ...matched, authType: 'oauth-personal' }, 'gemini', null)).toBe('official')
    const broken: SourceMarkerStorage = { getItem() { throw new Error('unavailable') }, setItem() {}, removeItem() {} }
    expect(sourceFor(matched, 'codex', broken)).toBe('account')
  })

  it('presents four matched provider configurations as five ready tool rows without writing source markers', () => {
    const providers = Object.fromEntries((['claude', 'codex', 'grok', 'gemini'] as const).map((provider) => [provider,
      { ...relayConfig(), configurationOwnership: 'unknown', configurationAccountMatched: true, ...(provider === 'gemini' ? { authType: 'gemini-api-key' } : {}) },
    ]))
    const status = { installed: true, version: '1.0.0', path: '/fixture' }
    const snapshot = { config: { providers }, platform: { codexDesktop: { launch: true } },
      system: { clis: { claude: status, codex: status, grok: status, gemini: status }, desktopApps: { codex: { ...status, appVersion: '1.0.0' } } },
    } as ToolboxSnapshot
    const before = structuredClone(snapshot)
    const storage: SourceMarkerStorage = { getItem: () => null, setItem() { throw new Error('must not write') }, removeItem() { throw new Error('must not write') } }
    const rows = presentTools(snapshot, storage)
    expect(rows.map((row) => row.id).sort()).toEqual(['claude', 'codex', 'codexDesktop', 'gemini', 'grok'])
    expect(rows.every((row) => row.source === 'account' && row.configured)).toBe(true)
    expect(snapshot).toEqual(before)
  })

  it('redacts the local path a failed detection puts in the home tool row (R-S7b)', () => {
    // status.detectionError is whatever describeProbeFailure got from the probe,
    // and the home row prints it verbatim as the row subtitle.
    const providers = Object.fromEntries((['claude', 'codex', 'grok', 'gemini'] as const).map((provider) => [provider, relayConfig()]))
    const status = { installed: true, version: '1.0.0', path: '/fixture' }
    const failed = { ...status, detectionFailed: true, detectionError: "EPERM: operation not permitted, scandir 'C:\\Users\\yoyo\\AppData\\Roaming\\npm'" }
    const rows = presentTools({ config: { providers }, platform: { codexDesktop: { launch: true } },
      system: { clis: { claude: failed, codex: { ...status, detectionFailed: true, detectionError: null }, grok: status, gemini: status },
        desktopApps: { codex: { ...status, appVersion: '1.0.0' } } },
    } as unknown as ToolboxSnapshot, memoryStorage())
    const claude = rows.find((row) => row.id === 'claude')
    expect(claude?.error).toBe("EPERM: operation not permitted, scandir '本地配置文件")
    expect(claude?.error).not.toContain('yoyo')
    // 探测失败但主进程没给原因时,原来的中文兜底文案不变。
    expect(rows.find((row) => row.id === 'codex')?.error).toBe('工具检测没有完成')
    expect(rows.find((row) => row.id === 'grok')?.error).toBeNull()
  })

  it('offers a desktop update only when the mirror has a newer package than the official feed alone claims', () => {
    const providers = Object.fromEntries((['claude', 'codex', 'grok', 'gemini'] as const).map((provider) => [provider, relayConfig()]))
    const cli = { installed: true, version: '1.0.0', path: '/fixture', updateAvailable: true, latestVersion: '1.1.0' }
    const desktopRow = (desktop: Record<string, unknown>) => {
      const snapshot = { config: { providers }, platform: { codexDesktop: { launch: true } },
        system: {
          clis: { claude: cli, codex: cli, grok: cli, gemini: cli },
          desktopApps: { codex: { ...cli, appVersion: '1.0.0', ...desktop } },
        },
      } as unknown as ToolboxSnapshot
      return presentTools(snapshot, memoryStorage())
    }

    // 官方清单领先商店和国内镜像: 更新按钮装不到任何包, 所以不出现。
    const storeCurrent = desktopRow({ updateState: 'available', mirrorUpdateAvailable: false, latestVersion: '1.1.0' })
    expect(storeCurrent.find((row) => row.id === 'codexDesktop')?.updateAvailable).toBe(false)
    // CLI 走 npm, 不受镜像影响, 仍按原字段显示。
    expect(storeCurrent.find((row) => row.id === 'codex')?.updateAvailable).toBe(true)

    expect(desktopRow({ updateState: 'available', mirrorUpdateAvailable: true, latestVersion: '1.1.0' })
      .find((row) => row.id === 'codexDesktop')?.updateAvailable).toBe(true)
    expect(desktopRow({ updateState: 'latest', mirrorUpdateAvailable: false, latestVersion: '1.0.0', updateAvailable: false })
      .find((row) => row.id === 'codexDesktop')?.updateAvailable).toBe(false)
    // 探测没有结论时不催更新, 免得按钮同样装不上。
    expect(desktopRow({ updateState: 'available', mirrorUpdateAvailable: null, latestVersion: '1.1.0' })
      .find((row) => row.id === 'codexDesktop')?.updateAvailable).toBe(false)
    expect(desktopRow({ updateState: undefined, mirrorUpdateAvailable: true, latestVersion: '1.1.0' })
      .find((row) => row.id === 'codexDesktop')?.updateAvailable).toBe(false)
  })

  it('names the three desktop update states the official feed alone cannot distinguish', () => {
    expect(codexDesktopUpdateKind({ updateState: 'latest', mirrorUpdateAvailable: false })).toBe('latest')
    expect(codexDesktopUpdateKind({ updateState: 'available', mirrorUpdateAvailable: true })).toBe('installable')
    expect(codexDesktopUpdateKind({ updateState: 'available', mirrorUpdateAvailable: false })).toBe('store-current')
    expect(codexDesktopUpdateKind({ updateState: 'available', mirrorUpdateAvailable: null })).toBe('unknown')
    expect(codexDesktopUpdateKind({ updateState: 'unknown', mirrorUpdateAvailable: true })).toBe('unknown')
    expect(codexDesktopUpdateKind({ mirrorUpdateAvailable: true })).toBe('unknown')
  })

  it('carries each CLI version advice through and never attaches one to the desktop app', () => {
    const providers = Object.fromEntries((['claude', 'codex', 'grok', 'gemini'] as const).map((provider) => [provider, relayConfig()]))
    const status = { installed: true, version: '2.1.276', path: '/fixture' }
    const advice = { recommendedVersion: '2.1.277', blockedReason: '每次请求都 400', onRecommended: false, pinned: true, rollbackAvailable: true }
    const snapshot = { config: { providers }, platform: { codexDesktop: { launch: true } },
      system: {
        clis: { claude: { ...status, versionAdvice: advice }, codex: status, grok: status, gemini: status },
        desktopApps: { codex: { ...status, appVersion: '1.0.0', versionAdvice: advice } },
      },
    } as unknown as ToolboxSnapshot
    const rows = presentTools(snapshot, memoryStorage())
    expect(rows.find((row) => row.id === 'claude')?.versionAdvice).toEqual(advice)
    expect(rows.find((row) => row.id === 'codex')?.versionAdvice).toBeNull()
    expect(rows.find((row) => row.id === 'codexDesktop')?.versionAdvice).toBeNull()
  })
})

describe('renderer CLI version advice', () => {
  const row = (versionAdvice: ToolPresentation['versionAdvice'], currentVersion: string | null = '2.1.276') => ({
    currentVersion,
    versionAdvice,
    status: { installed: currentVersion !== null, version: currentVersion, path: null, installDirectory: null },
  })

  it('shows only the version when no list applies or the version is already recommended', () => {
    expect(versionSubtitle(row(null))).toBe('2.1.276')
    expect(versionSubtitle(row({ recommendedVersion: '2.1.276', blockedReason: null, onRecommended: true, pinned: true, rollbackAvailable: false }))).toBe('2.1.276')
  })

  it('names the recommended version when the installed one merely differs', () => {
    expect(versionSubtitle(row({ recommendedVersion: '2.1.277', blockedReason: null, onRecommended: false, pinned: true, rollbackAvailable: true })))
      .toBe('2.1.276（推荐 2.1.277）')
  })

  it('stops recommending once the user chose to follow the latest release', () => {
    expect(versionSubtitle(row({ recommendedVersion: '2.1.277', blockedReason: null, onRecommended: false, pinned: false, rollbackAvailable: false })))
      .toBe('2.1.276')
  })

  it('says the installed version has a known problem when the list blocks it', () => {
    expect(versionSubtitle(row({ recommendedVersion: '2.1.277', blockedReason: '每次请求都 400', onRecommended: false, pinned: false, rollbackAvailable: true })))
      .toBe('2.1.276（已知问题，建议回到 2.1.277）')
  })

  it('points forward when the recommended version is the newer one', () => {
    // Codex 0.155.0 is the case this exists for: the fix shipped as the next
    // patch release, so telling the customer to go "back" points them the
    // wrong way while the button installs the newer build.
    const advice = { recommendedVersion: '0.155.1', blockedReason: '这个版本每次都向中转索要推理摘要', onRecommended: false, pinned: true, rollbackAvailable: true, recommendedIsNewer: true }
    expect(versionSubtitle(row(advice, '0.155.0'))).toBe('0.155.0（已知问题，建议更新到 0.155.1）')
    expect(recommendedVersionVerb(row(advice, '0.155.0'))).toBe('更新到')
    expect(recommendedVersionVerb(row({ ...advice, recommendedIsNewer: undefined }, '0.155.0'))).toBe('回到')
    expect(recommendedVersionVerb(row(null))).toBe('回到')
  })

  it('offers a rollback target only for an installed tool the list can move', () => {
    const advice = { recommendedVersion: '2.1.277', blockedReason: null, onRecommended: false, pinned: true, rollbackAvailable: true }
    expect(rollbackVersion(row(advice) as ToolPresentation)).toBe('2.1.277')
    expect(rollbackVersion(row(advice, null) as ToolPresentation)).toBeNull()
    expect(rollbackVersion(row(null) as ToolPresentation)).toBeNull()
    expect(rollbackVersion(row({ ...advice, rollbackAvailable: false }) as ToolPresentation)).toBeNull()
  })
})

describe('renderer tool availability', () => {
  it('names the probe failure reason instead of collapsing it into "not installed"', () => {
    const availability = toolAvailability({ installed: false, detectionFailed: true, detectionError: 'npm 查询超时' })
    expect(availability.state).toBe('detectionFailed')
    expect(availability.label).toBe('检测失败')
    expect(availability.tone).toBe('bad')
    expect(availability.reason).toBe('npm 查询超时')
    // 没探到不是「未找到版本」,那是一个这次并没有得出的结论。
    expect(availability.versionFallback).toBe('版本未读到')
  })

  it('still says the probe failed when the main process sent no reason', () => {
    const availability = toolAvailability({ installed: false, detectionFailed: true, detectionError: null })
    expect(availability.state).toBe('detectionFailed')
    expect(availability.reason).toBe('检测没有完成，装没装无法确认')
  })

  it('keeps a failed probe distinct from "not installed" even when the probe claims installed:false', () => {
    expect(toolAvailability({ installed: true, detectionFailed: false, detectionError: null }))
      .toMatchObject({ state: 'installed', label: '已安装', tone: 'ok', reason: null, versionFallback: '未找到版本' })
    expect(toolAvailability({ installed: false, detectionFailed: false, detectionError: null }))
      .toMatchObject({ state: 'missing', label: '未安装', tone: 'neutral', reason: null, versionFallback: '未找到版本' })
  })

  it('reports an unread partition as unknown rather than as a conclusion', () => {
    expect(toolAvailability(undefined, true))
      .toMatchObject({ state: 'unknown', label: '状态未读到', tone: 'warn', reason: null, versionFallback: '版本未读到' })
  })

  it('redacts a home directory out of the probe reason before it reaches the row', () => {
    const availability = toolAvailability({
      installed: false, detectionFailed: true,
      detectionError: 'C:\\Users\\peaker\\AppData\\npm 目录不可读',
    })
    expect(availability.reason).not.toContain('peaker')
  })
})

describe('renderer install source labelling', () => {
  it('names the official native installer in the status label', () => {
    expect(toolAvailability({ installed: true, installSource: 'native' }).label)
      .toBe('已安装（官方安装器）')
  })

  it('names an other-source install so the user knows npm did not put it there', () => {
    expect(toolAvailability({ installed: true, installSource: 'path' }).label)
      .toBe('已安装（其他来源）')
  })

  it('keeps a plain "已安装" for an npm install and when the source is unknown', () => {
    expect(toolAvailability({ installed: true, installSource: 'npm' }).label).toBe('已安装')
    expect(toolAvailability({ installed: true }).label).toBe('已安装')
  })

  it('treats non-npm sources as externally managed and npm/unknown/missing as not', () => {
    expect(isExternallyManagedInstall({ installed: true, installSource: 'native' })).toBe(true)
    expect(isExternallyManagedInstall({ installed: true, installSource: 'path' })).toBe(true)
    expect(isExternallyManagedInstall({ installed: true, installSource: 'npm' })).toBe(false)
    expect(isExternallyManagedInstall({ installed: true })).toBe(false)
    expect(isExternallyManagedInstall({ installed: false, installSource: 'native' })).toBe(false)
  })

  it('gives a source-specific passive hint instead of an npm update', () => {
    expect(externalInstallHint('native')).toBe('该版本由官方安装器管理，请用它自己的方式更新')
    expect(externalInstallHint('path')).toBe('该版本不是通过本工具安装的，更新请用它原本的安装方式')
    expect(externalInstallHint('npm')).toBeNull()
    expect(externalInstallHint(undefined)).toBeNull()
  })
})

describe('renderer copyable install directory', () => {
  function snapshotWith(claude: Record<string, unknown>): ToolboxSnapshot {
    const other = { installed: false, version: null, path: null, installDirectory: null }
    return {
      config: {},
      platform: {},
      system: {
        clis: { claude, codex: other, gemini: other, grok: other },
        desktopApps: { codex: { ...other, appVersion: null, installDirectory: '/Applications/ChatGPT.app' } },
      },
    } as unknown as ToolboxSnapshot
  }

  it('prefers the directory the probe actually found', () => {
    expect(toolInstallDirectory(snapshotWith({
      installed: true,
      installDirectory: '/usr/local/lib/node_modules/@anthropic-ai/claude-code',
      installTarget: '/Users/alex/Library/Application Support/XingMangAI/Cli/npm/lib/node_modules/@anthropic-ai/claude-code',
    }), 'claude')).toBe('/usr/local/lib/node_modules/@anthropic-ai/claude-code')
  })

  it('falls back to where a first install would land, which is the whole point on a fresh machine', () => {
    const target = '/Users/alex/Library/Application Support/XingMangAI/Cli/npm/lib/node_modules/@anthropic-ai/claude-code'
    expect(toolInstallDirectory(snapshotWith({ installed: false, installDirectory: null, installTarget: target }), 'claude'))
      .toBe(target)
  })

  it('returns null when neither is known, and when there is no snapshot or no tool', () => {
    expect(toolInstallDirectory(snapshotWith({ installed: false, installDirectory: null }), 'claude')).toBeNull()
    expect(toolInstallDirectory(snapshotWith({ installed: false, installDirectory: null, installTarget: null }), 'claude')).toBeNull()
    expect(toolInstallDirectory(null, 'claude')).toBeNull()
    expect(toolInstallDirectory(snapshotWith({ installed: true, installDirectory: '/x' }), undefined)).toBeNull()
  })

  it('reads the desktop app from its own partition, not from the CLI table', () => {
    expect(toolInstallDirectory(snapshotWith({ installed: true, installDirectory: '/x' }), 'codexDesktop'))
      .toBe('/Applications/ChatGPT.app')
  })
})

describe('renderer CLI update check failure', () => {
  it('surfaces the two reasons buildCliStatus writes when it cannot compare versions', () => {
    expect(updateCheckFailure({ updateCheck: 'failed', updateError: '已安装 CLI 的版本号无法解析，不能判断是否有更新' }))
      .toBe('已安装 CLI 的版本号无法解析，不能判断是否有更新')
    expect(updateCheckFailure({ updateCheck: 'failed', updateError: '已安装版本高于 npm latest，可能来自其他分发通道，无法可靠比较' }))
      .toBe('已安装版本高于 npm latest，可能来自其他分发通道，无法可靠比较')
  })

  it('says the check did not finish when it failed without a reason', () => {
    expect(updateCheckFailure({ updateCheck: 'failed', updateError: null }))
      .toBe('这次更新检查没有完成，无法判断是否有新版本')
  })

  it('stays silent when the check succeeded, was skipped, or never ran', () => {
    expect(updateCheckFailure({ updateCheck: 'checked', updateError: null })).toBeNull()
    expect(updateCheckFailure({ updateCheck: 'skipped', updateError: null })).toBeNull()
    expect(updateCheckFailure({})).toBeNull()
    expect(updateCheckFailure(undefined)).toBeNull()
  })

  it('keeps a stale error from a previous run off the row once the check succeeded', () => {
    expect(updateCheckFailure({ updateCheck: 'checked', updateError: 'npm latest 查询超时' })).toBeNull()
  })
})

describe('renderer config directory menu entry', () => {
  it('offers to open the folder once the tool has written one', () => {
    expect(configDirectoryMenuItem({ configDirectoryReady: true })).toEqual({ label: '打开配置文件夹', disabled: false })
  })

  it('greys the entry out instead of hiding it when nothing has been written yet', () => {
    // 藏起来的代价更大:用户要找的就是这一项,看不到会以为这个工具没有配置文件。
    expect(configDirectoryMenuItem({ configDirectoryReady: false })).toEqual({ label: '打开配置文件夹（还没生成）', disabled: true })
  })

  it('does not claim the folder is missing when the config block simply was not read', () => {
    expect(configDirectoryMenuItem({ configDirectoryReady: true }, true))
      .toEqual({ label: '打开配置文件夹（配置暂未读到）', disabled: true })
    expect(configDirectoryMenuItem({ configDirectoryReady: false }, true).label).not.toContain('还没生成')
  })

  it('reads the folder state the main process reported, per tool', () => {
    const providers = Object.fromEntries((['claude', 'codex', 'grok', 'gemini'] as const).map((provider) => [provider,
      { ...relayConfig(), ...(provider === 'gemini' ? { dataDirectoryExists: false } : {}) },
    ]))
    const status = { installed: true, version: '1.0.0', path: '/fixture' }
    const rows = presentTools({ config: { providers }, platform: { codexDesktop: { launch: true } },
      system: { clis: { claude: status, codex: status, grok: status, gemini: status },
        desktopApps: { codex: { ...status, appVersion: '1.0.0' } } },
    } as unknown as ToolboxSnapshot, memoryStorage())
    expect(rows.find((row) => row.id === 'gemini')?.configDirectoryReady).toBe(false)
    // Codex 桌面端与 Codex CLI 共用一份配置,两行读的是同一个目录状态。
    expect(rows.filter((row) => row.id === 'codex' || row.id === 'codexDesktop')
      .every((row) => row.configDirectoryReady)).toBe(true)
  })

  it('treats an unreadable config partition as "not written yet"', () => {
    const blank = { ...relayConfig(), exists: false, dataDirectory: '', dataDirectoryExists: false }
    const providers = Object.fromEntries((['claude', 'codex', 'grok', 'gemini'] as const).map((provider) => [provider, blank]))
    const status = { installed: true, version: '1.0.0', path: '/fixture' }
    const rows = presentTools({ config: { providers }, platform: { codexDesktop: { launch: false } },
      system: { clis: { claude: status, codex: status, grok: status, gemini: status }, desktopApps: { codex: status } },
    } as unknown as ToolboxSnapshot, memoryStorage())
    expect(rows.every((row) => !row.configDirectoryReady)).toBe(true)
  })
})

describe('renderer one-click account switch entry', () => {
  const installed = { installed: true } as ToolPresentation['status']
  it('offers the current account to any tool on its official account', () => {
    for (const provider of ['claude', 'codex', 'gemini', 'grok'] as const) {
      expect(accountSwitchTarget({ provider, source: 'official', status: installed })).toBe('account')
    }
  })

  it('offers the official account back only where a one-click official login works', () => {
    for (const source of ['account', 'manual', 'changed'] as const) {
      expect(accountSwitchTarget({ provider: 'claude', source, status: installed })).toBe('official')
      expect(accountSwitchTarget({ provider: 'codex', source, status: installed })).toBe('official')
      expect(accountSwitchTarget({ provider: 'grok', source, status: installed })).toBe('official')
      // 个人 Google 账号已不能用 Gemini CLI。
      expect(accountSwitchTarget({ provider: 'gemini', source, status: installed })).toBeNull()
    }
  })

  it('offers nothing for third-party, missing, or uninstalled tools', () => {
    expect(accountSwitchTarget({ provider: 'claude', source: 'unknown', status: installed })).toBeNull()
    expect(accountSwitchTarget({ provider: 'claude', source: 'missing', status: installed })).toBeNull()
    expect(accountSwitchTarget({ provider: 'claude', source: 'official', status: { installed: false } as ToolPresentation['status'] })).toBeNull()
  })
})
