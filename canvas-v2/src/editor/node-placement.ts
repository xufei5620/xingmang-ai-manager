import { unresolvedMediaPlacementDimensions } from '../library/media-assets'
import type { AssetRef } from '../model'
import { usesMediaBoundLayout } from '../nodes/media-bound'

export interface CanvasPlacementNode {
  id?: string
  parentId?: string
  type?: string
  position: { x: number; y: number }
  width?: number
  height?: number
  measured?: { width?: number; height?: number }
  data?: { result?: AssetRef }
}

interface NodeDimensions {
  width: number
  height: number
}

const placementGap = 28
const maximumPlacementRing = 20

function positiveDimension(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function finiteRectangle(position: { x: number; y: number }, dimensions: NodeDimensions): boolean {
  return [position.x, position.y, position.x + dimensions.width + placementGap, position.y + dimensions.height + placementGap].every(Number.isFinite)
}

/** Group children use parent-local coordinates; all insertion obstacles are world rectangles. */
function placementObstacles(nodes: readonly CanvasPlacementNode[]): CanvasPlacementNode[] {
  const byId = new Map<string, CanvasPlacementNode>()
  for (const node of nodes) {
    if (node.id && byId.has(node.id)) throw new Error('节点标识重复，无法确认素材摆放位置，请重新打开工程')
    if (node.id) byId.set(node.id, node)
  }
  const positions = new Map<CanvasPlacementNode, { x: number; y: number }>()
  for (const node of nodes) {
    const path: CanvasPlacementNode[] = []
    const visited = new Set<CanvasPlacementNode>()
    let current: CanvasPlacementNode | undefined = node
    while (current && !positions.has(current)) {
      if (visited.has(current)) throw new Error('分组层级存在循环，无法确认素材摆放位置，请重新打开工程')
      if (!Number.isFinite(current.position.x) || !Number.isFinite(current.position.y)) throw new Error('节点位置无效，无法自动摆放素材')
      visited.add(current)
      path.push(current)
      const parent: CanvasPlacementNode | undefined = current.parentId ? byId.get(current.parentId) : undefined
      if (current.parentId && !parent) throw new Error('节点所属分组不存在，无法确认素材摆放位置，请重新打开工程')
      current = parent
    }
    let position = current ? positions.get(current)! : { x: 0, y: 0 }
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const entry = path[index]
      position = { x: position.x + entry.position.x, y: position.y + entry.position.y }
      if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) throw new Error('分组坐标超出范围，无法自动摆放素材')
      positions.set(entry, position)
    }
  }
  return nodes.map((node) => {
    const mediaBound = Boolean(node.data?.result && usesMediaBoundLayout(node.type ?? '', node.data.result.assetId))
    const reserved = node.data?.result && mediaBound
      ? unresolvedMediaPlacementDimensions(node.data.result) : null
    const width = positiveDimension(node.width, node.type === 'group' ? 560 : 280)
    const height = positiveDimension(node.height, node.type === 'group' ? 360 : 220)
    const obstacle = {
      position: positions.get(node)!,
      // Native metadata updates explicit media geometry before ResizeObserver
      // catches up. An old placeholder measurement must not shrink that box.
      width: Math.max(reserved?.width ?? 0, positiveDimension(node.measured?.width, width), mediaBound ? width : 0),
      height: Math.max(reserved?.height ?? 0, positiveDimension(node.measured?.height, height), mediaBound ? height : 0),
    }
    if (!finiteRectangle(obstacle.position, obstacle)) throw new Error('节点范围无效，无法自动摆放素材')
    return obstacle
  })
}

function overlaps(
  position: { x: number; y: number },
  dimensions: NodeDimensions,
  node: CanvasPlacementNode,
): boolean {
  const nodeWidth = node.measured?.width ?? node.width ?? 280
  const nodeHeight = node.measured?.height ?? node.height ?? 220
  return position.x < node.position.x + nodeWidth + placementGap
    && position.x + dimensions.width + placementGap > node.position.x
    && position.y < node.position.y + nodeHeight + placementGap
    && position.y + dimensions.height + placementGap > node.position.y
}

function ringOffsets(ring: number): Array<{ x: number; y: number }> {
  if (ring === 0) return [{ x: 0, y: 0 }]
  const offsets: Array<{ x: number; y: number }> = []
  for (let x = -ring; x <= ring; x += 1) offsets.push({ x, y: -ring })
  for (let y = -ring + 1; y <= ring; y += 1) offsets.push({ x: ring, y })
  for (let x = ring - 1; x >= -ring; x -= 1) offsets.push({ x, y: ring })
  for (let y = ring - 1; y > -ring; y -= 1) offsets.push({ x: -ring, y })
  return offsets
}

export function findAvailableCanvasPosition(
  nodes: readonly CanvasPlacementNode[],
  preferredCenter: { x: number; y: number },
  dimensions: NodeDimensions,
): { x: number; y: number } {
  if (![preferredCenter.x, preferredCenter.y, dimensions.width, dimensions.height].every(Number.isFinite) || dimensions.width <= 0 || dimensions.height <= 0) throw new Error('素材摆放位置或尺寸无效')
  const obstacles = placementObstacles(nodes)
  const origin = {
    x: preferredCenter.x - dimensions.width / 2,
    y: preferredCenter.y - dimensions.height / 2,
  }
  const stepX = dimensions.width + placementGap
  const stepY = dimensions.height + placementGap
  if (!finiteRectangle(origin, dimensions)) throw new Error('素材摆放位置或尺寸超出范围')
  for (let ring = 0; ring <= maximumPlacementRing; ring += 1) {
    for (const offset of ringOffsets(ring)) {
      const candidate = { x: origin.x + offset.x * stepX, y: origin.y + offset.y * stepY }
      if (finiteRectangle(candidate, dimensions) && !obstacles.some((node) => overlaps(candidate, dimensions, node))) return candidate
    }
  }
  // A large group may cover every bounded search ring. Never fall back into
  // that same group: below the entire graph is a guaranteed free location.
  const below = obstacles.reduce((bottom, node) => Math.max(bottom, node.position.y + node.height! + placementGap), origin.y)
  const fallback = { x: origin.x, y: below }
  if (!finiteRectangle(fallback, dimensions)) throw new Error('画布位置超出范围，无法自动摆放素材')
  return fallback
}
