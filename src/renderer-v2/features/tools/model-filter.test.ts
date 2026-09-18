import { describe, expect, it } from 'vitest'
import { codexModelChoices, codexModelFilterSaveIssue, isOpenAiModelId } from './model-filter'

describe('Codex model filtering', () => {
  it.each(['gpt-6-astra', 'GPT-5.6-sol', 'gpt4', 'chatgpt-4o-latest', 'codex-auto-review', 'o3', 'o4-mini', 'vendor/gpt-5', 'azure:openai/model-alias', 'openai/custom-alias'])('recognizes OpenAI model names without deciding their protocol: %s', (model) => {
    expect(isOpenAiModelId(model)).toBe(true)
  })

  it.each(['deepseek-v4-flash', 'qwen3-max', 'glm-5', 'chatglm-6b', 'kimi-k2', 'claude-opus-5', 'gemini-3.8-flash-high', 'grok-4.6', 'vendor/custom-model'])('keeps a non-OpenAI model returned by the endpoint: %s', (model) => {
    expect(isOpenAiModelId(model)).toBe(false)
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

describe('Codex non-GPT save guard', () => {
  const ready = { filter: 'non-gpt' as const, models: ['gpt-6-astra', 'qwen3-max'], selectedModel: 'qwen3-max', detected: true, automaticKey: false }

  it('allows only a non-GPT model verified for the current key', () => {
    expect(codexModelFilterSaveIssue(ready)).toBeNull()
    expect(codexModelFilterSaveIssue({ ...ready, selectedModel: 'gpt-6-astra' })).toContain('请选择本次检测到')
    expect(codexModelFilterSaveIssue({ ...ready, selectedModel: 'retired-model' })).toContain('请选择本次检测到')
    expect(codexModelFilterSaveIssue({ ...ready, detected: false })).toContain('请先检测当前密钥')
  })

  it('blocks GPT-only and empty results with a useful key-permission explanation', () => {
    expect(codexModelFilterSaveIssue({ ...ready, models: ['gpt-6-astra'] })).toContain('更换有相应模型权限的密钥')
    expect(codexModelFilterSaveIssue({ ...ready, models: [] })).toContain('更换有相应模型权限的密钥')
  })

  it('blocks automatic provisioning so it cannot silently save its GPT default', () => {
    expect(codexModelFilterSaveIssue({ ...ready, automaticKey: true })).toContain('选择已有密钥或自行填写密钥')
  })

  it('requires an explicit source choice when the non-GPT entry opens a ChatGPT configuration', () => {
    expect(codexModelFilterSaveIssue({ ...ready, officialSource: true })).toContain('请切换账号来源后检测模型')
    expect(codexModelFilterSaveIssue({ ...ready, officialSource: true, filter: 'all' })).toBeNull()
  })

  it('leaves the existing all-model save flow unchanged', () => {
    expect(codexModelFilterSaveIssue({ ...ready, filter: 'all', detected: false, automaticKey: true, models: [] })).toBeNull()
  })
})
