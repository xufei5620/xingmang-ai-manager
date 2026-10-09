import { describe, expect, it } from 'vitest'
import { managedElsewhereHint, toolRouteHijackShownMs, toolRouteHomeTexts, toolRouteLabel } from './route-label'

describe('toolRouteLabel', () => {
  it('names the line actually written in the tool config', () => {
    expect(toolRouteLabel({ relayLine: 'direct' }, 'account')).toEqual({ text: '线路：洛杉矶' })
    expect(toolRouteLabel({ relayLine: 'primary' }, 'account')).toEqual({ text: '线路：CF' })
    expect(toolRouteLabel({ relayLine: 'other' }, 'account')).toEqual({ text: '线路：其他地址' })
  })

  it('shows nothing when the main process did not recognise a xm line', () => {
    expect(toolRouteLabel({}, 'account')).toBeNull()
    expect(toolRouteLabel(undefined, 'manual')).toBeNull()
  })

  it('adds one state tag, managed elsewhere first, then restart, then manual', () => {
    expect(toolRouteLabel({ relayLine: 'direct', relayRouteState: 'managed-elsewhere' }, 'manual'))
      .toEqual({ text: '线路：洛杉矶 · 由其他工具管理', hint: managedElsewhereHint })
    expect(toolRouteLabel({ relayLine: 'primary', relayRouteState: 'restart' }, 'manual')).toEqual({ text: '线路：CF · 需重开生效' })
    expect(toolRouteLabel({ relayLine: 'primary' }, 'manual')).toEqual({ text: '线路：CF · 手动配置' })
  })
})

describe('toolRouteHomeTexts', () => {
  it('says nothing while the tool line is fine', () => {
    expect(toolRouteHomeTexts(undefined, 0)).toEqual({})
    expect(toolRouteHomeTexts({}, 0)).toEqual({})
  })

  it('shows a quiet line while the server is switching', () => {
    expect(toolRouteHomeTexts({ serverSwitching: true }, 0)).toEqual({ quiet: '服务端正在切换线路，稍等几分钟' })
  })

  it('explains an outage by its cause and says first when the app itself still connects', () => {
    expect(toolRouteHomeTexts({ outage: { id: 1, reason: 'certificate', appReachable: false } }, 0).outage)
      .toBe('电脑上的安全软件接管了加密连接，AI 工具这会儿连不上星芒。可以在安全软件里关掉「网页扫描」再试。')
    expect(toolRouteHomeTexts({ outage: { id: 1, reason: 'dns', appReachable: true } }, 0).outage)
      .toBe('星芒管理工具能连上，但 AI 工具会连不上。这台电脑这会儿查不到星芒的地址，AI 工具连不上。可以换个网络再试。')
    for (const reason of ['reset', 'unreachable'] as const) {
      expect(toolRouteHomeTexts({ outage: { id: 1, reason, appReachable: false } }, 0).outage)
        .toBe('你所在的网络掐断了星芒的地址，AI 工具这会儿连不上。可以换个网络（比如手机热点）再试。')
    }
  })

  it('keeps the hijack sentence for half an hour and never mentions DNS', () => {
    const shown = toolRouteHomeTexts({ hijack: { id: 1_000 } }, 1_000).hijack
    expect(shown).toBe('你所在的网络把星芒洛杉矶线路的地址指到了别处，已为你改用 CF 线路，不影响使用。星芒不会改你电脑的任何设置。')
    expect(shown).not.toMatch(/DNS/)
    expect(toolRouteHomeTexts({ hijack: { id: 1_000 } }, 1_000 + toolRouteHijackShownMs).hijack).toBeUndefined()
  })
})
