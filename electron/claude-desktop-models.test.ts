import { describe, expect, it } from 'vitest'
import { claudeDesktopModelCandidates, claudeDesktopStartupCheckModel, resolveClaudeDesktopModels } from './claude-desktop-models'

describe('claudeDesktopModelCandidates', () => {
  it('offers the other Claude models newest first and leaves out the picked one, other vendors and unsafe names', () => {
    expect(claudeDesktopModelCandidates([
      'claude-haiku-4-5',
      'gpt-6-astra',
      'claude-opus-5-5',
      'claude-sonnet-4-6',
      'claude-opus-5-5',
      'claude sonnet "4"',
      'claude-sonnet-5-5',
      'grok-4.7',
    ], 'claude-sonnet-4-6')).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'])
  })

  it('keeps at most seven others so the menu holds eight models with the picked one', () => {
    const models = ['claude-opus-5-5', ...Array.from({ length: 10 }, (_value, index) => `claude-sonnet-4-${index}`)]
    const candidates = claudeDesktopModelCandidates(models, 'claude-opus-5-5')
    expect(candidates).toHaveLength(7)
    expect(candidates).toEqual(['claude-sonnet-4-9', 'claude-sonnet-4-8', 'claude-sonnet-4-7', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4-4', 'claude-sonnet-4-3'])
  })

  it('has nothing to try when the account lists no other Claude model', () => {
    expect(claudeDesktopModelCandidates(['claude-opus-5-5', 'gpt-6-astra'], 'claude-opus-5-5')).toEqual([])
    expect(claudeDesktopModelCandidates([], 'claude-opus-5-5')).toEqual([])
  })
})

describe('claudeDesktopStartupCheckModel', () => {
  it('picks a Haiku model before Sonnet and Opus, whatever the list order', () => {
    expect(claudeDesktopStartupCheckModel(['claude-opus-5-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'])).toBe('claude-haiku-4-5')
    expect(claudeDesktopStartupCheckModel(['claude-opus-5-5', 'claude-sonnet-4-6'])).toBe('claude-sonnet-4-6')
    expect(claudeDesktopStartupCheckModel(['claude-fable-5', 'claude-opus-5-5'])).toBe('claude-opus-5-5')
  })

  it('takes the shortest name in a tier, the earlier one on a tie, and fine-tuned models only when nothing else is left', () => {
    expect(claudeDesktopStartupCheckModel(['claude-haiku-4-5-20251001', 'claude-haiku-4-5'])).toBe('claude-haiku-4-5')
    expect(claudeDesktopStartupCheckModel(['claude-haiku-4-6', 'claude-haiku-4-5'])).toBe('claude-haiku-4-6')
    expect(claudeDesktopStartupCheckModel(['ft:claude-haiku:ft-1', 'claude-haiku-4-5-20251001'])).toBe('claude-haiku-4-5-20251001')
    expect(claudeDesktopStartupCheckModel(['ft:claude-haiku:ft-1'])).toBe('ft:claude-haiku:ft-1')
  })

  it('falls back to the first model when no tier matches and to null for an empty list', () => {
    expect(claudeDesktopStartupCheckModel(['claude-fable-5', 'claude-mythos-1'])).toBe('claude-fable-5')
    expect(claudeDesktopStartupCheckModel([])).toBeNull()
  })
})

describe('resolveClaudeDesktopModels', () => {
  it('puts the picked model first and keeps only the others that answer', async () => {
    const tried: string[] = []
    const selection = await resolveClaudeDesktopModels('claude-sonnet-4-6', ['claude-haiku-4-5', 'claude-opus-5-5', 'claude-fable-5', 'claude-sonnet-4-6'], async (model) => {
      tried.push(model)
      if (model === 'claude-opus-5-5') throw new Error('network down')
      return model !== 'claude-fable-5'
    })
    expect(selection).toEqual({ models: ['claude-sonnet-4-6', 'claude-haiku-4-5'], rejected: ['claude-opus-5-5', 'claude-fable-5'] })
    expect(tried.sort()).toEqual(['claude-fable-5', 'claude-haiku-4-5', 'claude-opus-5-5'])
  })

  it('writes only the picked model without trying anything when there is nothing else', async () => {
    const tried: string[] = []
    const selection = await resolveClaudeDesktopModels('claude-opus-5-5', ['claude-opus-5-5', 'gpt-6-astra'], async (model) => {
      tried.push(model)
      return true
    })
    expect(selection).toEqual({ models: ['claude-opus-5-5'], rejected: [] })
    expect(tried).toEqual([])
  })

  it('tries at most three models at a time', async () => {
    let inFlight = 0
    let peak = 0
    const models = ['claude-opus-5-5', ...Array.from({ length: 7 }, (_value, index) => `claude-sonnet-4-${index}`)]
    const selection = await resolveClaudeDesktopModels('claude-opus-5-5', models, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
      return true
    })
    expect(peak).toBe(3)
    expect(selection.models).toHaveLength(8)
  })
})
