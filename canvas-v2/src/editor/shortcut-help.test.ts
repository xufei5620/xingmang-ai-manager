import { describe, expect, it } from 'vitest'
import { canvasShortcutHelp, canvasShortcutKeyLabels } from './shortcut-help'
import { resolveCanvasShortcut } from './shortcuts'

describe('visible canvas shortcut guide', () => {
  it('documents working commands on both Mac and Windows', () => {
    for (const item of canvasShortcutHelp.flatMap((group) => group.items)) {
      expect(resolveCanvasShortcut(item.event), item.label).toBe(item.command)
      if (item.event.ctrlKey) {
        expect(resolveCanvasShortcut({ ...item.event, ctrlKey: false, metaKey: true }), item.label).toBe(item.command)
      }
    }
  })

  it('does not execute documented commands while typing or reading modal help', () => {
    for (const item of canvasShortcutHelp.flatMap((group) => group.items)) {
      expect(resolveCanvasShortcut({ ...item.event, target: { tagName: 'TEXTAREA' } })).toBeNull()
      expect(resolveCanvasShortcut(item.event, { modalOpen: true })).toBeNull()
    }
  })

  it('distinguishes the unmodified overview key from undo and redo', () => {
    expect(canvasShortcutKeyLabels({ key: 'z' })).toEqual(['Z'])
    expect(canvasShortcutKeyLabels({ key: 'z', ctrlKey: true })).toEqual(['⌘ / Ctrl', 'Z'])
    expect(canvasShortcutKeyLabels({ key: 'z', ctrlKey: true, shiftKey: true })).toEqual(['⌘ / Ctrl', 'Shift', 'Z'])
  })
})
