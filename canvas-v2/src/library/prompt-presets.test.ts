import { describe, expect, it } from 'vitest'
import { builtinPromptPresets, promptPresetMime, searchPromptPresets } from './prompt-presets'

describe('prompt preset library', () => {
  it('keeps unique first-party presets with usable content', () => {
    expect(new Set(builtinPromptPresets.map((preset) => preset.id)).size).toBe(builtinPromptPresets.length)
    expect(builtinPromptPresets.length).toBeGreaterThanOrEqual(4)
    for (const preset of builtinPromptPresets) {
      expect(preset.provenance).toBe('xingmang-original')
      expect(preset.prompt.length).toBeGreaterThan(20)
      expect(preset.tags.length).toBeGreaterThan(0)
    }
  })

  it('searches titles, descriptions and tags without mutating the catalog', () => {
    expect(searchPromptPresets('人像').map((preset) => preset.id)).toContain('xingmang-portrait-editorial')
    expect(searchPromptPresets('合成').map((preset) => preset.id)).toContain('xingmang-background-replace')
    expect(searchPromptPresets('多视图').map((preset) => preset.id)).toContain('xingmang-story-character-card')
    expect(searchPromptPresets('')).toBe(builtinPromptPresets)
  })

  it('uses a dedicated drag mime so presets can land on the canvas', () => {
    expect(promptPresetMime).toBe('application/x-xingmang-prompt-preset')
  })
})
