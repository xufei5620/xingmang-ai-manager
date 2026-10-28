import type { CanvasListedAssetSummary } from '../host'
import type { EditorNodeRecord } from '../domain/node-definition'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { assetInputNodeKind, mediaAssetNodeDimensions, unresolvedMediaPlacementDimensions } from '../library/media-assets'
import { findAvailableCanvasPosition } from './node-placement'
import type { CanvasCommand } from '../store/canvas-command'
import type { WorkflowFile, WorkflowNodeData } from '../model'

export function buildAssetBatchNodes(existing: readonly EditorNodeRecord[], assets: readonly CanvasListedAssetSummary[], ids: readonly string[], center: { x: number; y: number }): Omit<Extract<CanvasCommand, { type: 'add-nodes' }>, 'nodes'> & { nodes: EditorNodeRecord<WorkflowNodeData & Record<string, unknown>>[] } {
  if (!assets.length || assets.length > 50 || ids.length !== assets.length || new Set(ids).size !== ids.length || ids.some((id) => !id || existing.some((node) => node.id === id)) || new Set(assets.map((asset) => asset.assetId)).size !== assets.length) throw new Error('素材或节点标识无效，请重新选择')
  if (assets.some((asset) => !/^[A-Za-z0-9_-]{43}$/.test(asset.assetId) || asset.deletedAt || !['image', 'video', 'audio'].includes(asset.mediaType) || asset.localUrl !== `xingmang-asset://${asset.mediaType}/${asset.assetId}`)) throw new Error('部分素材已回收或未保存，本次没有添加节点')
  const columns = Math.min(3, assets.length), rows = Math.ceil(assets.length / columns)
  const reserved = assets.map((asset) => unresolvedMediaPlacementDimensions(asset) ?? mediaAssetNodeDimensions(asset))
  const obstacles = existing.map((node) => { const fallback = builtinNodeRegistry.resolve(node.type)?.dimensions; return { ...node, width: node.width ?? fallback?.width, height: node.height ?? fallback?.height } })
  const origin = findAvailableCanvasPosition(obstacles, center, { width: (columns - 1) * 540 + Math.max(...reserved.map((size) => size.width)), height: (rows - 1) * 560 + Math.max(...reserved.map((size) => size.height)) })
  const added: EditorNodeRecord<WorkflowNodeData & Record<string, unknown>>[] = []
  for (const [index, asset] of assets.entries()) {
    const type = assetInputNodeKind(asset), definition = builtinNodeRegistry.require(type), dimensions = mediaAssetNodeDimensions(asset)
    const position = { x: origin.x + index % columns * 540, y: origin.y + Math.floor(index / columns) * 560 }
    added.push({ id: ids[index], type, definitionVersion: definition.version,
      position, ...dimensions,
      data: { prompt: '', model: '', status: 'succeeded', dirty: false, settings: { title: (asset.displayName || asset.fileName).slice(0, 160) },
        result: { kind: asset.mediaType, assetId: asset.assetId, localUrl: asset.localUrl, mimeType: asset.mimeType,
          ...('width' in asset && asset.width ? { width: asset.width } : {}), ...('height' in asset && asset.height ? { height: asset.height } : {}),
          ...('durationSeconds' in asset && asset.durationSeconds ? { durationSeconds: asset.durationSeconds } : {}) } },
    })
  }
  return { type: 'add-nodes', nodes: added }
}

export function buildAssetBatchWorkflow(assets: readonly CanvasListedAssetSummary[], createId: () => string): WorkflowFile {
  const command = buildAssetBatchNodes([], assets, assets.map(() => createId()), { x: 200, y: 240 })
  return { schemaVersion: 2, name: `素材创作 · ${assets.length} 项`, viewport: { x: 0, y: 0, zoom: .7 }, edges: [], nodes: command.nodes.map(({ type: _type, ...node }, index) => ({ ...node, kind: assetInputNodeKind(assets[index]), data: node.data })) }
}
