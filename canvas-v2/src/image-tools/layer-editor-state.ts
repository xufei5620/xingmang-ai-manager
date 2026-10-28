import { maximumImageTransformInputs, parseImageTransformRecipe, type ImageLayer, type ImageLayerGroup, type ImageLayerRecipe } from './recipe'
import { imageLayerGroupEffectiveState, imageLayerGroupLeafIds, imageLayerGroupParentId, maximumImageLayerGroups, parseImageLayerGroups, reconcileImageLayerGroupLeaves, type ImageLayerGroupEffectiveState } from './layer-group-model'
import type { LayerCanvasSelection } from './layer-paint-state'
import { imageLayerGeometryBounds, resizeLayerDocumentFrame } from './layer-document-geometry'
import { cropLayerDocumentRecipe, type LayerDocumentCropRect } from './layer-document-crop'
import { buildEditorLayerNodeMove, type EditorLayerNodePosition } from './layer-editor-placement'

export type LayerEditorTool = 'image' | 'text' | 'rectangle' | 'ellipse' | 'paint'
export type LayerResizeHandle = 'nw' | 'ne' | 'sw' | 'se'
export type LayerAlignment = 'left' | 'center-x' | 'right' | 'top' | 'center-y' | 'bottom'

export interface LayerEditorSnapshot {
  recipe: ImageLayerRecipe
  ids: string[]
  selectedId: string | null
  selectedGroupId?: string | null
  /** Session-only multi-selection; omitted snapshots retain single selection. */
  selectedIds?: string[]
  anchorId?: string | null
  /** Session-only selection history; never part of the saved image recipe. */
  canvasSelection?: LayerCanvasSelection | null
}

export interface LayerEditorState {
  past: LayerEditorSnapshot[]
  present: LayerEditorSnapshot
  future: LayerEditorSnapshot[]
  transaction: LayerEditorSnapshot | null
  sequence: number
}

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)) }
function cloneRecipe(recipe: ImageLayerRecipe): ImageLayerRecipe { return structuredClone(recipe) }
function sameDocument(left: LayerEditorSnapshot, right: LayerEditorSnapshot): boolean { return JSON.stringify([left.recipe, left.ids, left.canvasSelection ?? null]) === JSON.stringify([right.recipe, right.ids, right.canvasSelection ?? null]) }

export function defaultEditorImageLayer(sourceIndex: number): ImageLayer {
  return { sourceIndex, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true }
}

export function createLayerEditorState(initial: ImageLayerRecipe, sourceCount: number): LayerEditorState {
  if (initial.layerGroups) parseImageTransformRecipe(initial)
  const recipe = cloneRecipe(initial)
  if (!recipe.explicitLayers && !recipe.layers.length) recipe.layers = Array.from({ length: Math.min(maximumImageTransformInputs, sourceCount) }, (_, index) => defaultEditorImageLayer(index))
  recipe.explicitLayers = true
  if (recipe.layerGroups) parseImageLayerGroups(recipe.layerGroups, recipe.layers.length)
  const ids = recipe.layerGroups?.layerIds.slice() ?? recipe.layers.map((_, index) => `layer-${index + 1}`)
  const selectedId = ids.at(-1) ?? null
  const sequence = Math.max(ids.length, ...ids.map((id) => /^layer-\d{1,9}$/.test(id) ? Number(id.slice(6)) : 0))
  return { past: [], present: { recipe, ids, selectedId, selectedIds: selectedId ? [selectedId] : [], anchorId: selectedId }, future: [], transaction: null, sequence }
}

function layerIdentity(snapshot: LayerEditorSnapshot, sequence: number, reserved: ReadonlySet<string> = new Set()): { id: string; sequence: number } {
  const used = new Set([...snapshot.ids, ...(snapshot.recipe.layerGroups?.groups.map((group) => group.id) ?? []), ...reserved])
  const from = Number.isSafeInteger(sequence) && sequence >= 0 && sequence < 1_000_000_000 ? sequence : 0
  for (let offset = 1; offset <= used.size + 1; offset++) {
    const next = from + offset, id = `layer-${next}`
    if (!used.has(id)) return { id, sequence: next }
  }
  throw new Error('无法创建新的图层身份，请重新打开编辑器')
}

export function nextEditorLayerIdentity(state: LayerEditorState): { id: string; sequence: number } {
  return layerIdentity(state.present, state.sequence)
}

function commit(state: LayerEditorState, present: LayerEditorSnapshot): LayerEditorState {
  if (present.recipe.layerGroups && JSON.stringify(present.recipe.layerGroups.layerIds) !== JSON.stringify(present.ids)) present = { ...present, recipe: reconcileImageLayerGroupLeaves(present.recipe, present.ids) }
  const selection = selectedEditorLayerIds(present)
  const selectedGroupId = present.selectedGroupId && present.recipe.layerGroups?.groups.some((group) => group.id === present.selectedGroupId) ? present.selectedGroupId : null
  const selectedId = selectedGroupId ? null : present.selectedId && present.ids.includes(present.selectedId) ? present.selectedId : selection.at(-1) ?? null
  const selectedIds = selectedId && !selection.includes(selectedId) ? [selectedId] : selection
  present = { ...present, ...(present.selectedGroupId !== undefined || selectedGroupId ? { selectedGroupId } : {}), selectedId, selectedIds, anchorId: selectedId && !selection.includes(selectedId) ? selectedId : present.anchorId && present.ids.includes(present.anchorId) ? present.anchorId : selectedId }
  if (sameDocument(state.present, present)) return JSON.stringify([state.present.selectedId, state.present.selectedGroupId ?? null, selectedEditorLayerIds(state.present), state.present.anchorId ?? null]) === JSON.stringify([present.selectedId, selectedGroupId, selectedIds, present.anchorId]) ? state : { ...state, present }
  return { ...state, present, future: state.transaction ? state.future : [], past: state.transaction ? state.past : [...state.past.slice(-59), state.present] }
}

export function selectedEditorLayerIds(snapshot: LayerEditorSnapshot): string[] {
  const selected = new Set(snapshot.selectedIds ?? (snapshot.selectedId ? [snapshot.selectedId] : []))
  return snapshot.ids.filter((id) => selected.has(id))
}

