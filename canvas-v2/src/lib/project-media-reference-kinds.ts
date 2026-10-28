import type { WorkflowFile } from '../model'
import { supportsImageCandidateCount } from '../runtime/image-candidate-count'
import { supportsVideoCandidateCount } from '../runtime/video-candidate-count'
import type { ProjectMediaType } from './project-media-validation'

/** Only typed fields constrain a reference; generic galleries may mix media. */
export function projectMediaReferenceKinds(workflow: WorkflowFile): Map<string, Set<ProjectMediaType>> {
  const kinds = new Map<string, Set<ProjectMediaType>>()
  function add(assetId: unknown, kind: ProjectMediaType): void {
    if (typeof assetId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(assetId)) return
    const values = kinds.get(assetId) ?? new Set<ProjectMediaType>()
    values.add(kind); kinds.set(assetId, values)
  }
  for (const node of workflow.nodes) {
    const result = node.data.result
    if (result) add(result.assetId, result.kind)
    const image = supportsImageCandidateCount(node.kind) || ['image-input', 'image-grid-split', 'image-crop', 'image-collage', 'image-tile', 'image-layer', 'image-compare', 'image-panorama', 'frame-extract'].includes(node.kind)
    const video = supportsVideoCandidateCount(node.kind) || node.kind === 'video-input'
    const expected = image ? 'image' : video ? 'video' : node.kind === 'audio-input' ? 'audio' : undefined
    if (expected) {
      add(result?.assetId, expected)
      for (const assetId of node.data.candidateAssetIds ?? []) add(assetId, expected)
      add(node.data.settings?.adoptedAssetId, expected)
    }
    const mask = node.data.settings?.imageEditMask
    if (mask && typeof mask === 'object' && !Array.isArray(mask)) add((mask as Record<string, unknown>).sourceAssetId, 'image')
  }
  return kinds
}
