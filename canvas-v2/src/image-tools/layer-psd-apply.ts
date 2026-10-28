import type { CanvasImageAssetSummary } from '../host'
import type { BrowserImportedLayerPsd } from '../library/browser-layer-psd-import'
import type { ImageLayerRecipe } from './recipe'
import { imageTransformRecipeForNode, maximumImageTransformInputs, parseImageTransformRecipe } from './recipe'
import { appendEditorCustomLayer, beginLayerEditorTransaction, finishLayerEditorTransaction, type LayerEditorState } from './layer-editor-state'
import { buildCanvasUpstreamReferences } from '../components/upstream-references'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import type { Edge } from '@xyflow/react'
import { markNodeAndDescendantsDirty } from '../runtime/run-projection'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { maximumCoordinateMagnitude, maximumWorkflowEdges, maximumWorkflowNodes } from '../persistence/workflow-schema'
import { findAvailableCanvasPosition } from '../editor/node-placement'
import { maximumImageLayerGroups, parseImageLayerGroups } from './layer-group-model'

export interface LayerPsdApplyInput {
  recipe: ImageLayerRecipe
  initialRecipe: ImageLayerRecipe
  baseSourceAssetIds: string[]
  importedAssets: CanvasImageAssetSummary[]
}

export function appendEditorImportedLayers(state: LayerEditorState, document: BrowserImportedLayerPsd, sourceOffset: number): LayerEditorState {
  const current = finishLayerEditorTransaction(state), { outputWidth, outputHeight } = current.present.recipe
  if (!document.layers.length || current.present.recipe.layers.length + document.layers.length > maximumImageTransformInputs) throw new Error('导入后将超过 20 个图层，请先删除不需要的图层')
  if (!Number.isSafeInteger(sourceOffset) || sourceOffset < 0 || sourceOffset + document.layers.length > maximumImageTransformInputs) throw new Error('导入后将超过 20 张来源图片，请先应用或整理当前图层')
  const importedGrouping = document.layerGroups === undefined ? undefined : parseImageLayerGroups(document.layerGroups, document.layers.length)
  if ((current.present.recipe.layerGroups?.groups.length ?? 0) + (importedGrouping?.groups.length ?? 0) > maximumImageLayerGroups) throw new Error('导入后将超过 20 个图层组，请先解组不需要的编组；原文档保留')
  let next = beginLayerEditorTransaction(current)
  for (const [index, layer] of document.layers.entries()) {
    const x = layer.left / outputWidth, y = layer.top / outputHeight, width = layer.width / outputWidth, height = layer.height / outputHeight
    if (x < -2 || x > 2 || y < -2 || y > 2 || width < 0.001 || height < 0.001 || width > 4 || height > 4) throw new Error('PSD 图层尺寸或位置超出当前画布的编辑范围，请调整画布尺寸或整理 PSD 后重试')
    // appendEditorCustomLayer closes previous transactions, so combine its
    // prepared snapshots and explicitly retain one pre-import undo boundary.
    next = appendEditorCustomLayer(next, { sourceIndex: sourceOffset + index, name: layer.name, x, y, width, height, rotation: 0, opacity: layer.opacity, visible: layer.visible, blend: layer.blend, ...(layer.locked !== undefined ? { locked: layer.locked } : {}) })
  }
  if (importedGrouping) {
    const ids = next.present.ids, addedIds = ids.slice(current.present.ids.length)
    const mapping = new Map(importedGrouping.layerIds.map((id, index) => [id, addedIds[index]]))
    const existing = next.present.recipe.layerGroups, used = new Set([...ids, ...(existing?.groups.map((group) => group.id) ?? [])])
    let sequence = 0
    for (const group of importedGrouping.groups) {
      let id: string
      do { id = `psd-import-group-${++sequence}` } while (used.has(id))
      mapping.set(group.id, id); used.add(id)
    }
    const groups = [...existing?.groups ?? [], ...importedGrouping.groups.map((group) => ({ ...group, id: mapping.get(group.id)!, children: group.children.map((id) => mapping.get(id)!) }))]
    const recipe = parseImageTransformRecipe({ ...next.present.recipe, layerGroups: { version: 1, layerIds: ids, groups } })
    if (recipe.kind !== 'layer') throw new Error('PSD 图层组参数无效，原文档保留')
    const selectedId = addedIds.at(-1) ?? null
    next = { ...next, present: { ...next.present, recipe, selectedGroupId: null, selectedIds: addedIds, selectedId, anchorId: selectedId } }
  }
  return { ...next, transaction: null, past: [...current.past.slice(-59), current.present], future: [] }
}

/** Apply recipe, owned source nodes and their ordered edges in one graph edit.
 * Validate the live upstream snapshot before reconnecting any imported pixels. */
