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
      nodes: [text, imageNode({ imageResolution: '4K' })],
    }))
    expect(computeCanvasGraphRevision(graph)).not.toBe(computeCanvasGraphRevision({
      ...graph,
      nodes: [text, imageNode({ seconds: '10' })],
    }))
  })

  it('does not change a generate node fingerprint when its own result is pinned', () => {
    const generated = imageNode({ adoptedAssetId: 'a'.repeat(43) })
    expect(computeCanvasNodeFingerprint({ node: imageNode(), upstream: [] }))
      .toBe(computeCanvasNodeFingerprint({ node: generated, upstream: [] }))
  })

  it('does change an input node fingerprint when the imported asset changes', () => {
    const first: CanvasRunGraphNode = {
      id: 'input',
      kind: 'image-input',
      definitionVersion: 1,
      data: { prompt: '', model: '', adoptedAssetId: 'a'.repeat(43) },
    }
    const second: CanvasRunGraphNode = {
      ...first,
      data: { ...first.data, adoptedAssetId: 'b'.repeat(43) },
    }
    expect(computeCanvasNodeFingerprint({ node: first, upstream: [] }))
      .not.toBe(computeCanvasNodeFingerprint({ node: second, upstream: [] }))
  })
  it('changes an image fingerprint when the resolution moves off the default', () => {
    const base = computeCanvasNodeFingerprint({ node: imageNode(), upstream: [] })
    expect(computeCanvasNodeFingerprint({ node: imageNode({ imageResolution: '4K' }), upstream: [] })).not.toBe(base)
    expect(computeCanvasNodeFingerprint({ node: imageNode({ imageResolution: '2K' }), upstream: [] }))
      .not.toBe(computeCanvasNodeFingerprint({ node: imageNode({ imageResolution: '4K' }), upstream: [] }))
  })

  it('keeps the pre-existing image fingerprint when the resolution equals the model default', () => {
    // Pinned so caches written before resolution joined the key stay valid.
    const legacy = computeCanvasNodeFingerprint({ node: imageNode(), upstream: [] })
    expect(computeCanvasNodeFingerprint({ node: imageNode({ imageResolution: '1K' }), upstream: [] })).toBe(legacy)
  })

  it('changes a MiniMax video fingerprint for each generation parameter but not for its defaults', () => {
    function videoNode(overrides: Partial<CanvasRunGraphNode['data']> = {}): CanvasRunGraphNode {
      return {
        id: 'video',
        kind: 'video',
        definitionVersion: 1,
        data: { prompt: 'waves', model: 'minimax-h3-fast', group: '视频', seconds: '5', ...overrides },
      }
    }
    const base = computeCanvasNodeFingerprint({ node: videoNode(), upstream: [] })
    expect(computeCanvasNodeFingerprint({
      node: videoNode({ videoMode: 'auto', videoResolution: '720p', videoAspectRatio: '16:9', promptOptimization: false }),
      upstream: [],
    })).toBe(base)
    const changed: Array<Partial<CanvasRunGraphNode['data']>> = [
      { videoMode: 't2va' },
      { videoResolution: '480p' },
      { videoAspectRatio: '9:16' },
      { promptOptimization: true },
    ]
    for (const overrides of changed) {
      expect(computeCanvasNodeFingerprint({ node: videoNode(overrides), upstream: [] })).not.toBe(base)
    }
  })

  it('ignores MiniMax-only parameters on models that never send them', () => {
    const grok: CanvasRunGraphNode = {
      id: 'video',
      kind: 'video',
      definitionVersion: 1,
      data: { prompt: 'waves', model: 'grok-imagine-video', seconds: '5' },
    }
    expect(computeCanvasNodeFingerprint({
      node: { ...grok, data: { ...grok.data, videoAspectRatio: '9:16', promptOptimization: true } },
      upstream: [],
    })).toBe(computeCanvasNodeFingerprint({ node: grok, upstream: [] }))
  })

  it('changes the graph revision for MiniMax video parameters', () => {
    const video: CanvasRunGraphNode = {
      id: 'video',
      kind: 'video',
      definitionVersion: 1,
      data: { prompt: 'waves', model: 'minimax-h3-fast', seconds: '5' },
    }
    const base = computeCanvasGraphRevision({ nodes: [video], edges: [] })
    for (const overrides of [
      { videoMode: 't2va' as const },
      { videoResolution: '480p' as const },
      { videoAspectRatio: '9:16' as const },
      { promptOptimization: true },
    ]) {
      expect(computeCanvasGraphRevision({ nodes: [{ ...video, data: { ...video.data, ...overrides } }], edges: [] }))
        .not.toBe(base)
    }
  })
})
