import { parseImageTransformRecipe, type ImageLayerGroup, type ImageLayerRecipe } from './recipe'
import { imageLayerGroupLeafIds, imageLayerGroupParentId } from './layer-group-model'
import type { LayerEditorSnapshot } from './layer-editor-state'

export type EditorLayerNodePosition = 'before' | 'inside' | 'after'
export interface EditorLayerNodeMove { recipe: ImageLayerRecipe; ids: string[] }

export function assertEditorLayerSnapshot(snapshot: LayerEditorSnapshot): void {
  const recipe = parseImageTransformRecipe(snapshot.recipe)
  if (recipe.kind !== 'layer' || recipe.layers.length !== snapshot.ids.length || new Set(snapshot.ids).size !== snapshot.ids.length
    || snapshot.ids.some((id) => typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id))
    || recipe.layerGroups && JSON.stringify(recipe.layerGroups.layerIds) !== JSON.stringify(snapshot.ids)) throw new Error('图层文档已变化，请重新打开编辑器')
}

export function editorLayerNodeLeaves(snapshot: LayerEditorSnapshot, id: string): string[] {
  if (snapshot.ids.includes(id)) return [id]
  const leaves = imageLayerGroupLeafIds(snapshot.recipe, id)
  if (!leaves.length) throw new Error('所选图层或组已变化，请重新选择')
  return leaves
}

/** Siblings are always in the document's bottom-to-top paint order. */
export function editorLayerSiblingNodes(snapshot: LayerEditorSnapshot, parentId: string | null): string[] {
  if (parentId) {
    const group = snapshot.recipe.layerGroups?.groups.find((value) => value.id === parentId)
    if (!group) throw new Error('目标组已变化，请重新选择')
    return group.children.slice()
  }
  return [...snapshot.ids, ...(snapshot.recipe.layerGroups?.groups.map((group) => group.id) ?? [])]
    .filter((id) => imageLayerGroupParentId(snapshot.recipe, id) === null)
    .sort((a, b) => snapshot.ids.indexOf(editorLayerNodeLeaves(snapshot, a)[0]) - snapshot.ids.indexOf(editorLayerNodeLeaves(snapshot, b)[0]))
}

export function editorLayerCommonParent(snapshot: LayerEditorSnapshot, nodes: readonly string[]): string | null {
  if (!nodes.length) throw new Error('请先选择需要整理的图层')
  function ancestors(id: string): Array<string | null> {
    const parents: Array<string | null> = [], seen = new Set<string>()
    let parent = imageLayerGroupParentId(snapshot.recipe, id)
    while (parent) {
      if (seen.has(parent)) throw new Error('图层组包含循环，请重新打开编辑器')
      seen.add(parent); parents.push(parent); parent = imageLayerGroupParentId(snapshot.recipe, parent)
    }
    return [...parents, null]
  }
  const paths = nodes.map(ancestors)
  return paths[0].find((id) => paths.every((path) => path.includes(id))) ?? null
}

/** Project arbitrary leaves onto whole direct-child blocks. An insertion inside
 * a retained child folder would split its flat interval and corrupt hierarchy. */
export function editorLayerMergeBoundary(snapshot: LayerEditorSnapshot, selectedIds: readonly string[], parentId: string | null, placement: 'upper' | 'lower'): number {
  const chosen = new Set(selectedIds), touched = editorLayerSiblingNodes(snapshot, parentId).filter((id) => editorLayerNodeLeaves(snapshot, id).some((leaf) => chosen.has(leaf)))
  if (!touched.length) throw new Error('合并位置已变化，请重新选择')
  const block = editorLayerNodeLeaves(snapshot, placement === 'upper' ? touched.at(-1)! : touched[0])
  const boundary = placement === 'upper' ? snapshot.ids.indexOf(block.at(-1)!) + 1 : snapshot.ids.indexOf(block[0])
  return snapshot.ids.slice(0, boundary).filter((id) => !chosen.has(id)).length
}

