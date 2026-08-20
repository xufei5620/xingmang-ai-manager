export interface SearchableNode {
  id: string
  title: string
  kind: string
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
export function searchCanvasNodes(nodes: readonly SearchableNode[], query: string, limit = 20): NodeSearchHit[] {
  const needle = normalize(query)
  if (needle.length === 0) return []

  const scored: { hit: NodeSearchHit; rank: number }[] = []
  for (const node of nodes) {
    const title = normalize(node.title)
    const model = normalize(node.model ?? '')
    const prompt = node.prompt ?? ''

    if (title.startsWith(needle)) scored.push({ hit: { id: node.id, title: node.title, detail: node.kind }, rank: 0 })
    else if (title.includes(needle)) scored.push({ hit: { id: node.id, title: node.title, detail: node.kind }, rank: 1 })
    else if (model.includes(needle)) scored.push({ hit: { id: node.id, title: node.title, detail: node.model ?? '' }, rank: 2 })
    else if (normalize(prompt).includes(needle)) {
      scored.push({ hit: { id: node.id, title: node.title, detail: promptExcerpt(prompt, needle) }, rank: 3 })
    }
  }

  return scored
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((entry) => entry.hit)
}

/** A window of the prompt around the match, so the user sees why it matched. */
export function promptExcerpt(prompt: string, needle: string, radius = 18): string {
  const at = normalize(prompt).indexOf(normalize(needle))
  if (at < 0) return prompt.slice(0, radius * 2)
  const start = Math.max(0, at - radius)
  const end = Math.min(prompt.length, at + needle.length + radius)
  return `${start > 0 ? '…' : ''}${prompt.slice(start, end)}${end < prompt.length ? '…' : ''}`
}
