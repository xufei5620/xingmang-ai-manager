import { finishLayerEditorTransaction, nextEditorLayerIdentity, selectedEditorLayerIds, selectedEditorLayerNodeIds, type LayerEditorSnapshot, type LayerEditorState } from './layer-editor-state'
import { imageLayerGroupParentId, materializeImageLayerGroups, reconcileImageLayerGroupLeaves } from './layer-group-model'
import { assertEditorLayerSnapshot, editorLayerCommonParent, editorLayerMergeBoundary } from './layer-editor-placement'
import { buildLayerDocumentReplayRecipe, resolveLayerDocumentFrame } from './layer-document-geometry'
import { maximumImageTransformInputs, parseImageTransformRecipe, type ImageLayer, type ImageLayerRecipe } from './recipe'

export type EditorLayerMergePlacement = 'upper' | 'lower'
export interface EditorLayerMergePlan {
  snapshot: LayerEditorSnapshot
  recipe: ImageLayerRecipe
  selectedIds: string[]
  placement: EditorLayerMergePlacement
  /** Position in the remaining bottom-to-top leaf array after removal. */
  insertionIndex: number
  rasterRecipe: ImageLayerRecipe
  width: number
  height: number
  replacement: Pick<ImageLayer, 'x' | 'y' | 'width' | 'height'>
  groupParentId: string | null
}
export interface EditorLayerMergeCandidate {
  recipe: ImageLayerRecipe
  ids: string[]
  replacementId: string
  sourceIndex: number
  removedGroupIds: string[]
  insertionIndex: number
  groupParentId: string | null
}

/** Complex blends and disjoint selections may change their interaction with
 * unselected backdrops. They produce candidates, never a losslessness claim;
 * the caller must show the actual encoded-PNG whole-document comparison. */
export function buildEditorLayerMergePlan(snapshot: LayerEditorSnapshot, options: { placement?: EditorLayerMergePlacement } = {}): EditorLayerMergePlan {
  if (Object.keys(options).some((key) => key !== 'placement') || options.placement !== undefined && options.placement !== 'upper' && options.placement !== 'lower') throw new Error('合并放置位置无效')
  const placement = options.placement ?? 'upper', selectedIds = selectedEditorLayerIds(snapshot)
  if (selectedIds.length < 2) throw new Error('请至少选择两个图层后合并')
  assertEditorLayerSnapshot(snapshot)
  const flat = materializeImageLayerGroups(snapshot.recipe), layers = selectedIds.map((id) => flat.layers[snapshot.ids.indexOf(id)])
  if (layers.some((layer) => layer.locked)) throw new Error('所选图层含锁定项，请先解锁；原图层已保留')
  if (layers.some((layer) => !layer.visible)) throw new Error('所选图层含隐藏项，请先显示或取消选择；不会丢弃隐藏内容')
  const sameLeafParent = selectedIds.every((id) => imageLayerGroupParentId(snapshot.recipe, id) === imageLayerGroupParentId(snapshot.recipe, selectedIds[0]))
  const nodes = !snapshot.selectedGroupId && sameLeafParent ? selectedIds : selectedEditorLayerNodeIds(snapshot)
  const groupParentId = editorLayerCommonParent(snapshot, nodes), insertionIndex = editorLayerMergeBoundary(snapshot, selectedIds, groupParentId, placement)
  const recipe = snapshot.recipe, frame = resolveLayerDocumentFrame(recipe)
  const rasterRecipe = buildLayerDocumentReplayRecipe({ ...flat, background: 'transparent', explicitLayers: true, layers })
  return { snapshot, recipe, selectedIds, placement, insertionIndex, rasterRecipe, width: frame.width, height: frame.height, groupParentId,
    replacement: { x: frame.offsetX ? -frame.offsetX / recipe.outputWidth : 0, y: frame.offsetY ? -frame.offsetY / recipe.outputHeight : 0, width: frame.width / recipe.outputWidth, height: frame.height / recipe.outputHeight } }
}

