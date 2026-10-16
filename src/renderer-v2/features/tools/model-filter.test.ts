import { describe, expect, it } from 'vitest'
import { codexModelChoices, isHiddenCodexModel, isOpenAiModelId, otherModelChoices, otherModelSaveIssue } from './model-filter'

describe('Codex model filtering', () => {
  it.each(['gpt-6-astra', 'GPT-5.6-sol', 'gpt4', 'chatgpt-4o-latest', 'codex-auto-review', 'o3', 'o4-mini', 'vendor/gpt-5', 'azure:openai/model-alias', 'openai/custom-alias'])('recognizes OpenAI model names without deciding their protocol: %s', (model) => {
    expect(isOpenAiModelId(model)).toBe(true)
  })

  it.each(['deepseek-v4-flash', 'qwen3-max', 'glm-5', 'chatglm-6b', 'kimi-k2', 'claude-opus-5', 'gemini-3.8-flash-high', 'grok-4.6', 'vendor/custom-model'])('keeps a non-OpenAI model returned by the endpoint: %s', (model) => {
    expect(isOpenAiModelId(model)).toBe(false)
  })

  it.each(['grok-4.6', 'GROK-4.6', 'grok-4.6-fast', 'xai/grok-4.6', 'x-ai:grok-4.6_reasoning'])('hides a model Codex cannot edit files with: %s', (model) => {
    expect(isHiddenCodexModel(model)).toBe(true)
  })

  it.each(['grok-4.7', 'grok-4.60', 'grok-4.5', 'grok-4', 'gpt-6-astra', 'qwen3-max'])('keeps other models in the Codex list: %s', (model) => {
    expect(isHiddenCodexModel(model)).toBe(false)
  })

  it('filters only detected models and keeps the current GPT selection visible but unavailable', () => {
    const result = codexModelChoices(['gpt-6-astra', 'qwen3-max', 'qwen3-max', 'deepseek-v4-flash'], 'non-gpt', 'gpt-6-astra')
    expect(result.candidates).toEqual(['qwen3-max', 'deepseek-v4-flash'])
    expect(result.options).toEqual([
      { value: 'gpt-6-astra', label: 'gpt-6-astra（当前选择 · 不符合筛选）', disabled: true },
      { value: 'qwen3-max', label: 'qwen3-max', disabled: false },
      { value: 'deepseek-v4-flash', label: 'deepseek-v4-flash', disabled: false },
    ])
  })

  it('never invents a non-GPT candidate from the previous selection or a fallback list', () => {
    const result = codexModelChoices(['gpt-6-astra'], 'non-gpt', 'retired-model')
    expect(result.candidates).toEqual([])
    expect(result.options).toEqual([{ value: 'retired-model', label: 'retired-model（当前选择 · 本次未检测到）', disabled: true }])
  })

  it('preserves all-model choices and a currently configured model that is not detected', () => {
    const result = codexModelChoices(['gpt-6-astra', 'qwen3-max'], 'all', 'current-model')
    expect(result.candidates).toEqual(['gpt-6-astra', 'qwen3-max'])
    expect(result.options.map((option) => option.value)).toEqual(['current-model', 'gpt-6-astra', 'qwen3-max'])
    expect(result.options.every((option) => !option.disabled)).toBe(true)
  })
})

describe('Codex other-model dialog', () => {
  const ready = { models: ['gpt-6-astra', 'gpt-6-mini', 'qwen3-max', 'qwen3-max'], defaultModel: 'gpt-6-astra', selectedModel: 'qwen3-max', detected: true }

  it('lists the Codex default first and then the detected non-GPT models', () => {
    expect(otherModelChoices(ready.models, 'gpt-6-astra')).toEqual(['gpt-6-astra', 'qwen3-max'])
    // The default is offered only when this key can actually use it.
    expect(otherModelChoices(['qwen3-max'], 'gpt-6-astra')).toEqual(['qwen3-max'])
  })

  it('allows the default or a non-GPT model verified for the current key', () => {
    expect(otherModelSaveIssue(ready)).toBeNull()
    expect(otherModelSaveIssue({ ...ready, selectedModel: 'gpt-6-astra' })).toBeNull()
    expect(otherModelSaveIssue({ ...ready, selectedModel: 'gpt-6-mini' })).toContain('请选择本次检测到')
    expect(otherModelSaveIssue({ ...ready, selectedModel: 'retired-model' })).toContain('请选择本次检测到')
    expect(otherModelSaveIssue({ ...ready, detected: false })).toContain('请先检测当前密钥')
  })

  it('leaves grok-4.6 out of the list and keeps grok-4.7', () => {
    const models = ['gpt-6-astra', 'grok-4.6', 'grok-4.7']
    expect(otherModelChoices(models, 'gpt-6-astra')).toEqual(['gpt-6-astra', 'grok-4.7'])
    expect(otherModelSaveIssue({ models, defaultModel: 'gpt-6-astra', selectedModel: 'grok-4.7', detected: true })).toBeNull()
    expect(otherModelSaveIssue({ models, defaultModel: 'gpt-6-astra', selectedModel: 'grok-4.6', detected: true })).toContain('请选择本次检测到')
  })

  it('treats a key whose only other-vendor model is grok-4.6 as having none', () => {
    const models = ['gpt-6-astra', 'grok-4.6']
    expect(otherModelChoices(models, 'gpt-6-astra')).toEqual(['gpt-6-astra'])
    expect(otherModelSaveIssue({ models, defaultModel: 'gpt-6-astra', selectedModel: 'gpt-6-astra', detected: true })).toContain('更换有相应模型权限的密钥')
  })

  it('blocks GPT-only and empty results with a useful key-permission explanation', () => {
    expect(otherModelSaveIssue({ ...ready, models: ['gpt-6-astra'], selectedModel: 'gpt-6-astra' })).toContain('更换有相应模型权限的密钥')
    expect(otherModelSaveIssue({ ...ready, models: [] })).toContain('更换有相应模型权限的密钥')
  })
})
