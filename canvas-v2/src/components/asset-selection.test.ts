import { describe, expect, it } from 'vitest'
import { assetSelectionAfterKey, retainedAssetSelection, toggleAssetSelection } from './asset-selection'

describe('toggleAssetSelection', () => {
  it('opens a closed tile and closes the open one', () => {
    expect(toggleAssetSelection(null, 'a')).toBe('a')
    expect(toggleAssetSelection('b', 'a')).toBe('a')
    expect(toggleAssetSelection('a', 'a')).toBeNull()
  })
})

describe('assetSelectionAfterKey', () => {
  it('treats Enter and Space as activation', () => {
    expect(assetSelectionAfterKey('Enter', null, 'a')).toBe('a')
    expect(assetSelectionAfterKey(' ', 'a', 'a')).toBeNull()
  })

  it('closes the open tile on Escape', () => {
    expect(assetSelectionAfterKey('Escape', 'a', 'a')).toBeNull()
  })

  it('leaves Escape to the surrounding dialog when nothing is open', () => {
    expect(assetSelectionAfterKey('Escape', null, 'a')).toBeUndefined()
  })

  it('ignores keys that are not selection keys', () => {
    expect(assetSelectionAfterKey('Tab', 'a', 'a')).toBeUndefined()
    expect(assetSelectionAfterKey('ArrowDown', null, 'a')).toBeUndefined()
  })
})

describe('retainedAssetSelection', () => {
  it('keeps the selection while its asset is on the page', () => {
    expect(retainedAssetSelection('a', ['a', 'b'])).toBe('a')
  })

  it('drops a selection whose asset left the page', () => {
    expect(retainedAssetSelection('a', ['b'])).toBeNull()
    expect(retainedAssetSelection('a', [])).toBeNull()
  })
})
