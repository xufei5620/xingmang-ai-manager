import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { Home, type HomeProps } from './Home'
import { presentTools, type ToolboxSnapshot } from './model'
import type { ToolsApi } from './api'
import {
  pendingToolUpdates,
  readAnnouncedToolUpdates,
  rememberAnnouncedToolUpdates,
  rememberRevertedToolUpdate,
  unannouncedToolUpdates,
  updateNoticeKey,
} from './update-notice'

const cliStatus: Record<string, unknown> = {
  installed: true, version: '1.2.3', path: 'C:\\fixture\\bin', installDirectory: 'C:\\fixture',
  latestVersion: '1.2.3', updateAvailable: false,
  uninstall: { available: true, reason: null, manualCommand: null },
}
const providerConfig = {
  exists: true, hasApiKey: true, matchesRelay: true, configurationOwnership: 'account',
  baseUrl: 'https://xm.solov.cc/v1', actualBaseUrl: 'https://xm.solov.cc/v1', model: 'fixture-model',
  apiKeyPreview: 'sk-***', dataDirectory: 'C:\\fixture', dataDirectoryExists: true, files: [], updatedAt: null,
}
const runtime = { installed: true, version: '22.0.0', detectionFailed: false }

function snapshot(clis: Record<string, unknown>): ToolboxSnapshot {
  return {
    config: { providers: { claude: providerConfig, codex: providerConfig, grok: providerConfig, gemini: providerConfig } },
    platform: { codexDesktop: { launch: false } },
    system: {
      checkedAt: '2026-09-18T00:00:00.000Z',
      runtime: { node: runtime, npm: runtime, python: runtime },
      clis, desktopApps: { codex: { ...cliStatus, appVersion: '1.0.0' } },
    },
  } as unknown as ToolboxSnapshot
}

function renderHome(state: ToolboxSnapshot): string {
  const noop = () => undefined
  const props: HomeProps = {
    api: {} as ToolsApi, snapshot: state, loading: false, error: '', account: null,
    balance: null, jobs: {}, externalClients: [], externalLoading: false, externalError: '',
    onScan: noop, onInstall: noop, onCancelInstall: noop, onLaunch: noop, onConfigure: noop, onConfigureExternal: noop,
    onInstallExternal: noop, onLaunchExternal: noop, onCodexModels: noop, onUninstall: noop,
    onRuntime: noop, onNavigate: noop, onGuide: noop,
  }
  return renderToStaticMarkup(createElement(Home, props))
}

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key) },
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}
const globalWithStorage = globalThis as { localStorage?: Storage }
afterEach(() => { delete globalWithStorage.localStorage })

describe('renderer-v2 pending CLI updates', () => {
  it('counts exactly what the home card already calls 「N 个有更新」', () => {
    const state = snapshot({
      claude: { ...cliStatus, latestVersion: '2.0.0', updateAvailable: true },
      codex: { ...cliStatus, latestVersion: '1.9.0', updateAvailable: true },
      gemini: cliStatus,
      // 更新检查失败的那一行既没有「更新」按钮，也不该被算进角标：
      // 数字比不出来时报一个数，比不报还糟。
      grok: { ...cliStatus, updateAvailable: false, updateCheck: 'failed', updateError: '版本号无法解析' },
    })
    const pending = pendingToolUpdates(presentTools(state))
    expect(pending.map((entry) => entry.id)).toEqual(['claude', 'codex'])
    expect(renderHome(state)).toContain(`${pending.length} 个有更新`)
  })

  it('leaves the badge empty when nothing is installed or nothing has a new version', () => {
    expect(pendingToolUpdates(presentTools(snapshot({
      claude: cliStatus, codex: cliStatus, gemini: cliStatus, grok: cliStatus,
    })))).toEqual([])
    expect(pendingToolUpdates(presentTools(snapshot({
      claude: { ...cliStatus, installed: false, latestVersion: '2.0.0', updateAvailable: true },
      codex: cliStatus, gemini: cliStatus, grok: cliStatus,
    })))).toEqual([])
  })

  it('builds an event key the main process will accept, whatever the upstream version string looks like', () => {
    const key = updateNoticeKey([
      { id: 'codex', version: '1.9.0-alpha+build 7' },
      { id: 'claude', version: '2.0.0' },
    ])
    expect(key).toBe('cli-update:claude.2.0.0_codex.1.9.0-alpha-build-7')
    expect(key).toMatch(/^[A-Za-z0-9:._-]+$/)
    expect(key.length).toBeLessThanOrEqual(160)
    // 顺序不该改变编号，否则同一批更新会被当成新的一批再提醒一次。
    expect(updateNoticeKey([{ id: 'claude', version: '2.0.0' }, { id: 'codex', version: '1.0.0' }]))
      .toBe(updateNoticeKey([{ id: 'codex', version: '1.0.0' }, { id: 'claude', version: '2.0.0' }]))
  })
})

