import type { CanvasAssetSummary } from '../host'

/** The latest list owns organization fields; a separate detail owns the full metadata. */
export function combineCanvasAssetDetail(summary: CanvasAssetSummary, detail: CanvasAssetSummary | null): CanvasAssetSummary {
  if (summary.metadataLevel !== 'summary') return summary
  if (!detail || detail.assetId !== summary.assetId || detail.mediaType !== summary.mediaType || detail.metadataLevel !== 'complete') return summary
  return { ...detail, ...summary, deletedAt: summary.deletedAt, metadataLevel: 'complete' }
}

export function createCanvasAssetDetailGuard() {
  let revision = 0
  return {
    begin() { revision += 1; return revision },
    current(ticket: number, signal: AbortSignal) { return revision === ticket && !signal.aborted },
    invalidate() { revision += 1 },
  }
}
