import type { EditorNodeRecord } from '../domain/node-definition'
import { maximumCoordinateMagnitude } from '../persistence/workflow-schema'
import { alignNodePositions, distributeNodePositions, type CanvasAlignMode, type CanvasDistributeAxis } from './align'
import { validateParentGraph } from './grouping'

export type CanvasSelectionLayout = { kind: 'align'; mode: CanvasAlignMode } | { kind: 'distribute'; axis: CanvasDistributeAxis }

export interface CanvasSelectionLayoutResult {
  nodes: EditorNodeRecord[]
  changed: boolean
  selectedRootIds: string[]
  lockedRootCount: number
}

function width(node: EditorNodeRecord): number { return node.width ?? (node.type === 'group' ? 560 : 280) }
function height(node: EditorNodeRecord): number { return node.height ?? (node.type === 'group' ? 360 : 220) }
function geometryChanged(before: EditorNodeRecord, after: EditorNodeRecord): boolean {
  return before.position.x !== after.position.x || before.position.y !== after.position.y || before.width !== after.width || before.height !== after.height
}

/**
 * Align in world coordinates, then grow containers without moving their other
 * contents. The caller commits the returned graph in one replace-nodes command;
 * no intermediate negative child position reaches React Flow's parent extent.
 */
export function layoutCanvasSelection(nodes: readonly EditorNodeRecord[], selectedIds: readonly string[], operation: CanvasSelectionLayout): CanvasSelectionLayoutResult {
  const originals = new Map(nodes.map((node) => [node.id, node]))
  if (originals.size !== nodes.length || !validateParentGraph(nodes)) throw new Error('分组层级无效，请重新打开工程后再对齐')
  if (nodes.some((node) => !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y) || !Number.isFinite(width(node)) || !Number.isFinite(height(node)) || width(node) <= 0 || height(node) <= 0)) throw new Error('节点尺寸或位置无效，请重新打开工程后再对齐')
  const selected = new Set(selectedIds)
  if ([...selected].some((id) => !originals.has(id))) throw new Error('选中的节点已发生变化，请重新选择')
  const lineage = new Map(nodes.map((node) => {
    const ids: string[] = []
    let current = node
    while (current.parentId) { ids.push(current.parentId); current = originals.get(current.parentId)! }
    return [node.id, ids] as const
  }))
  const roots = nodes.filter((node) => selected.has(node.id) && !lineage.get(node.id)!.some((id) => selected.has(id)))
  const selectedRootIds = roots.map((node) => node.id)
  const result = nodes.map((node) => structuredClone(node))
  const resultById = new Map(result.map((node) => [node.id, node]))
  const absolute = new Map(nodes.map((node) => [node.id, lineage.get(node.id)!.reduce((position, id) => ({ x: position.x + originals.get(id)!.position.x, y: position.y + originals.get(id)!.position.y }), { ...node.position })]))
  const lockedContainers = new Set(nodes.filter((node) => node.locked).flatMap((node) => lineage.get(node.id)!))
  const boxes = roots.map((node) => ({ id: node.id, position: absolute.get(node.id)!, width: width(node), height: height(node), locked: Boolean(node.locked || lineage.get(node.id)!.some((id) => originals.get(id)!.locked) || lockedContainers.has(node.id)) }))
  const positions = operation.kind === 'align' ? alignNodePositions(boxes, operation.mode) : distributeNodePositions(boxes, operation.axis)
  const containers = new Set<string>()
  for (const [id, position] of Object.entries(positions)) {
    const node = resultById.get(id)!
    const before = absolute.get(id)!
    node.position = { x: node.position.x + position.x - before.x, y: node.position.y + position.y - before.y }
    lineage.get(id)!.forEach((parent) => containers.add(parent))
  }
  const children = new Map<string, EditorNodeRecord[]>()
  for (const node of result) {
    if (!node.parentId) continue
    const siblings = children.get(node.parentId)
    if (siblings) siblings.push(node)
    else children.set(node.parentId, [node])
  }
  // Left/top growth moves the frame and compensates every direct child. This
  // also preserves the absolute position of unselected nested descendants.
  for (const id of [...containers].sort((a, b) => lineage.get(b)!.length - lineage.get(a)!.length)) {
    const group = resultById.get(id)!
    const contents = children.get(id) ?? []
    if (!contents.length) continue
    const shiftX = Math.min(0, ...contents.map((node) => node.position.x - 32))
    const shiftY = Math.min(0, ...contents.map((node) => node.position.y - 96))
    const nextWidth = Math.max(width(group), ...contents.map((node) => node.position.x + width(node) + 32)) - shiftX
    const nextHeight = Math.max(height(group), ...contents.map((node) => node.position.y + height(node) + 32)) - shiftY
    if (!shiftX && !shiftY && nextWidth === width(group) && nextHeight === height(group)) continue
    if (group.locked || lineage.get(id)!.some((parent) => originals.get(parent)!.locked)) throw new Error('对齐需要移动或扩展锁定分组，请先解锁后重试；本次未改变任何节点')
    group.position = { x: group.position.x + shiftX, y: group.position.y + shiftY }
    group.width = nextWidth
    group.height = nextHeight
    for (const child of contents) child.position = { x: child.position.x - shiftX, y: child.position.y - shiftY }
  }
  if (result.some((node) => Math.abs(node.position.x) > maximumCoordinateMagnitude || Math.abs(node.position.y) > maximumCoordinateMagnitude || !Number.isFinite(width(node)) || !Number.isFinite(height(node)))) throw new Error('对齐后的分组范围过大，请先缩小节点间距；本次未改变任何节点')
  return { nodes: result, changed: result.some((node) => geometryChanged(originals.get(node.id)!, node)), selectedRootIds, lockedRootCount: boxes.filter((node) => node.locked).length }
}
