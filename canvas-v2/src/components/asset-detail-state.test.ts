import { describe, expect, it } from 'vitest'
import type { CanvasAssetSummary } from '../host'
import { combineCanvasAssetDetail, createCanvasAssetDetailGuard } from './asset-detail-state'

function asset(): CanvasAssetSummary {
  return { assetId: 'a'.repeat(43), metadataLevel: 'summary', createdAt: '2026-10-10T00:00:00Z', mediaType: 'image', mimeType: 'image/png', fileName: 'a.png', displayName: '当前名称', localUrl: 'xingmang-asset://image/' + 'a'.repeat(43), thumbnailUrl: 'xingmang-asset://image/' + 'a'.repeat(43), favorite: true, tags: ['当前标签'] }
}

describe('canvas lazy asset detail state', () => {
  it('preserves full prompt and lineage while retaining recently confirmed list organization', () => {
    const summary = asset()
    const detail = { ...summary, metadataLevel: 'complete' as const, prompt: '长提示词'.repeat(8_000), favorite: false, displayName: '旧名称', tags: ['旧标签'] }
    expect(combineCanvasAssetDetail(summary, detail)).toMatchObject({ metadataLevel: 'complete', prompt: detail.prompt, displayName: '当前名称', favorite: true, tags: ['当前标签'] })
  })

  it('cannot substitute another asset or summary-only detail', () => {
    const summary = asset()
    for (const detail of [null, { ...summary, assetId: 'b'.repeat(43), metadataLevel: 'complete' as const, prompt: 'foreign' }, { ...summary, prompt: 'not complete' }]) expect(combineCanvasAssetDetail(summary, detail)).toBe(summary)
  })

  it('clears an old trash marker when the latest confirmed list shows the asset restored', () => {
    const summary = asset()
    const detail = { ...summary, metadataLevel: 'complete' as const, deletedAt: '2026-10-10T00:00:01Z', prompt: '原提示词' }
    expect(combineCanvasAssetDetail(summary, detail)).toMatchObject({ metadataLevel: 'complete', deletedAt: undefined, prompt: '原提示词' })
  })

  it('keeps desktop full objects compatible without forcing a network read', () => {
    const desktop = { ...asset(), metadataLevel: undefined, prompt: '原桌面提示词' }
    expect(combineCanvasAssetDetail(desktop, null)).toBe(desktop)
  })

  it('rejects late responses after another selection, close, or abort', () => {
    const guard = createCanvasAssetDetailGuard()
    const controller = new AbortController()
    const first = guard.begin()
    const second = guard.begin()
    expect(guard.current(first, controller.signal)).toBe(false)
    expect(guard.current(second, controller.signal)).toBe(true)
    guard.invalidate()
    expect(guard.current(second, controller.signal)).toBe(false)
    const third = guard.begin()
    controller.abort()
    expect(guard.current(third, controller.signal)).toBe(false)
  })
})
