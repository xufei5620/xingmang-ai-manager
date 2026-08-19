/**
 * Where a node's ports sit. The renderer positions its handles from here and
 * the canvas hit tests wires against the same numbers, because the two used to
 * disagree: hit testing assumed every wire left and entered a node 52px below
 * its top edge, so on a node with several ports -- or on a bound media node,
 * whose single output is centred on the preview -- cutting a wire and dropping
 * a node onto one both aimed at empty space.
 */

export const portSlotFirstOffsetPx = 52
export const portSlotSpacingPx = 26

/** Vertical offset of the nth port down one side of a node. */
export function portSlotOffsetY(index: number): number {
  return portSlotFirstOffsetPx + Math.max(0, index) * portSlotSpacingPx
}

/** Media source nodes drop their port rail and centre one output on the media. */
export function isMediaSourceKind(kind: string): boolean {
  return kind === 'image-input' || kind === 'video-input' || kind === 'audio-input'
}

export interface PortGeometryNode {
  /** Rendered height; only the centred layout depends on it. */
  height: number
  /** True once a media source node is showing its asset. */
  centredOutput: boolean
  /** The definition's ports, in declaration order. */
  ports: readonly { id: string; direction: 'input' | 'output' }[]
}

export function portOffsetY(
  node: PortGeometryNode,
  direction: 'input' | 'output',
  handleId: string | null | undefined,
): number {
  if (direction === 'output' && node.centredOutput) return node.height / 2
  const index = node.ports
    .filter((port) => port.direction === direction)
    .findIndex((port) => port.id === handleId)
  // An unknown handle means the document names a port this version of the node
  // no longer declares. The first slot is where React Flow parks the wire too.
  return portSlotOffsetY(index)
}
