import type { DramaAssetData, DramaBibleData, DramaShotGate } from './drama-model'
import { dramaShotBlockedReason, dramaShotGate, markDramaShotStale } from './drama-gate'
import { compileShotImagePrompt } from './drama-compile'
import {
  dramaAssetKindForType,
  isDramaAssetNodeType,
  readDramaAsset,
  readDramaBible,
  readDramaShot,
} from './drama-settings'

export interface DramaGraphNode {
  id: string
  type?: string
  data: {
    prompt?: string
    result?: { assetId?: string }
    settings?: Record<string, unknown>
  }
}

export interface DramaGraphEdge {
  source: string
  sourceHandle?: string | null
  target: string
  targetHandle?: string | null
}

export interface DramaShotAlert {
  nodeId: string
  shotId: string
  gate: DramaShotGate
  reason: string
}

function incoming(nodes: readonly DramaGraphNode[], edges: readonly DramaGraphEdge[], targetId: string): DramaGraphNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return edges
    .filter((edge) => edge.target === targetId)
    .flatMap((edge) => {
      const source = byId.get(edge.source)
      return source ? [source] : []
    })
}

export function connectedDramaAssets(nodes: readonly DramaGraphNode[], edges: readonly DramaGraphEdge[], shotId: string): DramaAssetData[] {
  return incoming(nodes, edges, shotId)
    .filter((node) => isDramaAssetNodeType(node.type))
    .map((node) => readDramaAsset(node.data.settings, dramaAssetKindForType(node.type ?? 'drama-character'), node.data.prompt))
}

export function connectedDramaBible(nodes: readonly DramaGraphNode[], edges: readonly DramaGraphEdge[], shotId: string): DramaBibleData | undefined {
  const bible = incoming(nodes, edges, shotId).find((node) => node.type === 'drama-bible')
    ?? nodes.find((node) => node.type === 'drama-bible')
  return bible ? readDramaBible(bible.data.settings, bible.data.prompt) : undefined
}

export function resolveDramaShotGate(nodes: readonly DramaGraphNode[], edges: readonly DramaGraphEdge[], shotId: string): {
  gate: DramaShotGate
  reason?: string
  assets: DramaAssetData[]
} {
  const assets = connectedDramaAssets(nodes, edges, shotId)
  const gate = dramaShotGate(assets)
  return { gate, reason: dramaShotBlockedReason(assets), assets }
}

export function compileConnectedShotPrompt(nodes: readonly DramaGraphNode[], edges: readonly DramaGraphEdge[], shotNode: DramaGraphNode): string {
  const shot = readDramaShot(shotNode.data.settings, shotNode.data.prompt)
  return compileShotImagePrompt({
    bible: connectedDramaBible(nodes, edges, shotNode.id),
    assets: connectedDramaAssets(nodes, edges, shotNode.id),
    shot,
  })
}

export function dramaPreflightBlockReasons(nodes: readonly DramaGraphNode[], edges: readonly DramaGraphEdge[]): Record<string, string> {
  const reasons: Record<string, string> = {}
  const blockedShotIds = new Set<string>()
  for (const node of nodes) {
    if (node.type !== 'drama-shot') continue
    const resolved = resolveDramaShotGate(nodes, edges, node.id)
    if (resolved.gate === 'blocked' && resolved.reason) {
      reasons[node.id] = resolved.reason
      blockedShotIds.add(node.id)
    }
  }
  if (blockedShotIds.size === 0) return reasons
  const queue = [...blockedShotIds]
  const seen = new Set(blockedShotIds)
  while (queue.length > 0) {
    const current = queue.pop() as string
    for (const edge of edges) {
      if (edge.source !== current || seen.has(edge.target)) continue
      seen.add(edge.target)
      queue.push(edge.target)
      const target = nodes.find((node) => node.id === edge.target)
      if (target && ['image', 'image-generate', 'image-edit'].includes(target.type ?? '')) {
        reasons[target.id] = reasons[current]
      }
    }
  }
  return reasons
}

export function collectDramaShotAlerts(nodes: readonly DramaGraphNode[], edges: readonly DramaGraphEdge[]): DramaShotAlert[] {
  return nodes.flatMap((node) => {
    if (node.type !== 'drama-shot') return []
    const shot = readDramaShot(node.data.settings, node.data.prompt)
    const resolved = resolveDramaShotGate(nodes, edges, node.id)
    const stored = shot.gate === 'stale' ? 'stale' : resolved.gate
    if (stored !== 'blocked' && stored !== 'stale') return []
    return [{
      nodeId: node.id,
      shotId: shot.shotId || node.id,
      gate: stored,
      reason: stored === 'stale' ? `分镜「${shot.shotId || node.id}」已过期，请重新编译生图提示词` : (resolved.reason || '请先封板定妆图'),
    }]
  })
}

export function markDownstreamShotsStale<T extends DramaGraphNode>(
  nodes: readonly T[],
  edges: readonly DramaGraphEdge[],
  assetNodeId: string,
): T[] {
  const shotIds = new Set(edges.filter((edge) => edge.source === assetNodeId).map((edge) => edge.target))
  return nodes.map((node) => {
    if (!shotIds.has(node.id) || node.type !== 'drama-shot') return node
    const shot = readDramaShot(node.data.settings, node.data.prompt)
    const compiled = Boolean(shot.compiledImagePrompt || node.data.prompt)
    const nextGate = markDramaShotStale(shot.gate, compiled)
    if (nextGate === shot.gate) return node
    return {
      ...node,
      data: {
        ...node.data,
        settings: { ...node.data.settings, gate: nextGate },
      },
    }
  })
}
