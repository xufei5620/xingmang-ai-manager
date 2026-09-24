import { describe, expect, it } from 'vitest'
import { modelSwapOffer, modelSwapQuestion } from './model-check'

describe('model swap offer', () => {
  it('asks only when the default model is gone and there is something to switch to', () => {
    expect(modelSwapOffer('Codex', { status: 'skipped' })).toBeNull()
    expect(modelSwapOffer('Codex', { status: 'ok', pickerRefreshed: true })).toBeNull()
    expect(modelSwapOffer('Codex', { status: 'unavailable', model: 'gpt-5', replacement: null })).toBeNull()
    expect(modelSwapOffer('Codex', { status: 'unavailable', model: 'gpt-5', replacement: 'gpt-5' })).toBeNull()
    expect(modelSwapOffer('Codex', { status: 'unavailable', model: 'gpt-5', replacement: 'gpt-6-astra' }))
      .toEqual({ toolName: 'Codex', model: 'gpt-5', replacement: 'gpt-6-astra' })
  })

  it('speaks about the current account and names both models', () => {
    expect(modelSwapQuestion({ toolName: 'Claude Code', model: 'claude-opus-4', replacement: 'claude-opus-5' }))
      .toBe('Claude Code 里设的「claude-opus-4」这个模型，当前账号用不了了。换成「claude-opus-5」再打开吗？')
  })
})
