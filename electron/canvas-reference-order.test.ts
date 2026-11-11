import { describe, expect, it } from 'vitest'
import {
  imageReferenceRolePrompt,
  orderImageReferenceInputs,
  parseImageReferenceOrder,
  parseNodeImageReferenceOrder,
} from '../canvas-v2/src/commerce/image-reference-order'
import { assertImageReferenceRunConfiguration } from '../canvas-v2/src/commerce/image-task-configuration'
import {
  assertVideoReferenceSlots,
  orderVideoReferences,
  parseVideoReferenceOrder,
} from '../canvas-v2/src/video-tools/video-reference-order'
import {
  assertCanvasImageReferenceRunConfiguration,
  assertCanvasVideoReferenceSlots,
  canvasImageReferenceRolePrompt,
  orderCanvasImageReferenceInputs,
  orderCanvasVideoReferences,
  parseCanvasImageReferenceOrder,
  parseCanvasNodeImageReferenceOrder,
  parseCanvasVideoReferenceOrder,
} from './canvas-reference-order'
import type { CanvasImageReferenceOrder, CanvasRunGraph, CanvasRunGraphNode, CanvasVideoReferenceOrder } from './canvas-run-contract'

type Outcome = { value: unknown } | { error: string }

function outcome(action: () => unknown): Outcome {
  try {
    return { value: action() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

// Deterministic, so a failing case can be replayed from its seed.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)]
}

function randomEdgeId(random: () => number): unknown {
  return random() < 0.9 ? pick(random, ['e1', 'e2', 'e3', 'e4', 'x'.repeat(256)]) : pick(random, ['', 'x'.repeat(257), 'bad\u0001id', 7])
}

function randomOutputIndex(random: () => number): unknown {
  return random() < 0.9 ? pick(random, [0, 0, 1, 3, 19]) : pick(random, [20, -1, 1.5, '0'])
}

// Shapes the kernel writes, near misses of them and plain garbage.
function randomSlot(random: () => number, index: number): unknown {
  const role = random() < 0.95 ? (index === 0 ? 'source' : 'reference') : pick(random, ['source', 'reference', 'other', undefined])
  const roll = random()
  if (roll < 0.12) return { role, missing: true }
  if (roll < 0.14) return { role, missing: true, edgeId: 'e1' }
  if (roll < 0.16) return pick(random, [null, 'slot', 3, ['e1', 0]])
  const slot: Record<string, unknown> = { role, edgeId: randomEdgeId(random), outputIndex: randomOutputIndex(random) }
  if (random() < 0.03) delete slot.outputIndex
  if (random() < 0.03) slot.extra = true
  return slot
}

function randomImageOrder(random: () => number): unknown {
  const roll = random()
  if (roll < 0.05) return pick(random, [null, [], 'order', 1])
  const value: Record<string, unknown> = {
    version: random() < 0.97 ? 1 : pick(random, [0, 2, '1']),
    slots: Array.from({ length: random() < 0.9 ? 1 + Math.floor(random() * 4) : pick(random, [0, 5]) }, (_, index) => randomSlot(random, index)),
  }
  if (random() < 0.05) value.url = 'https://evil.test'
  if (random() < 0.03) delete value.slots
  return value
}

function randomVideoOrder(random: () => number): unknown {
  const roll = random()
  if (roll < 0.05) return pick(random, [null, [], 'order'])
  return {
    version: random() < 0.92 ? 1 : 2,
    slots: Array.from({ length: random() < 0.9 ? Math.floor(random() * 6) : 13 }, () => random() < 0.95 ? randomVideoSlot(random) : randomSlot(random, 1)),
  }
}

function randomVideoSlot(random: () => number): unknown {
  if (random() < 0.05) return pick(random, [null, 'slot', ['e1', 0]])
  const slot: Record<string, unknown> = { edgeId: randomEdgeId(random), outputIndex: randomOutputIndex(random) }
  if (random() < 0.02) delete slot.outputIndex
  if (random() < 0.02) slot.kind = 'image'
  return slot
}

describe('canvas reference order', () => {
  it('parses picture roles exactly as the kernel does', () => {
    for (let seed = 0; seed < 4_000; seed += 1) {
      const value = randomImageOrder(seededRandom(seed))
      expect(outcome(() => parseCanvasImageReferenceOrder(structuredClone(value))), `seed ${seed}`)
        .toEqual(outcome(() => parseImageReferenceOrder(structuredClone(value))))
    }
    const order = { version: 1, slots: [{ role: 'source', edgeId: 'e1', outputIndex: 0 }] }
    for (const kind of ['image', 'image-generate', 'image-edit', 'text-generate', 'video-generate', 'image-crop', 'prompt']) {
      expect(outcome(() => parseCanvasNodeImageReferenceOrder(kind, order)), kind).toEqual(outcome(() => parseNodeImageReferenceOrder(kind, order)))
    }
  })

  it('orders the pictures by role, refusing a gone slot, a connection without a role or one picture twice', () => {
    const inputs = [
      { edgeId: 'e1', outputIndex: 0, assetId: 'a1' },
      { edgeId: 'e2', outputIndex: 0, assetId: 'a2' },
      { edgeId: 'e2', outputIndex: 1, assetId: 'a3' },
      { edgeId: 'e3', outputIndex: 0, assetId: 'a1' },
      { edgeId: 'e4', outputIndex: 0 },
    ]
    const orders: unknown[] = [
      { version: 1, slots: [{ role: 'source', edgeId: 'e2', outputIndex: 1 }, { role: 'reference', edgeId: 'e1', outputIndex: 0 }] },
      { version: 1, slots: [{ role: 'source', edgeId: 'e1', outputIndex: 0 }, { role: 'reference', edgeId: 'e3', outputIndex: 0 }] },
      { version: 1, slots: [{ role: 'source', edgeId: 'e1', outputIndex: 0 }, { role: 'reference', missing: true }] },
      { version: 1, slots: [{ role: 'source', edgeId: 'e9', outputIndex: 0 }] },
      { version: 1, slots: [{ role: 'source', edgeId: 'e4', outputIndex: 0 }, { role: 'reference', edgeId: 'e2', outputIndex: 0 }] },
      { version: 1, slots: [{ role: 'source', edgeId: 'e2', outputIndex: 2 }] },
    ]
    const incoming: Array<readonly string[] | undefined> = [undefined, [], ['e1', 'e2'], ['e1', 'e5'], ['e1', 'e2', 'e3', 'e4']]
    for (const [orderIndex, order] of orders.entries()) {
      for (const edges of incoming) {
        const desktop = outcome(() => orderCanvasImageReferenceInputs(inputs, parseCanvasImageReferenceOrder(order), edges))
        const kernel = outcome(() => orderImageReferenceInputs(inputs, parseImageReferenceOrder(order), edges))
        expect(desktop, `order ${orderIndex} edges ${JSON.stringify(edges)}`).toEqual(kernel)
      }
    }
    // The first two read in the order the user put them, not connection order.
    expect(orderCanvasImageReferenceInputs(inputs, parseCanvasImageReferenceOrder(orders[0]), ['e1', 'e2']).map((input) => input.assetId)).toEqual(['a3', 'a1'])
    expect(() => orderCanvasImageReferenceInputs(inputs, parseCanvasImageReferenceOrder(orders[1]))).toThrow('原图和参考图必须是不同的实际图片，请检查重复素材')
    expect(() => orderCanvasImageReferenceInputs(inputs, parseCanvasImageReferenceOrder(orders[3]), ['e1', 'e5'])).toThrow('有新接入的参考图片尚未分配角色')
    expect(() => orderCanvasImageReferenceInputs(inputs, parseCanvasImageReferenceOrder(orders[2]))).toThrow('参考图位置已失联或尚未就绪，请重新绑定；不会改用其他图片')
  })

  it('names each picture role ahead of the prompt exactly as the kernel does', () => {
    const order = { version: 1, slots: [{ role: 'source', edgeId: 'e1', outputIndex: 0 }, { role: 'reference', edgeId: 'e2', outputIndex: 0 }, { role: 'reference', missing: true }] }
    for (const prompt of ['', '换成夜景', '多行\n要求']) {
      expect(canvasImageReferenceRolePrompt(parseCanvasImageReferenceOrder(order), prompt)).toBe(imageReferenceRolePrompt(parseImageReferenceOrder(order), prompt))
    }
    expect(canvasImageReferenceRolePrompt(parseCanvasImageReferenceOrder(order), '换成夜景'))
      .toBe('第 1 张图片：原始主体图。\n第 2 张图片：辅助参考图。\n第 3 张图片：辅助参考图。\n换成夜景')
  })

  it('parses, orders and checks a video reference order exactly as the kernel does', () => {
    for (let seed = 0; seed < 3_000; seed += 1) {
      const value = randomVideoOrder(seededRandom(seed))
      expect(outcome(() => parseCanvasVideoReferenceOrder(structuredClone(value))), `seed ${seed}`)
        .toEqual(outcome(() => parseVideoReferenceOrder(structuredClone(value))))
    }
    const inputs = [
      { edgeId: 'first', outputIndex: 0, asset: 'image-1' },
      { edgeId: 'last', outputIndex: 0, asset: 'image-2' },
      { edgeId: 'sound', outputIndex: 0, asset: 'audio-1' },
      { edgeId: 'grid', outputIndex: 2, asset: 'slice-3' },
    ]
    const orders: Array<CanvasVideoReferenceOrder | undefined> = [
      undefined,
      { version: 1, slots: [] },
      { version: 1, slots: [{ edgeId: 'last', outputIndex: 0 }, { edgeId: 'first', outputIndex: 0 }] },
      { version: 1, slots: [{ edgeId: 'grid', outputIndex: 2 }] },
      { version: 1, slots: [{ edgeId: 'grid', outputIndex: 1 }, { edgeId: 'first', outputIndex: 0 }] },
    ]
    for (const [index, order] of orders.entries()) {
      expect(orderCanvasVideoReferences(inputs, order), `order ${index}`).toEqual(orderVideoReferences(inputs, order))
      expect(outcome(() => assertCanvasVideoReferenceSlots(inputs, order)), `order ${index}`).toEqual(outcome(() => assertVideoReferenceSlots(inputs, order)))
    }
    expect(orderCanvasVideoReferences(inputs, orders[2]).map((input) => input.asset)).toEqual(['image-2', 'image-1', 'audio-1', 'slice-3'])
    expect(() => assertCanvasVideoReferenceSlots(inputs, orders[4])).toThrow('已保存的视频参考位置缺失，请核对首尾帧并重新确认参考顺序；当前不会提交生成')
  })

  it('refuses picture roles that no longer match the connections before a run, as the kernel does', () => {
    const source = { id: 'source', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: 'a'.repeat(43) } } satisfies CanvasRunGraphNode
    const other = { id: 'other', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: 'b'.repeat(43) } } satisfies CanvasRunGraphNode
    const same = { id: 'same', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: 'a'.repeat(43) } } satisfies CanvasRunGraphNode
    const grid = { id: 'grid', kind: 'image-grid-split', definitionVersion: 1, data: { prompt: '', model: '', imageTransform: { kind: 'grid-split', rows: 2, columns: 2, gap: 0, padding: 0 } } } satisfies CanvasRunGraphNode
    const panorama = { id: 'panorama', kind: 'image-panorama', definitionVersion: 1, data: { prompt: '', model: '' } } satisfies CanvasRunGraphNode
    const edges: CanvasRunGraph['edges'] = [
      { id: 'e-source', source: 'source', sourceHandle: 'out:image', target: 'target', targetHandle: 'in:images' },
      { id: 'e-other', source: 'other', sourceHandle: 'out:image', target: 'target', targetHandle: 'in:images' },
      { id: 'e-same', source: 'same', sourceHandle: 'out:image', target: 'target', targetHandle: 'in:images' },
      { id: 'e-grid', source: 'grid', sourceHandle: 'out:images', target: 'target', targetHandle: 'in:images' },
      { id: 'e-panorama', source: 'panorama', sourceHandle: 'out:images', target: 'target', targetHandle: 'in:images' },
      { id: 'e-text', source: 'source', sourceHandle: 'out:text', target: 'target', targetHandle: 'in:images' },
    ]
    const slot = (role: 'source' | 'reference', edgeId: string, outputIndex = 0) => ({ role, edgeId, outputIndex })
    const orders: CanvasImageReferenceOrder[] = [
      { version: 1, slots: [slot('source', 'e-source'), slot('reference', 'e-other')] },
      { version: 1, slots: [slot('source', 'e-source'), slot('reference', 'e-same')] },
      { version: 1, slots: [slot('source', 'e-source', 1)] },
      { version: 1, slots: [slot('source', 'e-grid', 3)] },
      { version: 1, slots: [slot('source', 'e-grid', 4)] },
      { version: 1, slots: [slot('source', 'e-panorama', 0)] },
      { version: 1, slots: [slot('source', 'e-text')] },
      { version: 1, slots: [slot('source', 'e-gone')] },
      { version: 1, slots: [slot('source', 'e-source'), { role: 'reference', missing: true }] },
    ]
    const connections: Array<readonly string[]> = [['e-source', 'e-other'], ['e-source', 'e-same'], ['e-source'], ['e-grid'], ['e-panorama'], ['e-text'], ['e-source', 'e-other', 'e-grid']]
    const nodes = new Map<string, CanvasRunGraphNode>([source, other, same, grid, panorama].map((node) => [node.id, node]))
    let refusals = 0
    for (const [orderIndex, order] of orders.entries()) {
      for (const connected of connections) {
        const target: CanvasRunGraphNode = { id: 'target', kind: 'image-edit', definitionVersion: 1, data: { prompt: '', model: 'gpt-image-2', imageReferenceOrder: order } }
        const graphEdges = edges.filter((edge) => connected.includes(edge.id))
        const all = new Map(nodes).set('target', target)
        const desktop = outcome(() => assertCanvasImageReferenceRunConfiguration(target, graphEdges, all))
        // The kernel types its graph its own way; the JSON is the same.
        const kernel = outcome(() => assertImageReferenceRunConfiguration(JSON.parse(JSON.stringify(target)), JSON.parse(JSON.stringify(graphEdges)), new Map(JSON.parse(JSON.stringify([...all.entries()])))))
        expect(desktop, `order ${orderIndex} connections ${connected.join(',')}`).toEqual(kernel)
        if ('error' in desktop) refusals += 1
      }
    }
    // Most of these combinations are refused; the parity above covers both outcomes.
    expect(refusals).toBeGreaterThan(30)
    // Without roles nothing is checked, as before.
    expect(() => assertCanvasImageReferenceRunConfiguration({ id: 'target', kind: 'image-edit', definitionVersion: 1, data: { prompt: '', model: '' } }, edges, nodes)).not.toThrow()
  })
})
