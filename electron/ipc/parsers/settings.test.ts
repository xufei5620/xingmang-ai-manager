import { describe, expect, it } from 'vitest'
import { parseSettingsUpdate } from './settings'

describe('parseSettingsUpdate', () => {
  it('keeps absent fields absent so the stored values stay', () => {
    expect(parseSettingsUpdate({ version: 2 })).toEqual({ version: 2 })
  })

  it('rejects a typo in the setting that decides whether Codex starts with a debugging port', () => {
    expect(parseSettingsUpdate({ version: 2, codexDesktopChineseRuntimePatch: 'enabled' }))
      .toEqual({ version: 2, codexDesktopChineseRuntimePatch: 'enabled' })
    for (const value of ['enable', true, null]) {
      expect(() => parseSettingsUpdate({ version: 2, codexDesktopChineseRuntimePatch: value })).toThrow('Codex 中文界面设置格式错误')
    }
  })

  it('accepts only registered lines for registered sites', () => {
    expect(parseSettingsUpdate({ version: 2, relayEndpointIds: { solov: 'direct' } }))
      .toMatchObject({ relayEndpointIds: { solov: 'direct' } })
    for (const relayEndpointIds of [{ solov: 'https://attacker.invalid' }, { attacker: 'primary' }]) {
      expect(() => parseSettingsUpdate({ version: 2, relayEndpointIds })).toThrow('无法使用这条连接线路，请重新选择')
    }
    expect(() => parseSettingsUpdate({ version: 2, relayEndpointIds: 'direct' })).toThrow('连接线路设置格式错误')
  })

  it('drops an unknown site id instead of failing the whole save', () => {
    expect(parseSettingsUpdate({ version: 2, relaySiteId: 'sub2api', largeText: true })).toEqual({ version: 2, largeText: true })
  })

  it('rejects a malformed window position but lets null clear it', () => {
    expect(parseSettingsUpdate({ version: 2, windowState: null })).toEqual({ version: 2, windowState: null })
    expect(() => parseSettingsUpdate({ version: 2, windowState: { maximized: false, bounds: { x: 0, y: 0, width: 0, height: 10 } } }))
      .toThrow('窗口位置格式错误')
  })

  it('rejects a workspace path with a NUL byte', () => {
    expect(() => parseSettingsUpdate({ version: 2, workspace: '/home/user\0/etc' })).toThrow('工作目录格式错误')
  })
})
