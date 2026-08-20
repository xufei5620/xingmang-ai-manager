import { describe, expect, it } from 'vitest'
import {
  commitGenerationPrompts,
  composeGenerationPrompt,
  composeNodePromptFromGraph,
  composerFieldLabel,
  composerParamColumns,
  composerPromptPlaceholder,
  composerToolbarFields,
  isComposerKind,
} from './generation-composer'

describe('generation composer fields', () => {
  it('exposes the image controls a selected generate node can change', () => {
    expect(composerToolbarFields('image-generate', 'gpt-image-2')).toEqual([
      'model', 'quality', 'imageResolution', 'size',
    ])
  })

  it('hides quality when the model does not take it', () => {
    expect(composerToolbarFields('image-generate', 'jimeng_high_aes_general_v21_L')).toEqual([
      'model', 'imageResolution',
    ])
  })

  it('keeps MiniMax video extras on the bar so they are not stranded in the old form', () => {
    expect(composerToolbarFields('video-generate', 'minimax-h3-mini')).toEqual([
      'model', 'videoMode', 'videoResolution', 'videoAspectRatio', 'seconds', 'promptOptimization',
    ])
  })

  it('does not invent a composer for non-generation nodes', () => {
    expect(isComposerKind('prompt')).toBe(false)
    expect(composerToolbarFields('prompt', '')).toEqual([])
  })

  it('keeps the placeholder specific to the media being generated', () => {
    expect(composerPromptPlaceholder('image-generate')).toContain('画面')
    expect(composerPromptPlaceholder('video-generate')).toContain('视频')
  })

  it('labels each control and packs three image knobs onto one row', () => {
    expect(composerFieldLabel('quality')).toBe('画质')
    expect(composerFieldLabel('size', 'image-generate')).toBe('尺寸')
    expect(composerFieldLabel('size', 'video-generate')).toBe('比例')
    expect(composerParamColumns(['model', 'quality', 'imageResolution', 'size'])).toBe(3)
    expect(composerParamColumns(['model', 'videoMode', 'videoResolution', 'videoAspectRatio', 'seconds'])).toBe(2)
  })

  it('writes the upstream text into an empty generate-node prompt so it can be saved', () => {
    expect(composeGenerationPrompt('', '一只猫')).toBe('一只猫')
    expect(composeGenerationPrompt('夜景', '一只猫')).toBe('一只猫\n夜景')
    const nodes = [
      { id: 'text', type: 'prompt', data: { prompt: '角色三视图' } },
      { id: 'image', type: 'image-generate', data: { prompt: '' } },
    ]
    const edges = [{ source: 'text', target: 'image', sourceHandle: 'out:text' }]
    expect(composeNodePromptFromGraph('image', nodes, edges)).toBe('角色三视图')
    expect(commitGenerationPrompts(nodes, edges)[1]?.data.prompt).toBe('角色三视图')
  })
})
