import { describe, expect, it } from 'vitest'
import { isLegacyRouterAllSetting, nodeHasRouterStrategySetting, parseCanvasRouterStrategy, parseNodeRouterStrategy, resolveNodeRouterStrategy, routerStrategyRunField, selectCanvasRouterInputs } from './router-strategy'

describe('explicit workflow router strategy version one', () => {
  it('preserves an absent historical marker and rejects misplaced new configuration', () => {
    expect(parseNodeRouterStrategy('router', undefined)).toBeUndefined()
    expect(() => parseNodeRouterStrategy('prompt', { version: 1, strategy: 'all' })).toThrow('只能')
    expect(parseCanvasRouterStrategy({ version: 1, strategy: 'all' })).toEqual({ version: 1, strategy: 'all' })
  })
  it('runs the old explicit keep-all choice as the versioned all and leaves every other old value historical (D06)', () => {
    const all = { version: 1, strategy: 'all' }
    expect(resolveNodeRouterStrategy('router', { strategy: 'all' })).toEqual(all)
    expect(routerStrategyRunField('router', { strategy: 'all', title: '路由' })).toEqual({ routerStrategy: all })
    expect(nodeHasRouterStrategySetting('router', { strategy: 'all' })).toBe(true)
    for (const settings of [undefined, {}, { strategy: 'first-available' }, { strategy: 'unknown' }]) {
      expect(resolveNodeRouterStrategy('router', settings)).toBeUndefined()
      expect(routerStrategyRunField('router', settings)).toEqual({})
      expect(nodeHasRouterStrategySetting('router', settings)).toBe(false)
    }
    // A versioned value always wins over the old selector, and only routers carry either.
    expect(resolveNodeRouterStrategy('router', { strategy: 'all', routerStrategy: { version: 1, strategy: 'first-available' } })).toEqual({ version: 1, strategy: 'first-available' })
    expect(isLegacyRouterAllSetting('router', { strategy: 'all', routerStrategy: { version: 1, strategy: 'first-available' } })).toBe(false)
    expect(isLegacyRouterAllSetting('gallery', { strategy: 'all' })).toBe(false)
    expect(resolveNodeRouterStrategy('gallery', { strategy: 'all' })).toBeUndefined()
    expect(() => resolveNodeRouterStrategy('prompt', { routerStrategy: all })).toThrow('只能')
    expect(() => resolveNodeRouterStrategy('router', { routerStrategy: undefined })).toThrow()
    expect(() => resolveNodeRouterStrategy('router', { strategy: 'all', routerStrategy: { version: 2, strategy: 'all' } })).toThrow()
  })
  it.each([undefined, null, [], {}, 'first-available', { version: 2, strategy: 'all' }, { version: 1, strategy: 'unknown' }, { version: 1, strategy: 'all', fallback: true }])('rejects malformed or future configuration without normalizing it %#', (value) => {
    expect(() => parseCanvasRouterStrategy(value)).toThrow()
  })
  it('selects the first nonempty original text and one first asset of every media in supplied order', () => {
    const assets = [{ kind: 'video', id: 'v-second-node-first-edge' }, { kind: 'image', id: 'i-first-output' }, { kind: 'image', id: 'i-second-output-same-edge' }, { kind: 'audio', id: 'a-first' }, { kind: 'video', id: 'v-next-edge' }]
    const texts = [' ', '', '  Original\ntext  ', 'later'], snapshot = structuredClone({ assets, texts })
    const selected = selectCanvasRouterInputs({ version: 1, strategy: 'first-available' }, texts, assets)
    expect(selected.text).toBe('  Original\ntext  ')
    expect(selected.assets.map((asset) => asset.id)).toEqual(['v-second-node-first-edge', 'i-first-output', 'a-first'])
    expect({ assets, texts }).toEqual(snapshot)
  })
  it('retains every already normalized input in all mode including empty slots and duplicate media', () => {
    const assets = [{ kind: 'image', id: 'a' }, { kind: 'image', id: 'b' }, { kind: 'audio', id: 'c' }]
    const all = selectCanvasRouterInputs({ version: 1, strategy: 'all' }, ['first', '', 'second'], assets)
    expect(all).toEqual({ text: 'first\n\nsecond', assets })
    expect(all.assets).not.toBe(assets)
  })
  it('does not manufacture a value for an unavailable media type', () => {
    expect(selectCanvasRouterInputs({ version: 1, strategy: 'first-available' }, [' ', ''], [])).toEqual({ text: '', assets: [] })
    expect(() => selectCanvasRouterInputs({ version: 1, strategy: 'all' }, [], [{ kind: 'unknown' }])).toThrow('媒体类型')
  })
})
