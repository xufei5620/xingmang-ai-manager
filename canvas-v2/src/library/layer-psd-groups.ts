import type { ImageLayerGrouping } from '../image-tools/recipe'
import { parseImageLayerGroups } from '../image-tools/layer-group-model'

export type LayerPsdRecordPlan = { kind: 'layer'; index: number } | { kind: 'folder'; id: string; name: string; visible: boolean; locked: boolean; divider: 1 | 3 }

/** Adobe section dividers bracket bottom-to-top raster records. Folder names
 * and flags are portable; internal workflow/group identities are never encoded. */
export function buildLayerPsdRecordPlan(layerCount: number, value?: ImageLayerGrouping, offset = 0): LayerPsdRecordPlan[] {
  if (!Number.isSafeInteger(layerCount) || layerCount < 1 || layerCount > 21 || ![0, 1].includes(offset)) throw new Error('PSD 图层编组或背景偏移无效')
  if (value === undefined) {
    if (offset) throw new Error('PSD 背景偏移需要明确的图层编组')
    return Array.from({ length: layerCount }, (_, index) => ({ kind: 'layer' as const, index }))
  }
  const grouping = parseImageLayerGroups(value, layerCount - offset)
  const groups = new Map(grouping.groups.map((group) => [group.id, group])), leaves = new Map(grouping.layerIds.map((id, index) => [id, index + offset]))
  const children = new Set(grouping.groups.flatMap((group) => group.children))
  function firstIndex(id: string): number {
    const group = groups.get(id)
    return group ? firstIndex(group.children[0]) : leaves.get(id)!
  }
  const roots = [...grouping.layerIds, ...groups.keys()].filter((id) => !children.has(id)).sort((left, right) => firstIndex(left) - firstIndex(right))
  const plan: LayerPsdRecordPlan[] = Array.from({ length: offset }, (_, index) => ({ kind: 'layer', index }))
  function append(id: string): void {
    const group = groups.get(id)
    if (!group) { plan.push({ kind: 'layer', index: leaves.get(id)! }); return }
    plan.push({ kind: 'folder', id, name: '</Layer group>', visible: true, locked: false, divider: 3 })
    for (const child of group.children) append(child)
    plan.push({ kind: 'folder', id, name: group.name, visible: group.visible, locked: group.locked, divider: 1 })
  }
  for (const root of roots) append(root)
  return plan
}
