import { describe, expect, it } from 'vitest'
import * as TOML from '@iarna/toml'
import { removeCodexContextLimits } from './codex-context-limits'

describe('removeCodexContextLimits', () => {
  it('removes both root settings while preserving comments and CRLF formatting', () => {
    const kept = [
      '# 用户配置',
      'model = "gpt-6-astra"',
      '',
      '[desktop]',
      'localeOverride = "zh-CN"',
      '',
      '[profiles.custom]',
      'model_context_window = 128000',
      'model_auto_compact_token_limit = 100000',
      '',
    ]
    const source = [...kept.slice(0, 2),
      'model_context_window = 1_000_000 # 旧默认值',
      'model_auto_compact_token_limit = 900000',
      ...kept.slice(2),
    ].join('\r\n')
    expect(removeCodexContextLimits(source)).toEqual({ content: kept.join('\r\n'), changed: true })
  })

  it.each([
    'model_context_window = 256000',
    '"model_auto_compact_token_limit" = 200000',
    "'model_context_window' = 1_000_000",
  ])('removes a single root setting: %s', (line) => {
    expect(removeCodexContextLimits(`${line}\nmodel = "custom"`)).toEqual({
      content: 'model = "custom"', changed: true,
    })
  })

  it('does not rewrite a file with only nested settings or comments', () => {
    const source = '# model_context_window = 1000000\n[profiles.custom]\nmodel_context_window = 200000\n'
    expect(removeCodexContextLimits(source)).toEqual({ content: source, changed: false })
    expect(removeCodexContextLimits('')).toEqual({ content: '', changed: false })
  })

  it('preserves multiline prompts with table-like and key-like lines', () => {
    const source = [
      'instructions = """',
      'model_context_window = 1000000',
      '[desktop]',
      'model_auto_compact_token_limit = 900000',
      '"""',
      'model_context_window = 1000000',
      'model_auto_compact_token_limit = 900000',
      '[desktop]',
      'localeOverride = "zh-CN"',
    ].join('\n')
    const expected = TOML.parse(source)
    delete expected.model_context_window
    delete expected.model_auto_compact_token_limit
    const result = removeCodexContextLimits(source)
    expect(result.changed).toBe(true)
    expect(TOML.parse(result.content)).toEqual(expected)
  })

  it('handles escaped quoted keys without touching dotted keys', () => {
    const source = '"model_context_\\u0077indow" = 1000000\nprofile.model_context_window = 128000\n'
    const result = removeCodexContextLimits(source)
    expect(result.changed).toBe(true)
    expect(TOML.parse(result.content)).toEqual({ profile: { model_context_window: 128000 } })
  })

  it('writes UTF-8 text without a BOM when removing old values', () => {
    expect(removeCodexContextLimits('\uFEFFmodel_context_window = 1000000\nmodel = "测试"\n')).toEqual({
      content: 'model = "测试"\n', changed: true,
    })
  })

  it('refuses invalid TOML without leaking source excerpts', () => {
    expect(() => removeCodexContextLimits('model_context_window = 1000000\nprivate = "fixture-secret'))
      .toThrow('Codex 配置无法解析，未执行上下文限制迁移')
  })
})
