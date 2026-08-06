import { describe, expect, it } from 'vitest'
import {
  cliUninstallPresentation,
  type MaintenanceCliStatus,
} from './MaintenancePage'

function status(uninstall: MaintenanceCliStatus['uninstall']): MaintenanceCliStatus {
  return {
    installed: true,
    version: '0.1.0',
    installDirectory: 'C:\\Users\\tester\\AppData\\Roaming\\npm',
    latestVersion: '0.1.0',
    updateAvailable: false,
    uninstall,
  }
}

describe('maintenance CLI uninstall presentation', () => {
  it('disables the action and exposes an actionable manual npm command', () => {
    expect(cliUninstallPresentation(status({
      available: false,
      reason: '当前为用户级 npm 安装',
      manualCommand: 'npm uninstall -g @openai/codex',
    }))).toEqual({
      available: false,
      guidance: '当前为用户级 npm 安装；普通 PowerShell：npm uninstall -g @openai/codex',
    })
  })

  it('keeps the action enabled for a safely managed installation', () => {
    expect(cliUninstallPresentation(status({
      available: true,
      reason: null,
      manualCommand: null,
    }))).toEqual({ available: true, guidance: null })
  })
})
