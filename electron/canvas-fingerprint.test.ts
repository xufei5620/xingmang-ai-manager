import { describe, expect, it } from 'vitest'
import {
  canonicalCanvasJson,
  computeCanvasGraphRevision,
  computeCanvasNodeFingerprint,
} from './canvas-fingerprint'
import type { CanvasRunGraph, CanvasRunGraphNode } from './canvas-run-contract'

function imageNode(overrides: Partial<CanvasRunGraphNode['data']> = {}): CanvasRunGraphNode {
  return {
    id: 'image',
    kind: 'image',
    definitionVersion: 1,
    data: {
      prompt: 'a lighthouse',
      model: 'gpt-image-2',
      group: '生图',
      size: '1024x1024',
      quality: 'low',
      ...overrides,
    },
  }
}

describe('canvas fingerprints', () => {
  it('canonicalizes object keys while retaining array order', () => {
    expect(canonicalCanvasJson({ z: 1, a: { d: 2, b: 3 }, list: [2, 1] }))
      .toBe('{"a":{"b":3,"d":2},"list":[2,1],"z":1}')
  })

  it('retains upstream execution order while ignoring local URLs', () => {
    const node = imageNode()
    const first = computeCanvasNodeFingerprint({
      node,
      upstream: [
        { sourceNodeId: 'b', sourceHandle: 'out:image', targetHandle: 'in:image', fingerprint: 'b', asset: {
          kind: 'image',
          assetId: 'a'.repeat(43),
          localUrl: 'xingmang-asset://image/ignored',
        } },
        { sourceNodeId: 'a', sourceHandle: 'out:text', targetHandle: 'in:text', fingerprint: 'a', text: 'hello' },
      ],
    })
    const second = computeCanvasNodeFingerprint({
      node,
      upstream: [
        { sourceNodeId: 'b', sourceHandle: 'out:image', targetHandle: 'in:image', fingerprint: 'b', asset: {
          kind: 'image',
          assetId: 'a'.repeat(43),
          localUrl: 'C:\\secret\\image.png',
        } },
        { sourceNodeId: 'a', sourceHandle: 'out:text', targetHandle: 'in:text', fingerprint: 'a', text: 'hello' },
      ],
    })
    expect(first).toBe(second)
    expect(first).toMatch(/^[a-f0-9]{64}$/)

    const reversed = computeCanvasNodeFingerprint({
      node,
      upstream: [
        { sourceNodeId: 'a', sourceHandle: 'out:text', targetHandle: 'in:text', fingerprint: 'a', text: 'hello' },
        { sourceNodeId: 'b', sourceHandle: 'out:image', targetHandle: 'in:image', fingerprint: 'b', asset: {
          kind: 'image',
          assetId: 'a'.repeat(43),
          localUrl: 'xingmang-asset://image/ignored',
        } },
      ],
    })
    expect(reversed).not.toBe(first)
  })

  it('changes revisions for execution inputs but not graph enumeration order', () => {
    const text: CanvasRunGraphNode = {
      id: 'text',
      kind: 'text',
      definitionVersion: 1,
      data: { prompt: 'hello', model: '' },
    }
    const graph: CanvasRunGraph = {
      nodes: [text, imageNode()],
      edges: [{ id: 'edge', source: 'text', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' }],
    }
    expect(computeCanvasGraphRevision(graph)).toBe(computeCanvasGraphRevision({
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    }))
    expect(computeCanvasGraphRevision(graph)).not.toBe(computeCanvasGraphRevision({
      ...graph,
      nodes: [text, imageNode({ quality: 'high' })],
    }))
    expect(computeCanvasGraphRevision(graph)).not.toBe(computeCanvasGraphRevision({
      ...graph,
      nodes: [text, imageNode({ seconds: '10' })],
    }))
  })
})
