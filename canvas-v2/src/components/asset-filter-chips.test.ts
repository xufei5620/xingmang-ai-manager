import { describe, expect, it } from 'vitest'
import { activeAssetFilterCount, activeAssetFilters, defaultAssetSort } from './asset-filter-chips'

const base = { search: '', tag: '', mediaType: 'all', source: 'all', sort: defaultAssetSort, view: 'all' } as const

describe('asset filter chips', () => {
  it('shows nothing when nothing is filtering', () => {
    expect(activeAssetFilters({ ...base })).toEqual([])
    expect(activeAssetFilterCount({ ...base })).toBe(0)
  })

  it('names every active filter and carries the patch that removes it', () => {
    const chips = activeAssetFilters({
      ...base, search: '主视觉', tag: '海报', mediaType: 'video', source: 'imported', sort: 'name-asc',
    })
    expect(chips.map((chip) => chip.id)).toEqual(['search', 'tag', 'mediaType', 'source', 'sort'])
    expect(chips.map((chip) => chip.patch)).toEqual([
      { search: '' }, { tag: '' }, { mediaType: 'all' }, { source: 'all' }, { sort: defaultAssetSort },
    ])
    expect(chips[0]?.label).toContain('主视觉')
    expect(chips[2]?.label).toBe('视频')
  })

  it('does not offer to remove the sort the recent view depends on', () => {
    // Recent is defined by "most recently used"; taking that sort off would
    // break the view the user is looking at rather than widen it.
    expect(activeAssetFilters({ ...base, view: 'recent', sort: 'used-desc' })).toEqual([])
    expect(activeAssetFilters({ ...base, view: 'all', sort: 'used-desc' }).map((chip) => chip.id)).toEqual(['sort'])
  })

  it('ignores defaults and whitespace', () => {
    expect(activeAssetFilterCount({ ...base, search: '   ' })).toBe(0)
    expect(activeAssetFilterCount({ ...base, sort: defaultAssetSort })).toBe(0)
    expect(activeAssetFilterCount({ ...base, mediaType: 'all', source: 'all', tag: '' })).toBe(0)
  })

  it('counts what the collapsed button has to disclose', () => {
    expect(activeAssetFilterCount({ ...base, mediaType: 'image' })).toBe(1)
    expect(activeAssetFilterCount({ ...base, mediaType: 'image', source: 'generated' })).toBe(2)
  })
})