export function selectEditorLayer(state: LayerEditorState, id: string | null, modifiers: { toggle?: boolean; range?: boolean } = {}): LayerEditorState {
  const { present } = state
  if (!id || !present.ids.includes(id)) return commit(state, { ...present, ...(present.selectedGroupId !== undefined ? { selectedGroupId: null } : {}), selectedId: null, selectedIds: [], anchorId: null })
  const previous = selectedEditorLayerIds(present), anchorId = present.anchorId && present.ids.includes(present.anchorId) ? present.anchorId : present.selectedId ?? id
  let selectedIds: string[], selectedId: string | null = id
  if (modifiers.range) {
    const from = present.ids.indexOf(anchorId), to = present.ids.indexOf(id)
    const range = present.ids.slice(Math.min(from, to), Math.max(from, to) + 1)
    const selection = new Set(modifiers.toggle ? [...previous, ...range] : range)
    selectedIds = present.ids.filter((value) => selection.has(value))
  } else if (modifiers.toggle) {
    const selection = new Set(previous)
    if (selection.has(id)) selection.delete(id); else selection.add(id)
    selectedIds = present.ids.filter((value) => selection.has(value))
    if (!selection.has(id)) selectedId = present.selectedId && selection.has(present.selectedId) ? present.selectedId : selectedIds.at(-1) ?? null
  } else selectedIds = [id]
  return commit(state, { ...present, ...(present.selectedGroupId !== undefined ? { selectedGroupId: null } : {}), selectedId, selectedIds, anchorId: modifiers.range ? anchorId : id })
}

function checkedEditorLayerIds(state: LayerEditorState, values: readonly string[]): string[] {
  const selected = new Set(values)
  if ([...selected].some((id) => !state.present.ids.includes(id))) throw new Error('所选图层已变化，请重新选择')
  return state.present.ids.filter((id) => selected.has(id))
}

function assertEditorLayersUnlocked(state: LayerEditorState, ids: readonly string[]): void {
  if (ids.some((id) => editorLayerEffectiveState(state.present, id).locked)) throw new Error('所选图层或父组含锁定项，请先解锁；本次没有修改任何图层')
}

export function patchEditorLayers(state: LayerEditorState, values: readonly string[], patch: { visible?: boolean; locked?: boolean }): LayerEditorState {
  const ids = checkedEditorLayerIds(state, values), selected = new Set(ids)
  if (!ids.length) return state
  if (Object.keys(patch).some((key) => !['visible', 'locked'].includes(key)) || Object.values(patch).some((value) => typeof value !== 'boolean')) throw new Error('批量图层属性无效')
  if (state.present.recipe.layerGroups) {
    const nodes = new Set(normalizedEditorLayerNodes(state.present, ids)), recipe = state.present.recipe, grouping = state.present.recipe.layerGroups
    const layers = recipe.layers.map((layer, index) => nodes.has(state.present.ids[index]) ? { ...layer, ...patch } : layer)
    return commit(state, { ...state.present, recipe: { ...recipe, layers, layerGroups: { ...grouping, groups: grouping.groups.map((group) => nodes.has(group.id) ? { ...group, ...patch } : group) } } })
  }
  const layers = state.present.recipe.layers.map((layer, index) => selected.has(state.present.ids[index]) ? { ...layer, ...patch } : layer)
  return commit(state, { ...state.present, recipe: { ...state.present.recipe, layers } })
}

export function deleteEditorLayers(state: LayerEditorState, values: readonly string[]): LayerEditorState {
  const selected = checkedEditorLayerIds(state, values), deleted = new Set(selected)
  if (!selected.length) return state
  assertEditorLayersUnlocked(state, selected)
  const ids = state.present.ids.filter((id) => !deleted.has(id)), remainingSelection = selectedEditorLayerIds(state.present).filter((id) => !deleted.has(id))
  const selectedId = state.present.selectedId && !deleted.has(state.present.selectedId) ? state.present.selectedId : remainingSelection.at(-1) ?? ids[Math.min(state.present.ids.indexOf(selected[0]), ids.length - 1)] ?? null
  return commit(state, { ...state.present, ids, selectedId, selectedIds: remainingSelection.length ? remainingSelection : selectedId ? [selectedId] : [], anchorId: selectedId, recipe: { ...state.present.recipe, layers: state.present.recipe.layers.filter((_, index) => !deleted.has(state.present.ids[index])) } })
}

export function duplicateEditorLayers(state: LayerEditorState, values: readonly string[]): LayerEditorState {
  const selected = checkedEditorLayerIds(state, values), chosen = new Set(selected)
  if (!selected.length) return state
  if (state.present.recipe.layerGroups) return duplicateEditorNodes(state, normalizedEditorLayerNodes(state.present, selected))
  if (state.present.ids.length + selected.length > maximumImageTransformInputs) throw new Error('复制后将超过 20 个图层，请减少选择；本次没有复制任何图层')
  const recipe = state.present.recipe, horizontal = imageLayerGeometryBounds(recipe.outputWidth, recipe.documentFrame?.offsetX), vertical = imageLayerGeometryBounds(recipe.outputHeight, recipe.documentFrame?.offsetY)
  const layers: ImageLayer[] = [], ids: string[] = [], selectedIds: string[] = []
  const parents = new Map<string, string | null>()
  let sequence = state.sequence, selectedId: string | null = null
  for (const [index, id] of state.present.ids.entries()) {
    const layer = recipe.layers[index]
    ids.push(id); layers.push(layer)
    if (!chosen.has(id)) continue
    const identity = layerIdentity(state.present, sequence, new Set(ids)), nextId = identity.id
    sequence = identity.sequence
    parents.set(nextId, imageLayerGroupParentId(recipe, id))
    ids.push(nextId); selectedIds.push(nextId)
    if (id === state.present.selectedId) selectedId = nextId
    layers.push({ ...structuredClone(layer), name: `${layer.name || '图层'} 副本`.slice(0, 80), locked: false, x: clamp(layer.x + .025, horizontal.minPosition, horizontal.maxPosition), y: clamp(layer.y + .025, vertical.minPosition, vertical.maxPosition) })
  }
  selectedId ??= selectedIds.at(-1) ?? null
  return { ...commit(state, { ...state.present, selectedGroupId: null, recipe: reconcileImageLayerGroupLeaves({ ...recipe, layers }, ids, parents), ids, selectedIds, selectedId, anchorId: selectedId }), sequence }
}

