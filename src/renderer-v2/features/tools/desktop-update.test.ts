import { describe, expect, it } from 'vitest'
import type { ExternalClientStatus } from '../../../../electron/ipc-contract'
import {
  desktopUpdateBlockedPrompt,
  desktopUpdatedMessage,
  desktopUpdateFailedLine,
  desktopUpdateRunningPrompt,
  externalUpdateTarget,
  isMacDesktopUpdate,
  withoutDesktopTool,
} from './desktop-update'
import type { ToolboxSnapshot } from './model'

function snapshotOn(isMac: boolean): ToolboxSnapshot {
  return { platform: { isMac } } as ToolboxSnapshot
}

describe('renderer-v2 Mac desktop app updates', () => {
  it('routes only the Codex desktop update on a Mac to the in-place update', () => {
    expect(isMacDesktopUpdate(snapshotOn(true), 'codexDesktop', 'update')).toBe(true)
    expect(isMacDesktopUpdate(snapshotOn(false), 'codexDesktop', 'update')).toBe(false)
    expect(isMacDesktopUpdate(snapshotOn(true), 'codexDesktop', undefined)).toBe(false)
    expect(isMacDesktopUpdate(snapshotOn(true), 'codexDesktop', 'rollback')).toBe(false)
    expect(isMacDesktopUpdate(snapshotOn(true), 'codex', 'update')).toBe(false)
    expect(isMacDesktopUpdate(null, 'codexDesktop', 'update')).toBe(false)
  })

  it('reads the target version off a client row only when it can be updated', () => {
    const row = { installed: true, updateAvailable: true, latestVersion: 'v3.6556.2' } as ExternalClientStatus
    expect(externalUpdateTarget(row)).toBe('3.6556.2')
    expect(externalUpdateTarget({ ...row, updateAvailable: false })).toBeNull()
    expect(externalUpdateTarget({ ...row, installed: false })).toBeNull()
    expect(externalUpdateTarget({ ...row, latestVersion: null })).toBeNull()
  })

  it('uses the wording yoyo approved on 2026-10-27, word for word', () => {
    expect(desktopUpdateRunningPrompt('claudeDesktop')).toEqual({
      title: 'Claude Desktop 正在运行',
      body: '更新前需关闭该程序，正在进行的回答将被中断。更新完成后星芒将自动重新打开。',
      label: '关掉并更新',
      cancelLabel: '暂不更新',
    })
    expect(desktopUpdateRunningPrompt('codexDesktop').title).toBe('Codex 桌面端正在运行')
    expect(desktopUpdateRunningPrompt('opencode').title).toBe('OpenCode 正在运行')
    expect(desktopUpdatedMessage('claudeDesktop', '3.6556.2')).toBe('Claude Desktop 已更新到 v3.6556.2')
    expect(desktopUpdatedMessage('codexDesktop', 'v26.1003.2')).toBe('Codex 桌面端已更新到 v26.1003.2')
    expect(desktopUpdateBlockedPrompt('3.6556.2')).toEqual({
      title: '需先允许星芒更新 App',
      body: '本次更新被 Mac 安全设置拦截，旧版本仍可正常使用。请点击「前往设置」，在「App 管理」中开启「星芒AI管理工具」，然后返回再次点击「可更新到 v3.6556.2」。',
      label: '前往设置',
      cancelLabel: '暂不更新',
    })
    expect(desktopUpdateFailedLine).toBe('更新失败，旧版本仍可正常使用')
  })

  it('drops one tool from a record without touching the others', () => {
    const record = { opencode: 'a', codexDesktop: 'b' }
    expect(withoutDesktopTool(record, 'opencode')).toEqual({ codexDesktop: 'b' })
    expect(withoutDesktopTool(record, 'claudeDesktop')).toBe(record)
  })
})
