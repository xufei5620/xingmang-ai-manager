import { describe, expect, it } from 'vitest'
import {
  applyClaudeRelayModelPicker,
  buildClaudeRelayModelPicker,
  claudeModelLabel,
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
})