/** Move each selected run by one stack position. An edge or locked neighbour
 * blocks the whole operation, so a batch never partially reorders itself. */
export function reorderEditorLayers(state: LayerEditorState, values: readonly string[], direction: -1 | 1): LayerEditorState {
  const selected = checkedEditorLayerIds(state, values), chosen = new Set(selected)
  if (!selected.length) return state
  if (state.present.recipe.layerGroups) return reorderEditorNodes(state, normalizedEditorLayerNodes(state.present, selected), direction)
  assertEditorLayersUnlocked(state, selected)
  if (direction !== -1 && direction !== 1) throw new Error('图层排序方向无效')
  for (const id of selected) {
    const index = state.present.ids.indexOf(id), next = index + direction
    if (next < 0 || next >= state.present.ids.length) return state
    if (!chosen.has(state.present.ids[next]) && state.present.recipe.layers[next].locked) throw new Error('排序会经过锁定图层，请先解锁；本次没有修改图层顺序')
  }
  const ids = [...state.present.ids], layers = [...state.present.recipe.layers]
  const indices = direction === 1 ? [...ids.keys()].reverse() : [...ids.keys()]
  for (const index of indices) {
    const next = index + direction
    if (!chosen.has(ids[index]) || chosen.has(ids[next])) continue
    const previousId = ids[index], previousLayer = layers[index]
    ids[index] = ids[next]; ids[next] = previousId
    layers[index] = layers[next]; layers[next] = previousLayer
  }
  return commit(state, { ...state.present, ids, recipe: { ...state.present.recipe, layers } })
}

/** Use one shared, clamped delta so the selection's internal geometry remains
 * fixed even when one member reaches the supported physical boundary. */
export function moveEditorLayers(state: LayerEditorState, values: readonly string[], deltaX: number, deltaY: number): LayerEditorState {
  const selected = checkedEditorLayerIds(state, values), chosen = new Set(selected)
  if (!selected.length) return state
  assertEditorLayersUnlocked(state, selected)
  if (![deltaX, deltaY].every(Number.isFinite)) throw new Error('图层移动距离无效')
  const recipe = state.present.recipe, horizontal = imageLayerGeometryBounds(recipe.outputWidth, recipe.documentFrame?.offsetX), vertical = imageLayerGeometryBounds(recipe.outputHeight, recipe.documentFrame?.offsetY)
  const layers = recipe.layers.filter((_, index) => chosen.has(state.present.ids[index]))
  const x = clamp(deltaX / recipe.outputWidth, Math.max(...layers.map((layer) => horizontal.minPosition - layer.x)), Math.min(...layers.map((layer) => horizontal.maxPosition - layer.x)))
  const y = clamp(deltaY / recipe.outputHeight, Math.max(...layers.map((layer) => vertical.minPosition - layer.y)), Math.min(...layers.map((layer) => vertical.maxPosition - layer.y)))
  return commit(state, { ...state.present, recipe: { ...recipe, layers: recipe.layers.map((layer, index) => chosen.has(state.present.ids[index]) ? { ...layer, x: layer.x + x, y: layer.y + y } : layer) } })
}

export function moveSelectedEditorLayers(state: LayerEditorState, deltaX: number, deltaY: number): LayerEditorState {
  return moveEditorLayers(state, selectedEditorLayerIds(state.present), deltaX, deltaY)
}

export function beginLayerEditorTransaction(state: LayerEditorState): LayerEditorState {
  return state.transaction ? state : { ...state, transaction: state.present }
}

export function finishLayerEditorTransaction(state: LayerEditorState, cancel = false): LayerEditorState {
  if (!state.transaction) return state
  const before = state.transaction
  if (cancel) return { ...state, present: before, transaction: null }
  const changed = !sameDocument(before, state.present)
  return { ...state, transaction: null, future: changed ? [] : state.future, past: changed ? [...state.past.slice(-59), before] : state.past }
}

export function undoLayerEditor(state: LayerEditorState): LayerEditorState {
  const current = finishLayerEditorTransaction(state), previous = current.past.at(-1)
  return previous ? { ...current, present: previous, past: current.past.slice(0, -1), future: [current.present, ...current.future].slice(0, 60) } : current
}

export function redoLayerEditor(state: LayerEditorState): LayerEditorState {
  const current = finishLayerEditorTransaction(state), next = current.future[0]
  return next ? { ...current, present: next, past: [...current.past, current.present].slice(-60), future: current.future.slice(1) } : current
}

export function patchEditorRecipe(state: LayerEditorState, patch: Partial<Pick<ImageLayerRecipe, 'outputWidth' | 'outputHeight' | 'background'>>): LayerEditorState {
  const candidate = { ...state.present.recipe, ...patch, explicitLayers: true }
  if (candidate.documentFrame) {
    candidate.documentFrame = resizeLayerDocumentFrame(candidate.documentFrame, { width: candidate.outputWidth, height: candidate.outputHeight })
    const parsed = parseImageTransformRecipe(candidate)
    if (parsed.kind !== 'layer') throw new Error('图层文档参数无效')
    return commit(state, { ...state.present, recipe: candidate })
  }
  return commit(state, { ...state.present, recipe: candidate })
}

/** A document crop moves every layer, including locked/hidden/off-canvas ones,
 * in a single history entry. Session selections return with that same undo. */
export function applyEditorDocumentCrop(state: LayerEditorState, rect: LayerDocumentCropRect): LayerEditorState {
  const recipe = cropLayerDocumentRecipe(state.present.recipe, rect)
  if (recipe === state.present.recipe) return state
  const current = finishLayerEditorTransaction(state)
  return commit(current, { ...current.present, recipe, canvasSelection: null })
}

