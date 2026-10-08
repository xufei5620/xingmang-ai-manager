import { describe, expect, it } from 'vitest'
import { managedElsewhereHint, toolRouteLabel } from './route-label'

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