describe('renderer-v2 CLI update reminder suppression', () => {
  it('reminds once per tool and version, and again only when the target version moves', () => {
    const first = [{ id: 'claude' as const, version: '2.0.0' }]
    expect(unannouncedToolUpdates(first, {})).toEqual(first)
    expect(unannouncedToolUpdates(first, { claude: '2.0.0' })).toEqual([])
    expect(unannouncedToolUpdates([{ id: 'claude', version: '2.1.0' }], { claude: '2.0.0' }))
      .toEqual([{ id: 'claude', version: '2.1.0' }])
    expect(unannouncedToolUpdates(
      [{ id: 'claude', version: '2.0.0' }, { id: 'codex', version: '1.9.0' }],
      { claude: '2.0.0' },
    )).toEqual([{ id: 'codex', version: '1.9.0' }])
  })

  it('survives a restart and forgets a tool once the user has updated it', () => {
    globalWithStorage.localStorage = memoryStorage()
    expect(readAnnouncedToolUpdates()).toEqual({})
    expect(rememberAnnouncedToolUpdates([
      { id: 'claude', version: '2.0.0' },
      { id: 'codex', version: '1.9.0' },
    ])).toBe(true)
    expect(readAnnouncedToolUpdates()).toEqual({ claude: '2.0.0', codex: '1.9.0' })
    // 用户更完 codex 之后它不再待更新，记录里也不该留着它：
    // 下次 codex 再出新版本时要重新提醒。
    rememberAnnouncedToolUpdates([{ id: 'claude', version: '2.0.0' }])
    expect(readAnnouncedToolUpdates()).toEqual({ claude: '2.0.0' })
  })

  it('does not remind about the version the user just reverted from', () => {
    globalWithStorage.localStorage = memoryStorage()
    rememberAnnouncedToolUpdates([{ id: 'codex', version: '1.9.0' }])
    expect(rememberRevertedToolUpdate('claude', '2.1.282')).toBe(true)
    expect(readAnnouncedToolUpdates()).toEqual({ codex: '1.9.0', claude: '2.1.282' })
    expect(unannouncedToolUpdates([{ id: 'claude', version: '2.1.282' }], readAnnouncedToolUpdates())).toEqual([])
    // 上游之后再出更新的版本，照常提醒。
    expect(unannouncedToolUpdates([{ id: 'claude', version: '2.1.290' }], readAnnouncedToolUpdates()))
      .toEqual([{ id: 'claude', version: '2.1.290' }])
  })

  it('treats unreadable or missing local storage as 「还没提醒过」 instead of throwing', () => {
    expect(readAnnouncedToolUpdates()).toEqual({})
    expect(rememberAnnouncedToolUpdates([{ id: 'claude', version: '2.0.0' }])).toBe(false)
    const storage = memoryStorage()
    storage.setItem('xingmang-v2-cli-update-notice', '{not json')
    globalWithStorage.localStorage = storage
    expect(readAnnouncedToolUpdates()).toEqual({})
  })
})
