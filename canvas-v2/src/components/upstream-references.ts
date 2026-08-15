import type { CanvasAssetSummary } from '../host'
import type { AssetRef, PortKind, WorkflowNodeData } from '../model'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { handleKind } from '../ports'

export type UpstreamMediaKind = Extract<PortKind, 'image' | 'video' | 'audio'>

export interface UpstreamMediaReference {
  edgeId: string
  sourceNodeId: string
  kind: UpstreamMediaKind
  label: string
  mention: string
  relationLabel: '图像输入' | '视频输入' | '音频输入'
  status: 'ready' | 'waiting'
  asset?: AssetRef
}

export interface UpstreamReferenceNode {
  id: string
  type?: string | null
  data: WorkflowNodeData & Record<string, unknown>
}

export interface UpstreamReferenceEdge {
  id: string
  source: string
  sourceHandle?: string | null
  target: string
}

function displayedAsset(data: WorkflowNodeData): AssetRef | undefined {
  return data.result
    ?? data.candidates?.find((candidate) => candidate.candidateId === data.adoptedCandidateId)?.asset
}

function mediaLabel(kind: UpstreamMediaKind): string {
  return kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频'
}

function stableNodeHash(nodeId: string): string {
  let hash = 2166136261
  for (let index = 0; index < nodeId.length; index += 1) {
    hash ^= nodeId.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36).padStart(6, '0').slice(-6)
}

function resolvedAsset(asset: AssetRef | undefined, stored: CanvasAssetSummary | undefined, kind: UpstreamMediaKind): AssetRef | undefined {
  if (!asset || asset.kind !== kind || !asset.assetId || !asset.localUrl) return undefined
  if (!stored || stored.mediaType !== kind) return asset
  return {
    ...asset,
    localUrl: stored.localUrl,
    mimeType: stored.mimeType,
    ...('width' in stored && stored.width ? { width: stored.width } : {}),
    ...('height' in stored && stored.height ? { height: stored.height } : {}),
  }
}

export function buildCanvasUpstreamReferences(
  nodes: readonly UpstreamReferenceNode[],
  edges: readonly UpstreamReferenceEdge[],
  assets: readonly CanvasAssetSummary[],
): ReadonlyMap<string, readonly UpstreamMediaReference[]> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const assetById = new Map(assets.map((asset) => [asset.assetId, asset]))
  const references = new Map<string, UpstreamMediaReference[]>()
  const seenReferences = new Set<string>()

  for (const edge of edges) {
    const kind = handleKind(edge.sourceHandle)
    if (kind !== 'image' && kind !== 'video' && kind !== 'audio') continue
    const referenceKey = `${edge.target}\0${edge.source}\0${kind}`
    if (seenReferences.has(referenceKey)) continue
    const source = nodeById.get(edge.source)
    if (!source) continue
    const definition = builtinNodeRegistry.resolve(source.type ?? 'unknown') ?? builtinNodeRegistry.require('unknown')
    const sourceAsset = displayedAsset(source.data)
    const stored = sourceAsset?.assetId ? assetById.get(sourceAsset.assetId) : undefined
    const asset = resolvedAsset(sourceAsset, stored, kind)
    const suffix = stableNodeHash(source.id)
    const label = stored?.displayName || (asset ? `${definition.title} · ${mediaLabel(kind)}` : definition.title)
    const reference: UpstreamMediaReference = {
      edgeId: edge.id,
      sourceNodeId: source.id,
      kind,
      label,
      mention: `@${definition.title}-${mediaLabel(kind)}-${suffix}`,
      relationLabel: kind === 'image' ? '图像输入' : kind === 'video' ? '视频输入' : '音频输入',
      status: asset ? 'ready' : 'waiting',
      ...(asset ? { asset } : {}),
    }
    references.set(edge.target, [...(references.get(edge.target) ?? []), reference])
    seenReferences.add(referenceKey)
  }

  return references
}
