export interface SearchableNode {
  id: string
  title: string
  kind: string
  kindLabel?: string
  prompt?: string
  model?: string
  status?: string
}

export interface NodeSearchHit {
  id: string
  title: string
  /** Why this node matched, shown as the secondary line. */
  detail: string
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Find nodes by title, prompt or model.
 *
 * Ranked so that a title match always beats a prompt match: searching "输出"
 * should surface the output node, not every prompt that mentions the word.
 */
export function searchCanvasNodes(nodes: readonly SearchableNode[], query: string, limit = Number.POSITIVE_INFINITY): NodeSearchHit[] {
  const needle = normalize(query)
  if (needle.length === 0 || limit <= 0) return []

  const scored: { hit: NodeSearchHit; rank: number }[] = []
  for (const node of nodes) {
    const title = normalize(node.title)
    const id = normalize(node.id)
    const kind = normalize(`${node.kindLabel ?? ''} ${node.kind}`)
    const model = normalize(node.model ?? '')
    const statusLabel = node.status === 'succeeded' ? '已完成' : node.status === 'running' ? '运行中' : node.status === 'queued' ? '排队中' : node.status === 'failed' ? '失败' : '待运行'
    const status = normalize(`${node.status ?? ''} ${statusLabel}`)
    const prompt = node.prompt ?? ''
    const identity = `${node.kindLabel ?? node.kind} · ${node.id}`

    if (id === needle || title === needle) scored.push({ hit: { id: node.id, title: node.title, detail: identity }, rank: 0 })
    else if (title.startsWith(needle) || id.startsWith(needle)) scored.push({ hit: { id: node.id, title: node.title, detail: identity }, rank: 1 })
    else if (title.includes(needle) || id.includes(needle)) scored.push({ hit: { id: node.id, title: node.title, detail: identity }, rank: 2 })
    else if (kind.includes(needle)) scored.push({ hit: { id: node.id, title: node.title, detail: identity }, rank: 3 })
    else if (model.includes(needle)) scored.push({ hit: { id: node.id, title: node.title, detail: `${node.model ?? ''} · ${node.id}` }, rank: 4 })
    else if (status.includes(needle)) scored.push({ hit: { id: node.id, title: node.title, detail: `${statusLabel} · ${identity}` }, rank: 5 })
    else if (normalize(prompt).includes(needle)) {
      scored.push({ hit: { id: node.id, title: node.title, detail: `${promptExcerpt(prompt, needle)} · ${node.id}` }, rank: 6 })
    }
  }

  return scored
    .sort((a, b) => a.rank - b.rank || a.hit.title.localeCompare(b.hit.title) || a.hit.id.localeCompare(b.hit.id))
    .slice(0, limit)
    .map((entry) => entry.hit)
}

/** A window of the prompt around the match, so the user sees why it matched. */
export function promptExcerpt(prompt: string, needle: string, radius = 18): string {
  const at = prompt.toLowerCase().indexOf(normalize(needle))
  if (at < 0) return prompt.slice(0, radius * 2)
  const start = Math.max(0, at - radius)
  const end = Math.min(prompt.length, at + needle.length + radius)
  return `${start > 0 ? '…' : ''}${prompt.slice(start, end)}${end < prompt.length ? '…' : ''}`
}
