import { describe, expect, it } from 'vitest'
import { orderImageReferenceInputs, parseImageReferenceOrder, parseNodeImageReferenceOrder, remapImageReferenceOrderSettings, resolveImageReferenceSlots, type ImageReferenceOrder } from './image-reference-order'

const order: ImageReferenceOrder = { version: 1, slots: [{ role: 'source', edgeId: 'second-edge', outputIndex: 0 }, { role: 'reference', edgeId: 'first-edge', outputIndex: 2 }] }
describe('explicit image source roles and durable missing slots', () => {
  it('orders by graph identity rather than edge enumeration and keeps selected batch indexes', () => {
    const first = { edgeId: 'first-edge', outputIndex: 2, assetId: 'ref' }, second = { edgeId: 'second-edge', outputIndex: 0, assetId: 'base' }
    expect(orderImageReferenceInputs([first, second], order, ['first-edge', 'second-edge'])).toEqual([second, first])
    expect(parseNodeImageReferenceOrder('text-generate', order)).toEqual(order)
  })
  it('retains explicit descriptor indexes when an upstream intermediate batch item is absent', () => {
    const refs = [{ edgeId: 'first-edge', outputIndex: 0, kind: 'image', status: 'ready', assetId: 'zero' }, { edgeId: 'first-edge', outputIndex: 2, kind: 'image', status: 'ready', assetId: 'two' }, { edgeId: 'second-edge', outputIndex: 0, kind: 'image', status: 'ready', assetId: 'base' }]
    expect(resolveImageReferenceSlots(refs, order)[1].reference?.assetId).toBe('two')
    expect(resolveImageReferenceSlots(refs.filter((ref) => ref.outputIndex !== 2), order)[1]).toMatchObject({ missing: true })
  })
  it('blocks missing slots, unassigned incoming edges and duplicate resolved assets instead of falling back', () => {
    const inputs = [{ edgeId: 'first-edge', outputIndex: 2, assetId: 'same' }, { edgeId: 'second-edge', outputIndex: 0, assetId: 'same' }]
    expect(() => orderImageReferenceInputs(inputs, order)).toThrow('不同的实际图片')
    expect(() => orderImageReferenceInputs([], order)).toThrow('失联')
    expect(() => orderImageReferenceInputs(inputs, order, ['third'])).toThrow('尚未分配')
    const missing = remapImageReferenceOrderSettings({ imageReferenceOrder: order }, new Map())?.imageReferenceOrder as ImageReferenceOrder
    expect(missing.slots).toEqual([{ role: 'source', missing: true }, { role: 'reference', missing: true }])
    expect(() => orderImageReferenceInputs(inputs, missing)).toThrow('失联')
  })
  it('remaps internal edges while preserving external dependencies as tombstones', () => {
    expect(remapImageReferenceOrderSettings({ imageReferenceOrder: order }, new Map([['second-edge', 'new-base']]))).toEqual({ imageReferenceOrder: { version: 1, slots: [{ role: 'source', edgeId: 'new-base', outputIndex: 0 }, { role: 'reference', missing: true }] } })
  })
  it.each([null, { version: 2, slots: [] }, { version: 1, slots: [] }, { version: 1, slots: [{ role: 'reference', missing: true }] }, { version: 1, slots: [{ role: 'source', missing: true, edgeId: 'x' }] }, { version: 1, slots: [{ role: 'source', edgeId: 'e', outputIndex: 20 }] }, { version: 1, slots: [{ role: 'source', edgeId: 'e', outputIndex: 0 }, { role: 'reference', edgeId: 'e', outputIndex: 0 }] }])('rejects malformed role identities %#', (value) => {
    expect(() => parseImageReferenceOrder(value)).toThrow()
  })
})
