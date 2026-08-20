import { describe, expect, it } from 'vitest'
import { platformCapabilitiesFor } from '../../electron/platform-capabilities'
import {
  applyManualUninstallResult,
  canSwitchCodexDesktopToChinese,
  codexDesktopMaintenanceControl,
  cliMaintenanceAction,
  cliUninstallPresentation,
  runCodexDesktopMaintenanceAction,
  updateStateLabel,
  type MaintenanceCliStatus,
  type MaintenanceSnapshot,
} from './MaintenancePage'

function localeStatus(effectiveLocale: string, available = true) {
  return {
    installed: true,
    version: '26.818.2441.0',
    running: true,
    configPath: 'C:\\Users\\tester\\.codex\\config.toml',
    configuredLocale: effectiveLocale === 'zh-CN' ? 'zh-CN' : null,
    effectiveLocale,
    chineseResources: {
      available,
      frontendChunk: available,
      menuLocale: available,
      pakLocale: available,
      resourceRoot: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex',
    },
    needsRestart: false,
    error: null,
  }
}

describe('Codex Desktop locale controls', () => {
  it('disables switching when simplified Chinese is already active', () => {
    expect(canSwitchCodexDesktopToChinese(localeStatus('zh-CN'))).toBe(false)
    expect(canSwitchCodexDesktopToChinese(localeStatus('system'))).toBe(true)
    expect(canSwitchCodexDesktopToChinese(localeStatus('system', false))).toBe(false)
    expect(canSwitchCodexDesktopToChinese(null)).toBe(false)
  })
})

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

  it('shows mirror synchronization instead of claiming the domestic package is ready', () => {
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
      action: 'update',
      label: '查看更新',
      statusClass: 'is-warn',
      statusLabel: '镜像同步中',
    })
  })
})