export function patchEditorLayer(state: LayerEditorState, id: string, patch: Partial<ImageLayer>): LayerEditorState {
  const index = state.present.ids.indexOf(id), layer = state.present.recipe.layers[index]
  if (!layer) return state
  const parentId = imageLayerGroupParentId(state.present.recipe, id)
  if (parentId && imageLayerGroupEffectiveState(state.present.recipe, parentId).locked && Object.keys(patch).some((key) => !['name', 'visible', 'locked'].includes(key))) return state
  if (layer.locked && Object.keys(patch).some((key) => !['locked', 'visible', 'name'].includes(key))) return state
  const layers = [...state.present.recipe.layers]
  layers[index] = { ...layer, ...structuredClone(patch) }
  return commit(state, { ...state.present, recipe: { ...state.present.recipe, layers } })
}

export function addEditorLayer(state: LayerEditorState, tool: LayerEditorTool, sourceIndex = 0): LayerEditorState {
  if (state.present.recipe.layers.length >= maximumImageTransformInputs) return state
  const identity = nextEditorLayerIdentity(state), number = identity.sequence, id = identity.id
  let layer: ImageLayer = { ...defaultEditorImageLayer(sourceIndex), name: `图片 ${number}` }
  if (tool === 'paint') layer = { ...layer, sourceIndex: 0, name: `绘画 ${number}`, content: { kind: 'paint' } }
  if (tool === 'text') layer = { ...layer, sourceIndex: 0, name: `文字 ${number}`, x: 0.1, y: 0.15, width: 0.8, height: 0.25, content: { kind: 'text', text: '输入文字', color: '#ffffff', fontSize: Math.max(16, Math.min(96, Math.round(state.present.recipe.outputWidth / 12))), fontFamily: 'sans-serif', fontWeight: 700, align: 'left' } }
  if (tool === 'rectangle' || tool === 'ellipse') layer = { ...layer, sourceIndex: 0, name: `${tool === 'ellipse' ? '椭圆' : '矩形'} ${number}`, x: 0.25, y: 0.25, width: 0.5, height: 0.5, content: { kind: 'shape', shape: tool, fill: '#a6ddc4', stroke: 'transparent', strokeWidth: 0 } }
  const next = commit(state, { ...state.present, selectedGroupId: null, recipe: { ...state.present.recipe, layers: [...state.present.recipe.layers, layer] }, ids: [...state.present.ids, id], selectedId: id })
  return { ...next, sequence: number }
}

/** Commit a prepared independent layer as one history step, including its mask. */
export function appendEditorCustomLayer(state: LayerEditorState, layer: ImageLayer): LayerEditorState {
  const current = finishLayerEditorTransaction(state)
  if (current.present.recipe.layers.length >= maximumImageTransformInputs) throw new Error('最多支持 20 个图层，请先删除不需要的图层')
  const identity = nextEditorLayerIdentity(current), number = identity.sequence, id = identity.id
  const ids = [...current.present.ids, id]
  const recipe = parseImageTransformRecipe(reconcileImageLayerGroupLeaves({ ...current.present.recipe, explicitLayers: true, layers: [...current.present.recipe.layers, layer] }, ids))
  if (recipe.kind !== 'layer') throw new Error('图层参数无效')
  return { ...commit(current, { ...current.present, selectedGroupId: null, recipe, ids, selectedId: id }), sequence: number }
}

export function duplicateEditorLayer(state: LayerEditorState, id: string): LayerEditorState {
  const index = state.present.ids.indexOf(id), layer = state.present.recipe.layers[index]
  if (!layer || state.present.recipe.layers.length >= maximumImageTransformInputs) return state
  const identity = nextEditorLayerIdentity(state), number = identity.sequence, nextId = identity.id, layers = [...state.present.recipe.layers], ids = [...state.present.ids]
  const recipe = state.present.recipe, horizontal = imageLayerGeometryBounds(recipe.outputWidth, recipe.documentFrame?.offsetX), vertical = imageLayerGeometryBounds(recipe.outputHeight, recipe.documentFrame?.offsetY)
  layers.splice(index + 1, 0, { ...structuredClone(layer), name: `${layer.name || '图层'} 副本`.slice(0, 80), locked: false, x: clamp(layer.x + 0.025, horizontal.minPosition, horizontal.maxPosition), y: clamp(layer.y + 0.025, vertical.minPosition, vertical.maxPosition) })
  ids.splice(index + 1, 0, nextId)
  return { ...commit(state, { ...state.present, selectedGroupId: null, recipe: reconcileImageLayerGroupLeaves({ ...state.present.recipe, layers }, ids, new Map([[nextId, imageLayerGroupParentId(recipe, id)]])), ids, selectedId: nextId }), sequence: number }
}

export function deleteEditorLayer(state: LayerEditorState, id: string): LayerEditorState {
  const index = state.present.ids.indexOf(id)
  if (index < 0 || editorLayerEffectiveState(state.present, id).locked) return state
  const ids = state.present.ids.filter((value) => value !== id)
  return commit(state, { ...state.present, recipe: { ...state.present.recipe, layers: state.present.recipe.layers.filter((_, i) => i !== index) }, ids, selectedId: ids[Math.min(index, ids.length - 1)] ?? null })
}

export function reorderEditorLayer(state: LayerEditorState, id: string, direction: -1 | 1): LayerEditorState {
  if (state.present.recipe.layerGroups) return reorderEditorLayers(state, [id], direction)
  const index = state.present.ids.indexOf(id), next = index + direction
  if (index < 0 || next < 0 || next >= state.present.ids.length || state.present.recipe.layers[index].locked) return state
  const layers = [...state.present.recipe.layers], ids = [...state.present.ids]
  const previousLayer = layers[index], previousId = ids[index]
  layers[index] = layers[next]; layers[next] = previousLayer
  ids[index] = ids[next]; ids[next] = previousId
  return commit(state, { ...state.present, recipe: { ...state.present.recipe, layers }, ids })
}

