import type { ExternalClientStatus, ExternalToolId } from '../../../../electron/ipc-contract'
import { spacedName, type ToolboxSnapshot } from './model'
import { jobToolName } from './tool-jobs'

/**
 * Mac 上星芒一键装的那几个桌面端，有新版时首页提醒、点一下就在星芒里更新（yoyo 2026-10-27「桌面端更新改」）。
 * 新版以星芒存储桶为准，比不比、换不换得了都由主进程定（macos-desktop-app-update.ts），这里只管点了以后
 * 问一句、说一句。
 */
export type DesktopUpdateTool = 'codexDesktop' | ExternalToolId

/** Codex 桌面端那一行的「可更新到 v…」在 Mac 上走这条路；Windows 照旧是 install。 */
export function isMacDesktopUpdate(snapshot: ToolboxSnapshot | null, tool: string, intent?: 'update' | 'rollback'): tool is 'codexDesktop' {
  return tool === 'codexDesktop' && intent === 'update' && snapshot?.platform.isMac === true
}

/** 首页卡片上「可更新到 v…」要更到的那一版：主进程说换得了、版本号也读得到才有。 */
export function externalUpdateTarget(status: ExternalClientStatus): string | null {
  return status.installed && status.updateAvailable === true && status.latestVersion ? status.latestVersion.replace(/^v/, '') : null
}

export function desktopUpdateToolName(tool: DesktopUpdateTool): string {
  return jobToolName(tool) ?? tool
}

/** 它还开着时那一问（10-08 给 Windows Codex 写过的那版字）。 */
export function desktopUpdateRunningPrompt(tool: DesktopUpdateTool): { title: string; body: string; label: string; cancelLabel: string } {
  return {
    title: `${spacedName(desktopUpdateToolName(tool))}正在运行`,
    body: '更新前需关闭该程序，正在进行的回答将被中断。更新完成后星芒将自动重新打开。',
    label: '关掉并更新',
    cancelLabel: '暂不更新',
  }
}

/** Mac 的「App 管理」拦住了这次更新：带客户去系统设置里打开星芒的开关，回来再点一次。 */
export function desktopUpdateBlockedPrompt(version: string): { title: string; body: string; label: string; cancelLabel: string } {
  return {
    title: '需先允许星芒更新 App',
    body: `本次更新被 Mac 安全设置拦截，旧版本仍可正常使用。请点击「前往设置」，在「App 管理」中开启「星芒AI管理工具」，然后返回再次点击「可更新到 v${version.replace(/^v/, '')}」。`,
    label: '前往设置',
    cancelLabel: '暂不更新',
  }
}

export function desktopUpdatedMessage(tool: DesktopUpdateTool, version: string): string {
  return `${spacedName(desktopUpdateToolName(tool))}已更新到 v${version.replace(/^v/, '')}`
}

/** 其它原因没更新成时卡片上那一行（旁边照旧有「看原因」）。 */
export const desktopUpdateFailedLine = '更新失败，旧版本仍可正常使用'

export function withoutDesktopTool<T>(record: Partial<Record<DesktopUpdateTool, T>>, tool: DesktopUpdateTool): Partial<Record<DesktopUpdateTool, T>> {
  if (!(tool in record)) return record
  const next = { ...record }
  delete next[tool]
  return next
}
