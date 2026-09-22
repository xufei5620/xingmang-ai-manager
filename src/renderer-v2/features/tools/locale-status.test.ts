import { describe, expect, it } from 'vitest'
import type { CodexDesktopLocaleResult } from '../../../../electron/ipc-contract'
import { describeChineseLocaleResult } from './locale-status'

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
    expect(describeChineseLocaleResult(result({ runtimeVerified: true, restarted: true })))
      .toBe('中文界面已启用，Codex 已重新打开。')
  })

  it('tells the user the debugging port is gone after switching back to the system language', () => {
    expect(describeChineseLocaleResult(result({ configuredLocale: 'system', restarted: true })))
      .toContain('那条本机通道也不再开启')
    expect(describeChineseLocaleResult(result({ configuredLocale: 'system', restarted: false })))
      .toBe('已改为跟随系统语言，下次从星芒打开 Codex 时生效。')
  })

  it('keeps a launch warning ahead of every other message', () => {
    expect(describeChineseLocaleResult(result({ configuredLocale: 'system', warning: '未能重启 Codex' })))
      .toBe('未能重启 Codex')
  })
})
