import { describe, expect, it } from 'vitest'
import { nextUiScale, uiScaleShortcutFor } from './ui-scale-shortcut'

function key(value: string, extra: Partial<KeyboardEvent> = {}) {
  return { key: value, ctrlKey: true, metaKey: false, altKey: false, isComposing: false, ...extra }
}

describe('ui scale shortcut', () => {
  it('recognizes plus, equals, minus and zero with Ctrl or Command', () => {
    expect(uiScaleShortcutFor(key('+'))).toBe('larger')
    expect(uiScaleShortcutFor(key('='))).toBe('larger')
    expect(uiScaleShortcutFor(key('-'))).toBe('smaller')
    expect(uiScaleShortcutFor(key('0', { ctrlKey: false, metaKey: true }))).toBe('reset')
  })

  it('ignores plain keys, Alt combinations and IME composition', () => {
    expect(uiScaleShortcutFor(key('+', { ctrlKey: false }))).toBeNull()
    expect(uiScaleShortcutFor(key('+', { altKey: true }))).toBeNull()
    expect(uiScaleShortcutFor(key('0', { isComposing: true }))).toBeNull()
    expect(uiScaleShortcutFor(key('1'))).toBeNull()
  })

  it('steps between 90, 100 and 110 treating automatic as 100', () => {
    expect(nextUiScale(undefined, 'larger', 'win')).toEqual({ next: '110', message: '界面缩放 110%，按 Ctrl 0 恢复自动' })
    expect(nextUiScale('auto', 'smaller', 'win')).toEqual({ next: '90', message: '界面缩放 90%，按 Ctrl 0 恢复自动' })
    expect(nextUiScale('90', 'larger', 'win').next).toBe('100')
    expect(nextUiScale('110', 'smaller', 'mac')).toEqual({ next: '100', message: '界面缩放 100%，按 ⌘ 0 恢复自动' })
  })

  it('stays put at either end and says so', () => {
    expect(nextUiScale('110', 'larger', 'win')).toEqual({ next: null, message: '已经是最大的 110%' })
    expect(nextUiScale('90', 'smaller', 'win')).toEqual({ next: null, message: '已经是最小的 90%' })
  })

  it('resets to automatic', () => {
    expect(nextUiScale('110', 'reset', 'mac')).toEqual({ next: 'auto', message: '界面缩放已恢复自动' })
  })
})
