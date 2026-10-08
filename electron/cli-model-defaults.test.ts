import { describe, expect, it } from 'vitest'
import { resolveCliModelUpgrade, resolveDefaultCliModel } from './cli-model-defaults'

describe('resolveDefaultCliModel', () => {
  it('selects the Codex product default regardless of model endpoint ordering', () => {
    expect(resolveDefaultCliModel('codex', ['codex-auto-review', 'gpt-5.6-sol', 'gpt-6-astra'])).toBe('gpt-6-astra')
  })

  it('preserves an available model explicitly chosen by the user', () => {
    expect(resolveDefaultCliModel('codex', ['gpt-5.6-sol', 'gpt-6-astra'], 'gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(resolveDefaultCliModel('codex', ['codex-auto-review', 'gpt-6-astra'], 'codex-auto-review')).toBe('codex-auto-review')
  })

  it('uses the product default if a previously selected model is no longer available', () => {
    expect(resolveDefaultCliModel('codex', ['codex-auto-review', 'gpt-6-astra'], 'retired-model')).toBe('gpt-6-astra')
  })

  it('falls back only to an available interactive model when the product default is missing', () => {
    expect(resolveDefaultCliModel('codex', ['codex-auto-review', 'codex-auto-review-v2', 'gpt-5.6-sol'])).toBe('gpt-5.6-sol')
    expect(resolveDefaultCliModel('codex', ['vendor/codex-auto-review', 'codex_auto_review', 'codex-custom'])).toBe('codex-custom')
  })

  it('keeps a non-GPT interactive model when the Codex group exposes one', () => {
    expect(resolveDefaultCliModel('codex', ['codex-auto-review', 'deepseek-v4-flash'])).toBe('deepseek-v4-flash')
    expect(resolveDefaultCliModel('codex', ['qwen3-max'])).toBe('qwen3-max')
  })

  it('declines to invent a model when the group only exposes auto-review models', () => {
    expect(resolveDefaultCliModel('codex', ['codex-auto-review', 'codex-auto-review-v2'])).toBeNull()
    expect(resolveDefaultCliModel('codex', [], 'gpt-6-astra')).toBeNull()
  })

  it.each([
    ['claude', 'claude-opus-5-5', 'claude-opus-4-6'],
    ['gemini', 'gemini-3.8-flash-high', 'gemini-3.1-pro'],
    ['grok', 'grok-4.6', 'grok-4.5'],
  ] as const)('chooses the %s default from the available group while preserving saved choices', (provider, model, existing) => {
    expect(resolveDefaultCliModel(provider, [existing, model])).toBe(model)
    expect(resolveDefaultCliModel(provider, [existing, model], 'retired-model')).toBe(model)
    expect(resolveDefaultCliModel(provider, [existing, model], existing)).toBe(existing)
    expect(resolveDefaultCliModel(provider, [existing])).toBe(existing)
    expect(resolveDefaultCliModel(provider, [])).toBeNull()
  })

  it('preserves fallback behavior when a group does not expose the requested default', () => {
    expect(resolveDefaultCliModel('claude', ['claude-first', 'claude-preferred'], 'claude-preferred')).toBe('claude-preferred')
    expect(resolveDefaultCliModel('gemini', ['gemini-first', 'gpt-6-astra'], 'retired-model')).toBe('gemini-first')
    expect(resolveDefaultCliModel('grok', [])).toBeNull()
  })

  it('falls back to the previous Claude default before picking an arbitrary model', () => {
    expect(resolveDefaultCliModel('claude', ['claude-haiku-4-5', 'claude-opus-5', 'claude-sonnet-5'])).toBe('claude-opus-5')
    expect(resolveDefaultCliModel('claude', ['claude-opus-5', 'claude-opus-5-5'])).toBe('claude-opus-5-5')
    expect(resolveDefaultCliModel('claude', ['claude-opus-5', 'claude-opus-5-5'], 'claude-opus-5')).toBe('claude-opus-5')
  })
})

describe('resolveCliModelUpgrade', () => {
  it('offers the new default only for the previous default and only when the account has it', () => {
    expect(resolveCliModelUpgrade('claude', 'claude-opus-5', ['claude-opus-5', 'claude-opus-5-5'])).toBe('claude-opus-5-5')
    expect(resolveCliModelUpgrade('claude', 'claude-opus-5', ['claude-opus-5'])).toBeNull()
    expect(resolveCliModelUpgrade('claude', 'claude-sonnet-5', ['claude-sonnet-5', 'claude-opus-5-5'])).toBeNull()
    expect(resolveCliModelUpgrade('claude', 'claude-opus-5-5', ['claude-opus-5-5'])).toBeNull()
    expect(resolveCliModelUpgrade('codex', 'claude-opus-5', ['claude-opus-5-5'])).toBeNull()
  })

  it('ignores model names that collide with object prototype keys', () => {
    expect(resolveCliModelUpgrade('claude', 'constructor', ['claude-opus-5-5'])).toBeNull()
    expect(resolveCliModelUpgrade('claude', '__proto__', ['claude-opus-5-5'])).toBeNull()
  })
})
