import { parseCanvasRouterStrategy } from '../runtime/router-strategy'
import type { CanvasAssetSummary } from '../host'
import type { AssetRef, PortKind, WorkflowNodeData } from '../model'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { handleKind } from '../ports'

export type UpstreamMediaKind = Extract<PortKind, 'image' | 'video' | 'audio'>

export interface UpstreamMediaReference {
  edgeId: string
  referenceId?: string
  outputIndex?: number
  batch?: boolean
  batchSize?: number
  sourceNodeId: string
  targetHandle?: string
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
  targetHandle?: string | null
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
    // A single-image port and a whole-batch port from the same node are
    // distinct connections. Hiding either misrepresents the submitted inputs.
    const referenceKey = edge.id
    if (seenReferences.has(referenceKey)) continue
    const source = nodeById.get(edge.source)
    if (!source) continue
    const definition = builtinNodeRegistry.resolve(source.type ?? 'unknown') ?? builtinNodeRegistry.require('unknown')
    const title = source.data.settings?.title
    const sourceTitle = typeof title === 'string' && title.trim() && title.length <= 160 && !/[\u0000-\u001f\u007f]/.test(title) ? title.trim() : definition.title
    let routed: 'all' | 'first-available' | 'invalid' | undefined
    if (source.type === 'router' && Object.hasOwn(source.data.settings ?? {}, 'routerStrategy')) {
      try { routed = parseCanvasRouterStrategy(source.data.settings?.routerStrategy).strategy } catch { routed = 'invalid' }
    }
    // Router candidate order is its normalized per-media output order. The
    // adopted candidate is only a preview and must not hide the other slots.
    const routedAssets: AssetRef[] = []
    const seenAssets = new Set<string>()
    for (const asset of source.data.candidates?.length ? source.data.candidates.map((candidate) => candidate.asset) : (source.data.candidateAssetIds ?? []).flatMap((assetId) => {
      const stored = assetById.get(assetId)
      return stored?.mediaType === kind ? [{ kind, assetId, localUrl: stored.localUrl, mimeType: stored.mimeType }] : []
    })) if (asset.kind === kind && asset.assetId && !seenAssets.has(asset.assetId)) {
      seenAssets.add(asset.assetId)
      routedAssets.push(asset)
    }
    const batch = edge.sourceHandle === 'out:images' || routed === 'all'
    let sourceAssets: Array<AssetRef | undefined>
    if (routed === 'invalid') sourceAssets = [undefined]
    else if (routed) sourceAssets = routed === 'all' ? routedAssets : routedAssets.slice(0, 1)
    else if (source.type === 'router' && displayedAsset(source.data)?.kind !== kind && routedAssets.length) sourceAssets = routedAssets.slice(0, 1)
    else if (batch) sourceAssets = source.data.candidateAssetIds?.length
      ? source.data.candidateAssetIds.map((assetId) => source.data.candidates?.find((candidate) => candidate.asset.assetId === assetId)?.asset ?? { kind: 'image' as const, assetId, localUrl: `xingmang-asset://image/${assetId}` })
      : [...(source.data.candidates ?? [])].sort((a, b) => (a.outputIndex ?? 0) - (b.outputIndex ?? 0)).map((candidate) => candidate.asset)
    else sourceAssets = [displayedAsset(source.data)]
    for (const [index, sourceAsset] of (sourceAssets.length ? sourceAssets : [undefined]).entries()) {
      const stored = sourceAsset?.assetId ? assetById.get(sourceAsset.assetId) : undefined
      const asset = resolvedAsset(sourceAsset, stored, kind)
      const suffix = stableNodeHash(source.id)
      const label = routed === 'invalid' ? `${sourceTitle} · 路由策略待核对` : stored?.displayName || (asset || batch ? `${sourceTitle} · ${mediaLabel(kind)}${batch ? ` ${index + 1}` : ''}` : sourceTitle)
      const reference: UpstreamMediaReference = {
        edgeId: edge.id,
        referenceId: JSON.stringify([edge.id, index]),
        outputIndex: index,
        batch,
        ...(batch && sourceAssets.length ? { batchSize: sourceAssets.length } : {}),
        sourceNodeId: source.id,
        ...(edge.targetHandle ? { targetHandle: edge.targetHandle } : {}),
        kind,
        label,
        mention: `@${definition.title}-${mediaLabel(kind)}-${suffix}${batch ? `-${index + 1}` : ''}`,
        relationLabel: kind === 'image' ? '图像输入' : kind === 'video' ? '视频输入' : '音频输入',
        status: asset ? 'ready' : 'waiting',
        ...(asset ? { asset } : {}),
      }
      references.set(edge.target, [...(references.get(edge.target) ?? []), reference])
    }
    seenReferences.add(referenceKey)
  }

  return references
}

function sameReference(left: UpstreamMediaReference, right: UpstreamMediaReference): boolean {
  if (left.referenceId !== right.referenceId || left.batch !== right.batch || left.batchSize !== right.batchSize || left.edgeId !== right.edgeId || left.targetHandle !== right.targetHandle || left.sourceNodeId !== right.sourceNodeId || left.kind !== right.kind
    || left.label !== right.label || left.mention !== right.mention || left.relationLabel !== right.relationLabel || left.status !== right.status) return false
  if (left.asset === right.asset) return true
  if (!left.asset || !right.asset) return false
  const leftAsset = left.asset
  const rightAsset = right.asset
  return Object.entries(leftAsset).every(([key, value]) => Object.is(value, Reflect.get(rightAsset, key)))
    && Object.entries(rightAsset).every(([key, value]) => Object.is(value, Reflect.get(leftAsset, key)))
}

export function upstreamReferenceRemovalLabel(reference: UpstreamMediaReference): string {
  return reference.batch ? `移除整组输入${reference.batchSize ? `（${reference.batchSize} 张）` : ''}：${reference.label}` : `移除${reference.label}`
}

export function createCanvasUpstreamReferenceSelector(): typeof buildCanvasUpstreamReferences {
  let previous: ReturnType<typeof buildCanvasUpstreamReferences> | undefined
  return function selectReferences(nodes, edges, assets) {
    const next = buildCanvasUpstreamReferences(nodes, edges, assets)
    // Position, selection and prompt edits do not change upstream media. Keep
    // the context identity so those gestures do not rerender every node editor.
    if (previous && previous.size === next.size && [...next].every(([nodeId, references]) => {
      const before = previous?.get(nodeId)
      return before?.length === references.length && references.every((reference, index) => sameReference(reference, before[index]))
    })) return previous
    previous = next
    return next
  }
}