export function buildLayerPsdGraph(nodes: readonly CanvasNode[], edges: readonly Edge[], targetId: string, input: LayerPsdApplyInput, nextId: () => string): { nodes: CanvasNode[]; edges: Edge[]; importedCount: number } {
  const target = nodes.find((node) => node.id === targetId)
  if (!target || target.type !== 'image-layer') throw new Error('原图层节点已删除，请保留素材并重新打开编辑器')
  const byId = new Map(nodes.map((node) => [node.id, node])), visited = new Set<string>()
  let parent: CanvasNode | undefined = target
  let world = { ...target.position }
  while (parent) {
    if (visited.has(parent.id)) throw new Error('分组层级无效，请重新打开工程')
    visited.add(parent.id)
    if (parent.draggable === false || parent.data.__canvasLocked || parent.disabled) throw new Error('图层节点或所在分组已锁定，请解锁后再应用')
    if (!parent.parentId) break
    parent = byId.get(parent.parentId)
    if (!parent) throw new Error('原分组已变化，请重新打开图层编辑器')
    world = { x: world.x + parent.position.x, y: world.y + parent.position.y }
  }
  if (target.data.status === 'running') throw new Error('图层节点正在运行，请等待完成后再应用')
  const original = imageTransformRecipeForNode('image-layer', target.data.settings)
  if (JSON.stringify(original) !== JSON.stringify(parseImageTransformRecipe(input.initialRecipe))) throw new Error('原图层参数已变化，请重新打开编辑器；已上传素材仍保留在素材库')
  const references = (buildCanvasUpstreamReferences(nodes, edges, []).get(targetId) ?? []).filter((reference) => reference.kind === 'image')
  const baseIds = references.map((reference) => reference.asset?.assetId)
  if (references.some((reference) => reference.status !== 'ready') || JSON.stringify(baseIds) !== JSON.stringify(input.baseSourceAssetIds)) throw new Error('上游图片或连接顺序已变化，请重新打开编辑器；已上传素材仍保留在素材库')
  const recipe = parseImageTransformRecipe(input.recipe)
  if (recipe.kind !== 'layer' || !recipe.explicitLayers || input.importedAssets.length + baseIds.length > 20) throw new Error('PSD 图层配方或来源数量无效')
  if (input.importedAssets.some((asset) => asset.mediaType !== 'image' || asset.mimeType !== 'image/png' || !/^[A-Za-z0-9_-]{43}$/.test(asset.assetId) || asset.localUrl !== `xingmang-asset://image/${asset.assetId}` || asset.deletedAt)) throw new Error('导入图层没有有效的本人素材回执')
  const used = new Set(recipe.layers.filter((layer) => !layer.content).map((layer) => layer.sourceIndex))
  if ([...used].some((index) => index >= baseIds.length + input.importedAssets.length)) throw new Error('有图层缺少图片来源，请重新导入')
  const selected = input.importedAssets.map((asset, index) => ({ asset, index: baseIds.length + index })).filter(({ index }) => used.has(index))
  if (nodes.length + selected.length + (selected.length ? 1 : 0) > maximumWorkflowNodes || edges.length + selected.length > maximumWorkflowEdges) throw new Error('工程已达到节点或连线容量，请先拆分工程')
  const remap = new Map(selected.map(({ index }, order) => [index, baseIds.length + order]))
  const applied: ImageLayerRecipe = { ...recipe, layers: recipe.layers.map((layer) => !layer.content && remap.has(layer.sourceIndex) ? { ...layer, sourceIndex: remap.get(layer.sourceIndex)! } : layer) }
  const ids = new Set([...nodes.map((node) => node.id), ...edges.map((edge) => edge.id)])
  function id(): string { const value = nextId(); if (!value || ids.has(value)) throw new Error('新增图层节点标识重复，请重试'); ids.add(value); return value }
  const added: CanvasNode[] = [], addedEdges: Edge[] = []
  if (selected.length) {
    const groupId = id(), groupSize = { width: 620, height: Math.ceil(selected.length / 2) * 230 + 80 }
    const groupPosition = findAvailableCanvasPosition(nodes.filter((node) => !node.parentId), { x: world.x - 350, y: world.y + groupSize.height / 2 }, groupSize)
    if ([groupPosition.x, groupPosition.x + groupSize.width, groupPosition.y, groupPosition.y + groupSize.height].some((coordinate) => Math.abs(coordinate) > maximumCoordinateMagnitude)) throw new Error('画布位置超出范围，请将图层节点移近中心后导入')
    added.push({ id: groupId, type: 'group', definitionVersion: builtinNodeRegistry.require('group').version, position: groupPosition, ...groupSize, data: { prompt: '', model: '', status: 'idle', settings: { title: '图层图片素材' } } })
    for (const [{ asset }, order] of selected.map((item, index) => [item, index] as const)) {
      const nodeId = id()
      added.push({ id: nodeId, type: 'image-input', definitionVersion: builtinNodeRegistry.require('image-input').version, parentId: groupId, position: { x: 24 + order % 2 * 300, y: 60 + Math.floor(order / 2) * 230 }, width: 280, height: 210,
        data: { prompt: '', model: '', status: 'succeeded', result: { kind: 'image', assetId: asset.assetId, localUrl: asset.localUrl, mimeType: asset.mimeType, width: asset.width, height: asset.height } } })
      addedEdges.push({ id: id(), source: nodeId, sourceHandle: 'out:image', target: targetId, targetHandle: 'in:images' })
    }
  }
  const nextEdges = [...edges, ...addedEdges]
  const updated = markNodeAndDescendantsDirty([...nodes, ...added], nextEdges, targetId, { settings: { ...target.data.settings, imageTransform: applied } })
  return { nodes: updated, edges: nextEdges, importedCount: selected.length }
}