export function isCurrentEditorLayerMergePlan(snapshot: LayerEditorSnapshot, plan: EditorLayerMergePlan): boolean {
  return snapshot === plan.snapshot && snapshot.recipe === plan.recipe && JSON.stringify(selectedEditorLayerIds(snapshot)) === JSON.stringify(plan.selectedIds)
}

function verifyPlan(plan: EditorLayerMergePlan): void {
  if (!isCurrentEditorLayerMergePlan(plan.snapshot, plan)) throw new Error('图层或选择已变化，旧合并结果未应用，请重新选择后重试')
  const current = buildEditorLayerMergePlan(plan.snapshot, { placement: plan.placement })
  const fields = (value: EditorLayerMergePlan) => [value.selectedIds, value.placement, value.rasterRecipe, value.replacement, value.insertionIndex, value.width, value.height, value.groupParentId]
  if (JSON.stringify(fields(plan)) !== JSON.stringify(fields(current))) throw new Error('合并参数已变化，请重新确认；原图层已保留')
}

/** Pure exact candidate construction shared by native preview and final commit.
 * Unselected objects and relative order survive; an insertion always lies at a
 * complete sibling-block boundary, including partially retained child folders. */
export function buildEditorLayerMergeCandidate(plan: EditorLayerMergePlan, identity: { sourceIndex: number; replacementId: string }): EditorLayerMergeCandidate {
  verifyPlan(plan)
  const { sourceIndex, replacementId } = identity
  if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= maximumImageTransformInputs) throw new Error('合并后将超过 20 张图片来源，请先应用或整理来源；原图层已保留')
  if (typeof replacementId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(replacementId) || [...plan.snapshot.ids, ...(plan.recipe.layerGroups?.groups.map((group) => group.id) ?? [])].includes(replacementId)) throw new Error('合并图层身份已变化，请重新确认')
  const chosen = new Set(plan.selectedIds), ids = plan.snapshot.ids.filter((value) => !chosen.has(value)), layers = plan.recipe.layers.filter((_, index) => !chosen.has(plan.snapshot.ids[index]))
  const merged: ImageLayer = { sourceIndex, name: `合并图层（${plan.selectedIds.length}）`, ...plan.replacement, rotation: 0, opacity: 1, visible: true, locked: false, blend: 'source-over' }
  ids.splice(plan.insertionIndex, 0, replacementId); layers.splice(plan.insertionIndex, 0, merged)
  const recipe = reconcileImageLayerGroupLeaves({ ...plan.recipe, explicitLayers: true, layers }, ids, new Map([[replacementId, plan.groupParentId]]))
  parseImageTransformRecipe(recipe)
  const retained = new Set(recipe.layerGroups?.groups.map((group) => group.id) ?? [])
  return { recipe, ids, replacementId, sourceIndex, removedGroupIds: (plan.recipe.layerGroups?.groups ?? []).filter((group) => !retained.has(group.id)).map((group) => group.id), insertionIndex: plan.insertionIndex, groupParentId: plan.groupParentId }
}

/** The caller passes the exact previewed candidate. Recompute its fresh identity
 * and full recipe before adding one reversible history entry; previews allocate
 * neither identities nor history and cannot apply after source/session changes. */
export function commitEditorLayerMerge(state: LayerEditorState, plan: EditorLayerMergePlan, sourceIndex: number, expectedCandidate?: EditorLayerMergeCandidate): LayerEditorState {
  if (!isCurrentEditorLayerMergePlan(state.present, plan)) throw new Error('图层或选择已变化，旧合并结果未应用，请重新选择后重试')
  const current = finishLayerEditorTransaction(state), identity = nextEditorLayerIdentity(current)
  const candidate = buildEditorLayerMergeCandidate(plan, { sourceIndex, replacementId: identity.id })
  if (expectedCandidate && JSON.stringify(candidate) !== JSON.stringify(expectedCandidate)) throw new Error('预览候选或图层身份已变化，请重新预览确认；原图层已保留')
  return { ...current, sequence: identity.sequence, transaction: null, past: [...current.past.slice(-59), current.present], future: [], present: { ...current.present, recipe: candidate.recipe, ids: candidate.ids, selectedGroupId: null, selectedId: identity.id, selectedIds: [identity.id], anchorId: identity.id } }
}
