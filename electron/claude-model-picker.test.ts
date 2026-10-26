import { describe, expect, it } from 'vitest'
import {
  applyClaudeRelayModelPicker,
  buildClaudeRelayModelPicker,
  claudeModelLabel,
  claudeRelayModelPickerOutdated,
  claudeRelayModelPickerUpdates,
  isManagedClaudeModelPicker,
  removeClaudeRelayModelPicker,
} from './claude-model-picker'

describe('claude model picker', () => {
  it.each([
    ['claude-opus-5', 'Opus 5'],
    ['claude-sonnet-4-6', 'Sonnet 4.6'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['claude-3-7-sonnet-20250219', 'Sonnet 3.7'],
    ['claude-sonnet-4-6-thinking', 'Sonnet 4.6 Thinking'],
    ['claude-opus-5[1m]', 'claude-opus-5[1m]'],
  ])('labels %s as %s', (model, label) => {
    expect(claudeModelLabel(model)).toBe(label)
  })

  it('lists only the Claude models the key can use, sorted, with the full id as description', () => {
    expect(buildClaudeRelayModelPicker(['gpt-6-astra', 'claude-sonnet-5', 'claude-opus-5', 'claude-opus-5'], 'claude-opus-5'))
      .toEqual({
        replaceBuiltInOptions: true,
        options: [
          { model: 'claude-opus-5', label: 'Opus 5', description: 'claude-opus-5' },
          { model: 'claude-sonnet-5', label: 'Sonnet 5', description: 'claude-sonnet-5' },
        ],
      })
  })

  it('keeps the official menu when the key exposes no Claude model', () => {
    expect(buildClaudeRelayModelPicker(['gpt-6-astra'], 'claude-opus-5')).toBeNull()
    expect(buildClaudeRelayModelPicker([], 'claude-opus-5')).toBeNull()
  })

  it('always keeps the current model when the list is capped', () => {
    const many = Array.from({ length: 30 }, (_, index) => `claude-a${String(index).padStart(2, '0')}-1`)
    const picker = buildClaudeRelayModelPicker([...many, 'claude-zz-9'], 'claude-zz-9')
    expect(picker?.options).toHaveLength(20)
    expect(picker?.options.map((option) => option.model)).toContain('claude-zz-9')
  })

  it('points Default at the current model and writes the menu over an unset or managed one', () => {
    const parsed: Record<string, unknown> = {}
    const env: Record<string, unknown> = {}
    applyClaudeRelayModelPicker(parsed, env, ['claude-opus-5', 'claude-sonnet-5'], 'claude-sonnet-5')
    expect(env.ANTHROPIC_DEFAULT_MODEL).toBe('claude-sonnet-5')
    expect(isManagedClaudeModelPicker(parsed.modelPicker)).toBe(true)

    applyClaudeRelayModelPicker(parsed, env, ['claude-opus-5'], 'claude-opus-5')
    expect(parsed.modelPicker).toEqual({
      replaceBuiltInOptions: true,
      options: [{ model: 'claude-opus-5', label: 'Opus 5', description: 'claude-opus-5' }],
    })
  })

  it('leaves a model menu the user wrote alone', () => {
    const own = { options: [{ model: 'claude-opus-5', label: '主力', description: '我自己的' }] }
    const parsed: Record<string, unknown> = { modelPicker: own }
    const env: Record<string, unknown> = {}
    applyClaudeRelayModelPicker(parsed, env, ['claude-opus-5', 'claude-sonnet-5'], 'claude-opus-5')
    expect(parsed.modelPicker).toBe(own)
    expect(env.ANTHROPIC_DEFAULT_MODEL).toBe('claude-opus-5')

    removeClaudeRelayModelPicker(parsed, env)
    expect(parsed.modelPicker).toBe(own)
    expect(env).not.toHaveProperty('ANTHROPIC_DEFAULT_MODEL')
  })

  it('takes back its own menu when leaving the relay', () => {
    const parsed: Record<string, unknown> = {}
    const env: Record<string, unknown> = {}
    applyClaudeRelayModelPicker(parsed, env, ['claude-opus-5'], 'claude-opus-5')
    removeClaudeRelayModelPicker(parsed, env)
    expect(parsed).not.toHaveProperty('modelPicker')
    expect(env).toEqual({})
  })

  describe('claudeRelayModelPickerOutdated', () => {
    function written(models: string[], model: string): Record<string, unknown> {
      const parsed: Record<string, unknown> = {}
      const env: Record<string, unknown> = {}
      parsed.env = env
      applyClaudeRelayModelPicker(parsed, env, models, model)
      return parsed
    }

    it('is current when the settings were written from the same model list', () => {
      expect(claudeRelayModelPickerOutdated(written(['claude-opus-5', 'claude-sonnet-5'], 'claude-opus-5'), ['claude-sonnet-5', 'claude-opus-5'], 'claude-opus-5')).toBe(false)
    })

    it('is outdated when the account gained or lost a model', () => {
      const parsed = written(['claude-opus-5', 'claude-sonnet-5'], 'claude-opus-5')
      expect(claudeRelayModelPickerOutdated(parsed, ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-5-5'], 'claude-opus-5')).toBe(true)
      expect(claudeRelayModelPickerOutdated(parsed, ['claude-opus-5'], 'claude-opus-5')).toBe(true)
    })

    it('is outdated when Default was never written, including settings written before the picker existed', () => {
      expect(claudeRelayModelPickerOutdated({ env: {} }, ['claude-opus-5'], 'claude-opus-5')).toBe(true)
      expect(claudeRelayModelPickerOutdated({}, ['gpt-6-astra'], 'claude-opus-5')).toBe(true)
      expect(claudeRelayModelPickerUpdates({ env: { ANTHROPIC_DEFAULT_MODEL: ' ' } }, ['gpt-6-astra'], 'claude-opus-5')).toEqual({ defaultModel: 'claude-opus-5' })
    })

    // #1154 后续：客户另指了 Default、或用 /model 换了型号，刷新菜单不跟着改 Default。
    it('leaves a Default that points at another model and only brings the menu up to date', () => {
      const parsed = written(['claude-opus-5', 'claude-sonnet-5'], 'claude-opus-5')
      expect(claudeRelayModelPickerOutdated(parsed, ['claude-opus-5', 'claude-sonnet-5'], 'claude-sonnet-5')).toBe(false)
      expect(claudeRelayModelPickerUpdates(parsed, ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5'], 'claude-sonnet-5')).toEqual({
        modelPicker: buildClaudeRelayModelPicker(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5'], 'claude-sonnet-5'),
      })
    })

    it('never counts a picker the user wrote as outdated', () => {
      const parsed = {
        env: { ANTHROPIC_DEFAULT_MODEL: 'claude-opus-5' },
        modelPicker: { options: [{ model: 'claude-opus-5', label: 'Mine', description: 'mine' }] },
        fallbackModel: ['claude-sonnet-5'],
      }
      expect(claudeRelayModelPickerOutdated(parsed, ['claude-opus-5', 'claude-sonnet-5'], 'claude-opus-5')).toBe(false)
    })

    it('keeps the picker when the list has no Claude model rather than asking to rewrite it', () => {
      expect(claudeRelayModelPickerOutdated(written(['claude-opus-5'], 'claude-opus-5'), ['gpt-6-astra'], 'claude-opus-5')).toBe(false)
    })

    it('fills in fallback models only where settings never had them', () => {
      const models = ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']
      const parsed = written(models, 'claude-opus-5-5')
      delete parsed.fallbackModel
      expect(claudeRelayModelPickerUpdates(parsed, models, 'claude-opus-5-5')).toEqual({ fallbackModel: ['claude-opus-5', 'claude-sonnet-5-5'] })
      // 写过的不管是不是照老清单写的都不动；清单里一个备用都挑不出也不算落后。
      expect(claudeRelayModelPickerOutdated({ ...parsed, fallbackModel: ['claude-opus-4-8'] }, models, 'claude-opus-5-5')).toBe(false)
      expect(claudeRelayModelPickerOutdated(written(['claude-opus-5-5'], 'claude-opus-5-5'), ['claude-opus-5-5'], 'claude-opus-5-5')).toBe(false)
    })
  })

  describe('fallback models', () => {
    const models = ['claude-haiku-5-5', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6-astra']

    it('writes fallback models picked from the key\'s own model list when settings have none', () => {
      const parsed: Record<string, unknown> = { model: 'claude-opus-5-5' }
      applyClaudeRelayModelPicker(parsed, {}, models, 'claude-opus-5-5')
      expect(parsed.fallbackModel).toEqual(['claude-opus-5', 'claude-sonnet-5-5'])
    })

    it('follows a model changed in the config dialog when the fallback models are the ones it wrote', () => {
      const parsed: Record<string, unknown> = { model: 'claude-opus-5-5', fallbackModel: ['claude-opus-5', 'claude-sonnet-5-5'] }
      applyClaudeRelayModelPicker(parsed, {}, models, 'claude-sonnet-5-5')
      expect(parsed.fallbackModel).toEqual(['claude-opus-5-5'])
    })

    it('leaves fallback models the customer wrote alone, and keeps them when leaving the relay', () => {
      const parsed: Record<string, unknown> = { model: 'claude-opus-5-5', fallbackModel: ['claude-haiku-5-5'] }
      const env: Record<string, unknown> = {}
      applyClaudeRelayModelPicker(parsed, env, models, 'claude-sonnet-5-5')
      expect(parsed.fallbackModel).toEqual(['claude-haiku-5-5'])
      removeClaudeRelayModelPicker(parsed, env)
      expect(parsed.fallbackModel).toEqual(['claude-haiku-5-5'])

      // 客户写了个空的，就是不要备用，账号里挑不出备用时也不当成本软件写的收走。
      const none: Record<string, unknown> = { model: 'claude-opus-5-5', fallbackModel: [] }
      applyClaudeRelayModelPicker(none, {}, ['claude-opus-5-5'], 'claude-opus-5-5')
      expect(none.fallbackModel).toEqual([])
    })

    it('takes back its own fallback models when the new model has nothing to fall back to', () => {
      const parsed: Record<string, unknown> = { model: 'claude-opus-5-5', fallbackModel: ['claude-opus-5', 'claude-sonnet-5-5'] }
      applyClaudeRelayModelPicker(parsed, {}, models, 'claude-haiku-5-5')
      expect(parsed.fallbackModel).toEqual(['claude-sonnet-5-5'])
      const lean = ['claude-haiku-5-5', 'claude-opus-5', 'claude-opus-5-5']
      const written: Record<string, unknown> = { model: 'claude-opus-5-5', fallbackModel: ['claude-opus-5'] }
      applyClaudeRelayModelPicker(written, {}, lean, 'claude-haiku-5-5')
      expect(written).not.toHaveProperty('fallbackModel')
      const fresh: Record<string, unknown> = { model: 'claude-opus-5-5' }
      applyClaudeRelayModelPicker(fresh, {}, ['claude-opus-5-5', 'claude-haiku-5-5'], 'claude-opus-5-5')
      expect(fresh).not.toHaveProperty('fallbackModel')
    })
  })
})
