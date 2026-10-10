import { describe, expect, it } from 'vitest'
import {
  composerParameterSummary,
  generationModelChangePatch,
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
    expect(composeNodePromptFromGraph('image', [
      { id: 'text', data: { prompt: '角色三视图' } },
      { id: 'image', data: { prompt: '角色三视图\n夜景' } },
    ], edges)).toBe('角色三视图\n夜景')
  })
})

describe('compact generation settings', () => {
  it('summarizes supported values and preserves visibility of imported values', () => {
    expect(composerParameterSummary('image-generate', 'gpt-image-2', { size: '1280x720', imageResolution: '2K', quality: 'high' })).toBe('16:9 · 2K · 极高')
    expect(composerParameterSummary('image-generate', 'gpt-image-2', { size: '1600x1600', quality: 'auto' })).toContain('1600x1600（已保存）')
    expect(composerParameterSummary('image-generate', 'gpt-image-2', { quality: 'auto' })).toContain('自动画质')
    expect(composerParameterSummary('image-generate', 'gpt-image-1', { imageResolution: '4K' })).toContain('4K（需调整）')
  })

  it('summarizes video settings without exposing irrelevant image controls', () => {
    expect(composerParameterSummary('video-generate', 'minimax-h3-mini', { seconds: '6', settings: { videoAspectRatio: '9:16', videoResolution: '480p', promptOptimization: true } })).toBe('9:16 · 480p · 6 秒 · AI 优化')
    expect(composerParameterSummary('video-generate', 'grok-imagine-video', { seconds: '6', size: '1280x720' })).toBe('16:9 · 6 秒')
  })

  it('reconciles the persisted image configuration when switching model capabilities', () => {
    expect(generationModelChangePatch('image-generate', 'gpt-image-1', { size: '1280x720', imageResolution: '4K' })).toEqual({ model: 'gpt-image-1', size: '1024x1024', imageResolution: '1K' })
    expect(generationModelChangePatch('image-generate', 'jimeng_high_aes_general_v21_L', { size: '1280x720', imageResolution: '2K' })).toEqual({ model: 'jimeng_high_aes_general_v21_L', size: '1024x1024', imageResolution: '1K' })
    expect(generationModelChangePatch('image-generate', 'gpt-image-2', { size: '1280x720', imageResolution: '2K' })).toEqual({ model: 'gpt-image-2' })
  })

  it('preserves supported video durations and resets unsupported values', () => {
    expect(generationModelChangePatch('video-generate', 'grok-imagine-video', { size: '1280x720', seconds: '6' })).toEqual({ model: 'grok-imagine-video' })
    expect(generationModelChangePatch('video-generate', 'minimax-h3-mini', { size: '1280x720', seconds: '2' })).toMatchObject({ model: 'minimax-h3-mini', seconds: '5' })
    expect(generationModelChangePatch('video-generate', 'grok-imagine-video', { size: '1280x736', seconds: '20' })).toEqual({ model: 'grok-imagine-video', size: '1280x720', seconds: '5' })
  })
})
