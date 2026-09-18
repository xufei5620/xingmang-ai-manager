import { describe, expect, it } from 'vitest'
import { platformCapabilitiesFor } from '../../electron/platform-capabilities'
import { providerIds } from '../../electron/catalog'
import {
  applyManualUninstallResult,
  codexDesktopMaintenanceControl,
  cliMaintenanceAction,
  cliUninstallPresentation,
  maintenanceSelectableProviders,
  runCodexDesktopMaintenanceAction,
  updateStateLabel,
  type MaintenanceCliStatus,
  type MaintenanceSnapshot,
} from './MaintenancePage'
import type { ProviderId } from '../types'

function status(uninstall: MaintenanceCliStatus['uninstall']): MaintenanceCliStatus {
  return {
    installed: true,
    version: '0.1.0',
    path: 'C:\\Users\\tester\\AppData\\Roaming\\npm\\tool.cmd',
    installDirectory: 'C:\\Users\\tester\\AppData\\Roaming\\npm',
    latestVersion: '0.1.0',
    updateAvailable: false,
    uninstall,
  }
}

function desktopStatus(
  overrides: Partial<MaintenanceSnapshot['codexDesktop']> = {},
): MaintenanceSnapshot['codexDesktop'] {
  return {
    installed: true,
    version: '26.727.51351',
    appVersion: '26.727.51351',
    path: '/Applications/Codex.app',
    installDirectory: '/Applications/Codex.app',
    updateCheck: 'skipped',
    updateState: 'unknown',
    running: false,
    ...overrides,
  }
}

describe('maintenance CLI uninstall presentation', () => {
  it('turns an unsupported installed CLI into an actionable manual-help flow', () => {
    expect(cliUninstallPresentation(status({
      available: false,
      reason: '当前为用户级 npm 安装',
      manualCommand: 'npm uninstall -g @openai/codex',
    }), platformCapabilitiesFor('darwin', 'arm64'))).toEqual({
      available: false,
      mode: 'manual',
      actionLabel: '卸载帮助',
      command: 'npm uninstall -g @openai/codex',
      guidance: '当前为用户级 npm 安装；打开卸载帮助可复制终端命令',
      shellLabel: '终端',
    })
  })

  it('keeps the action enabled for a safely managed installation', () => {
    expect(cliUninstallPresentation(status({
      available: true,
      reason: null,
      manualCommand: null,
    }))).toEqual({
      available: true,
      mode: 'automatic',
      actionLabel: '卸载',
      command: null,
      guidance: null,
      shellLabel: null,
    })
  })

  it('keeps manual help active for an unknown source without inventing a command', () => {
    expect(cliUninstallPresentation(status({
      available: false,
      reason: '当前安装来源未知',
      manualCommand: null,
    }), platformCapabilitiesFor('darwin', 'arm64'))).toMatchObject({
      available: false,
      mode: 'manual',
      actionLabel: '卸载帮助',
      command: null,
      shellLabel: '终端',
    })
  })

  it('keeps the error visible while converting an automatic failure into the existing manual tutorial', () => {
    const automatic = status({ available: true, reason: null, manualCommand: null })
    const snapshot: MaintenanceSnapshot = {
      checkedAt: '2026-08-03T00:00:00.000Z',
      runtime: {
        node: {
          installed: true,
          version: '24.19.0',
          path: 'C:\\Program Files\\nodejs\\node.exe',
          installDirectory: 'C:\\Program Files\\nodejs',
          versionStatus: 'supported',
        },
        npm: {
          installed: true,
          version: '11.17.0',
          path: 'C:\\Program Files\\nodejs\\npm.cmd',
          installDirectory: 'C:\\Program Files\\nodejs',
        },
      },
      clis: {
        claude: automatic,
        codex: automatic,
        gemini: automatic,
        grok: automatic,
      },
      codexDesktop: desktopStatus(),
    }
    const result = {
      outcome: 'manual-required' as const,
      previousVersion: '0.2.118',
      error: 'Grok CLI 隔离文件在最终删除前发生变化',
      manualHelp: {
        reason: '自动卸载安全验证失败：Grok CLI 隔离文件在最终删除前发生变化',
        manualCommand: null,
      },
    }

    const next = applyManualUninstallResult(snapshot, 'grok', result)

    expect(result.error).toContain('最终删除前发生变化')
    expect(cliUninstallPresentation(
      next.clis.grok,
      platformCapabilitiesFor('darwin', 'arm64'),
    )).toMatchObject({
      mode: 'manual',
      actionLabel: '卸载帮助',
      command: null,
      guidance: result.manualHelp.reason,
    })
  })
})

