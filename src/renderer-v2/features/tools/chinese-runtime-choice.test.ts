import { describe, expect, it } from 'vitest'
import type { CodexDesktopLocaleStatus, PlatformCapabilities } from '../../../../electron/ipc-contract'
import { shouldAskForChineseRuntimePatch } from './chinese-runtime-choice'

const windows = { platform: 'windows' } as PlatformCapabilities
const macos = { platform: 'macos' } as PlatformCapabilities

function locale(overrides: Partial<CodexDesktopLocaleStatus> = {}): CodexDesktopLocaleStatus {
  return {
    installed: true,
    version: '26.901.0.0',
    running: false,
    configPath: 'C:\\Users\\test\\.codex\\config.toml',
    configuredLocale: 'zh-CN',
    effectiveLocale: 'zh-CN',
    chineseResources: { available: true, frontendChunk: true, menuLocale: true, pakLocale: true, resourceRoot: 'C:\\Codex' },
    needsRestart: false,
    error: null,
    ...overrides,
  }
}

describe('Codex Desktop Chinese runtime patch question', () => {
  it('asks a Windows user who has never answered, whatever config.toml already says', () => {
    expect(shouldAskForChineseRuntimePatch({ platform: windows, storedChoice: undefined, locale: locale() })).toBe(true)
    expect(shouldAskForChineseRuntimePatch({ platform: windows, storedChoice: undefined, locale: locale({ configuredLocale: null }) })).toBe(true)
  })

  it.each(['enabled' as const, 'disabled' as const])('never asks twice once the answer is stored: %s', (storedChoice) => {
    expect(shouldAskForChineseRuntimePatch({ platform: windows, storedChoice, locale: locale() })).toBe(false)
  })

  it('does not ask where the runtime patch cannot run at all', () => {
    expect(shouldAskForChineseRuntimePatch({ platform: macos, storedChoice: undefined, locale: locale() })).toBe(false)
    expect(shouldAskForChineseRuntimePatch({ platform: null, storedChoice: undefined, locale: locale() })).toBe(false)
    expect(shouldAskForChineseRuntimePatch({ platform: windows, storedChoice: undefined, locale: locale({ installed: false }) })).toBe(false)
    expect(shouldAskForChineseRuntimePatch({
      platform: windows,
      storedChoice: undefined,
      locale: locale({ chineseResources: { available: false, frontendChunk: false, menuLocale: false, pakLocale: false, resourceRoot: null } }),
    })).toBe(false)
  })

  it('leaves the question open when the probe itself failed, instead of recording an answer', () => {
    expect(shouldAskForChineseRuntimePatch({ platform: windows, storedChoice: undefined, locale: null })).toBe(false)
    expect(shouldAskForChineseRuntimePatch({ platform: windows, storedChoice: undefined, locale: locale({ error: '读取失败' }) })).toBe(false)
  })
})
