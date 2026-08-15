import { describe, expect, it } from 'vitest'
import type { CanvasAssetSummary } from '../host'
import type { WorkflowNodeData } from '../model'
import { buildCanvasUpstreamReferences, type UpstreamReferenceNode } from './upstream-references'

function node(id: string, type: string, data: Partial<WorkflowNodeData> = {}): UpstreamReferenceNode {
  return { id, type, data: { prompt: '', model: '', status: 'idle', ...data } }
}

const imageAssetId = 'i'.repeat(43)
const videoAssetId = 'v'.repeat(43)
const previewOnlyAssetId = 'p'.repeat(43)

const assets: CanvasAssetSummary[] = [
  {
    assetId: imageAssetId,
    localUrl: `xingmang-asset://image/${imageAssetId}`,
    thumbnailUrl: `xingmang-asset://image/${imageAssetId}`,
    mimeType: 'image/png',
    fileName: `xingmang-${imageAssetId}.png`,
    displayName: '产品参考图',
    createdAt: '2026-08-14T00:00:00.000Z',
    mediaType: 'image',
  },
]

describe('canvas upstream media projection', () => {
  it('projects only direct explicit media edges and keeps readable stable mentions', () => {
    const nodes = [
      node('source-image', 'image-input', { status: 'succeeded', result: { kind: 'image', assetId: imageAssetId, localUrl: `xingmang-asset://image/${imageAssetId}` } }),
      node('source-video', 'video-input', { status: 'succeeded', result: { kind: 'video', assetId: videoAssetId, localUrl: `xingmang-asset://video/${videoAssetId}` } }),
      node('source-audio', 'audio-input'),
      node('edit-target', 'image-edit'),
      node('video-target', 'video-generate'),
    ]
    const edges = [
      { id: 'e-image', source: 'source-image', sourceHandle: 'out:image', target: 'edit-target' },
      { id: 'e-video', source: 'source-video', sourceHandle: 'out:video', target: 'video-target' },
      { id: 'e-video-duplicate', source: 'source-video', sourceHandle: 'out:video', target: 'video-target' },
      { id: 'e-audio', source: 'source-audio', sourceHandle: 'out:audio', target: 'video-target' },
      { id: 'e-text', source: 'source-image', sourceHandle: 'out:text', target: 'video-target' },
    ]

    const projected = buildCanvasUpstreamReferences(nodes, edges, assets)
    expect(projected.get('edit-target')).toMatchObject([{
      edgeId: 'e-image', kind: 'image', label: '产品参考图', relationLabel: '图像输入', status: 'ready',
    }])
    expect(projected.get('video-target')).toHaveLength(2)
    expect(projected.get('video-target')?.[0]).toMatchObject({ kind: 'video', relationLabel: '视频输入', status: 'ready' })
    expect(projected.get('video-target')?.[1]).toMatchObject({ kind: 'audio', relationLabel: '音频输入', status: 'waiting' })
    expect(projected.get('video-target')?.[0]?.mention).toMatch(/^@视频素材-视频-[a-z0-9]{6}$/)
    expect(buildCanvasUpstreamReferences(nodes, edges, assets).get('video-target')?.[0]?.mention)
      .toBe(projected.get('video-target')?.[0]?.mention)
  })

  it('does not infer transitive or asset-library-only dependencies', () => {
    const nodes = [
      node('asset-source', 'image-input', { status: 'succeeded', result: { kind: 'image', assetId: imageAssetId, localUrl: `xingmang-asset://image/${imageAssetId}` } }),
      node('middle', 'image-edit'),
      node('target', 'video-generate'),
    ]
    const edges = [{ id: 'e1', source: 'asset-source', sourceHandle: 'out:image', target: 'middle' }]
    const projected = buildCanvasUpstreamReferences(nodes, edges, assets)

    expect(projected.get('middle')).toHaveLength(1)
    expect(projected.has('target')).toBe(false)
  })

  it('projects the adopted result instead of a preview-only selected candidate', () => {
    const nodes = [
      node('generated', 'image-generate', {
        status: 'succeeded',
        result: { kind: 'image', assetId: imageAssetId, localUrl: `xingmang-asset://image/${imageAssetId}` },
        selectedCandidateId: 'preview-only',
        adoptedCandidateId: 'adopted',
        candidates: [
          {
            candidateId: 'preview-only', attemptId: 'attempt-preview', createdAt: '2026-08-14T00:00:00.000Z',
            asset: { kind: 'image', assetId: previewOnlyAssetId, localUrl: `xingmang-asset://image/${previewOnlyAssetId}` },
          },
          {
            candidateId: 'adopted', attemptId: 'attempt-adopted', createdAt: '2026-08-14T00:00:01.000Z',
            asset: { kind: 'image', assetId: imageAssetId, localUrl: `xingmang-asset://image/${imageAssetId}` },
          },
        ],
      }),
      node('video-target', 'video-generate'),
    ]
    const projected = buildCanvasUpstreamReferences(nodes, [
      { id: 'generated-to-video', source: 'generated', sourceHandle: 'out:image', target: 'video-target' },
    ], assets)

    expect(projected.get('video-target')?.[0]?.asset?.assetId).toBe(imageAssetId)
  })
})
