import { describe, expect, it } from 'vitest'
import { createInsertionViewportHistory } from './insertion-viewport-history'

const original = { x: 31, y: 42, zoom: .8 }
const firstCopy = { x: 31, y: -600, zoom: .7 }

describe('transient insertion viewport ownership', () => {
  it('does not turn ordinary graph edits into camera undo entries', () => {
    const history = createInsertionViewportHistory()
    history.record(true, 1); history.record(true, 2)
    expect(history.undo()).toBeNull(); expect(history.redo()).toBeNull()
  })

  it('snapshots the original viewport and restores the matching insertion around undo redo', () => {
    const history = createInsertionViewportHistory(), before = { ...original }, ids = ['copy']
    const token = history.record(true, 1, { viewport: before, nodeIds: ids })!
    before.x = 999; ids.push('not-in-copy')
    expect(history.current(token)).toBe(true)
    expect(history.undo()).toEqual({ kind: 'restore', viewport: original })
    expect(history.current(token)).toBe(false)
    expect(history.redo()).toEqual({ kind: 'focus', token, nodeIds: ['copy'] })
    expect(history.current(token)).toBe(true)
  })

  it('keeps the insertion ownership across an intervening ordinary edit and merged draft', () => {
    const history = createInsertionViewportHistory()
    const token = history.record(true, 1, { viewport: original, nodeIds: ['copy'] })!
    history.record(true, 2); history.record(false, 2)
    expect(history.undo()).toBeNull()
    expect(history.current(token)).toBe(true)
    expect(history.undo()).toEqual({ kind: 'restore', viewport: original })
  })

  it('restores nested insertions in order without recording manual navigation', () => {
    const history = createInsertionViewportHistory()
    const first = history.record(true, 1, { viewport: original, nodeIds: ['one'] })!
    const second = history.record(true, 2, { viewport: firstCopy, nodeIds: ['two'] })!
    expect(history.undo()).toEqual({ kind: 'restore', viewport: firstCopy })
    expect(history.current(first)).toBe(true)
    expect(history.undo()).toEqual({ kind: 'restore', viewport: original })
    expect(history.redo()).toMatchObject({ kind: 'focus', token: first })
    expect(history.redo()).toMatchObject({ kind: 'focus', token: second })
  })

  it('preserves later manual camera intent through both undo and redo', () => {
    const history = createInsertionViewportHistory()
    const token = history.record(true, 1, { viewport: original, nodeIds: ['copy'] })!
    history.userNavigation()
    expect(history.current(token)).toBe(false)
    expect(history.undo()).toBeNull(); expect(history.redo()).toBeNull()
  })

  it('does not steal a new user view when navigation occurs between undo and redo', () => {
    const history = createInsertionViewportHistory()
    history.record(true, 1, { viewport: original, nodeIds: ['copy'] })
    history.undo(); history.userNavigation()
    expect(history.redo()).toBeNull()
  })

  it('discards undone camera effects when a new graph branch is edited', () => {
    const history = createInsertionViewportHistory()
    const token = history.record(true, 1, { viewport: original, nodeIds: ['discarded'] })!
    history.undo(); history.record(true, 1)
    expect(history.redo()).toBeNull(); expect(history.current(token)).toBe(false)
  })

  it('clips transient metadata to the same bounded history depth', () => {
    const history = createInsertionViewportHistory()
    history.record(true, 1, { viewport: original, nodeIds: ['one'] })
    history.record(true, 1, { viewport: firstCopy, nodeIds: ['two'] })
    expect(history.undo()).toEqual({ kind: 'restore', viewport: firstCopy })
    expect(history.undo()).toBeNull()
  })

  it('invalidates pending focus across a project reset without reusing a token', () => {
    const history = createInsertionViewportHistory()
    const previous = history.record(true, 1, { viewport: original, nodeIds: ['same-id'] })!
    history.reset()
    const next = history.record(true, 1, { viewport: original, nodeIds: ['same-id'] })!
    expect(history.current(previous)).toBe(false)
    expect(next.id).not.toBe(previous.id)
  })
})
