import { describe, expect, it } from 'vitest'
import { canvasTextKeyIsComposing, canvasTextSelection, createCanvasTextHistory, formatCanvasText, rememberCanvasText, restoreCanvasText, type CanvasTextFormat } from './text-editor-state'

describe('canvas text formatting and isolated history', () => {
  it('wraps a selected Unicode phrase and toggles it without losing surrounding text', () => {
    const before = '产品：陶瓷杯 ☕️\n白色背景'
    const bold = formatCanvasText(canvasTextSelection(before, 3, 6), 'bold')
    expect(bold).toEqual({ text: '产品：**陶瓷杯** ☕️\n白色背景', start: 5, end: 8 })
    expect(formatCanvasText(bold, 'bold')).toEqual({ text: before, start: 3, end: 6 })
    expect(formatCanvasText(canvasTextSelection('**商品**', 0, 6), 'bold').text).toBe('商品')
  })
  it.each<[CanvasTextFormat, string]>([['bold', '**文字**'], ['italic', '*文字*'], ['strike', '~~文字~~'], ['inline-code', '`代码`'], ['h1', '# '], ['h2', '## '], ['h3', '### '], ['unordered', '- '], ['ordered', '1. '], ['quote', '> '], ['link', '[链接文字](https://)'], ['image', '![图片说明](https://)'], ['code-block', '```\n代码\n```'], ['divider', '---']])('inserts %s into an empty document with an editable selection', (format, expected) => {
    const next = formatCanvasText(canvasTextSelection(''), format)
    expect(next.text).toBe(expected); expect(next.start).toBeGreaterThanOrEqual(0); expect(next.end).toBeLessThanOrEqual(next.text.length)
  })
  it('formats only selected lines, replaces headings and excludes a trailing newline', () => {
    const selected = canvasTextSelection('首行\n商品\n材质\n末行', 3, 9)
    const numbered = formatCanvasText(selected, 'ordered')
    expect(numbered.text).toBe('首行\n1. 商品\n2. 材质\n末行')
    expect(formatCanvasText(numbered, 'ordered').text).toBe(selected.text)
    expect(formatCanvasText(canvasTextSelection('## 商品\n末行', 2, 4), 'h1').text).toBe('# 商品\n末行')
    expect(formatCanvasText(canvasTextSelection('\n下一行', 0, 0), 'quote').text).toBe('> \n下一行')
  })
  it('uses safe fences around code containing backticks and separates block insertions', () => {
    expect(formatCanvasText(canvasTextSelection('a ` b', 0, 5), 'inline-code').text).toBe('``a ` b``')
    expect(formatCanvasText(canvasTextSelection('```\nbody', 0, 8), 'code-block').text).toBe('````\n```\nbody\n````')
    expect(formatCanvasText(canvasTextSelection('beforeafter', 6), 'divider').text).toBe('before\n\n---\n\nafter')
  })
  it('keeps surrogate pairs intact and rejects capacity overflow without mutation', () => {
    expect(canvasTextSelection('x😀y', 2)).toEqual({ text: 'x😀y', start: 1, end: 1 })
    const value = canvasTextSelection('完整正文', 0, 4)
    expect(() => formatCanvasText(value, 'bold', 5)).toThrow('超过')
    expect(value.text).toBe('完整正文')
  })
  it('groups contiguous typing but keeps formatting, cursor jumps and redo as separate edits', () => {
    let history = createCanvasTextHistory('')
    history = rememberCanvasText(history, canvasTextSelection('a'), true, 10)
    history = rememberCanvasText(history, canvasTextSelection('ab'), true, 100)
    history = rememberCanvasText(history, canvasTextSelection('abc'), true, 200)
    expect(history.past).toHaveLength(1)
    history = rememberCanvasText(history, formatCanvasText(canvasTextSelection('abc', 0, 3), 'bold'), false, 300)
    expect(history.past).toHaveLength(2)
    history = restoreCanvasText(history); expect(history.present.text).toBe('abc')
    history = restoreCanvasText(history); expect(history.present.text).toBe('')
    history = restoreCanvasText(history, true); expect(history.present.text).toBe('abc')
    history = rememberCanvasText(history, canvasTextSelection('xabc', 1), true, 400)
    expect(history.future).toHaveLength(0); expect(restoreCanvasText(history).present.text).toBe('abc')
  })
  it('bounds history for long text while preserving the full present document', () => {
    let history = createCanvasTextHistory('x'.repeat(99_000))
    for (let index = 0; index < 100; index++) history = rememberCanvasText(history, canvasTextSelection('x'.repeat(99_000) + index), false, index)
    expect(history.past.reduce((size, entry) => size + entry.text.length, 0)).toBeLessThanOrEqual(2_000_000)
    expect(history.present.text).toHaveLength(99_002); expect(restoreCanvasText(history).present.text.endsWith('98')).toBe(true)
  })
  it('recognizes composition events from modern and legacy IME key events', () => {
    expect(canvasTextKeyIsComposing({ isComposing: true })).toBe(true)
    expect(canvasTextKeyIsComposing({ keyCode: 229 })).toBe(true)
    expect(canvasTextKeyIsComposing({ isComposing: false, keyCode: 13 })).toBe(false)
  })
})