describe('Codex Desktop maintenance action', () => {
  it('turns a failed detector into retry instead of install or launch', () => {
    const failed = desktopStatus({
      installed: false,
      detectionFailed: true,
      detectionError: 'AppX 查询失败',
    })

    expect(cliMaintenanceAction(failed)).toBe('check')
    expect(updateStateLabel(failed)).toBe('检测失败')
    expect(codexDesktopMaintenanceControl(
      platformCapabilitiesFor('win32', 'x64'),
      failed,
      false,
    )).toMatchObject({
      action: 'check',
      label: '重新检测',
      statusLabel: '检测失败',
    })
    expect(codexDesktopMaintenanceControl(
      platformCapabilitiesFor('darwin', 'arm64'),
      failed,
      false,
    )).toMatchObject({ action: 'check', label: '重新检测' })
  })

  it('presents an installed macOS app as an open action instead of an update check', () => {
    const control = codexDesktopMaintenanceControl(
      platformCapabilitiesFor('darwin', 'arm64'),
      desktopStatus(),
      false,
    )

    expect(control).toEqual({
      action: 'launch',
      disabled: false,
      loading: false,
      icon: 'open',
      label: '打开 Codex App',
      statusClass: 'is-pass',
      statusLabel: '可打开',
    })
  })

  it('uses opening progress semantics while a macOS launch is active', () => {
    expect(codexDesktopMaintenanceControl(
      platformCapabilitiesFor('darwin', 'arm64'),
      desktopStatus({ running: true }),
      true,
    )).toEqual({
      action: 'launch',
      disabled: true,
      loading: true,
      icon: 'loading',
      label: '正在打开',
      statusClass: 'is-pass',
      statusLabel: '正在运行',
    })
  })

  it('launches before refreshing and never falls through to the generic check', async () => {
    const effects: string[] = []

    await runCodexDesktopMaintenanceAction('launch', {
      launch: async () => { effects.push('launch') },
      refresh: async () => { effects.push('refresh') },
      check: async () => { effects.push('check') },
      showInstaller: () => { effects.push('installer') },
    })

    expect(effects).toEqual(['launch', 'refresh'])
  })

  it('keeps the Windows generic update-check control unchanged', () => {
    expect(codexDesktopMaintenanceControl(
      platformCapabilitiesFor('win32', 'x64'),
      desktopStatus(),
      false,
    )).toMatchObject({
      action: 'check',
      disabled: false,
      loading: false,
      icon: 'refresh',
      label: '检查更新',
      statusLabel: '未完成检测',
    })
  })

  it('does not nag for a Store-current install when only the official feed is ahead', () => {
    expect(codexDesktopMaintenanceControl(
      platformCapabilitiesFor('win32', 'x64'),
      desktopStatus({
        latestVersion: '26.803.10989.0',
        mirrorVersion: '26.803.5235.0',
        mirrorUpdateAvailable: false,
        updateCheck: 'checked',
        updateState: 'available',
      }),
      false,
    )).toMatchObject({
      action: 'check',
      label: '检查更新',
      statusClass: 'is-pass',
      statusLabel: '已是可安装最新版',
    })
  })
})

function cliStatus(overrides: Partial<MaintenanceCliStatus> = {}): MaintenanceCliStatus {
  return {
    installed: false,
    version: null,
    path: null,
    installDirectory: null,
    latestVersion: null,
    updateAvailable: false,
    uninstall: { available: false, reason: null, manualCommand: null },
    ...overrides,
  }
}

function snapshot(checkedAt: string, clis: Partial<Record<ProviderId, MaintenanceCliStatus>> = {}): MaintenanceSnapshot {
  const runtime = { installed: true, version: '22.11.0', path: null, installDirectory: null }
  return {
    checkedAt,
    runtime: { node: runtime, npm: runtime },
    clis: Object.fromEntries(providerIds.map((id) => [id, clis[id] ?? cliStatus()])) as Record<ProviderId, MaintenanceCliStatus>,
    codexDesktop: { installed: false, version: null, path: null, installDirectory: null, running: false },
  }
}

describe('maintenance selection before detection reports', () => {
  it('selects nothing while checkedAt is empty, so a failed first scan cannot invite four reinstalls', () => {
    expect(maintenanceSelectableProviders(snapshot(''))).toEqual([])
  })

  it('selects the CLIs a completed scan actually found missing', () => {
    expect(maintenanceSelectableProviders(snapshot('2026-09-18T00:00:00.000Z', {
      claude: cliStatus({ installed: true, version: '1.0.0', updateState: 'latest' }),
    }))).toEqual(['codex', 'gemini', 'grok'])
  })

  it('leaves a CLI whose probe failed out of the selection', () => {
    expect(maintenanceSelectableProviders(snapshot('2026-09-18T00:00:00.000Z', {
      codex: cliStatus({ detectionFailed: true, detectionError: '本地探针暂时不可用' }),
    }))).toEqual(['claude', 'gemini', 'grok'])
  })

  it('reports an unchecked CLI as needing a rescan rather than an install', () => {
    expect(cliMaintenanceAction(cliStatus(), false)).toBe('check')
    expect(updateStateLabel(cliStatus(), false)).toBe('未完成检测')
  })

  it('keeps the confirmed-scan behaviour unchanged by default', () => {
    expect(cliMaintenanceAction(cliStatus())).toBe('install')
    expect(updateStateLabel(cliStatus())).toBe('未安装')
  })
})
