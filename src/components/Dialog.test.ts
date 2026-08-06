import { describe, expect, it } from 'vitest'
import { dialogAriaProps, dialogKeyboardDecision } from './Dialog'

describe('dialog accessibility contract', () => {
  it('provides consistent modal labelling props for form dialogs', () => {
    expect(dialogAriaProps('dialog-title')).toEqual({
      role: 'dialog',
      'aria-modal': true,
      'aria-labelledby': 'dialog-title',
    })
  })

  it('dismisses on Escape and ignores unrelated keys', () => {
    expect(dialogKeyboardDecision({
      key: 'Escape',
      shiftKey: false,
      activeIndex: 0,
      focusableCount: 2,
    })).toEqual({ handled: true, dismiss: true, focusIndex: null, preventDefault: false })
    expect(dialogKeyboardDecision({
      key: 'Enter',
      shiftKey: false,
      activeIndex: 0,
      focusableCount: 2,
    })).toEqual({ handled: false, dismiss: false, focusIndex: null, preventDefault: false })
  })

  it('contains Tab when no focusable control exists', () => {
    expect(dialogKeyboardDecision({
      key: 'Tab',
      shiftKey: false,
      activeIndex: -1,
      focusableCount: 0,
    })).toEqual({ handled: true, dismiss: false, focusIndex: null, preventDefault: true })
  })

  it('wraps focus at both ends and recovers focus that escaped the dialog', () => {
    expect(dialogKeyboardDecision({
      key: 'Tab',
      shiftKey: false,
      activeIndex: 2,
      focusableCount: 3,
    }).focusIndex).toBe(0)
    expect(dialogKeyboardDecision({
      key: 'Tab',
      shiftKey: true,
      activeIndex: 0,
      focusableCount: 3,
    }).focusIndex).toBe(2)
    expect(dialogKeyboardDecision({
      key: 'Tab',
      shiftKey: false,
      activeIndex: -1,
      focusableCount: 3,
    }).focusIndex).toBe(0)
    expect(dialogKeyboardDecision({
      key: 'Tab',
      shiftKey: true,
      activeIndex: -1,
      focusableCount: 3,
    }).focusIndex).toBe(2)
  })

  it('allows native Tab movement between interior controls', () => {
    expect(dialogKeyboardDecision({
      key: 'Tab',
      shiftKey: false,
      activeIndex: 1,
      focusableCount: 3,
    })).toEqual({ handled: true, dismiss: false, focusIndex: null, preventDefault: false })
  })
})
