import { describe, expect, it } from 'vitest'
import { adjacentAssetId, assetGridKeyAction, rovingTabIndex } from './asset-grid-keyboard'

describe('asset grid keyboard', () => {
  it('moves one tile horizontally and one row vertically', () => {
    expect(assetGridKeyAction('ArrowRight', 0, 6, 2)).toEqual({ kind: 'focus', index: 1 })
    expect(assetGridKeyAction('ArrowLeft', 3, 6, 2)).toEqual({ kind: 'focus', index: 2 })
    expect(assetGridKeyAction('ArrowDown', 1, 6, 2)).toEqual({ kind: 'focus', index: 3 })
    expect(assetGridKeyAction('ArrowUp', 4, 6, 2)).toEqual({ kind: 'focus', index: 2 })
  })

  it('clamps at the edges instead of wrapping', () => {
    // Wrapping from the last tile to the first reads as an unexplained jump
    // when the whole grid is not visible at once.
    expect(assetGridKeyAction('ArrowLeft', 0, 6, 2)).toEqual({ kind: 'focus', index: 0 })
    expect(assetGridKeyAction('ArrowRight', 5, 6, 2)).toEqual({ kind: 'focus', index: 5 })
    expect(assetGridKeyAction('ArrowUp', 1, 6, 2)).toEqual({ kind: 'focus', index: 0 })
    expect(assetGridKeyAction('ArrowDown', 4, 6, 2)).toEqual({ kind: 'focus', index: 5 })
  })

  it('jumps to the ends of the page', () => {
    expect(assetGridKeyAction('Home', 4, 6, 2)).toEqual({ kind: 'focus', index: 0 })
    expect(assetGridKeyAction('End', 1, 6, 2)).toEqual({ kind: 'focus', index: 5 })
  })

  it('reads the shortcuts for favourite and search', () => {
    expect(assetGridKeyAction('.', 0, 6, 2)).toEqual({ kind: 'favorite' })
    expect(assetGridKeyAction('/', 0, 6, 2)).toEqual({ kind: 'search' })
    // They must work on an empty page too: nothing to move to, still something
    // to search for.
    expect(assetGridKeyAction('/', 0, 0, 2)).toEqual({ kind: 'search' })
  })

  it('leaves unrelated keys to their owners', () => {
    expect(assetGridKeyAction('Enter', 0, 6, 2)).toBeUndefined()
    expect(assetGridKeyAction('a', 0, 6, 2)).toBeUndefined()
    expect(assetGridKeyAction('ArrowDown', 0, 0, 2)).toBeUndefined()
  })

  it('survives a degenerate column count', () => {
    expect(assetGridKeyAction('ArrowDown', 0, 4, 0)).toEqual({ kind: 'focus', index: 1 })
    expect(assetGridKeyAction('ArrowDown', 0, 4, Number.NaN)).toEqual({ kind: 'focus', index: 1 })
  })

  it('keeps exactly one tab stop and resumes at the selected tile', () => {
    expect(rovingTabIndex(2, -1, 6)).toBe(2)
    expect(rovingTabIndex(-1, 3, 6)).toBe(3)
    expect(rovingTabIndex(-1, -1, 6)).toBe(0)
    // A page that shrank under the cursor must not leave the grid unreachable.
    expect(rovingTabIndex(9, -1, 6)).toBe(0)
    expect(rovingTabIndex(9, 4, 6)).toBe(4)
    expect(rovingTabIndex(0, 0, 0)).toBe(-1)
  })

  it('steps the viewer through the page and stops at both ends', () => {
    const ids = ['a', 'b', 'c']
    expect(adjacentAssetId(ids, 'a', 1)).toBe('b')
    expect(adjacentAssetId(ids, 'c', -1)).toBe('b')
    expect(adjacentAssetId(ids, 'a', -1)).toBeNull()
    expect(adjacentAssetId(ids, 'c', 1)).toBeNull()
    expect(adjacentAssetId(ids, 'missing', 1)).toBeNull()
    expect(adjacentAssetId(ids, null, 1)).toBeNull()
  })
})
