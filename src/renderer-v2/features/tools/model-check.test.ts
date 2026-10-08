import { describe, expect, it } from 'vitest'
import { modelSwapConfirmLabel, modelSwapKeepLabel, modelSwapOffer, modelSwapQuestion, modelSwapTitle } from './model-check'

describe('model swap offer', () => {
  it('asks only when the default model is gone and there is something to switch to', () => {
    expect(modelSwapOffer('Codex', { status: 'skipped' })).toBeNull()
    expect(modelSwapOffer('Codex', { status: 'ok', pickerRefreshed: true })).toBeNull()
    expect(modelSwapOffer('Codex', { status: 'unavailable', model: 'gpt-5', replacement: null })).toBeNull()
    expect(modelSwapOffer('Codex', { status: 'unavailable', model: 'gpt-5', replacement: 'gpt-5' })).toBeNull()
    expect(modelSwapOffer('Codex', { status: 'unavailable', model: 'gpt-5', replacement: 'gpt-6-astra' }))
      .toEqual({ kind: 'unavailable', toolName: 'Codex', model: 'gpt-5', replacement: 'gpt-6-astra' })
  })

  it('speaks about the current account and names both models', () => {
    expect(modelSwapQuestion({ kind: 'unavailable', toolName: 'Claude Code', model: 'claude-opus-4', replacement: 'claude-opus-5' }))
      .toBe('Claude Code 里设的「claude-opus-4」这个模型，当前账号用不了了。换成「claude-opus-5」再打开吗？')
  })

  it('offers a newer default by its short name and lets the user keep the current one', () => {
    const offer = modelSwapOffer('Claude Code', { status: 'upgrade', model: 'claude-opus-5', replacement: 'claude-opus-5-5' })
    expect(offer).toEqual({ kind: 'upgrade', toolName: 'Claude Code', model: 'claude-opus-5', replacement: 'claude-opus-5-5' })
    if (!offer) return
    expect(modelSwapTitle(offer)).toBe('Claude Code 有更新的型号')
    expect(modelSwapQuestion(offer)).toBe('当前账号可以用 Opus 5.5，比现在用的 Opus 5 新。要换成 Opus 5.5 吗？以后也可以在「配置」里换回来。')
    expect(modelSwapConfirmLabel(offer)).toBe('换成 Opus 5.5')
    expect(modelSwapKeepLabel(offer)).toBe('先不换')
  })

  it('keeps the unavailable-model wording unchanged', () => {
    const offer = { kind: 'unavailable' as const, toolName: 'Codex', model: 'gpt-5', replacement: 'gpt-6-astra' }
    expect(modelSwapTitle(offer)).toBe('默认模型用不了了')
    expect(modelSwapConfirmLabel(offer)).toBe('换成 gpt-6-astra')
    expect(modelSwapKeepLabel(offer)).toBe('照旧打开')
  })
})
