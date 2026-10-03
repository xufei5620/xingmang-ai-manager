import { describe, expect, it } from 'vitest'
import type { CodexDesktopLocaleResult } from '../../../../electron/ipc-contract'
import { describeChineseLocale, describeChineseLocaleResult, macLocaleNote } from './locale-status'

function result(overrides: Partial<CodexDesktopLocaleResult> = {}): CodexDesktopLocaleResult {
  return {
    installed: true,
    version: '26.901.0.0',
    running: true,
    configPath: 'C:\\Users\\test\\.codex\\config.toml',
    configuredLocale: 'zh-CN',
    effectiveLocale: 'zh-CN',
    chineseResources: { available: true, frontendChunk: true, menuLocale: true, pakLocale: true, resourceRoot: 'C:\\Codex' },
    needsRestart: false,
    error: null,
    restarted: false,
    ...overrides,
  }
}

describe('Codex Desktop locale result messages', () => {
  it('reports a verified Chinese runtime patch', () => {
    expect(describeChineseLocaleResult(result({ runtimeVerified: true, restarted: true }), 'win'))
      .toBe('中文界面已启用，Codex 已重新打开。')
  })

  it('tells the user the debugging port is gone after switching back to the system language', () => {
    expect(describeChineseLocaleResult(result({ configuredLocale: 'system', restarted: true }), 'win'))
      .toContain('那条本机通道也不再开启')
    expect(describeChineseLocaleResult(result({ configuredLocale: 'system', restarted: false }), 'win'))
      .toBe('已改为跟随系统语言，下次从星芒打开 Codex 时生效。')
  })

  it('keeps a launch warning ahead of every other message', () => {
    expect(describeChineseLocaleResult(result({ configuredLocale: 'system', warning: '未能重启 Codex' }), 'win'))
      .toBe('未能重启 Codex')
  })

  it('keeps the Windows wording that relies on reopening Codex from the app', () => {
    expect(describeChineseLocaleResult(result({ needsRestart: true }), 'win'))
      .toBe('中文设置已保存，请从星芒重新打开 Codex 桌面端以应用。')
    expect(describeChineseLocale(result(), 'win')).toBe('已保存的语言设置：简体中文。如果仍显示英文，可再次启用中文界面。')
  })

  it('tells a Mac user with Codex still open to quit it completely, since the app never restarts it there', () => {
    expect(describeChineseLocaleResult(result({ needsRestart: true }), 'mac'))
      .toBe('中文设置已保存。先在 Codex 窗口里按 Command + Q 完全退出，再回星芒点「打开」。')
    expect(describeChineseLocaleResult(result({ configuredLocale: 'system', needsRestart: true }), 'mac'))
      .toBe('已改为跟随系统语言。先在 Codex 窗口里按 Command + Q 完全退出，再回星芒点「打开」。')
    expect(describeChineseLocale(result(), 'mac'))
      .toBe('已保存的语言设置：简体中文。如果仍显示英文，先在 Codex 窗口里按 Command + Q 完全退出，再回星芒点「打开」。')
  })

  it('tells a Mac user with Codex closed that the next open picks the setting up', () => {
    expect(describeChineseLocaleResult(result({ running: false, needsRestart: true }), 'mac'))
      .toBe('中文设置已保存，下次从星芒打开 Codex 时生效。')
    expect(describeChineseLocaleResult(result({ running: false, configuredLocale: 'system', needsRestart: true }), 'mac'))
      .toBe('已改为跟随系统语言，下次从星芒打开 Codex 时生效。')
  })

  it('does not ask a Mac user to quit Codex when following the system language changed nothing', () => {
    expect(describeChineseLocaleResult(result({ configuredLocale: 'system', needsRestart: false }), 'mac'))
      .toBe('已改为跟随系统语言，下次从星芒打开 Codex 时生效。')
  })

  it('explains the Mac settings without the Windows-only local channel or automatic reopen', () => {
    expect(macLocaleNote).toContain('Command + Q')
    expect(macLocaleNote).not.toMatch(/通道|重新打开/)
  })
})
