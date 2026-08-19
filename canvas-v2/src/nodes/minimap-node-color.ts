import type { NodeStatus } from '../model'

interface MinimapNode {
  data?: { status?: NodeStatus; dirty?: boolean } | undefined
}

// Priority order, not a lookup table: a node can be both dirty and succeeded,
// and a failure must never be hidden behind a stale success.
export function canvasMinimapNodeColor(node: MinimapNode): string {
  const status = node.data?.status
  if (status === 'failed') return 'var(--state-failed)'
  if (status === 'running') return 'var(--state-running)'
  if (status === 'queued') return 'var(--state-queued)'
  if (node.data?.dirty === true) return 'var(--state-dirty)'
  if (status === 'succeeded') return 'var(--state-succeeded)'
  return 'var(--surface-3)'
}
