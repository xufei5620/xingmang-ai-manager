import { describe, expect, it } from 'vitest'
import { changeCompareParallelCount, changeCompareSelection, compareSliderPosition, compareStageAspectRatio, compareViewSelections, createCompareViewState, resolveCompareSlot, type CompareImageSlot } from './compare-view-state'

function slots(): CompareImageSlot[] {
  return [0, 1, 2, 3, 4].map((index) => ({ key: String(index), label: `图片 ${index}`, asset: { kind: 'image', localUrl: `xingmang-asset://image/${String(index).repeat(43)}` }, dimensions: { width: 400, height: 300 } }))
}

describe('controlled image comparison state', () => {
  it('initializes two comparisons and four grid slots once in actual input order', () => {
    expect(createCompareViewState(slots())).toEqual({ mode: 'slider', position: 50, a: '0', b: '1', grid: ['0', '1', '2', '3'] })
    expect(createCompareViewState(slots().slice(0, 1), 'grid')).toEqual({ mode: 'grid', position: 50, a: '0', b: null, grid: ['0', null, null, null] })
  })

  it('preserves empty selections and missing identities without choosing another input', () => {
    const source = slots(), view = { ...createCompareViewState(source), a: 'missing:old', b: null }
    expect(compareViewSelections(view)).toEqual(['missing:old', null])
    expect(resolveCompareSlot(source, view.a)).toMatchObject({ key: 'missing:old', status: 'missing' })
    expect(resolveCompareSlot(source, view.b)).toMatchObject({ key: null, status: 'empty' })
    expect(view.a).toBe('missing:old')
  })

  it('keeps an unfinished middle source in place and resolves its result without shifting later inputs', () => {
    const source = slots(), view = createCompareViewState(source)
    source[1] = { ...source[1], asset: undefined }
    expect(resolveCompareSlot(source, view.b)).toMatchObject({ key: '1', status: 'waiting', slot: { label: '图片 1' } })
    expect(resolveCompareSlot(source, view.grid[2])).toMatchObject({ key: '2', status: 'ready' })
    source[1] = slots()[1]
    expect(resolveCompareSlot(source, view.b)).toMatchObject({ key: '1', status: 'ready' })
  })

  it('changes one selected slot without reordering or mutating the source collection', () => {
    const source = slots(), before = structuredClone(source), original = createCompareViewState(source)
    const next = changeCompareSelection(original, 2, '4')
    expect(next.grid).toEqual(['0', '1', '4', '3'])
    expect(next.a).toBe('0')
    expect(original.grid).toEqual(['0', '1', '2', '3'])
    expect(source).toEqual(before)
    expect(changeCompareSelection(next, 2, '4')).toBe(next)
    expect(changeCompareSelection(next, 'a', '0')).toBe(next)
  })

  it('keeps per-mode choices while switching among slider, side-by-side and grid', () => {
    const initial = { ...createCompareViewState(slots()), a: '3', b: '2', position: 84, grid: ['4', '3', null, '1'] }
    expect(compareViewSelections({ ...initial, mode: 'side-by-side' })).toEqual(['3', '2'])
    expect(compareViewSelections({ ...initial, mode: 'grid' })).toEqual(['4', '3', null, '1'])
    expect(compareViewSelections({ ...initial, mode: 'slider' })).toEqual(['3', '2'])
    expect(initial.position).toBe(84)
  })

  it('caps rendered grid slots at four and preserves explicit empty slots', () => {
    const view = { ...createCompareViewState(slots(), 'grid'), grid: [null, '3', '4', 'missing', '0'] }
    expect(compareViewSelections(view)).toEqual([null, '3', '4', 'missing'])
    expect(changeCompareSelection(view, 0, '2').grid).toEqual(['2', '3', '4', 'missing'])
  })

  it('opts into a third parallel slot without changing legacy two-image behavior', () => {
    const source = slots(), original = createCompareViewState(source, 'side-by-side')
    expect(compareViewSelections(original)).toEqual(['0', '1'])
    expect(changeCompareParallelCount(original, 2, source)).toBe(original)
    const three = changeCompareParallelCount(original, 3, source)
    expect(three).toEqual({ ...original, sideBySideCount: 3, c: '2' })
    expect(compareViewSelections(three)).toEqual(['0', '1', '2'])
    expect(compareViewSelections({ ...three, mode: 'slider' })).toEqual(['0', '1'])
    expect(compareViewSelections({ ...three, mode: 'grid' })).toEqual(original.grid)
  })

  it.each([null, 'missing', '4'])('keeps an explicit third selection %s across two/three toggles', (c) => {
    const source = slots(), original = { ...createCompareViewState(source, 'side-by-side'), c }
    const three = changeCompareParallelCount(original, 3, source)
    expect(three.c).toBe(c)
    const two = changeCompareParallelCount(three, 2, source)
    expect(two.c).toBe(c)
    expect(changeCompareParallelCount(two, 3, source).c).toBe(c)
    const next = changeCompareSelection(three, 'c', '0')
    expect(next).toEqual({ ...three, c: '0' })
    expect(original.c).toBe(c)
  })

  it('leaves the third slot explicitly empty if enabled without a third input', () => {
    const source = slots().slice(0, 2), original = createCompareViewState(source, 'side-by-side')
    const three = changeCompareParallelCount(original, 3, source)
    expect(three.c).toBeNull()
    expect(compareViewSelections(three)).toEqual(['0', '1', null])
    expect(changeCompareParallelCount(three, 3, slots())).toBe(three)
  })

  it.each([[-10, 0], [130, 100], [23.75, 23.75], [Number.NaN, 50]])('bounds slider position %s to %s', (input, expected) => {
    expect(compareSliderPosition(input)).toBe(expected)
  })

  it('uses displayed orientation dimensions without stretching the first comparison', () => {
    const source = slots()
    source[0].dimensions = { width: 400, height: 600 }
    expect(compareStageAspectRatio(resolveCompareSlot(source, '0'))).toBe(2 / 3)
    source[0].dimensions.height = 0
    expect(compareStageAspectRatio(resolveCompareSlot(source, '0'))).toBe(4 / 3)
    expect(compareStageAspectRatio(resolveCompareSlot(source, 'missing'))).toBe(4 / 3)
  })
})
