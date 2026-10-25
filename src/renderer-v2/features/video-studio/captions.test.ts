import { describe, expect, it } from 'vitest'
import {
  layoutVideoStudioCaption,
  paintVideoStudioCaption,
  splitCaptionUnits,
  videoStudioCaptionFont,
  wrapCaptionParagraph,
  type VideoStudioCaptionPainter,
} from './captions'

// 假的量字：每个字符算 1 个单位宽，乘上字号。
function measureByCharacter(text: string, fontSize = 1) {
  return Array.from(text).length * fontSize
}

describe('video studio captions', () => {
  it('splits Chinese by character and English by word', () => {
    expect(splitCaptionUnits('你好 world')).toEqual(['你', '好 ', 'world'])
    expect(splitCaptionUnits('Hello, big world!')).toEqual(['Hello, ', 'big ', 'world!'])
    expect(splitCaptionUnits('3.14 和 50%')).toEqual(['3.14 ', '和 ', '50%'])
  })

  it('keeps punctuation off the start of a line and brackets off the end', () => {
    expect(splitCaptionUnits('好的。然后（括号）「引号」')).toEqual(['好', '的。', '然', '后', '（括', '号）', '「引', '号」'])
    expect(splitCaptionUnits('。开头')).toEqual(['。', '开', '头'])
    expect(splitCaptionUnits('结尾（')).toEqual(['结', '尾', '（'])
    expect(splitCaptionUnits('   ')).toEqual([])
  })

  it('wraps greedily without breaking a unit', () => {
    expect(wrapCaptionParagraph('一二三四五六七', 3, measureByCharacter)).toEqual(['一二三', '四五六', '七'])
    expect(wrapCaptionParagraph('今天天气很好。', 6, measureByCharacter)).toEqual(['今天天气很', '好。'])
    expect(wrapCaptionParagraph('make every line fit', 10, measureByCharacter)).toEqual(['make every', 'line fit'])
  })

  it('breaks a unit that is wider than a line by character', () => {
    expect(wrapCaptionParagraph('https://example.com/abc', 10, measureByCharacter)).toEqual(['https://ex', 'ample.com/', 'abc'])
  })

  it('places a landscape caption near the bottom at a size set by the short side', () => {
    const layout = layoutVideoStudioCaption('第一行\n第二行', { width: 1280, height: 720 }, measureByCharacter)
    expect(layout).toMatchObject({ fontSize: 40, lines: ['第一行', '第二行'], centerX: 640, strokeWidth: 6, font: videoStudioCaptionFont(40) })
    expect(layout?.baselines).toEqual([610, 662])
  })

  it('lifts a portrait caption above the platform controls', () => {
    const layout = layoutVideoStudioCaption('竖屏字幕', { width: 720, height: 1280 }, measureByCharacter)
    expect(layout?.baselines).toEqual([1024])
  })

  it('shrinks a long caption before cutting it with an ellipsis', () => {
    const frame = { width: 1280, height: 720 }
    // 1280 × 0.88 / 40 = 28 个字一行；两行装不下 60 个字，缩到 34 号后一行 33 个字，正好装下。
    const shrunk = layoutVideoStudioCaption('字'.repeat(60), frame, measureByCharacter)
    expect(shrunk?.fontSize).toBe(34)
    expect(shrunk?.lines).toHaveLength(2)
    const cut = layoutVideoStudioCaption('字'.repeat(400), frame, measureByCharacter)
    expect(cut?.lines).toHaveLength(2)
    expect(cut?.lines[1].endsWith('…')).toBe(true)
    expect(measureByCharacter(cut?.lines[1] ?? '', cut?.fontSize)).toBeLessThanOrEqual(1280 * 0.88)
  })

  it('has nothing to draw for an empty caption', () => {
    expect(layoutVideoStudioCaption(' \n ', { width: 1280, height: 720 }, measureByCharacter)).toBeNull()
  })

  it('paints each line as a dark outline under white text', () => {
    const calls: string[] = []
    const painter: VideoStudioCaptionPainter = {
      font: '',
      textAlign: 'start',
      textBaseline: 'top',
      lineJoin: 'miter',
      lineWidth: 1,
      strokeStyle: '',
      fillStyle: '',
      strokeText(text, x, y) { calls.push(`stroke ${text} ${x} ${y}`) },
      fillText(text, x, y) { calls.push(`fill ${text} ${x} ${y} ${painter.fillStyle}`) },
    }
    const layout = layoutVideoStudioCaption('上\n下', { width: 1280, height: 720 }, measureByCharacter)
    if (!layout) throw new Error('expected a layout')
    paintVideoStudioCaption(painter, layout)
    expect(painter).toMatchObject({ font: layout.font, textAlign: 'center', textBaseline: 'alphabetic', lineJoin: 'round', lineWidth: 6 })
    expect(calls).toEqual(['stroke 上 640 610', 'fill 上 640 610 #ffffff', 'stroke 下 640 662', 'fill 下 640 662 #ffffff'])
  })
})
