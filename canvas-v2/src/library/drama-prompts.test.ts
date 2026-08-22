import { describe, expect, it } from 'vitest'
import { composePropSheetPrompt } from './prop-sheet-prompt'
import { composeSceneSheetPrompt } from './scene-sheet-prompt'
import { composeShotFramePrompt } from './shot-frame-prompt'

describe('drama sheet and shot prompts', () => {
  it('keeps scene sheets empty of people and prop sheets on a plain background', () => {
    const scene = composeSceneSheetPrompt({ environment: '暖阁内室帷帐烛火', tone: '暧昧蓄力', style: '3D漫剧写实厚涂风。' })
    expect(scene).toContain('纯环境无人')
    expect(scene).toContain('暖阁内室帷帐烛火')
    const prop = composePropSheetPrompt({ morphology: '血色丹珠', countLock: '一枚' })
    expect(prop).toContain('单体道具设定图')
    expect(prop).toContain('数量锁：一枚')
  })

  it('describes a single story frame without rewriting faces', () => {
    const prompt = composeShotFramePrompt({ action: '虞晚旋动血丹', framing: '大特写', camera: '极缓推' })
    expect(prompt).toContain('单张剧情关键帧')
    expect(prompt).toContain('大特写')
    expect(prompt).toContain('不重写五官')
  })
})
