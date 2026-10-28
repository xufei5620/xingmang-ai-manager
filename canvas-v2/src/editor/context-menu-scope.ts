interface ContextNode {
  id: string
  selected?: boolean
}

/** Capture the menu's targets once; later selection changes must not retarget it. */
export function canvasContextNodeIds(nodes: readonly ContextNode[], targetId: string | null): string[] {
  const target = nodes.find((node) => node.id === targetId)
  if (!target) return []
  return target.selected ? nodes.filter((node) => node.selected).map((node) => node.id) : [target.id]
}