/** This pure tree rewrite does not create a history entry or alter leaf flags.
 * Callers enforce current selection and protection before committing the result. */
export function buildEditorLayerNodeMove(snapshot: LayerEditorSnapshot, nodes: readonly string[], targetId: string | null, position: EditorLayerNodePosition): EditorLayerNodeMove | null {
  assertEditorLayerSnapshot(snapshot)
  if (!['before', 'inside', 'after'].includes(position) || targetId === null && position !== 'inside') throw new Error('图层放置位置无效')
  if (!nodes.length) return null
  const selected = new Set(nodes), oldGroups = snapshot.recipe.layerGroups?.groups ?? [], known = new Set([...snapshot.ids, ...oldGroups.map((group) => group.id)])
  if (selected.size !== nodes.length || nodes.some((id) => !known.has(id)) || targetId !== null && !known.has(targetId)) throw new Error('所选图层或目标已变化，请重新选择')
  const movedLeaves = nodes.flatMap((id) => editorLayerNodeLeaves(snapshot, id))
  if (new Set(movedLeaves).size !== movedLeaves.length) throw new Error('不能重复移动父组和其中成员')
  if (targetId !== null && selected.has(targetId) && position !== 'inside') return null
  if (targetId !== null && nodes.some((id) => id === targetId || oldGroups.some((group) => group.id === id) && editorLayerNodeLeaves(snapshot, targetId).some((leaf) => editorLayerNodeLeaves(snapshot, id).includes(leaf)))) throw new Error('不能把图层组放入自身或自己的子项')
  const parentId = position === 'inside' ? targetId : imageLayerGroupParentId(snapshot.recipe, targetId!)
  if (position === 'inside' && targetId !== null && !oldGroups.some((group) => group.id === targetId)) throw new Error('只能移入图层组，或移到文档根目录')
  const roots = editorLayerSiblingNodes(snapshot, null).filter((id) => !selected.has(id))
  let groups = oldGroups.map((group) => ({ ...group, children: group.children.filter((child) => !selected.has(child)) }))
  const destination = parentId ? groups.find((group) => group.id === parentId)!.children : roots
  const offset = position === 'inside' ? destination.length : destination.indexOf(targetId!) + (position === 'after' ? 1 : 0)
  if (offset < 0 || position !== 'inside' && !destination.includes(targetId!)) throw new Error('目标层级已变化，请重新放置')
  destination.splice(offset, 0, ...nodes)
  for (let count = groups.length; count > 0; count--) {
    const empty = new Set(groups.filter((group) => !group.children.length).map((group) => group.id))
    if (!empty.size) break
    groups = groups.filter((group) => !empty.has(group.id)).map((group) => ({ ...group, children: group.children.filter((id) => !empty.has(id)) }))
    for (let index = roots.length - 1; index >= 0; index--) if (empty.has(roots[index])) roots.splice(index, 1)
  }
  const byId = new Map<string, ImageLayerGroup>(groups.map((group) => [group.id, group])), seen = new Set<string>()
  function expand(id: string): string[] {
    if (seen.has(id)) throw new Error('图层放置造成重复或循环，原层级已保留')
    seen.add(id)
    return byId.get(id)?.children.flatMap(expand) ?? [id]
  }
  const ids = roots.flatMap(expand)
  if (ids.length !== snapshot.ids.length || ids.some((id) => !snapshot.ids.includes(id))) throw new Error('图层放置不能丢失或增加内容')
  const layers = ids.map((id) => snapshot.recipe.layers[snapshot.ids.indexOf(id)])
  let recipe: ImageLayerRecipe = { ...snapshot.recipe, layers }
  if (groups.length) recipe = { ...recipe, layerGroups: { version: 1, layerIds: ids, groups } }
  else { const { layerGroups: _groups, ...flat } = recipe; recipe = flat }
  parseImageTransformRecipe(recipe)
  return JSON.stringify([recipe, ids]) === JSON.stringify([snapshot.recipe, snapshot.ids]) ? null : { recipe, ids }
}
