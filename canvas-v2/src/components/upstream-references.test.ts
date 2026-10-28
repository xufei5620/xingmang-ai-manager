import { describe, expect, it } from 'vitest'
import type { CanvasAssetSummary } from '../host'
import { createCanvasUpstreamReferenceSelector, upstreamReferenceRemovalLabel, type UpstreamReferenceNode } from './upstream-references'

function nodes(): UpstreamReferenceNode[] {
  return [
    { id: 'source', type: 'image-input', data: { prompt: '', model: '', status: 'idle', result: { kind: 'image', assetId: 'image-a', localUrl: 'xingmang-asset://image/image-a', width: 320 } } },
    { id: 'target', type: 'image-generate', data: { prompt: '', model: '', status: 'idle' } },
  ]
}

const edges = [{ id: 'wire', source: 'source', sourceHandle: 'out:image', target: 'target' }]

describe('upstream media reference stability', () => {
  it('retains the context value across moves, selections and prompt edits', () => {
    const select = createCanvasUpstreamReferenceSelector()
    const original = nodes()
    const first = select(original, edges, [])
    const moved = original.map((node) => ({ ...node, position: { x: 100, y: 200 }, selected: true }))
    expect(select(moved, edges, [])).toBe(first)
    const edited = moved.map((node) => ({ ...node, data: { ...node.data, prompt: 'new prompt' } }))
    expect(select(edited, edges.map((edge) => ({ ...edge })), [])).toBe(first)
  })

  it('publishes media metadata changes even when the asset identifier is unchanged', () => {
    const select = createCanvasUpstreamReferenceSelector()
    const original = nodes()
    const first = select(original, edges, [])
    const changed = original.map((node) => node.id === 'source' ? { ...node, data: { ...node.data, result: { ...node.data.result!, width: 640 } } } : node)
    const second = select(changed, edges, [])
    expect(second).not.toBe(first)
    expect(second.get('target')?.[0].asset?.width).toBe(640)
    expect(first.get('target')?.[0].asset?.width).toBe(320)
  })

  it('publishes rewiring, removed inputs and restored inputs', () => {
    const select = createCanvasUpstreamReferenceSelector()
    const first = select(nodes(), edges, [])
    const rewired = select(nodes(), [{ ...edges[0], target: 'another-target' }], [])
    expect(rewired).not.toBe(first)
    expect(rewired.has('target')).toBe(false)
    expect(rewired.has('another-target')).toBe(true)
    expect(select(nodes(), [], []).size).toBe(0)
    expect(select(nodes(), edges, []).get('target')).toHaveLength(1)
  })

  it('refreshes the reference label and local URL when the stored media changes', () => {
    const select = createCanvasUpstreamReferenceSelector()
    const first = select(nodes(), edges, [])
    const stored: CanvasAssetSummary = { assetId: 'image-a', mediaType: 'image', displayName: 'Renamed image', fileName: 'image.png', localUrl: '/api/assets/image-a', thumbnailUrl: '', mimeType: 'image/png', createdAt: '2026-10-11T00:00:00Z' }
    const second = select(nodes(), edges, [stored])
    expect(second).not.toBe(first)
    expect(second.get('target')?.[0]).toMatchObject({ label: 'Renamed image', asset: { localUrl: '/api/assets/image-a' } })
    expect(select(nodes(), edges, [{ ...stored }])).toBe(second)
  })

  it('updates renamed waiting template inputs without changing mention or edge identity', () => {
    const select = createCanvasUpstreamReferenceSelector()
    const original = nodes()
    original[0].data = { prompt: '', model: '', status: 'idle', settings: { title: '  商品正面 A  ' } }
    const first = select(original, edges, [])
    expect(first.get('target')?.[0]).toMatchObject({ label: '商品正面 A', status: 'waiting' })
    const renamed = original.map((node) => node.id === 'source' ? { ...node, data: { ...node.data, settings: { title: '商品背面 D' } } } : node)
    const second = select(renamed, edges, [])
    expect(second).not.toBe(first)
    expect(second.get('target')?.[0]).toMatchObject({ label: '商品背面 D', mention: first.get('target')?.[0].mention, edgeId: first.get('target')?.[0].edgeId })
    expect(select(renamed, edges, [])).toBe(second)
  })

  it.each(['', '  ', 7, 'x'.repeat(161), 'bad\u0000name'])('falls back to the registered title for invalid or empty title %j', (title) => {
    const original = nodes()
    original[0].data = { prompt: '', model: '', status: 'idle', settings: { title } }
    expect(createCanvasUpstreamReferenceSelector()(original, edges, []).get('target')?.[0].label).toBe('图片素材')
  })

  it('keeps stored display names authoritative but uses the source title when the catalogue has no name', () => {
    const select = createCanvasUpstreamReferenceSelector()
    const original = nodes()
    original[0].data.settings = { title: '产品图 A' }
    const first = select(original, edges, [])
    expect(first.get('target')?.[0].label).toBe('产品图 A · 图片')
    const stored: CanvasAssetSummary = { assetId: 'image-a', mediaType: 'image', displayName: '正面.png', fileName: 'image.png', localUrl: '/api/assets/image-a', thumbnailUrl: '', mimeType: 'image/png', createdAt: '2026-10-11T00:00:00Z' }
    expect(select(original, edges, [stored]).get('target')?.[0].label).toBe('正面.png')
    original[0].data.settings = { title: '重命名节点' }
    expect(select(original, edges, [stored]).get('target')?.[0].label).toBe('正面.png')
    expect(select(original, edges, [{ ...stored, displayName: '' }]).get('target')?.[0].label).toBe('重命名节点 · 图片')
  })

  it('retains batch output indexes and stable mentions with custom titles for ready and waiting inputs', () => {
    const select = createCanvasUpstreamReferenceSelector()
    const original = nodes()
    original[0].type = 'image-grid-split'
    original[0].data.settings = { title: '商品九宫格' }
    original[0].data.candidateAssetIds = ['tile-a', 'tile-b']
    const batch = [{ ...edges[0], sourceHandle: 'out:images' }]
    const ready = select(original, batch, []).get('target')!
    expect(new Set(ready.map((entry) => entry.referenceId)).size).toBe(2)
    expect(ready.map((entry) => entry.outputIndex)).toEqual([0, 1])
    expect(ready.every((entry) => entry.batch && entry.batchSize === 2)).toBe(true)
    expect(upstreamReferenceRemovalLabel(ready[0])).toContain('移除整组输入（2 张）')
    expect(ready.map((entry) => entry.label)).toEqual(['商品九宫格 · 图片 1', '商品九宫格 · 图片 2'])
    original[0].data.settings = { title: '新名称' }
    expect(select(original, batch, []).get('target')?.map((entry) => entry.mention)).toEqual(ready.map((entry) => entry.mention))
    original[0].data.candidateAssetIds = []
    delete original[0].data.result
    expect(select(original, batch, []).get('target')?.[0]).toMatchObject({ label: '新名称 · 图片 1', status: 'waiting' })
    expect(upstreamReferenceRemovalLabel(select(original, batch, []).get('target')![0])).toBe('移除整组输入：新名称 · 图片 1')
  })
  it('retains both selected and whole-batch connections without colliding keys', () => {
    const original = nodes()
    original[0].data.candidateAssetIds = ['image-a', 'image-b']
    const references = createCanvasUpstreamReferenceSelector()(original, [...edges, { ...edges[0], id: 'whole', sourceHandle: 'out:images' }], []).get('target')!
    expect(references).toHaveLength(3)
    expect(new Set(references.map((entry) => entry.referenceId)).size).toBe(3)
    expect(upstreamReferenceRemovalLabel(references[0])).not.toContain('整组')
  })

  it('enumerates every typed all-router slot in original output order independently of its adopted preview', () => {
    const original = nodes(), source = original[0]
    source.type = 'router'; source.data.settings = { routerStrategy: { version: 1, strategy: 'all' } }
    source.data.candidates = (['image', 'video', 'audio'] as const).flatMap((kind) => [0, 1].map((index) => ({ candidateId: `${kind}-${index}`, attemptId: 'original', createdAt: '2026-10-11T00:00:00Z', asset: { kind, assetId: `${kind}-${index}`, localUrl: `/asset/${kind}-${index}` } })))
    source.data.result = source.data.candidates[1].asset
    source.data.adoptedCandidateId = 'image-1'
    const connections = (['image', 'video', 'audio'] as const).map((kind) => ({ ...edges[0], id: kind, sourceHandle: `out:${kind}` }))
    const select = createCanvasUpstreamReferenceSelector(), before = select(original, connections, []), result = before.get('target')!
    for (const kind of ['image', 'video', 'audio']) {
      const typed = result.filter((reference) => reference.kind === kind)
      expect(typed.map((reference) => reference.asset?.assetId)).toEqual([`${kind}-0`, `${kind}-1`])
      expect(typed.map((reference) => reference.outputIndex)).toEqual([0, 1])
      expect(typed.every((reference) => reference.batch && reference.batchSize === 2 && reference.status === 'ready')).toBe(true)
    }
    source.data.result = source.data.candidates[0].asset
    source.data.adoptedCandidateId = 'image-0'
    expect(select(original, connections, [])).toBe(before)
    expect(select(original, connections, []).get('target')).toEqual(result)
  })

  it('restores typed router slots from saved candidate IDs only with known media metadata', () => {
    const original = nodes(), source = original[0]
    source.type = 'router'; source.data.settings = { routerStrategy: { version: 1, strategy: 'all' } }
    source.data.candidateAssetIds = ['image-b', 'unknown-kind', 'image-a']
    const assets: CanvasAssetSummary[] = ['image-a', 'image-b'].map((assetId) => ({ assetId, mediaType: 'image', displayName: assetId, fileName: `${assetId}.png`, localUrl: `/api/assets/${assetId}`, thumbnailUrl: '', mimeType: 'image/png', createdAt: '2026-10-11T00:00:00Z' }))
    expect(createCanvasUpstreamReferenceSelector()(original, edges, assets).get('target')!.map((reference) => reference.asset?.assetId)).toEqual(['image-b', 'image-a'])
    const waiting = createCanvasUpstreamReferenceSelector()(original, edges, []).get('target')!
    expect(waiting).toHaveLength(1); expect(waiting[0].status).toBe('waiting')
  })

  it.each(['first-available', undefined])('keeps %s typed router references scalar and refuses a future configuration', (strategy) => {
    const original = nodes(), source = original[0]
    source.type = 'router'; source.data.settings = strategy ? { routerStrategy: { version: 1, strategy } } : { strategy: 'all' }
    source.data.candidates = ['image-a', 'image-b'].map((assetId) => ({ candidateId: assetId, attemptId: 'original', createdAt: '2026-10-11T00:00:00Z', asset: { kind: 'image' as const, assetId, localUrl: `/asset/${assetId}` } }))
    const refs = createCanvasUpstreamReferenceSelector()(original, edges, []).get('target')!
    expect(refs).toHaveLength(1); expect(refs[0].batch).toBe(false)
    source.data.settings.routerStrategy = { version: 2, strategy: 'all' }
    const invalid = createCanvasUpstreamReferenceSelector()(original, edges, []).get('target')!
    expect(invalid).toHaveLength(1); expect(invalid[0]).toMatchObject({ status: 'waiting', label: expect.stringContaining('待核对') }); expect(invalid[0].asset).toBeUndefined()
  })
})
