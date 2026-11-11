import { describe, expect, it } from 'vitest'
import {
  canonicalCanvasJson,
  canvasImageCandidateCacheKey,
  computeCanvasGraphRevision,
  computeCanvasNodeFingerprint,
} from './canvas-fingerprint'
import type { CanvasImageEditMask, CanvasRunGraph, CanvasRunGraphNode } from './canvas-run-contract'

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

  it('keeps one image per request of a multi-image node, with request 1 on the node fingerprint', () => {
    const fingerprint = computeCanvasNodeFingerprint({ node: imageNode(), upstream: [] })
    // Not part of the node fingerprint: a run that asks for more images
    // still finds what a one-image run made.
    expect(computeCanvasNodeFingerprint({ node: imageNode({ imageCandidateCount: 4 }), upstream: [] })).toBe(fingerprint)
    expect(canvasImageCandidateCacheKey(fingerprint, 1)).toBe(fingerprint)
    const keys = [2, 3, 4].map((index) => canvasImageCandidateCacheKey(fingerprint, index))
    expect(new Set([fingerprint, ...keys]).size).toBe(4)
    for (const key of keys) expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(canvasImageCandidateCacheKey(fingerprint, 3)).toBe(keys[1])
    expect(() => canvasImageCandidateCacheKey(fingerprint, 5)).toThrow('画布图片序号格式错误')
    expect(() => canvasImageCandidateCacheKey('not-a-fingerprint', 2)).toThrow('画布节点指纹格式错误')
  })

  it('keeps every existing edit fingerprint and gives a masked edit its own', () => {
    const edit = (imageEditMask?: CanvasImageEditMask): CanvasRunGraphNode => ({
      id: 'edit', kind: 'image-edit', definitionVersion: 1,
      data: { prompt: '换成红色', model: 'gpt-image-2', group: '生图', size: '1024x1024', quality: 'low', ...(imageEditMask ? { imageEditMask } : {}) },
    })
    // Both values computed by main 4049a622, before masks were passed on: a
    // node without one must keep its cache key and its graph revision.
    expect(computeCanvasNodeFingerprint({ node: edit(), upstream: [] })).toBe('dc3b82d73d46fd7a054eaf1d929cac13ae42284c186c2a81b3fe0ca8996bf2ab')
    expect(computeCanvasGraphRevision({ nodes: [edit()], edges: [] })).toBe('5ddbdb7f62d91ee381cc3d9b2234c37619c16bcf15973e4ce73f3b9729791234')
    const mask: CanvasImageEditMask = { version: 1, sourceAssetId: 'a'.repeat(43), width: 64, height: 48, strokes: [{ tool: 'brush', size: 0.2, points: [{ x: 0.5, y: 0.5 }] }] }
    const masked = computeCanvasNodeFingerprint({ node: edit(mask), upstream: [] })
    expect(masked).not.toBe('dc3b82d73d46fd7a054eaf1d929cac13ae42284c186c2a81b3fe0ca8996bf2ab')
    const moreStroke = { ...mask, strokes: [...mask.strokes, { tool: 'erase' as const, size: 0.1, points: [{ x: 0.5, y: 0.5 }] }] }
    expect(computeCanvasNodeFingerprint({ node: edit(moreStroke), upstream: [] })).not.toBe(masked)
    expect(computeCanvasGraphRevision({ nodes: [edit(mask)], edges: [] })).not.toBe('5ddbdb7f62d91ee381cc3d9b2234c37619c16bcf15973e4ce73f3b9729791234')
  })

  it('gives a frame at another second its own fingerprint and keeps every node without one as it was', () => {
    const frame = (frameTimestampSeconds?: number): CanvasRunGraphNode => ({
      id: 'frame', kind: 'frame-extract', definitionVersion: 1,
      data: { prompt: '', model: '', ...(frameTimestampSeconds !== undefined ? { frameTimestampSeconds } : {}) },
    })
    // Absent, the field changes nothing: the same key as before frames ran.
    const plain = computeCanvasNodeFingerprint({ node: frame(), upstream: [] })
    expect(computeCanvasNodeFingerprint({ node: { ...frame(), data: { prompt: '', model: '', frameTimestampSeconds: undefined } }, upstream: [] })).toBe(plain)
    const atOne = computeCanvasNodeFingerprint({ node: frame(1), upstream: [] })
    expect(atOne).not.toBe(plain)
    expect(computeCanvasNodeFingerprint({ node: frame(2), upstream: [] })).not.toBe(atOne)
    expect(computeCanvasNodeFingerprint({ node: frame(1), upstream: [] })).toBe(atOne)
    const revision = computeCanvasGraphRevision({ nodes: [frame(1)], edges: [] })
    expect(computeCanvasGraphRevision({ nodes: [frame(2)], edges: [] })).not.toBe(revision)
    expect(computeCanvasGraphRevision({ nodes: [frame()], edges: [] })).toBe(computeCanvasGraphRevision({ nodes: [{ ...frame(), data: { prompt: '', model: '', frameTimestampSeconds: undefined } }], edges: [] }))
  })

  it('changes the graph revision with the image count but keeps it for one image', () => {
    const base = computeCanvasGraphRevision({ nodes: [imageNode()], edges: [] })
    expect(computeCanvasGraphRevision({ nodes: [imageNode({ imageCandidateCount: 2 })], edges: [] })).not.toBe(base)
    expect(computeCanvasGraphRevision({ nodes: [imageNode({ imageCandidateCount: undefined })], edges: [] })).toBe(base)
  })
})
