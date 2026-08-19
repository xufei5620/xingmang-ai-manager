import { describe, expect, it } from 'vitest'
import { resolveCanvasShortcut } from './shortcuts'

describe('canvas shortcuts', () => {
  it('resolves platform modifiers and shifted variants', () => {
    expect(resolveCanvasShortcut({ key: 'z', ctrlKey: true })).toBe('undo')
    expect(resolveCanvasShortcut({ key: 'Z', metaKey: true, shiftKey: true })).toBe('redo')
    expect(resolveCanvasShortcut({ key: 'g', ctrlKey: true })).toBe('group')
    expect(resolveCanvasShortcut({ key: 'g', ctrlKey: true, shiftKey: true })).toBe('ungroup')
    expect(resolveCanvasShortcut({ key: 'k', ctrlKey: true })).toBe('quick-insert')
  })

  it('does not steal keys from editable or composing targets', () => {
    expect(resolveCanvasShortcut({ key: 'z', ctrlKey: true, target: { tagName: 'TEXTAREA' } })).toBeNull()
    expect(resolveCanvasShortcut({ key: 'Backspace', target: { isContentEditable: true } })).toBeNull()
    expect(resolveCanvasShortcut({ key: 'c', ctrlKey: true, isComposing: true })).toBeNull()
  })

  it('maps delete without a modifier', () => {
    expect(resolveCanvasShortcut({ key: 'Delete' })).toBe('delete')
    expect(resolveCanvasShortcut({ key: 'Backspace' })).toBe('delete')
  })

  it('maps unmodified asset and overview navigation without stealing variants', () => {
    expect(resolveCanvasShortcut({ key: 'a' })).toBe('toggle-assets')
    expect(resolveCanvasShortcut({ key: 'Z' })).toBe('toggle-overview')
    expect(resolveCanvasShortcut({ key: 'a', shiftKey: true })).toBeNull()
    expect(resolveCanvasShortcut({ key: 'Delete', shiftKey: true })).toBe('delete')
    expect(resolveCanvasShortcut({ key: 'z', altKey: true })).toBeNull()
    expect(resolveCanvasShortcut({ key: 'a', target: { tagName: 'INPUT' } })).toBeNull()
    expect(resolveCanvasShortcut({ key: 'z', isComposing: true })).toBeNull()
  })
})
