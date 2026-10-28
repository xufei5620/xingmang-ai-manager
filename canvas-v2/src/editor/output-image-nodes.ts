import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { EditorNodeRecord } from '../domain/node-definition'
import type { CanvasImageAssetSummary } from '../host'
import { isImageTransformNodeKind } from '../image-tools/recipe'
import { mediaAssetNodeDimensions } from '../library/media-assets'
import type { AssetRef, WorkflowNodeData } from '../model'
import { stableAssetId } from '../persistence/workflow-schema'
import type { CanvasCommand } from '../store/canvas-command'
import { validateParentGraph } from './grouping'
import { findAvailableCanvasPosition } from './node-placement'

export type OutputImageSelection = 'current' | 'all'

function supportsImageSnapshot(kind: string): boolean { return isImageTransformNodeKind(kind) || kind === 'frame-extract' }

function placementMedia(node: EditorNodeRecord): { result: AssetRef } | undefined {
  const value = node.data.result
  if (!value || typeof value !== 'object' || !('kind' in value) || !['image', 'video', 'audio'].includes(String(value.kind))) return undefined
  if (value.kind !== 'image' && value.kind !== 'video' && value.kind !== 'audio') return undefined
  return { result: { kind: value.kind,
    ...('assetId' in value && typeof value.assetId === 'string' ? { assetId: value.assetId } : {}),
    ...('width' in value && typeof value.width === 'number' ? { width: value.width } : {}),
    ...('height' in value && typeof value.height === 'number' ? { height: value.height } : {}),
  } }
}

export function nodeOutputImageIds(kind: string, data: Pick<WorkflowNodeData, 'result' | 'candidateAssetIds'>, selection: OutputImageSelection): string[] {
  if (!supportsImageSnapshot(kind)) throw new Error('此节点不是本地图像处理或视频抽帧工具')
  if (selection === 'all') {
    if (kind !== 'image-grid-split') throw new Error('只有宫格裁剪支持放置全部切片')
    const ids = data.candidateAssetIds ?? []
    if (!ids.length || ids.length > 16 || ids.some((id) => !stableAssetId(id))) throw new Error('当前没有完整的已保存切片，请先运行宫格裁剪')
    return [...ids]
  }
  if (data.result?.kind !== 'image' || typeof data.result.assetId !== 'string' || !stableAssetId(data.result.assetId)) throw new Error('当前没有已保存的图片成品，请先运行此工具')
  return [data.result.assetId]
}

/** A result is a snapshot. No input edge is invented for an input-only node. */
export function buildOutputImageNodes(nodes: readonly EditorNodeRecord[], sourceId: string, assets: readonly CanvasImageAssetSummary[], ids: readonly string[]): Extract<CanvasCommand, { type: 'add-nodes' }> {
  const source = nodes.find((node) => node.id === sourceId)
  if (!source || !supportsImageSnapshot(source.type)) throw new Error('原图像工具已变化，本次没有添加图片')
  if (!validateParentGraph(nodes) || new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new Error('画布分组层级无效，请重新打开工程')
  if (!assets.length || assets.length > 16 || ids.length !== assets.length || new Set(ids).size !== ids.length || ids.some((id) => !id || nodes.some((node) => node.id === id))) throw new Error('图片输出标识无效，请重新放置')
  if (assets.some((asset) => !stableAssetId(asset.assetId) || asset.mediaType !== 'image' || asset.deletedAt || !asset.localUrl || !Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width! <= 0 || asset.height! <= 0)) throw new Error('图片成品尚不可读取，请在素材库中核对后重试')
  // A frame is the current saved result, including a clearly labelled previous
  // result after a timestamp edit. Never invent a batch or bind another image.
  if (source.type === 'frame-extract') {
    const result = source.data.result
    if (assets.length !== 1 || !result || typeof result !== 'object' || !('kind' in result) || result.kind !== 'image' || !('assetId' in result) || result.assetId !== assets[0].assetId) throw new Error('视频抽帧成品已变化，请重新核对当前图片后再放置')
  }
  const byId = new Map(nodes.map((node) => [node.id, node]))
  let position = { ...source.position }, parent = source.parentId ? byId.get(source.parentId) : undefined
  while (parent) { position = { x: position.x + parent.position.x, y: position.y + parent.position.y }; parent = parent.parentId ? byId.get(parent.parentId) : undefined }
  const sourceDefinition = builtinNodeRegistry.require(source.type)
  const sourceWidth = source.width ?? sourceDefinition.dimensions.width
  const sourceHeight = source.height ?? sourceDefinition.dimensions.height
  const title = source.data.settings && typeof source.data.settings === 'object' && typeof Reflect.get(source.data.settings, 'title') === 'string'
    ? String(Reflect.get(source.data.settings, 'title')).trim() || sourceDefinition.title : sourceDefinition.title
  const definition = builtinNodeRegistry.require('image-input')
  const added: EditorNodeRecord[] = []
  for (const [index, asset] of assets.entries()) {
    const dimensions = mediaAssetNodeDimensions(asset)
    const center = { x: position.x + sourceWidth + 60 + dimensions.width / 2, y: position.y + sourceHeight / 2 }
    const obstacles = [...nodes, ...added].map((node) => {
      const fallback = builtinNodeRegistry.resolve(node.type)?.dimensions
      return { ...node, data: placementMedia(node), width: node.width ?? fallback?.width, height: node.height ?? fallback?.height }
    })
    added.push({ id: ids[index], type: 'image-input', definitionVersion: definition.version,
      position: findAvailableCanvasPosition(obstacles, center, dimensions), ...dimensions,
      data: { prompt: '', model: '', status: 'succeeded', dirty: false,
        settings: { title: `${title} ${assets.length > 1 ? `切片 ${index + 1}` : '成品'}`.slice(0, 160) },
        result: { kind: 'image', assetId: asset.assetId, localUrl: asset.localUrl, mimeType: asset.mimeType, width: asset.width, height: asset.height } },
    })
  }
  return { type: 'add-nodes', nodes: added }
}
