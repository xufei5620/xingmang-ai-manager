import { describe, expect, it } from 'vitest'
import { codexDesktopUpdateDetail, codexDesktopUpdateKind } from './codex-desktop-update'

describe('codexDesktopUpdateKind', () => {
  it('treats a Store-current install as current when the official feed is ahead of the mirror', () => {
    expect(codexDesktopUpdateKind({
      updateState: 'available',
      mirrorUpdateAvailable: false,
    })).toBe('store-current')
    expect(codexDesktopUpdateDetail({
      updateState: 'available',
      mirrorUpdateAvailable: false,
      latestVersion: '26.818.5345.0',
    })).toBe('已是可安装最新版 · 官方 26.818.5345.0 国内尚未同步')
  })

  it('keeps a real sideload update when the mirror has a newer package', () => {
    expect(codexDesktopUpdateKind({
      updateState: 'available',
      mirrorUpdateAvailable: true,
    })).toBe('installable')
    expect(codexDesktopUpdateDetail({
      updateState: 'available',
      mirrorUpdateAvailable: true,
      latestVersion: '26.818.5345.0',
    })).toBe('可更新至 26.818.5345.0')
  })

  it('does not invent a store-current state when the mirror probe is missing', () => {
    expect(codexDesktopUpdateKind({
      updateState: 'available',
      mirrorUpdateAvailable: null,
    })).toBe('unknown')
  })
})