export function alignEditorLayer(state: LayerEditorState, id: string, alignment: LayerAlignment): LayerEditorState {
  const layer = state.present.recipe.layers[state.present.ids.indexOf(id)]
  if (!layer || editorLayerEffectiveState(state.present, id).locked) return state
  const angle = layer.rotation * Math.PI / 180, size = state.present.recipe
  const width = Math.abs(Math.cos(angle) * layer.width * size.outputWidth) + Math.abs(Math.sin(angle) * layer.height * size.outputHeight)
  const height = Math.abs(Math.sin(angle) * layer.width * size.outputWidth) + Math.abs(Math.cos(angle) * layer.height * size.outputHeight)
  const x = alignment === 'left' ? width / size.outputWidth / 2 - layer.width / 2 : alignment === 'right' ? 1 - width / size.outputWidth / 2 - layer.width / 2 : (1 - layer.width) / 2
  const y = alignment === 'top' ? height / size.outputHeight / 2 - layer.height / 2 : alignment === 'bottom' ? 1 - height / size.outputHeight / 2 - layer.height / 2 : (1 - layer.height) / 2
  const horizontal = imageLayerGeometryBounds(size.outputWidth, size.documentFrame?.offsetX), vertical = imageLayerGeometryBounds(size.outputHeight, size.documentFrame?.offsetY)
  return patchEditorLayer(state, id, ['left', 'right', 'center-x'].includes(alignment) ? { x: clamp(x, horizontal.minPosition, horizontal.maxPosition) } : { y: clamp(y, vertical.minPosition, vertical.maxPosition) })
}

export function moveEditorLayer(layer: ImageLayer, deltaX: number, deltaY: number, output: Pick<ImageLayerRecipe, 'outputWidth' | 'outputHeight' | 'documentFrame'>): Partial<ImageLayer> {
  if (layer.locked) return {}
  const horizontal = imageLayerGeometryBounds(output.outputWidth, output.documentFrame?.offsetX), vertical = imageLayerGeometryBounds(output.outputHeight, output.documentFrame?.offsetY)
  return { x: clamp(layer.x + deltaX / output.outputWidth, horizontal.minPosition, horizontal.maxPosition), y: clamp(layer.y + deltaY / output.outputHeight, vertical.minPosition, vertical.maxPosition) }
}

export function resizeEditorLayer(layer: ImageLayer, handle: LayerResizeHandle, deltaX: number, deltaY: number, output: Pick<ImageLayerRecipe, 'outputWidth' | 'outputHeight' | 'documentFrame'>, preserveRatio = false): Partial<ImageLayer> {
  if (layer.locked) return {}
  const angle = layer.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle), fx = layer.flipX ? -1 : 1, fy = layer.flipY ? -1 : 1
  const localX = cos * deltaX * fx + sin * deltaY * fy, localY = -sin * deltaX * fx + cos * deltaY * fy
  const sx = handle.endsWith('e') ? 1 : -1, sy = handle.startsWith('s') ? 1 : -1
  const oldWidth = layer.width * output.outputWidth, oldHeight = layer.height * output.outputHeight
  const horizontal = imageLayerGeometryBounds(output.outputWidth, output.documentFrame?.offsetX), vertical = imageLayerGeometryBounds(output.outputHeight, output.documentFrame?.offsetY)
  let width = clamp(oldWidth + sx * localX, output.outputWidth * horizontal.minSize, output.outputWidth * horizontal.maxSize)
  let height = clamp(oldHeight + sy * localY, output.outputHeight * vertical.minSize, output.outputHeight * vertical.maxSize)
  if (preserveRatio) {
    const desired = Math.abs(width / oldWidth - 1) > Math.abs(height / oldHeight - 1) ? width / oldWidth : height / oldHeight
    const factor = clamp(desired, Math.max(horizontal.minSize / layer.width, vertical.minSize / layer.height), Math.min(horizontal.maxSize / layer.width, vertical.maxSize / layer.height))
    width = oldWidth * factor; height = oldHeight * factor
  }
  const centerX = sx * (width - oldWidth) / 2, centerY = sy * (height - oldHeight) / 2
  return {
    width: width / output.outputWidth, height: height / output.outputHeight,
    x: clamp(layer.x + (oldWidth - width) / 2 / output.outputWidth + fx * (cos * centerX - sin * centerY) / output.outputWidth, horizontal.minPosition, horizontal.maxPosition),
    y: clamp(layer.y + (oldHeight - height) / 2 / output.outputHeight + fy * (sin * centerX + cos * centerY) / output.outputHeight, vertical.minPosition, vertical.maxPosition),
  }
}

export interface EditorLayerTreeRow extends ImageLayerGroupEffectiveState {
  id: string
  kind: 'layer' | 'group'
  depth: number
  leafIds: string[]
  layerIndex?: number
  group?: ImageLayerGroup
}

export function selectedEditorGroup(snapshot: LayerEditorSnapshot): ImageLayerGroup | null {
  return snapshot.recipe.layerGroups?.groups.find((group) => group.id === snapshot.selectedGroupId) ?? null
}

export function editorLayerEffectiveState(snapshot: LayerEditorSnapshot, id: string): ImageLayerGroupEffectiveState {
  if (snapshot.recipe.layerGroups) return imageLayerGroupEffectiveState(snapshot.recipe, id)
  const layer = snapshot.recipe.layers[snapshot.ids.indexOf(id)]
  if (!layer) throw new Error('所选图层已变化，请重新选择')
  return { visible: layer.visible, locked: !!layer.locked, ownVisible: layer.visible, ownLocked: !!layer.locked, parentId: null }
}

function editorNodeLeaves(snapshot: LayerEditorSnapshot, id: string): string[] {
  return snapshot.ids.includes(id) ? [id] : imageLayerGroupLeafIds(snapshot.recipe, id)
}

function editorSiblingNodes(snapshot: LayerEditorSnapshot, parentId: string | null): string[] {
  if (parentId) return snapshot.recipe.layerGroups?.groups.find((group) => group.id === parentId)?.children.slice() ?? []
  const groups = snapshot.recipe.layerGroups?.groups ?? []
  return [...snapshot.ids, ...groups.map((group) => group.id)].filter((id) => !imageLayerGroupParentId(snapshot.recipe, id))
    .sort((left, right) => snapshot.ids.indexOf(editorNodeLeaves(snapshot, left)[0]) - snapshot.ids.indexOf(editorNodeLeaves(snapshot, right)[0]))
}

