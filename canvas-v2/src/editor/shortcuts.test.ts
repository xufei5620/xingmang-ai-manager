import { describe, expect, it, vi } from 'vitest'
import { canvasKeyboardEventBlocked, canvasModalSelector, resolveCanvasShortcut, type CanvasShortcutEvent } from './shortcuts'

const destructiveAndGlobalKeys: CanvasShortcutEvent[] = [
  { key: 'Delete' }, { key: 'Backspace' }, { key: 'Enter', metaKey: true },
  { key: 'z', ctrlKey: true }, { key: 'y', ctrlKey: true },
  { key: 'd', metaKey: true }, { key: 's', metaKey: true },
  { key: 'o', ctrlKey: true }, { key: 'a', ctrlKey: true },
  { key: 'c', metaKey: true }, { key: 'v', metaKey: true },
  { key: 'g', ctrlKey: true }, { key: 'g', ctrlKey: true, shiftKey: true },
  { key: 'l', metaKey: true }, { key: 'k', metaKey: true },
  { key: 'f', ctrlKey: true }, { key: 'a' }, { key: 'z' },
]

describe('canvas shortcuts respect modal and handled keyboard boundaries', () => {
  it('does not alter the canvas from a modal even when focus is on a button or remains outside the dialog', () => {
    for (const key of destructiveAndGlobalKeys) {
      expect(resolveCanvasShortcut({ ...key, target: { tagName: 'BUTTON' } }, { modalOpen: true })).toBeNull()
      expect(resolveCanvasShortcut(key, { modalOpen: true })).toBeNull()
    }
    expect(resolveCanvasShortcut({ key: 'Delete', target: { tagName: 'BUTTON' } }, { modalOpen: false })).toBe('delete')
    expect(resolveCanvasShortcut({ key: 'Enter', metaKey: true }, { modalOpen: false })).toBe('run')
  })

  it('recognizes modal ancestors for nested button and SVG event targets without requiring canvas state', () => {
    const closest = vi.fn((selector: string) => selector === canvasModalSelector ? { role: 'dialog', modal: true } : null)
    for (const tagName of ['BUTTON', 'svg', 'SPAN']) {
      expect(resolveCanvasShortcut({ key: 'Delete', target: { tagName, closest } })).toBeNull()
      expect(canvasKeyboardEventBlocked({ key: 'Escape', target: { tagName, closest } })).toBe(true)
    }
    expect(closest).toHaveBeenCalledWith('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')
    expect(resolveCanvasShortcut({ key: 'Delete', target: { tagName: 'BUTTON', closest: () => null } })).toBe('delete')
  })

  it('does not reinterpret an Enter or Delete already consumed by a palette or dialog', () => {
    for (const key of destructiveAndGlobalKeys) expect(resolveCanvasShortcut({ ...key, defaultPrevented: true })).toBeNull()
    expect(canvasKeyboardEventBlocked({ key: 'Escape', defaultPrevented: true })).toBe(true)
    expect(resolveCanvasShortcut({ key: 'Enter', metaKey: true, defaultPrevented: false })).toBe('run')
  })

  it('leaves modal Escape and Tab to the modal owner and never prevents their default action', () => {
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()
    for (const key of ['Escape', 'Tab']) {
      const event = { key, target: { tagName: 'BUTTON' }, preventDefault, stopPropagation }
      expect(resolveCanvasShortcut(event, { modalOpen: true })).toBeNull()
      expect(canvasKeyboardEventBlocked(event, { modalOpen: true })).toBe(true)
    }
    expect(preventDefault).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
    expect(canvasKeyboardEventBlocked({ key: 'Escape', target: { tagName: 'BUTTON', closest: () => null } }, { modalOpen: false })).toBe(false)
  })

  it('keeps native text editing, selection and composition ahead of canvas operations', () => {
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
      for (const key of destructiveAndGlobalKeys) expect(resolveCanvasShortcut({ ...key, target })).toBeNull()
    }
    expect(resolveCanvasShortcut({ key: 'Backspace', isComposing: true })).toBeNull()
    expect(resolveCanvasShortcut({ key: 'Enter', metaKey: true, altKey: true })).toBeNull()
    expect(resolveCanvasShortcut({ key: 'z', ctrlKey: true })).toBe('undo')
    expect(resolveCanvasShortcut({ key: 'z', ctrlKey: true, shiftKey: true })).toBe('redo')
  })
})
