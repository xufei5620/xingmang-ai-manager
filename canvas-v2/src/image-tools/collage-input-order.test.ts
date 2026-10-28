import { describe, expect, it } from 'vitest'
import { collageInputOrderFromSlots, moveCollageInput, orderCollageInputs, parseImageCollageInputOrder, resolveCollageInputSlots } from './collage-input-order'

function slot(edgeId: string, outputIndex = 0) { return { edgeId, outputIndex } }
function reference(edgeId: string, status = 'ready') { return { edgeId, status, kind: 'image', label: edgeId } }

describe('collage input identities', () => {
  it('uses the old complete input order when the field is absent', () => {
    const inputs = [slot('batch', 0), slot('batch', 1), slot('same-asset-second-edge')]
    expect(orderCollageInputs(inputs, undefined)).toEqual(inputs)
  })
  it('retains batch identities and appends every newly expanded output without deduplicating assets', () => {
    const inputs = [...Array.from({ length: 16 }, (_, index) => ({ ...slot('batch', index), assetId: 'same' })), { ...slot('single'), assetId: 'same' }]
    const order = collageInputOrderFromSlots([slot('batch', 8), slot('single'), ...Array.from({ length: 8 }, (_, index) => slot('batch', index))])
    const sorted = orderCollageInputs(inputs, order)
    expect(sorted.map((input) => [input.edgeId, input.outputIndex])).toEqual([['batch', 8], ['single', 0], ...Array.from({ length: 8 }, (_, index) => ['batch', index]), ...Array.from({ length: 7 }, (_, index) => ['batch', index + 9])])
    expect(sorted).toHaveLength(17)
    expect(inputs[0].outputIndex).toBe(0)
  })
  it('keeps waiting batch positions but prunes known shrinkage and deleted edges', () => {
    const order = collageInputOrderFromSlots([slot('batch', 2), slot('single'), slot('batch', 0), slot('batch', 1)])
    const waiting = resolveCollageInputSlots([reference('batch', 'waiting'), reference('single')], order)
    expect(waiting.map(({ edgeId, outputIndex, pending }) => [edgeId, outputIndex, pending])).toEqual([['batch', 2, true], ['single', 0, false], ['batch', 0, true], ['batch', 1, true]])
    expect(resolveCollageInputSlots([reference('batch'), reference('single')], order).map(({ edgeId, outputIndex }) => slot(edgeId, outputIndex))).toEqual([slot('single'), slot('batch')])
    expect(resolveCollageInputSlots([reference('single')], order).map(({ edgeId }) => edgeId)).toEqual(['single'])
  })
  it('keeps twenty positions and rejects overflow or duplicate identities', () => {
    const slots = Array.from({ length: 20 }, (_, index) => slot('batch', index))
    expect(parseImageCollageInputOrder({ version: 1, slots })).toEqual({ version: 1, slots })
    expect(() => parseImageCollageInputOrder({ version: 1, slots: [...slots, slot('other')] })).toThrow('20')
    expect(() => parseImageCollageInputOrder({ version: 1, slots: [slot('same'), slot('same')] })).toThrow('重复')
  })
  it.each([null, { version: 2, slots: [] }, { version: 1, slots: [slot('a', -1)] }, { version: 1, slots: [slot('a', 20)] }, { version: 1, slots: [slot('a\n')] }, { version: 1, slots: [slot('a', 1.2)] }])('rejects malformed identities %j', (value) => {
    expect(() => parseImageCollageInputOrder(value)).toThrow()
  })
  it('whitelists identity metadata and handles reorder boundaries without mutation', () => {
    expect(parseImageCollageInputOrder({ version: 1, slots: [{ ...slot('a'), assetId: 'private' }], token: 'secret' })).toEqual({ version: 1, slots: [slot('a')] })
    const items = ['a', 'b', 'c']
    expect(moveCollageInput(items, 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveCollageInput(items, 0, -1)).toEqual(items)
    expect(moveCollageInput(items, 0, 3)).toEqual(items)
    expect(items).toEqual(['a', 'b', 'c'])
  })
})