/** A complete selected subtree is one node for batch folder operations. Partial
 * selections keep their own leaf identities and never pull in unselected leaves. */
function normalizedEditorLayerNodes(snapshot: LayerEditorSnapshot, values: readonly string[]): string[] {
  const selected = new Set(values), result: string[] = []
  function visit(id: string): void {
    const leaves = editorNodeLeaves(snapshot, id)
    if (leaves.length && leaves.every((leaf) => selected.has(leaf))) result.push(id)
    else {
      const group = snapshot.recipe.layerGroups?.groups.find((item) => item.id === id)
      for (const child of group?.children ?? []) visit(child)
    }
  }
  for (const root of editorSiblingNodes(snapshot, null)) visit(root)
  return result
}

export function selectedEditorLayerNodeIds(snapshot: LayerEditorSnapshot): string[] {
  const selected = selectedEditorLayerIds(snapshot), primary = selectedEditorGroup(snapshot)
  return primary && selected.length === imageLayerGroupLeafIds(snapshot.recipe, primary.id).length ? [primary.id] : normalizedEditorLayerNodes(snapshot, selected)
}

export function editorLayerTreeRows(snapshot: LayerEditorSnapshot): EditorLayerTreeRow[] {
  const result: EditorLayerTreeRow[] = []
  function visit(id: string, depth: number): void {
    const group = snapshot.recipe.layerGroups?.groups.find((value) => value.id === id), leafIds = editorNodeLeaves(snapshot, id)
    result.push({ id, kind: group ? 'group' : 'layer', depth, leafIds, ...editorLayerEffectiveState(snapshot, id), ...(group ? { group } : { layerIndex: snapshot.ids.indexOf(id) }) })
    if (group) for (const child of [...group.children].reverse()) visit(child, depth + 1)
  }
  for (const root of editorSiblingNodes(snapshot, null).reverse()) visit(root, 0)
  return result
}

export function selectEditorGroup(state: LayerEditorState, id: string, modifiers: { toggle?: boolean; range?: boolean } = {}): LayerEditorState {
  const leaves = imageLayerGroupLeafIds(state.present.recipe, id)
  if (!leaves.length || !state.present.recipe.layerGroups?.groups.some((group) => group.id === id)) throw new Error('所选组已变化，请重新选择')
  const previous = new Set(selectedEditorLayerIds(state.present)), selected = new Set(modifiers.toggle ? previous : [])
  const removing = modifiers.toggle && leaves.every((leaf) => selected.has(leaf))
  if (modifiers.range && state.present.anchorId) {
    const from = state.present.ids.indexOf(state.present.anchorId), to = state.present.ids.indexOf(leaves.at(-1)!)
    for (const leaf of state.present.ids.slice(Math.min(from, to), Math.max(from, to) + 1)) selected.add(leaf)
  } else for (const leaf of leaves) { if (removing) selected.delete(leaf); else selected.add(leaf) }
  const selectedIds = state.present.ids.filter((leaf) => selected.has(leaf))
  return commit(state, { ...state.present, selectedGroupId: removing ? null : id, selectedId: removing ? selectedIds.at(-1) ?? null : null, selectedIds, anchorId: modifiers.range ? state.present.anchorId : leaves[0] })
}

function nextEditorGroupId(recipe: ImageLayerRecipe, reserved: ReadonlySet<string> = new Set()): string {
  const used = new Set([...(recipe.layerGroups?.layerIds ?? []), ...(recipe.layerGroups?.groups.map((group) => group.id) ?? []), ...reserved])
  for (let value = 1; value <= 1000; value++) if (!used.has(`group-${value}`)) return `group-${value}`
  throw new Error('无法创建新的组身份，请重新打开编辑器')
}

function validateEditorGrouping(recipe: ImageLayerRecipe, ids: readonly string[]): ImageLayerRecipe {
  if (!recipe.layerGroups?.groups.length) { const { layerGroups: _groups, ...flat } = recipe; return flat }
  return { ...recipe, layerGroups: parseImageLayerGroups({ ...recipe.layerGroups, layerIds: [...ids] }, recipe.layers.length) }
}

export function groupEditorLayers(state: LayerEditorState, name = '新建组'): LayerEditorState {
  const snapshot = state.present, selected = selectedEditorLayerIds(snapshot)
  if (!selected.length) throw new Error('请先选择需要编组的图层或组')
  const primary = selectedEditorGroup(snapshot)
  const sameParent = selected.every((id) => imageLayerGroupParentId(snapshot.recipe, id) === imageLayerGroupParentId(snapshot.recipe, selected[0]))
  const nodes = primary && selected.length === imageLayerGroupLeafIds(snapshot.recipe, primary.id).length ? [primary.id] : sameParent ? selected : normalizedEditorLayerNodes(snapshot, selected)
  const parentId = imageLayerGroupParentId(snapshot.recipe, nodes[0])
  if (nodes.some((id) => imageLayerGroupParentId(snapshot.recipe, id) !== parentId)) throw new Error('编组需要同一父级的连续图层或组；请先整理层级，不会自动重排未选内容')
  const siblings = editorSiblingNodes(snapshot, parentId), start = siblings.indexOf(nodes[0])
  if (nodes.some((id, offset) => siblings[start + offset] !== id)) throw new Error('编组需要连续同级成员，避免改变未选图层的遮挡顺序')
  assertEditorLayersUnlocked(state, selected)
  const previous = snapshot.recipe.layerGroups, groups = previous?.groups ?? []
  if (groups.length >= maximumImageLayerGroups) throw new Error('最多支持 20 个图层组，请先解组或删除不需要的组')
  const id = nextEditorGroupId(snapshot.recipe), group: ImageLayerGroup = { id, name, children: nodes, visible: true, locked: false }
  const nextGroups = groups.map((value) => value.id === parentId ? { ...value, children: [...siblings.slice(0, start), id, ...siblings.slice(start + nodes.length)] } : value)
  const recipe = validateEditorGrouping({ ...snapshot.recipe, layerGroups: { version: 1, layerIds: snapshot.ids.slice(), groups: [...nextGroups, group] } }, snapshot.ids)
  return commit(state, { ...snapshot, recipe, selectedGroupId: id, selectedId: null, selectedIds: selected, anchorId: selected[0] })
}

