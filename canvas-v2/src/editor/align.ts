export type CanvasAlignMode = 'left' | 'horizontal-center' | 'right' | 'top' | 'vertical-center' | 'bottom'
export type CanvasDistributeAxis = 'horizontal' | 'vertical'

export interface AlignableNode {
  id: string
  position: { x: number; y: number }
  width: number
  height: number
  locked?: boolean
}

export type NodePositions = Record<string, { x: number; y: number }>

function movable(nodes: readonly AlignableNode[]): AlignableNode[] {
  return nodes.filter((node) => !node.locked)
}

/**
 * Align against the bounding box of the whole selection, including any locked
 * members. Locked nodes anchor the result but never move, which is what a user
 * means by locking one node and aligning the rest to it.
 */
export function alignNodePositions(nodes: readonly AlignableNode[], mode: CanvasAlignMode): NodePositions {
  const targets = movable(nodes)
  if (nodes.length < 2 || targets.length === 0) return {}

  const left = Math.min(...nodes.map((node) => node.position.x))
  const right = Math.max(...nodes.map((node) => node.position.x + node.width))
  const top = Math.min(...nodes.map((node) => node.position.y))
  const bottom = Math.max(...nodes.map((node) => node.position.y + node.height))
  const centerX = (left + right) / 2
  const centerY = (top + bottom) / 2

  const positions: NodePositions = {}
  for (const node of targets) {
    const next = { ...node.position }
    if (mode === 'left') next.x = left
    if (mode === 'right') next.x = right - node.width
    if (mode === 'horizontal-center') next.x = centerX - node.width / 2
    if (mode === 'top') next.y = top
    if (mode === 'bottom') next.y = bottom - node.height
    if (mode === 'vertical-center') next.y = centerY - node.height / 2
    if (next.x !== node.position.x || next.y !== node.position.y) positions[node.id] = next
  }
  return positions
}

/**
 * Even the gaps between nodes, keeping the two outermost in place. Distributing
 * by gap rather than by centre is what keeps differently sized nodes from
 * visually bunching up.
 */
export function distributeNodePositions(nodes: readonly AlignableNode[], axis: CanvasDistributeAxis): NodePositions {
  if (nodes.length < 3) return {}
  const horizontal = axis === 'horizontal'
  const ordered = [...nodes].sort((a, b) => (
    horizontal ? a.position.x - b.position.x : a.position.y - b.position.y
  ))
  const first = ordered[0]
  const last = ordered[ordered.length - 1]

  const span = horizontal
    ? (last.position.x + last.width) - first.position.x
    : (last.position.y + last.height) - first.position.y
  const occupied = ordered.reduce((total, node) => total + (horizontal ? node.width : node.height), 0)
  const gap = (span - occupied) / (ordered.length - 1)

  const positions: NodePositions = {}
  let cursor = horizontal ? first.position.x : first.position.y
  for (const node of ordered) {
    const size = horizontal ? node.width : node.height
    if (node !== first && node !== last && !node.locked) {
      const value = Math.round(cursor)
      const current = horizontal ? node.position.x : node.position.y
      if (value !== current) {
        positions[node.id] = horizontal
          ? { x: value, y: node.position.y }
          : { x: node.position.x, y: value }
      }
    }
    cursor += size + gap
  }
  return positions
}
