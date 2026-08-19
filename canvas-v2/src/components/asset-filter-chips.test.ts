import { describe, expect, it } from 'vitest'
import { activeAssetFilterCount, activeAssetFilters, defaultAssetSort } from './asset-filter-chips'

const base = { search: '', tag: '', mediaType: 'all', source: 'all', sort: defaultAssetSort, view: 'all' } as const

describe('activeAssetFilters find-similar chips', () => {
  it('shows and removes the three find-similar filters', () => {
    // Without a chip the library looks like it lost most of its contents: this
    // filter is set from a button in the detail panel, not from the popover.
    const prompt = activeAssetFilters({ ...base, prompt: '一只在雨里的橘猫，霓虹灯背景，胶片颗粒感，超高细节' })
    expect(prompt).toHaveLength(1)
    expect(prompt[0]?.id).toBe('prompt')
    expect(prompt[0]?.label).toContain('…')
    expect(prompt[0]?.patch).toEqual({ prompt: undefined })

    expect(activeAssetFilters({ ...base, runId: 'run-1' })).toEqual([
      { id: 'runId', label: '同一次运行', patch: { runId: undefined } },
    ])
    expect(activeAssetFilters({ ...base, nodeId: 'node-7' })).toEqual([
      { id: 'nodeId', label: '同来源节点：node-7', patch: { nodeId: undefined } },
    ])
    expect(activeAssetFilterCount({ ...base, prompt: '猫', runId: 'run-1', mediaType: 'image' })).toBe(3)
  })
})

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