export function patchEditorGroup(state: LayerEditorState, id: string, patch: { name?: string; visible?: boolean; locked?: boolean }): LayerEditorState {
  const grouping = state.present.recipe.layerGroups
  if (!grouping?.groups.some((group) => group.id === id)) throw new Error('所选组已变化，请重新选择')
  if (Object.keys(patch).some((key) => !['name', 'visible', 'locked'].includes(key))) throw new Error('图层组属性无效')
  const recipe = validateEditorGrouping({ ...state.present.recipe, layerGroups: { ...grouping, groups: grouping.groups.map((group) => group.id === id ? { ...group, ...patch } : group) } }, state.present.ids)
  return commit(state, { ...state.present, recipe })
}

export function ungroupEditorGroup(state: LayerEditorState, id: string): LayerEditorState {
  const snapshot = state.present, grouping = snapshot.recipe.layerGroups, group = grouping?.groups.find((value) => value.id === id)
  if (!group || !grouping) throw new Error('所选组已变化，请重新选择')
  const parentId = imageLayerGroupParentId(snapshot.recipe, id), chosen = new Set(group.children), selected = imageLayerGroupLeafIds(snapshot.recipe, id)
  if (parentId && imageLayerGroupEffectiveState(snapshot.recipe, parentId).locked) throw new Error('父组已锁定，请先解锁后再解组；原组与成员已保留')
  const groups = grouping.groups.filter((value) => value.id !== id).map((value) => {
    const children = value.id === parentId ? value.children.flatMap((child) => child === id ? group.children : [child]) : value.children
    return chosen.has(value.id) ? { ...value, children, visible: value.visible && group.visible, locked: value.locked || group.locked } : children === value.children ? value : { ...value, children }
  })
  const layers = snapshot.recipe.layers.map((layer, index) => chosen.has(snapshot.ids[index]) && (!group.visible || group.locked) ? { ...layer, visible: layer.visible && group.visible, locked: !!layer.locked || group.locked } : layer)
  const recipe = validateEditorGrouping({ ...snapshot.recipe, layers, layerGroups: { ...grouping, groups } }, snapshot.ids)
  return commit(state, { ...snapshot, recipe, selectedGroupId: null, selectedId: selected.at(-1) ?? null, selectedIds: selected, anchorId: selected[0] ?? null })
}

export function moveEditorGroup(state: LayerEditorState, id: string, deltaX: number, deltaY: number): LayerEditorState {
  const ids = imageLayerGroupLeafIds(state.present.recipe, id)
  if (!ids.length) throw new Error('所选组已变化，请重新选择')
  return moveEditorLayers(state, ids, deltaX, deltaY)
}

export function deleteEditorGroup(state: LayerEditorState, id: string): LayerEditorState {
  const ids = imageLayerGroupLeafIds(state.present.recipe, id)
  if (!ids.length) throw new Error('所选组已变化，请重新选择')
  return deleteEditorLayers(state, ids)
}

function duplicateEditorNodes(state: LayerEditorState, nodes: readonly string[]): LayerEditorState {
  const snapshot = state.present, recipe = snapshot.recipe, grouping = recipe.layerGroups
  if (!grouping || !nodes.length) return state
  const copyLeaves = nodes.flatMap((id) => editorNodeLeaves(snapshot, id))
  if (snapshot.ids.length + copyLeaves.length > maximumImageTransformInputs) throw new Error('复制后将超过 20 个图层，本次没有复制任何内容')
  function countGroups(id: string): number { const group = grouping!.groups.find((value) => value.id === id); return group ? 1 + group.children.reduce((sum, child) => sum + countGroups(child), 0) : 0 }
  if (grouping.groups.length + nodes.reduce((sum, id) => sum + countGroups(id), 0) > maximumImageLayerGroups) throw new Error('复制后将超过 20 个组，本次没有复制任何内容')
  const reserved = new Set<string>(), copiedRoots = new Map<string, string>(), parentCopies = new Map<string, string[]>(), addedGroups: ImageLayerGroup[] = [], copiedLayers: ImageLayer[] = [], copiedIds: string[] = []
  let sequence = state.sequence
  const horizontal = imageLayerGeometryBounds(recipe.outputWidth, recipe.documentFrame?.offsetX), vertical = imageLayerGeometryBounds(recipe.outputHeight, recipe.documentFrame?.offsetY)
  function copyNode(id: string, dx: number, dy: number, rootCopy = true): string {
    const group = grouping!.groups.find((value) => value.id === id)
    if (group) {
      const nextId = nextEditorGroupId(recipe, reserved); reserved.add(nextId)
      const children = group.children.map((child) => copyNode(child, dx, dy, false))
      addedGroups.push({ ...structuredClone(group), id: nextId, name: rootCopy ? `${group.name} 副本`.slice(0, 80) : group.name, children, locked: false })
      return nextId
    }
    const identity = layerIdentity(snapshot, sequence, reserved), nextId = identity.id
    sequence = identity.sequence
    reserved.add(nextId)
    const layer = recipe.layers[snapshot.ids.indexOf(id)]
    copiedIds.push(nextId); copiedLayers.push({ ...structuredClone(layer), ...(rootCopy ? { name: `${layer.name || '图层'} 副本`.slice(0, 80) } : {}), locked: false, x: layer.x + dx, y: layer.y + dy })
    return nextId
  }
  const additions = new Map<number, { ids: string[]; layers: ImageLayer[] }>()
  for (const id of nodes) {
    const leaves = editorNodeLeaves(snapshot, id), layers = leaves.map((leaf) => recipe.layers[snapshot.ids.indexOf(leaf)])
    const dx = clamp(.025, Math.max(...layers.map((layer) => horizontal.minPosition - layer.x)), Math.min(...layers.map((layer) => horizontal.maxPosition - layer.x)))
    const dy = clamp(.025, Math.max(...layers.map((layer) => vertical.minPosition - layer.y)), Math.min(...layers.map((layer) => vertical.maxPosition - layer.y)))
    const from = copiedIds.length, copyId = copyNode(id, dx, dy); copiedRoots.set(id, copyId)
    const parent = imageLayerGroupParentId(recipe, id)
    if (parent) parentCopies.set(parent, [...(parentCopies.get(parent) ?? []), id])
    additions.set(snapshot.ids.indexOf(leaves.at(-1)!), { ids: copiedIds.slice(from), layers: copiedLayers.slice(from) })
  }
  const ids: string[] = [], layers: ImageLayer[] = []
  for (const [index, id] of snapshot.ids.entries()) {
    ids.push(id); layers.push(recipe.layers[index])
    const added = additions.get(index)
    if (added) { ids.push(...added.ids); layers.push(...added.layers) }
  }
  const groups = grouping.groups.map((group) => parentCopies.has(group.id) ? { ...group, children: group.children.flatMap((child) => copiedRoots.has(child) ? [child, copiedRoots.get(child)!] : [child]) } : group).concat(addedGroups)
  const nextRecipe = validateEditorGrouping({ ...recipe, layers, layerGroups: { ...grouping, layerIds: ids, groups } }, ids)
  const primaryGroupId = snapshot.selectedGroupId ? copiedRoots.get(snapshot.selectedGroupId) ?? null : nodes.length === 1 && grouping.groups.some((group) => group.id === nodes[0]) ? copiedRoots.get(nodes[0])! : null
  return { ...commit(state, { ...snapshot, recipe: nextRecipe, ids, selectedGroupId: primaryGroupId, selectedId: primaryGroupId ? null : copiedIds.at(-1) ?? null, selectedIds: copiedIds, anchorId: copiedIds[0] ?? null }), sequence }
}

