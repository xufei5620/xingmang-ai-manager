export interface CanvasPlacementNode {
  position: { x: number; y: number }
  width?: number
  height?: number
  measured?: { width?: number; height?: number }
}

interface NodeDimensions {
  width: number
  height: number
}

const placementGap = 28
const maximumPlacementRing = 20

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
  const origin = {
    x: preferredCenter.x - dimensions.width / 2,
    y: preferredCenter.y - dimensions.height / 2,
  }
  const stepX = dimensions.width + placementGap
  const stepY = dimensions.height + placementGap
  for (let ring = 0; ring <= maximumPlacementRing; ring += 1) {
    for (const offset of ringOffsets(ring)) {
      const candidate = { x: origin.x + offset.x * stepX, y: origin.y + offset.y * stepY }
      if (!nodes.some((node) => overlaps(candidate, dimensions, node))) return candidate
    }
  }
  return { x: origin.x, y: origin.y + (maximumPlacementRing + 1) * stepY }
}
