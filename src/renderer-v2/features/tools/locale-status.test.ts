import { describe, expect, it } from 'vitest'
import type { CodexDesktopLocaleResult } from '../../../../electron/ipc-contract'
import { describeChineseLocale, describeChineseLocaleResult, describeWorkspaceTrustResult, macLocaleNote } from './locale-status'

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
      .toContain('本机通道将不再开启')
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
      .toBe('中文设置已保存。请先在 Codex 窗口中按 ⌘Q 完全退出，再回到星芒点击「打开」。')
    expect(describeChineseLocaleResult(result({ configuredLocale: 'system', needsRestart: true }), 'mac'))
      .toBe('已改为跟随系统语言。请先在 Codex 窗口中按 ⌘Q 完全退出，再回到星芒点击「打开」。')
    expect(describeChineseLocale(result(), 'mac'))
      .toBe('已保存的语言设置：简体中文。如果仍显示英文，请先在 Codex 窗口中按 ⌘Q 完全退出，再回到星芒点击「打开」。')
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
    expect(macLocaleNote).toContain('⌘Q')
    expect(macLocaleNote).not.toMatch(/通道|重新打开/)
  })

  it('tells a Mac user that Chinese only shows when the toolbox opens Codex', () => {
    expect(macLocaleNote).toBe('中文界面仅在从星芒打开 Codex 时生效，直接从程序坞或启动台打开 ChatGPT 仍为英文。点击「启用中文界面」仅修改设置，不会自动重启 Codex。如 Codex 正在运行，请先在 Codex 窗口中按 ⌘Q 完全退出，再回到星芒点击「打开」。')
  })

  it('tells a Mac user how an open Codex picks up a newly trusted folder', () => {
    expect(describeWorkspaceTrustResult(true, 'mac'))
      .toBe('文件夹信任已保存。如 Codex 正在运行，请先在 Codex 窗口中按 ⌘Q 完全退出，再回到星芒点击「打开」。')
  })

  it('keeps the plain trust message on Windows, where Codex is reopened for the user, and when nothing changed', () => {
    expect(describeWorkspaceTrustResult(true, 'win')).toBe('文件夹信任已保存')
    expect(describeWorkspaceTrustResult(false, 'mac')).toBe('文件夹信任已保存')
    expect(describeWorkspaceTrustResult(true, 'linux')).toBe('文件夹信任已保存')
  })
})
