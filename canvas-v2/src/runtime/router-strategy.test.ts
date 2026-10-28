import { describe, expect, it } from 'vitest'
import { parseCanvasRouterStrategy, parseNodeRouterStrategy, selectCanvasRouterInputs } from './router-strategy'

describe('explicit workflow router strategy version one', () => {
  it('preserves an absent historical marker and rejects misplaced new configuration', () => {
    expect(parseNodeRouterStrategy('router', undefined)).toBeUndefined()
    expect(() => parseNodeRouterStrategy('prompt', { version: 1, strategy: 'all' })).toThrow('只能')
    expect(parseCanvasRouterStrategy({ version: 1, strategy: 'all' })).toEqual({ version: 1, strategy: 'all' })
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
