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
      .toBe('Claude Code 中设置的模型「claude-opus-4」当前账号已无法使用。是否更换为「claude-opus-5」后打开？')
  })

  it('offers a newer default by its short name and lets the user keep the current one', () => {
    const offer = modelSwapOffer('Claude Code', { status: 'upgrade', model: 'claude-opus-5', replacement: 'claude-opus-5-5' })
    expect(offer).toEqual({ kind: 'upgrade', toolName: 'Claude Code', model: 'claude-opus-5', replacement: 'claude-opus-5-5' })
    if (!offer) return
    expect(modelSwapTitle(offer)).toBe('Claude Code 有更新的型号')
    expect(modelSwapQuestion(offer)).toBe('当前账号可使用 Opus 5.5，比当前的 Opus 5 更新。是否更换为 Opus 5.5？之后可在「配置」中改回。')
    expect(modelSwapConfirmLabel(offer)).toBe('更换为 Opus 5.5')
    expect(modelSwapKeepLabel(offer)).toBe('暂不更换')
  })

  it('keeps the unavailable-model wording unchanged', () => {
    const offer = { kind: 'unavailable' as const, toolName: 'Codex', model: 'gpt-5', replacement: 'gpt-6-astra' }
    expect(modelSwapTitle(offer)).toBe('默认模型已不可用')
    expect(modelSwapConfirmLabel(offer)).toBe('更换为 gpt-6-astra')
    expect(modelSwapKeepLabel(offer)).toBe('照旧打开')
  })
})
