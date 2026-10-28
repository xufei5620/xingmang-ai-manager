export interface ComposerPlacementInput {
  viewport: { width: number; height: number }
  node: { x: number; y: number; width: number; height: number }
  panelHeight: number
  follow: boolean
}

/** Coordinates are CSS pixels in the unzoomed React Flow toolbar portal. The
 * bottom strip belongs to navigation/status controls, including on small screens. */
export function composerPlacement(input: ComposerPlacementInput) {
  const width = Math.max(0, input.viewport.width)
  const height = Math.max(0, input.viewport.height)
  const panelWidth = Math.min(540, Math.max(0, width - 24))
  // The selection toolbar remains above the composer, and wraps on phones.
  const topInset = width < 640 ? 100 : 64
  const maxHeight = Math.max(48, height - 64 - topInset)
  const panelHeight = Math.min(maxHeight, Math.max(48, input.panelHeight))
  const fixed = { left: Math.max(12, (width - panelWidth) / 2), top: Math.max(topInset, height - 64 - panelHeight), width: panelWidth, maxHeight, mode: 'fixed' as 'fixed' | 'follow' }
  if (!input.follow || width < 640 || height < 480) return fixed
  const node = input.node
  const below = node.y + node.height + 12
  const above = node.y - panelHeight - 12
  const bottom = height - 64 - panelHeight
  // An offscreen node or a node filling the viewport has no safe attached
  // editor space. Docking preserves access without covering the whole result.
  if (node.x + node.width < 0 || node.x > width || node.y + node.height < 0 || node.y > height || below > bottom && above < topInset) return fixed
  return { ...fixed, mode: 'follow' as const, left: Math.max(12, Math.min(width - panelWidth - 12, node.x + node.width / 2 - panelWidth / 2)), top: Math.max(topInset, Math.min(bottom, below <= bottom ? below : above)) }
}
