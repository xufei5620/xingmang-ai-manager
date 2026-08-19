import { describe, expect, it } from 'vitest'
import { assetEmptyState } from './asset-empty-state'

const base = { search: '', tag: undefined, mediaType: 'all', source: 'all', view: 'all' } as const

describe('asset empty state', () => {
  it('offers importing when the library itself is empty', () => {
    const state = assetEmptyState({ ...base })
    expect(state.reason).toBe('library')
    expect(state.kind).toBe('import')
  })

  it('offers clearing the search that matched nothing', () => {
    const state = assetEmptyState({ ...base, search: '主视觉' })
    expect(state.reason).toBe('search')
    expect(state.kind).toBe('clear-search')
    // The term is quoted back so it is obvious which one matched nothing.
    expect(state.title).toContain('主视觉')
  })

  it('names the filter that excluded everything', () => {
    expect(assetEmptyState({ ...base, tag: '海报' })).toMatchObject({ reason: 'filters', kind: 'clear-filters' })
    expect(assetEmptyState({ ...base, tag: '海报' }).description).toContain('海报')
    expect(assetEmptyState({ ...base, mediaType: 'video' }).description).toContain('视频')
    expect(assetEmptyState({ ...base, source: 'imported' }).description).toContain('本地导入')
  })

  it('explains how to fill the favourite and recent views', () => {
    const favorite = assetEmptyState({ ...base, view: 'favorites' })
    expect(favorite).toMatchObject({ reason: 'favorite', kind: 'show-all' })
    const recent = assetEmptyState({ ...base, view: 'recent' })
    expect(recent).toMatchObject({ reason: 'recent', kind: 'show-all' })
    // Neither offers importing: an import lands in "all", so the view the user
    // is looking at would still be empty afterwards.
    expect(favorite.kind).not.toBe('import')
    expect(recent.kind).not.toBe('import')
  })

  it('resolves the most recent thing the user did first', () => {
    // Searching inside favourites with a tag on: the search is the newest and
    // cheapest thing to undo, so it is the one offered.
    expect(assetEmptyState({ ...base, view: 'favorites', tag: '海报', search: 'x' }).reason).toBe('search')
    expect(assetEmptyState({ ...base, view: 'favorites', tag: '海报' }).reason).toBe('filters')
    expect(assetEmptyState({ ...base, view: 'favorites' }).reason).toBe('favorite')
  })

  it('ignores a search of nothing but whitespace', () => {
    expect(assetEmptyState({ ...base, search: '   ' }).reason).toBe('library')
  })

  it('always gives the empty grid exactly one next step', () => {
    const queries: Parameters<typeof assetEmptyState>[0][] = [
      { ...base },
      { ...base, search: 'x' },
      { ...base, tag: 't' },
      { ...base, mediaType: 'audio' as const },
      { ...base, source: 'generated' as const },
      { ...base, view: 'favorites' as const },
      { ...base, view: 'recent' as const },
    ]
    for (const query of queries) {
      const state = assetEmptyState(query)
      expect(state.label.length).toBeGreaterThan(0)
      expect(state.description.length).toBeGreaterThan(0)
      expect(state.title).not.toBe('没有符合条件的本地资产')
    }
  })
})
