import { describe, expect, it } from 'vitest'
import { isCliModelName, isNonInteractiveCliModel, isRetiredCliModel, resolveClaudeFallbackModels, resolveCliModelDefault, resolveCliModelUpgrade, resolveDefaultCliModel, resolveNewestModelOfFamily, resolveRetiredCliModelReplacement, sortClaudeModelsNewestFirst } from './cli-model-defaults'

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

  // #1154：模型列表按字母排，只拿第一个会把 Claude Code 配成 Haiku。
  it('ranks Claude models Opus over Sonnet over Haiku instead of alphabetically when no known default is listed', () => {
    expect(resolveDefaultCliModel('claude', ['claude-haiku-4-5', 'claude-sonnet-5'])).toBe('claude-sonnet-5')
    expect(resolveDefaultCliModel('claude', ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-sonnet-5'])).toBe('claude-sonnet-5')
    expect(resolveDefaultCliModel('claude', ['claude-haiku-4-5', 'claude-opus-4-1-20250805', 'claude-opus-4-8', 'claude-sonnet-5'])).toBe('claude-opus-4-8')
    expect(resolveDefaultCliModel('claude', ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'])).toBe('claude-sonnet-4-5')
    expect(resolveDefaultCliModel('claude', ['claude-3-5-sonnet-20241022', 'claude-haiku-4-5'])).toBe('claude-3-5-sonnet-20241022')
    expect(resolveDefaultCliModel('claude', ['deepseek-v4-flash', 'claude-haiku-4-5'])).toBe('claude-haiku-4-5')
    expect(resolveDefaultCliModel('claude', ['deepseek-v4-flash'])).toBe('deepseek-v4-flash')
  })

  it('stays in the family of the model being replaced before moving to another one', () => {
    expect(resolveDefaultCliModel('claude', ['claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-5'], 'claude-sonnet-4-5')).toBe('claude-sonnet-5')
    expect(resolveDefaultCliModel('claude', ['claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-5'], 'claude-haiku-3')).toBe('claude-haiku-4-5')
    // 默认还在就照旧换成默认。
    expect(resolveDefaultCliModel('claude', ['claude-opus-5-5', 'claude-sonnet-5'], 'claude-sonnet-4-5')).toBe('claude-opus-5-5')
    expect(resolveDefaultCliModel('grok', ['grok-3-mini', 'grok-4.7', 'grok-code-fast-1'], 'grok-4.6')).toBe('grok-4.7')
    expect(resolveDefaultCliModel('grok', ['grok-3-mini', 'grok-4.5', 'grok-4.7', 'grok-code-fast-1'])).toBe('grok-4.7')
    expect(resolveDefaultCliModel('grok', ['grok-3-mini', 'grok-code-fast-1'])).toBe('grok-3-mini')
  })

  it('keeps the Codex fallback as it was', () => {
    expect(resolveDefaultCliModel('codex', ['codex-auto-review', 'deepseek-v4-flash', 'gpt-5.4'], 'gpt-5.5')).toBe('deepseek-v4-flash')
  })

  // #1154 第 3 条：列表按字母排，dall-e、gpt-image 排在能对话的型号前面。
  it('never infers an image, embedding or speech model as the default', () => {
    expect(resolveDefaultCliModel('codex', ['codex-auto-review', 'dall-e-3', 'gpt-5.4', 'gpt-image-2'])).toBe('gpt-5.4')
    expect(resolveDefaultCliModel('codex', ['gpt-image-2', 'text-embedding-3-large', 'tts-1'])).toBeNull()
    expect(resolveDefaultCliModel('grok', ['grok-code-fast-1', 'grok-imagine-image'], 'grok-imagine-video')).toBe('grok-code-fast-1')
    expect(resolveDefaultCliModel('claude', ['dall-e-3', 'deepseek-v4-flash'])).toBe('deepseek-v4-flash')
    // 客户自己选的、账号还列着的照旧留着。
    expect(resolveDefaultCliModel('codex', ['gpt-6-astra', 'gpt-image-2'], 'gpt-image-2')).toBe('gpt-image-2')
  })

  it('keeps swapping a retired Codex model for a model that can chat', () => {
    expect(resolveRetiredCliModelReplacement('codex', 'gpt-5.5', ['dall-e-3', 'gpt-5.4', 'gpt-image-2'])).toBe('gpt-5.4')
  })
})

describe('resolveRetiredCliModelReplacement', () => {
  const opusRetired = { claude: { retired: ['claude-opus-5'] } }

  it('swaps a retired Claude Code model only for a known default or the same family', () => {
    expect(resolveRetiredCliModelReplacement('claude', 'claude-opus-5', ['claude-opus-5-5', 'claude-sonnet-5'], opusRetired)).toBe('claude-opus-5-5')
    expect(resolveRetiredCliModelReplacement('claude', 'claude-opus-5', ['claude-haiku-4-5', 'claude-opus-4-8', 'claude-sonnet-5'], opusRetired)).toBe('claude-opus-4-8')
    expect(resolveRetiredCliModelReplacement('claude', 'claude-sonnet-4-5', ['claude-haiku-4-5', 'claude-sonnet-5'], { claude: { retired: ['claude-sonnet-4-5'] } })).toBe('claude-sonnet-5')
  })

  it('leaves the swap to the question before a launch when only another family is listed', () => {
    expect(resolveRetiredCliModelReplacement('claude', 'claude-opus-5', ['claude-haiku-4-5', 'claude-sonnet-5'], opusRetired)).toBeNull()
    expect(resolveRetiredCliModelReplacement('claude', 'claude-opus-5', ['claude-haiku-4-5'], opusRetired)).toBeNull()
    expect(resolveRetiredCliModelReplacement('grok', 'grok-4.6', ['grok-3-mini', 'grok-code-fast-1'], { grok: { retired: ['grok-4.6'] } })).toBeNull()
    expect(resolveRetiredCliModelReplacement('grok', 'grok-4.6', ['grok-3-mini', 'grok-4.7'], { grok: { retired: ['grok-4.6'] } })).toBe('grok-4.7')
  })

  it('never swaps in a model the same table retires', () => {
    const hints = { claude: { retired: ['claude-opus-5', 'claude-opus-4-8'] } }
    expect(resolveRetiredCliModelReplacement('claude', 'claude-opus-5', ['claude-opus-4-8', 'claude-sonnet-5'], hints)).toBeNull()
  })

  it('keeps the Codex swap that has been running since gpt-5.5 was retired', () => {
    expect(resolveRetiredCliModelReplacement('codex', 'gpt-5.5', ['codex-auto-review', 'gpt-6-astra', 'gpt-6.1-sol'])).toBe('gpt-6-astra')
    expect(resolveRetiredCliModelReplacement('codex', 'gpt-5.5', ['codex-auto-review', 'gpt-6.1-sol'])).toBe('gpt-6.1-sol')
    expect(resolveRetiredCliModelReplacement('codex', 'gpt-5.5', ['codex-auto-review'])).toBeNull()
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

describe('isRetiredCliModel', () => {
  it('names only models both sites have taken down, and only for the tool that used them', () => {
    expect(isRetiredCliModel('codex', 'gpt-5.5')).toBe(true)
    expect(isRetiredCliModel('codex', 'gpt-5.6-sol')).toBe(false)
    expect(isRetiredCliModel('codex', 'gpt-6-astra')).toBe(false)
    expect(isRetiredCliModel('claude', 'gpt-5.5')).toBe(false)
  })
})

describe('cli model hints from the service status file', () => {
  it('lets the published table move the default while the bundled default stays a fallback', () => {
    const hints = { codex: { default: 'gpt-7' } }
    expect(resolveDefaultCliModel('codex', ['gpt-6-astra', 'gpt-7'], undefined, hints)).toBe('gpt-7')
    // 账号分组里还没上新默认：退回程序自带的默认，不按字母序挑。
    expect(resolveDefaultCliModel('codex', ['codex-auto-review', 'gpt-5.6-sol', 'gpt-6-astra'], undefined, hints)).toBe('gpt-6-astra')
    expect(resolveDefaultCliModel('codex', ['gpt-6-astra', 'gpt-7'], 'gpt-6-astra', hints)).toBe('gpt-6-astra')
    expect(resolveDefaultCliModel('codex', ['gpt-6-astra', 'gpt-7'])).toBe('gpt-6-astra')
  })

  it('tries the published previous defaults in order before the bundled ones', () => {
    const hints = { claude: { default: 'claude-opus-6', previous: ['claude-sonnet-6'] } }
    expect(resolveDefaultCliModel('claude', ['claude-haiku-4-5', 'claude-opus-5', 'claude-sonnet-6'], undefined, hints)).toBe('claude-sonnet-6')
    expect(resolveDefaultCliModel('claude', ['claude-haiku-4-5', 'claude-opus-5', 'claude-opus-5-5'], undefined, hints)).toBe('claude-opus-5-5')
    expect(resolveDefaultCliModel('claude', ['claude-haiku-4-5', 'claude-opus-5'], undefined, hints)).toBe('claude-opus-5')
  })

  it('adds published retired models to the bundled ones and never picks them as a default', () => {
    const hints = { claude: { retired: ['claude-opus-5'] }, grok: { retired: ['grok-4.6'] } }
    expect(isRetiredCliModel('claude', 'claude-opus-5', hints)).toBe(true)
    expect(isRetiredCliModel('claude', 'claude-opus-5')).toBe(false)
    expect(isRetiredCliModel('codex', 'gpt-5.5', hints)).toBe(true)
    // 新配时 Haiku 是这个分组唯一能用的；开机自动替换不会换成它（resolveRetiredCliModelReplacement）。
    expect(resolveDefaultCliModel('claude', ['claude-haiku-4-5', 'claude-opus-5'], undefined, hints)).toBe('claude-haiku-4-5')
    expect(resolveDefaultCliModel('grok', ['grok-4.6', 'grok-4.7'], undefined, hints)).toBe('grok-4.7')
    expect(resolveDefaultCliModel('grok', ['grok-4.6'], undefined, hints)).toBeNull()
  })

  it('ignores a published default that the same table retires, and cannot bring back a bundled retired model', () => {
    expect(resolveDefaultCliModel('codex', ['gpt-6-astra', 'gpt-7'], undefined, { codex: { default: 'gpt-7', retired: ['gpt-7'] } })).toBe('gpt-6-astra')
    expect(resolveDefaultCliModel('codex', ['gpt-5.5', 'gpt-6.1-sol'], undefined, { codex: { default: 'gpt-5.5' } })).toBe('gpt-6.1-sol')
    expect(isRetiredCliModel('codex', 'gpt-5.5', { codex: { retired: [] } })).toBe(true)
  })

  it('offers the published default to configs still on a previous default, the bundled one included', () => {
    const hints = { codex: { default: 'gpt-7', previous: ['gpt-6.1-sol'] } }
    expect(resolveCliModelUpgrade('codex', 'gpt-6-astra', ['gpt-6-astra', 'gpt-7'], hints)).toBe('gpt-7')
    expect(resolveCliModelUpgrade('codex', 'gpt-6.1-sol', ['gpt-6.1-sol', 'gpt-7'], hints)).toBe('gpt-7')
    expect(resolveCliModelUpgrade('codex', 'gpt-6-astra', ['gpt-6-astra'], hints)).toBeNull()
    expect(resolveCliModelUpgrade('codex', 'gpt-7', ['gpt-7'], hints)).toBeNull()
    expect(resolveCliModelUpgrade('codex', 'gpt-6-astra', ['gpt-6-astra', 'gpt-7'])).toBeNull()
    // 新默认被同一份表下架时一律不问。
    expect(resolveCliModelUpgrade('claude', 'claude-opus-5', ['claude-opus-5', 'claude-opus-5-5'], { claude: { retired: ['claude-opus-5-5'] } })).toBeNull()
  })

  it('keeps bundled behavior for tools the published table leaves out', () => {
    const hints = { codex: { default: 'gpt-7' } }
    expect(resolveDefaultCliModel('claude', ['claude-opus-5', 'claude-opus-5-5'], undefined, hints)).toBe('claude-opus-5-5')
    expect(resolveCliModelUpgrade('claude', 'claude-opus-5', ['claude-opus-5', 'claude-opus-5-5'], hints)).toBe('claude-opus-5-5')
    expect(resolveDefaultCliModel('claude', ['claude-opus-5-5'], undefined, null)).toBe('claude-opus-5-5')
  })
})

describe('resolveCliModelDefault', () => {
  it('names the bundled default when no table was published', () => {
    expect(resolveCliModelDefault('codex')).toBe('gpt-6-astra')
    expect(resolveCliModelDefault('claude', null)).toBe('claude-opus-5-5')
    expect(resolveCliModelDefault('grok', { codex: { default: 'gpt-7' } })).toBe('grok-4.6')
  })

  it('follows the published default, the same one sign-in provisioning picks', () => {
    const hints = { claude: { default: 'claude-opus-6' }, codex: { default: 'gpt-7' } }
    expect(resolveCliModelDefault('claude', hints)).toBe('claude-opus-6')
    expect(resolveCliModelDefault('codex', hints)).toBe('gpt-7')
    expect(resolveDefaultCliModel('claude', ['claude-opus-5-5', 'claude-opus-6'], undefined, hints)).toBe(resolveCliModelDefault('claude', hints))
  })

  it('ignores a published default that the same table retires', () => {
    expect(resolveCliModelDefault('claude', { claude: { default: 'claude-opus-6', retired: ['claude-opus-6'] } })).toBe('claude-opus-5-5')
  })
})

describe('resolveNewestModelOfFamily', () => {
  it('picks the newest version in the same family instead of the alphabetically first model', () => {
    const models = ['gpt-5.4', 'gpt-5.6-terra', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6.1-sol-thinking']
    expect(resolveNewestModelOfFamily(models, 'gpt-5.6-sol')).toBe('gpt-6.1-sol')
  })

  it('returns null when nothing in the list shares the family', () => {
    expect(resolveNewestModelOfFamily(['gpt-5.4', 'gpt-6-astra'], 'gpt-5.6-sol')).toBeNull()
    expect(resolveNewestModelOfFamily([], 'gpt-5.6-sol')).toBeNull()
  })
})

describe('sortClaudeModelsNewestFirst', () => {
  it('orders Claude models by version first and by Opus, Sonnet, Haiku within a version', () => {
    expect(sortClaudeModelsNewestFirst([
      'claude-haiku-4-5',
      'claude-sonnet-5-5',
      'claude-3-5-sonnet-20241022',
      'claude-opus-4-8',
      'claude-opus-5-5',
      'claude-sonnet-4-6',
    ])).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-3-5-sonnet-20241022'])
  })

  it('leaves the input list untouched', () => {
    const models = ['claude-haiku-4-5', 'claude-opus-5-5']
    sortClaudeModelsNewestFirst(models)
    expect(models).toEqual(['claude-haiku-4-5', 'claude-opus-5-5'])
  })
})

describe('isNonInteractiveCliModel', () => {
  it('recognizes the image, video, speech, embedding and review-only models relays list', () => {
    for (const name of [
      'codex-auto-review', 'vendor/codex_auto_review', 'gpt-image-2', 'gpt-image-2.5-flare', 'dall-e-3', 'gemini-3.1-flash-image', 'imagen-4.0-generate-001',
      'grok-imagine-image', 'grok-imagine-video-1.5', 'jimeng_high_aes_general_v21_L', 'minimax-h3-fast', 'sora-2', 'veo-3',
      'text-embedding-3-large', 'tts-1', 'gpt-4o-mini-tts', 'whisper-1', 'gpt-4o-transcribe', 'omni-moderation-latest',
    ]) {
      expect(isNonInteractiveCliModel(name)).toBe(true)
    }
  })

  it('leaves chat models alone', () => {
    for (const name of [
      'gpt-6-astra', 'gpt-5.6-sol', 'claude-opus-5-5', 'claude-haiku-4-5', 'grok-4.6', 'grok-code-fast-1', 'deepseek-v4-flash',
      'qwen3-max', 'minimax-m2', 'codex-custom', 'openai/gpt-7', 'kimi-k2-turbo',
    ]) {
      expect(isNonInteractiveCliModel(name)).toBe(false)
    }
  })

  it('ignores a remote default or previous model that cannot chat', () => {
    expect(resolveCliModelDefault('codex', { codex: { default: 'gpt-image-2' } })).toBe('gpt-6-astra')
    expect(resolveCliModelDefault('grok', { grok: { default: 'grok-imagine-image' } })).toBe('grok-4.6')
    const hints = { codex: { default: 'gpt-7', previous: ['text-embedding-3-large', 'gpt-6.1-sol'] } }
    expect(resolveDefaultCliModel('codex', ['gpt-6.1-sol', 'text-embedding-3-large'], undefined, hints)).toBe('gpt-6.1-sol')
  })
})

describe('isCliModelName', () => {
  it('accepts the model ids relays list and rejects anything that could escape a config value', () => {
    for (const name of ['gpt-6-astra', 'claude-opus-5-5', 'grok-4.6', 'openai/gpt-7', 'vendor:model_v2', 'model@2026+fast']) {
      expect(isCliModelName(name)).toBe(true)
    }
    for (const name of ['', ' gpt-7', 'gpt 7', 'gpt-7"', "gpt-7'", 'gpt-7\n', '-gpt-7', '_x', 'claude-opus-4-8[1m]', 'x'.repeat(129)]) {
      expect(isCliModelName(name)).toBe(false)
    }
  })
})

describe('resolveClaudeFallbackModels', () => {
  const models = ['claude-haiku-5-5', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-5-5', 'gpt-6-astra']

  it('falls back to the newest other version in the same family, then the newest of the other tier', () => {
    expect(resolveClaudeFallbackModels(models, 'claude-opus-5-5')).toEqual(['claude-opus-5', 'claude-sonnet-5-5'])
    expect(resolveClaudeFallbackModels(models, 'claude-opus-5')).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5'])
    expect(resolveClaudeFallbackModels(models, 'claude-sonnet-5-5')).toEqual(['claude-sonnet-5', 'claude-opus-5-5'])
  })

  it('never falls back to Haiku, and a Haiku primary falls back to Sonnet', () => {
    expect(resolveClaudeFallbackModels(['claude-haiku-5-5', 'claude-opus-5-5'], 'claude-opus-5-5')).toEqual([])
    expect(resolveClaudeFallbackModels(models, 'claude-haiku-5-5')).toEqual(['claude-sonnet-5-5'])
  })

  it('prefers plain ids over suffixed variants of the same version and skips models the key does not list', () => {
    expect(resolveClaudeFallbackModels(['claude-opus-5-5', 'claude-sonnet-5-5-thinking', 'claude-sonnet-5-5'], 'claude-opus-5-5')).toEqual(['claude-sonnet-5-5'])
    expect(resolveClaudeFallbackModels(['claude-opus-5-5', 'claude-opus-5-5'], 'claude-opus-5-5')).toEqual([])
    expect(resolveClaudeFallbackModels([], 'claude-opus-5-5')).toEqual([])
  })
})
