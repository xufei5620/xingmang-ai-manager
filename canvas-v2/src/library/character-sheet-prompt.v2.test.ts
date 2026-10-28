import { describe, expect, it } from 'vitest'
import {
  characterSheetLayoutPrompt,
  composeCharacterSheetPrompt,
  defaultCharacterSheetPrompt,
  defaultCharacterSheetStyle,
} from './character-sheet-prompt'

describe('character sheet prompt', () => {
  it('stacks layout, appearance and style in that order', () => {
    const prompt = composeCharacterSheetPrompt({
      appearance: '黑发少年，黑色高领，白色运动鞋。',
      style: '赛璐璐漫画风。',
    })
    expect(prompt.startsWith('生成角色的多视图')).toBe(true)
    expect(prompt).toContain('上方板块占画面1/3')
    expect(prompt).toContain('严禁展示头部')
    expect(prompt).toContain('黑发少年，黑色高领，白色运动鞋。')
    expect(prompt.endsWith('赛璐璐漫画风。')).toBe(true)
  })

  it('keeps the default example ready to drop onto an image node', () => {
    expect(defaultCharacterSheetPrompt).toContain(characterSheetLayoutPrompt)
    expect(defaultCharacterSheetPrompt).toContain('韩系年轻少女')
    expect(defaultCharacterSheetPrompt).toContain(defaultCharacterSheetStyle)
    expect(defaultCharacterSheetPrompt).toContain('不生成文字、标注、水印')
  })
})
