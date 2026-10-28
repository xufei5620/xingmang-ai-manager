import { supportsImageCandidateCount } from './image-candidate-count'
import { supportsVideoCandidateCount } from './video-candidate-count'
import type { CanvasAssetSummary } from '../host'
import type { WorkflowCandidateRef, WorkflowNodeData } from '../model'
import { localAssetUrl, stableAssetId } from '../persistence/workflow-schema'

/** Prefetch only explicit current gallery references; selecting another batch
 * brings it inside the bounded budget without reading the whole asset library. */
export function collectGalleryCandidateAssetIds(nodes: readonly { type?: string; selected?: boolean; data: Pick<WorkflowNodeData, 'candidateAssetIds'> }[]): string[] {
  const galleries = nodes.filter((node) => node.type === 'gallery')
  const ordered = [...galleries.filter((node) => node.selected), ...galleries.filter((node) => !node.selected)]
  return [...new Set(ordered.flatMap((node) => (node.data.candidateAssetIds ?? []).slice(0, 16).filter(stableAssetId)))].slice(0, 128)
}

/** Restore only the persisted current batch, never candidates from another run. */
export function currentNodeCandidates(
  nodeId: string,
  kind: string | undefined,
  data: WorkflowNodeData,
  assets: readonly CanvasAssetSummary[] = [],
): WorkflowCandidateRef[] {
  const grid = kind === 'image-grid-split'
  if (kind === 'gallery' && data.candidateAssetIds?.length) {
    const byId = new Map(assets.map((asset) => [asset.assetId, asset]))
    return data.candidateAssetIds.slice(0, 16).flatMap((assetId, outputIndex) => {
      if (!stableAssetId(assetId)) return []
      const stored = byId.get(assetId)
      const existing = data.candidates?.find((candidate) => candidate.asset.assetId === assetId)
      const result = data.result?.assetId === assetId ? data.result : undefined
      // A gallery can mix media. An ID alone provides no evidence that a
      // missing asset is an image; wait for its owned asset metadata instead.
      const mediaType = stored?.mediaType ?? existing?.asset.kind ?? result?.kind
      if (!mediaType) return []
      const previous = existing?.asset.kind === mediaType ? existing : undefined
      return [{
        candidateId: previous?.candidateId ?? `document:${nodeId}:${outputIndex}:${assetId}`,
        attemptId: previous?.attemptId ?? `document:${nodeId}`,
        createdAt: previous?.createdAt ?? stored?.createdAt ?? '',
        asset: {
          ...(result?.kind === mediaType ? result : undefined),
          ...previous?.asset,
          kind: mediaType,
          assetId,
          localUrl: stored?.localUrl ?? previous?.asset.localUrl ?? result?.localUrl ?? localAssetUrl(mediaType, assetId),
          ...(stored ? { mimeType: stored.mimeType } : {}),
          ...(stored && stored.mediaType !== 'audio' ? { width: stored.width, height: stored.height } : {}),
          ...(stored && stored.mediaType !== 'image' ? { durationSeconds: stored.durationSeconds } : {}),
        },
      }]
    })
  }
  const video = supportsVideoCandidateCount(kind ?? '')
  const mediaKind = video ? 'video' : 'image'
  if ((!grid && !supportsImageCandidateCount(kind ?? '') && !video) || !data.candidateAssetIds?.length) return data.candidates ?? []
  const byId = new Map(assets.map((asset) => [asset.assetId, asset]))
  return data.candidateAssetIds.slice(0, 16).flatMap((assetId, outputIndex) => {
    if (!stableAssetId(assetId)) return []
    const existing = data.candidates?.find((candidate) => candidate.asset.kind === mediaKind && candidate.asset.assetId === assetId)
    const stored = byId.get(assetId)
    if (video && stored && stored.mediaType !== 'video') return []
    const image = stored?.mediaType === 'image' ? stored : undefined
    const media = stored?.mediaType === mediaKind ? stored : undefined
    const result = data.result?.kind === mediaKind && data.result.assetId === assetId ? data.result : undefined
    // Synthetic identifiers belong only to the restored view. They are never
    // persisted as a run receipt or used to claim another processing attempt.
    return [{
      candidateId: existing?.candidateId ?? `document:${nodeId}:${outputIndex}:${assetId}`,
      attemptId: existing?.attemptId ?? (grid ? image?.imageTransform?.attemptId : undefined) ?? `document:${nodeId}`,
      createdAt: existing?.createdAt ?? media?.createdAt ?? '',
      ...(grid ? { outputIndex } : {}),
      asset: {
        ...result,
        ...existing?.asset,
        kind: mediaKind,
        assetId,
        localUrl: media?.localUrl ?? existing?.asset.localUrl ?? result?.localUrl ?? localAssetUrl(mediaKind, assetId),
        ...(media ? { mimeType: media.mimeType, ...('width' in media && media.width ? { width: media.width } : {}), ...('height' in media && media.height ? { height: media.height } : {}), ...('durationSeconds' in media && media.durationSeconds !== undefined ? { durationSeconds: media.durationSeconds } : {}) } : {}),
      },
    }]
  })
}
