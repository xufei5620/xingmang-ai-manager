import type { ImageLayerRecipe } from './recipe'

export const maximumImageLayerGroups = 20
export const maximumImageLayerGroupDepth = 4
export interface ImageLayerGroup { id: string; name: string; children: string[]; visible: boolean; locked: boolean }
export interface ImageLayerGrouping { version: 1; layerIds: string[]; groups: ImageLayerGroup[] }
export interface ImageLayerGroupEffectiveState { visible: boolean; locked: boolean; ownVisible: boolean; ownLocked: boolean; parentId: string | null }

function fail(): never { throw new Error('图层编组无效：需要唯一身份、连续有序成员和单一父组，最多 20 个组、4 层嵌套') }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) fail()
  return value as Record<string, unknown>
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)) fail()
  return value
}

/** Groups are pass-through organizational nodes, never isolated composites.
 * Every subtree is a contiguous interval in the unchanged flat paint order. */
export function parseImageLayerGroups(value: unknown, leafCount: number): ImageLayerGrouping {
  const input = object(value, ['version', 'layerIds', 'groups'])
  if (input.version !== 1 || !Number.isSafeInteger(leafCount) || leafCount < 1 || leafCount > 20 || !Array.isArray(input.layerIds) || input.layerIds.length !== leafCount || !Array.isArray(input.groups) || !input.groups.length || input.groups.length > maximumImageLayerGroups) fail()
  const layerIds = input.layerIds.map(identity), ids = new Set(layerIds)
  if (ids.size !== layerIds.length) fail()
  const groups = input.groups.map((value): ImageLayerGroup => {
    const item = object(value, ['id', 'name', 'children', 'visible', 'locked']), id = identity(item.id)
    if (ids.has(id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80 || /[\x00-\x1f\x7f]/.test(item.name) || /[\uD800-\uDFFF]/u.test(item.name) || !Array.isArray(item.children) || !item.children.length || item.children.length > 20 || typeof item.visible !== 'boolean' || typeof item.locked !== 'boolean') fail()
    ids.add(id)
    return { id, name: item.name, children: item.children.map(identity), visible: item.visible, locked: item.locked }
  })
  const byId = new Map(groups.map((group) => [group.id, group])), parent = new Map<string, string>()
  for (const group of groups) for (const child of group.children) {
    if (!ids.has(child) || parent.has(child) || child === group.id) fail()
    parent.set(child, group.id)
  }
  const seen = new Set<string>(), active = new Set<string>()
  function visit(id: string, depth: number): string[] {
    const group = byId.get(id)
    if (!group) return [id]
    if (depth > maximumImageLayerGroupDepth || active.has(id) || seen.has(id)) fail()
    active.add(id); seen.add(id)
    const leaves = group.children.flatMap((child) => visit(child, depth + 1))
    active.delete(id)
    const start = layerIds.indexOf(leaves[0])
    if (leaves.some((leaf, offset) => layerIds[start + offset] !== leaf)) fail()
    return leaves
  }
  for (const group of groups) if (!parent.has(group.id)) visit(group.id, 1)
  if (seen.size !== groups.length) fail()
  return { version: 1, layerIds, groups }
}

export function imageLayerGroupLeafIds(recipe: ImageLayerRecipe, id: string): string[] {
  const grouping = recipe.layerGroups
  if (!grouping) return []
  const groups = new Map(grouping.groups.map((group) => [group.id, group])), knownLeaves = new Set(grouping.layerIds), seen = new Set<string>()
  function collect(value: string): string[] {
    if (seen.has(value)) fail()
    seen.add(value)
    const group = groups.get(value)
    return group ? group.children.flatMap(collect) : knownLeaves.has(value) ? [value] : []
  }
  return collect(id)
}

export function imageLayerGroupParentId(recipe: ImageLayerRecipe, id: string): string | null {
  return recipe.layerGroups?.groups.find((group) => group.children.includes(id))?.id ?? null
}

export function imageLayerGroupEffectiveState(recipe: ImageLayerRecipe, id: string): ImageLayerGroupEffectiveState {
  const grouping = recipe.layerGroups, group = grouping?.groups.find((value) => value.id === id), layer = grouping ? recipe.layers[grouping.layerIds.indexOf(id)] : undefined
  if (!group && !layer) throw new Error('所选图层或组已变化，请重新选择')
  const ownVisible = group?.visible ?? layer!.visible, ownLocked = group?.locked ?? !!layer!.locked
  let visible = ownVisible, locked = ownLocked, parentId = imageLayerGroupParentId(recipe, id), cursor = parentId
  const seen = new Set<string>()
  while (cursor) {
    if (seen.has(cursor)) fail()
    seen.add(cursor)
    const ancestor = grouping?.groups.find((value) => value.id === cursor)
    if (!ancestor) fail()
    visible = visible && ancestor.visible; locked = locked || ancestor.locked
    cursor = imageLayerGroupParentId(recipe, cursor)
  }
  return { visible, locked, ownVisible, ownLocked, parentId }
}

/** Rendering subsets must not retain identities for removed leaves. This copy
 * applies inherited flags without mutating the persistent leaf or group flags. */
export function materializeImageLayerGroups(recipe: ImageLayerRecipe): ImageLayerRecipe {
  if (!recipe.layerGroups) return recipe
  const { layerGroups, ...flat } = recipe
  return { ...flat, layers: recipe.layers.map((layer, index) => {
    const effective = imageLayerGroupEffectiveState(recipe, layerGroups.layerIds[index])
    return effective.visible === layer.visible && effective.locked === !!layer.locked ? layer : { ...layer, visible: effective.visible, locked: effective.locked }
  }) }
}

/** Leaf-only commands retain folder membership. New leaves are root siblings
 * unless their caller explicitly supplies a parent (for example duplication). */
export function reconcileImageLayerGroupLeaves(recipe: ImageLayerRecipe, layerIds: readonly string[], parentByAddedId: ReadonlyMap<string, string | null> = new Map()): ImageLayerRecipe {
  if (!recipe.layerGroups) return recipe
  const grouping = recipe.layerGroups, leaves = new Set(layerIds), originalLeaves = new Set(grouping.layerIds), allGroups = new Set(grouping.groups.map((group) => group.id))
  let groups = grouping.groups.map((group) => ({ ...group, children: group.children.filter((child) => leaves.has(child) || allGroups.has(child)) }))
  for (const id of layerIds) if (!originalLeaves.has(id)) {
    const parentId = parentByAddedId.get(id)
    if (parentId) {
      const parent = groups.find((group) => group.id === parentId)
      if (!parent) fail()
      parent.children.push(id)
    }
  }
  for (let remaining = groups.length; remaining > 0; remaining--) {
    const empty = new Set(groups.filter((group) => !group.children.length).map((group) => group.id))
    if (!empty.size) break
    groups = groups.filter((group) => !empty.has(group.id)).map((group) => ({ ...group, children: group.children.filter((child) => !empty.has(child)) }))
  }
  if (!groups.length) { const { layerGroups: _groups, ...flat } = recipe; return flat }
  const byId = new Map(groups.map((group) => [group.id, group])), active = new Set<string>()
  function position(id: string): number {
    const group = byId.get(id)
    if (!group) return layerIds.indexOf(id)
    if (active.has(id)) fail()
    active.add(id)
    const value = Math.min(...group.children.map(position)); active.delete(id)
    return value
  }
  groups = groups.map((group) => ({ ...group, children: [...group.children].sort((left, right) => position(left) - position(right)) }))
  const next = parseImageLayerGroups({ version: 1, layerIds: [...layerIds], groups }, recipe.layers.length)
  return { ...recipe, layerGroups: next }
}
