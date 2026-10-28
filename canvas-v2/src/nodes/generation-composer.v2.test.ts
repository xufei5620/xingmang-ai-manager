// 桌面 v2 编辑器的用例（桌面 000f9131 的 canvas-v2/src/nodes/generation-composer.test.ts），#4 搬进内核。
// 内核有意和 v2 不一样的地方，期望改成内核的行为或退役，改动处写了为什么，汇总见 docs/canvas-kernel-v2-tests.md。
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
      // 内核多列生成数量；宿主一次只出一张时（老桌面）控件不显示，见 hostCandidateCountChoices。
      'model', 'quality', 'imageResolution', 'size', 'imageCandidateCount',
    ])
  })

  it('hides quality when the model does not take it', () => {
    expect(composerToolbarFields('image-generate', 'jimeng_high_aes_general_v21_L')).toEqual([
      'model', 'imageResolution', 'imageCandidateCount',
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
