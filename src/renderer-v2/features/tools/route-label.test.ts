import { describe, expect, it } from 'vitest'
import { managedElsewhereHint, toolRouteHijackShownMs, toolRouteHomeTexts, toolRouteLabel } from './route-label'

describe('toolRouteLabel', () => {
  it('names the line actually written in the tool config', () => {
    expect(toolRouteLabel({ relayLine: 'direct' }, 'account')).toEqual({ text: '线路2' })
    expect(toolRouteLabel({ relayLine: 'primary' }, 'account')).toEqual({ text: '线路1' })
    expect(toolRouteLabel({ relayLine: 'other' }, 'account')).toEqual({ text: '线路：其他地址' })
  })

  it('shows nothing when the main process did not recognise a xm line', () => {
    expect(toolRouteLabel({}, 'account')).toBeNull()
    expect(toolRouteLabel(undefined, 'manual')).toBeNull()
  })

  it('adds one state tag, managed elsewhere first, then restart, then manual', () => {
    expect(toolRouteLabel({ relayLine: 'direct', relayRouteState: 'managed-elsewhere' }, 'manual'))
      .toEqual({ text: '线路2 · 由其他工具管理', hint: managedElsewhereHint })
    expect(toolRouteLabel({ relayLine: 'primary', relayRouteState: 'restart' }, 'manual')).toEqual({ text: '线路1 · 需重开生效' })
    expect(toolRouteLabel({ relayLine: 'primary' }, 'manual')).toEqual({ text: '线路1 · 手动配置' })
  })
})

describe('toolRouteHomeTexts', () => {
  it('says nothing while the tool line is fine', () => {
    expect(toolRouteHomeTexts(undefined, 0)).toEqual({})
    expect(toolRouteHomeTexts({}, 0)).toEqual({})
  })

  it('shows a quiet line while the server is switching', () => {
    expect(toolRouteHomeTexts({ serverSwitching: true }, 0)).toEqual({ quiet: '服务端正在切换线路，请稍候几分钟' })
  })

  it('explains an outage by its cause and says first when the app itself still connects', () => {
    expect(toolRouteHomeTexts({ outage: { id: 1, reason: 'certificate', appReachable: false } }, 0).outage)
      .toBe('当前网络正在拦截星芒的加密连接（证书已被替换），AI 工具暂时无法连接。请切换网络（如手机热点）后重试；公司或学校网络请联系网络管理员。')
    expect(toolRouteHomeTexts({ outage: { id: 1, reason: 'dns', appReachable: true } }, 0).outage)
      .toBe('星芒服务连接正常。本机暂时无法解析星芒的地址，AI 工具无法连接。请切换网络后重试。')
    for (const reason of ['reset', 'unreachable'] as const) {
      expect(toolRouteHomeTexts({ outage: { id: 1, reason, appReachable: false } }, 0).outage)
        .toBe('当前网络阻断了星芒的连接，AI 工具暂时无法连接。请切换网络（如手机热点）后重试。')
    }
  })

  it('tells the customer to change DNS when the address itself was pointed elsewhere', () => {
    expect(toolRouteHomeTexts({ outage: { id: 1, reason: 'hijack', appReachable: false } }, 0).outage)
      .toBe('本机使用的 DNS（域名解析服务）返回了错误的星芒地址，AI 工具暂时无法连接。请将 DNS 改为 223.5.5.5 和 119.29.29.29，或切换网络（如手机热点）后重试。')
  })

  it('keeps the hijack sentence for half an hour and never mentions DNS', () => {
    const shown = toolRouteHomeTexts({ hijack: { id: 1_000 } }, 1_000).hijack
    expect(shown).toBe('当前网络将星芒线路2的地址解析到了其他位置，已自动改用线路1，不影响使用。星芒不会修改本机的任何设置。')
    expect(shown).not.toMatch(/DNS|洛杉矶|CF/)
    expect(toolRouteHomeTexts({ hijack: { id: 1_000 } }, 1_000 + toolRouteHijackShownMs).hijack).toBeUndefined()
  })

  it('names the line that was actually pointed elsewhere', () => {
    expect(toolRouteHomeTexts({ hijack: { id: 1_000, line: 'direct' } }, 1_000).hijack)
      .toBe('当前网络将星芒线路2的地址解析到了其他位置，已自动改用线路1，不影响使用。星芒不会修改本机的任何设置。')
    const shown = toolRouteHomeTexts({ hijack: { id: 1_000, line: 'primary' } }, 1_000).hijack
    expect(shown).toBe('当前网络将星芒线路1的地址解析到了其他位置，已自动改用线路2，不影响使用。星芒不会修改本机的任何设置。')
    expect(shown).not.toMatch(/DNS|洛杉矶|CF/)
  })
})