export function duplicateEditorGroup(state: LayerEditorState, id: string): LayerEditorState {
  if (!state.present.recipe.layerGroups?.groups.some((group) => group.id === id)) throw new Error('所选组已变化，请重新选择')
  return duplicateEditorNodes(state, [id])
}

function reorderEditorNodes(state: LayerEditorState, nodes: readonly string[], direction: -1 | 1): LayerEditorState {
  const snapshot = state.present, grouping = snapshot.recipe.layerGroups
  if (!grouping || !nodes.length) return state
  if (direction !== -1 && direction !== 1) throw new Error('图层排序方向无效')
  assertEditorLayersUnlocked(state, nodes.flatMap((id) => editorNodeLeaves(snapshot, id)))
  const parentId = imageLayerGroupParentId(snapshot.recipe, nodes[0])
  if (nodes.some((id) => imageLayerGroupParentId(snapshot.recipe, id) !== parentId)) throw new Error('排序需要同一父级的图层或组，请先分别选择；本次没有改变层级')
  const siblings = editorSiblingNodes(snapshot, parentId), selected = new Set(nodes)
  for (const id of nodes) {
    const index = siblings.indexOf(id), neighbour = siblings[index + direction]
    if (!neighbour) return state
    if (!selected.has(neighbour) && editorNodeLeaves(snapshot, neighbour).some((leaf) => editorLayerEffectiveState(snapshot, leaf).locked)) throw new Error('排序会经过锁定图层或组，请先解锁')
  }
  const order = direction === 1 ? [...siblings.keys()].reverse() : [...siblings.keys()]
  for (const index of order) {
    const next = index + direction
    if (selected.has(siblings[index]) && !selected.has(siblings[next])) [siblings[index], siblings[next]] = [siblings[next], siblings[index]]
  }
  const groups = grouping.groups.map((group) => group.id === parentId ? { ...group, children: siblings } : group), byId = new Map(groups.map((group) => [group.id, group]))
  function expand(id: string): string[] { return byId.get(id)?.children.flatMap(expand) ?? [id] }
  const ids = (parentId ? editorSiblingNodes(snapshot, null) : siblings).flatMap(expand), layers = ids.map((id) => snapshot.recipe.layers[snapshot.ids.indexOf(id)])
  const recipe = validateEditorGrouping({ ...snapshot.recipe, layers, layerGroups: { ...grouping, layerIds: ids, groups } }, ids)
  return commit(state, { ...snapshot, recipe, ids })
}

export function reorderEditorGroup(state: LayerEditorState, id: string, direction: -1 | 1): LayerEditorState {
  if (!state.present.recipe.layerGroups?.groups.some((group) => group.id === id)) throw new Error('所选组已变化，请重新选择')
  return reorderEditorNodes(state, [id], direction)
}

/** A drop is a single tree transaction. Explicit folders retain their subtree;
 * directly selected sibling leaves can leave even a one-leaf folder. */
export function moveEditorLayerNodes(state: LayerEditorState, targetId: string | null, position: EditorLayerNodePosition): LayerEditorState {
  const snapshot = state.present, selected = selectedEditorLayerIds(snapshot)
  if (!selected.length) return state
  const sameParent = selected.every((id) => imageLayerGroupParentId(snapshot.recipe, id) === imageLayerGroupParentId(snapshot.recipe, selected[0]))
  const nodes = !snapshot.selectedGroupId && sameParent ? selected : selectedEditorLayerNodeIds(snapshot)
  const changed = buildEditorLayerNodeMove(snapshot, nodes, targetId, position)
  if (!changed) return state
  assertEditorLayersUnlocked(state, selected)
  const parentId = position === 'inside' ? targetId : imageLayerGroupParentId(snapshot.recipe, targetId!)
  if (parentId && editorLayerEffectiveState(snapshot, parentId).locked) throw new Error('目标父组已锁定，请先解锁；原层级已保留')
  const chosen = new Set(selected)
  // A distant drop must not bypass the protected-neighbour rule of one-step
  // sorting. Check relative order against every unselected locked leaf.
  for (const id of snapshot.ids) if (!chosen.has(id) && editorLayerEffectiveState(snapshot, id).locked) {
    if (selected.some((leaf) => (snapshot.ids.indexOf(leaf) < snapshot.ids.indexOf(id)) !== (changed.ids.indexOf(leaf) < changed.ids.indexOf(id)))) throw new Error('放置会经过锁定图层或组，请先解锁；原层级已保留')
  }
  return commit(state, { ...snapshot, recipe: changed.recipe, ids: changed.ids })
}
