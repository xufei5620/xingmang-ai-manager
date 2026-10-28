import { describe, expect, it } from 'vitest'
import { buildCompareInputSlots, parseImageCompareSettings, persistImageCompareView, portableImageCompareSettings, remapImageCompareSettings, resolveCompareInputReferences, resolveImageCompareView } from './viewer-settings'

const slots = buildCompareInputSlots([{ edgeId: 'a' }, { edgeId: 'batch' }, { edgeId: 'batch' }, { edgeId: 'd' }])
const settings = { mode: 'grid' as const, position: 37.5, a: '2', b: '0', grid: ['2', '0', '1', null], inputSlots: slots }

describe('persisted image viewer settings', () => {
  it('keeps a saved sixth occurrence waiting and stable when view edits are committed before the batch exists', () => {
    const saved = { mode: 'slider', a: '0', b: '1', inputSlots: ['["batch",5]', '["photo",0]'] }
    const references = [{ edgeId: 'batch', batch: true, outputIndex: 0, status: 'waiting' }, { edgeId: 'photo', batch: false, outputIndex: 0, status: 'ready' }]
    const before = structuredClone(references)
    const current = resolveCompareInputReferences(references, saved)
    expect(current.map((slot) => slot.identity)).toEqual(['["batch",0]', '["photo",0]', '["batch",5]'])
    expect(current[2]).toMatchObject({ placeholder: true, outputIndex: 5, reference: references[0] })
    const identities = current.map((slot) => slot.identity)
    const view = resolveImageCompareView(saved, identities)
    expect(view).toMatchObject({ a: '2', b: '1' })
    const committed = persistImageCompareView({ ...view, position: 75 }, identities)
    const produced = buildCompareInputSlots([...Array.from({ length: 6 }, () => ({ edgeId: 'batch' })), { edgeId: 'photo' }])
    expect(resolveImageCompareView(committed, produced)).toMatchObject({ a: '5', b: '6', position: 75 })
    expect(references).toEqual(before)
  })

  it('never invents waiting images for disconnected, single-image or completed shorter batches', () => {
    const saved = { mode: 'slider', a: '0', inputSlots: ['["batch",5]'] }
    for (const references of [[], [{ edgeId: 'batch', status: 'waiting', batch: false }], [{ edgeId: 'batch', status: 'ready', batch: true }], [{ edgeId: 'batch', status: 'waiting', batch: true, batchSize: 3 }]]) {
      const current = resolveCompareInputReferences(references, saved)
      expect(current.some((slot) => slot.placeholder)).toBe(false)
      expect(resolveImageCompareView(saved, current.map((slot) => slot.identity)).a).toBe('missing')
    }
    expect(() => resolveCompareInputReferences(Array.from({ length: 200 }, (_, index) => ({ edgeId: `edge-${index}`, status: 'waiting', batch: true })), { mode: 'slider', inputSlots: ['["edge-0",5]'] })).toThrow('200')
  })

  it('preserves legacy mode-only canonical settings and supplies display defaults separately', () => {
    expect(parseImageCompareSettings({ mode: 'grid' })).toEqual({ mode: 'grid' })
    expect(resolveImageCompareView({ mode: 'grid' }, slots)).toEqual({ mode: 'grid', position: 50, a: '0', b: '1', c: '2', sideBySideCount: 2, opacity: 50, overlayVisible: true, grid: ['0', '1', '2', '3'] })
    expect(resolveImageCompareView(undefined, [])).toEqual({ mode: 'slider', position: 50, a: null, b: null, c: null, sideBySideCount: 2, opacity: 50, overlayVisible: true, grid: [null, null, null, null] })
  })

  it.each(['opacity', 'toggle'] as const)('preserves mode-only %s settings without injecting defaults into storage', (mode) => {
    expect(parseImageCompareSettings({ mode })).toEqual({ mode })
    expect(portableImageCompareSettings({ mode })).toEqual({ mode })
    expect(resolveImageCompareView({ mode }, slots)).toMatchObject({ mode, opacity: 50, overlayVisible: true })
  })

  it('keeps opacity independent of the slider and preserves explicit zero and hidden overlay across remaps', () => {
    const original = { ...settings, mode: 'opacity' as const, opacity: 0, overlayVisible: false }
    const view = resolveImageCompareView(original, slots)
    expect(view).toMatchObject({ position: 37.5, opacity: 0, overlayVisible: false })
    const saved = persistImageCompareView(view, slots)
    const mapped = remapImageCompareSettings(saved, new Map([['batch', 'new-batch']]))
    const next = buildCompareInputSlots([{ edgeId: 'new-batch' }, { edgeId: 'new-batch' }])
    expect(resolveImageCompareView(mapped, next)).toMatchObject({ a: '1', b: 'missing', position: 37.5, opacity: 0, overlayVisible: false })
    expect(portableImageCompareSettings(mapped)).toMatchObject({ mode: 'opacity', opacity: 0, overlayVisible: false })
    expect(parseImageCompareSettings({ mode: 'toggle', opacity: 100, overlayVisible: true })).toEqual({ mode: 'toggle', opacity: 100, overlayVisible: true })
  })

  it('defaults an absent third choice once while keeping explicit empty and missing choices', () => {
    expect(parseImageCompareSettings({ mode: 'side-by-side' })).toEqual({ mode: 'side-by-side' })
    expect(resolveImageCompareView({ mode: 'side-by-side', sideBySideCount: 3 }, slots)).toMatchObject({ c: '2', sideBySideCount: 3 })
    for (const c of [null, 'missing'] as const) {
      const view = resolveImageCompareView({ mode: 'side-by-side', c, sideBySideCount: 3 }, slots)
      expect(view.c).toBe(c)
      expect(resolveImageCompareView(persistImageCompareView(view, slots), slots).c).toBe(c)
    }
  })

  it('tracks the third batch occurrence across removals and reordering without selecting a replacement', () => {
    const original = { ...settings, mode: 'side-by-side' as const, c: '2', sideBySideCount: 3 as const }
    const reordered = [slots[3], slots[2], slots[1]]
    expect(resolveImageCompareView(original, reordered)).toMatchObject({ c: '1', sideBySideCount: 3 })
    const removed = [slots[0], slots[1], slots[3]]
    const view = resolveImageCompareView(original, removed)
    expect(view.c).toBe('missing')
    expect(resolveImageCompareView(persistImageCompareView(view, removed), slots).c).toBe('missing')
  })

  it('remaps and exports third choices with the same identity and portable-index rules as A and B', () => {
    const original = { ...settings, mode: 'side-by-side' as const, c: '2', sideBySideCount: 3 as const }
    const mapped = remapImageCompareSettings(original, new Map([['batch', 'new-batch']]))
    expect(resolveImageCompareView(mapped, buildCompareInputSlots([{ edgeId: 'new-batch' }, { edgeId: 'new-batch' }])).c).toBe('1')
    expect(portableImageCompareSettings(mapped)).toEqual({ mode: 'side-by-side', position: 37.5, a: '2', b: '0', c: '2', sideBySideCount: 3, grid: ['2', '0', '1', null] })
    expect(parseImageCompareSettings({ mode: 'side-by-side', c: '199', sideBySideCount: 2 })).toEqual({ mode: 'side-by-side', c: '199', sideBySideCount: 2 })
  })

  it('keeps an occurrence within the same batch and a repeated source edge distinct', () => {
    expect(slots).toEqual(['["a",0]', '["batch",0]', '["batch",1]', '["d",0]'])
    expect(buildCompareInputSlots([{ edgeId: 'a#0' }, { edgeId: 'a' }])).toEqual(['["a#0",0]', '["a",0]'])
    const current = buildCompareInputSlots([{ edgeId: 'batch' }, { edgeId: 'batch' }, { edgeId: 'd' }])
    expect(resolveImageCompareView(settings, current)).toMatchObject({ a: '1', b: 'missing', grid: ['1', 'missing', '0', null] })
  })

  it('never retargets a removed source to an unrelated new input at the same index', () => {
    const current = buildCompareInputSlots([{ edgeId: 'replacement' }, { edgeId: 'batch' }, { edgeId: 'batch' }, { edgeId: 'd' }])
    const resolved = resolveImageCompareView(settings, current)
    expect(resolved.b).toBe('missing')
    const saved = persistImageCompareView(resolved, current)
    expect(resolveImageCompareView(saved, slots).b).toBe('missing')
    expect(saved.inputSlots).not.toBe(current)
  })

  it('keeps null unselected and portable numeric positions independently of private identities', () => {
    const portable = portableImageCompareSettings(settings)
    expect(portable).toEqual({ mode: 'grid', position: 37.5, a: '2', b: '0', grid: ['2', '0', '1', null] })
    expect(resolveImageCompareView(portable, slots)).toMatchObject({ a: '2', b: '0' })
    expect(parseImageCompareSettings({ mode: 'slider', a: '199', b: 'missing' })).toMatchObject({ a: '199', b: 'missing' })
  })

  it('remaps only copied edge identities and preserves disconnected identities as missing', () => {
    const mapped = remapImageCompareSettings(settings, new Map([['batch', 'new-batch'], ['d', 'new-d']]))
    expect(mapped.inputSlots).toEqual(['["a",0]', '["new-batch",0]', '["new-batch",1]', '["new-d",0]'])
    expect(resolveImageCompareView(mapped, buildCompareInputSlots([{ edgeId: 'new-batch' }, { edgeId: 'new-batch' }, { edgeId: 'new-d' }]))).toMatchObject({ a: '1', b: 'missing' })
    expect(settings.inputSlots).toEqual(slots)
  })

  it.each([
    null, [], { mode: ['slider'] }, { mode: 'unknown' }, { mode: 'slider', a: '01' }, { mode: 'slider', a: '-1' },
    { mode: 'slider', a: '200' }, { mode: 'slider', a: 1 }, { mode: 'slider', position: Infinity }, { mode: 'slider', position: -1 },
    { mode: 'grid', grid: [] }, { mode: 'slider', sourceUrl: 'https://private.invalid' },
    { mode: 'slider', inputSlots: ['not-json'] }, { mode: 'slider', inputSlots: ['["a",0]', '["a",0]'] },
    { mode: 'slider', inputSlots: ['["a",200]'] }, { mode: 'slider', inputSlots: ['["a", 0]'] },
    { mode: 'side-by-side', c: '200' }, { mode: 'side-by-side', c: 2 }, { mode: 'side-by-side', c: '02' },
    { mode: 'side-by-side', sideBySideCount: '3' }, { mode: 'side-by-side', sideBySideCount: null },
    { mode: 'side-by-side', sideBySideCount: 1 }, { mode: 'side-by-side', sideBySideCount: 4 },
    { mode: 'side-by-side', sideBySideCount: NaN }, { mode: 'side-by-side', sideBySideCount: 2.5 },
    { mode: 'opacity', opacity: null }, { mode: 'opacity', opacity: '50' }, { mode: 'opacity', opacity: NaN },
    { mode: 'opacity', opacity: -1 }, { mode: 'opacity', opacity: 101 }, { mode: 'opacity', opacity: Infinity },
    { mode: 'toggle', overlayVisible: null }, { mode: 'toggle', overlayVisible: 0 }, { mode: 'toggle', overlayVisible: 'false' },
  ])('rejects malformed settings %#', (value) => {
    expect(() => parseImageCompareSettings(value)).toThrow()
  })

  it('bounds private input identities without silently truncating or renumbering', () => {
    const inputs = Array.from({ length: 200 }, (_, index) => ({ edgeId: `edge-${index}` }))
    expect(buildCompareInputSlots(inputs)).toHaveLength(200)
    expect(() => buildCompareInputSlots([...inputs, { edgeId: 'extra' }])).toThrow('200')
  })
})
