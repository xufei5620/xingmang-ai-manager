import { describe, expect, it } from 'vitest'
import { parseModelIds } from './models'

describe('model list parsing', () => {
  it('parses an OpenAI-compatible models response', () => {
    expect(parseModelIds({
      object: 'list',
      data: [{ id: 'gpt-5.5' }, { id: 'claude-opus-4-6' }],
    })).toEqual(['claude-opus-4-6', 'gpt-5.5'])
  })

  it('accepts alternate string and object arrays without duplicates', () => {
    expect(parseModelIds({ models: ['gemini-3.5-flash', { model: 'grok-4.5' }, 'gemini-3.5-flash'] }))
      .toEqual(['gemini-3.5-flash', 'grok-4.5'])
  })

  it('rejects malformed model payloads', () => {
    expect(parseModelIds({ data: 'not-an-array' })).toEqual([])
    expect(parseModelIds(null)).toEqual([])
  })

  it('bounds model ids and rejects oversized or control-character values', () => {
    const values = Array.from({ length: 3_000 }, (_, index) => `model-${index}`)
    values[0] = `model-${'x'.repeat(300)}`
    values[1] = 'model-with\ncontrol'

    const result = parseModelIds({ data: values })
    expect(result).toHaveLength(512)
    expect(result).not.toContain(values[0])
    expect(result).not.toContain(values[1])
    expect(result.some((id) => id === 'model-2500')).toBe(false)
  })
})
