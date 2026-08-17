import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { CanvasNode } from '../nodes/WorkflowNodes'

export interface ExistingCanvasNodeSearchResult {
  id: string
  title: string
  description: string
  search: string
}

const maximumIndexedPromptLength = 240
export const maximumExistingNodeResults = 40

function resultScore(query: string, title: string, id: string, search: string): number {
  if (id === query || title === query) return 0
  if (id.startsWith(query) || title.startsWith(query)) return 1
  if (id.includes(query) || title.includes(query)) return 2
  return search.includes(query) ? 3 : Number.POSITIVE_INFINITY
}

export function searchExistingCanvasNodes(
  nodes: readonly CanvasNode[],
  query: string,
  limit = maximumExistingNodeResults,
): ExistingCanvasNodeSearchResult[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized || limit <= 0) return []
  return nodes.flatMap((node) => {
    const definition = builtinNodeRegistry.resolve(node.type ?? 'unknown') ?? builtinNodeRegistry.require('unknown')
    const settingsTitle = typeof node.data.settings?.title === 'string' ? node.data.settings.title.slice(0, 128) : ''
    const prompt = node.data.prompt.slice(0, maximumIndexedPromptLength)
    const model = node.data.model.slice(0, 128)
    const title = definition.title
    const id = node.id.toLocaleLowerCase()
    const normalizedTitle = title.toLocaleLowerCase()
    const search = `${normalizedTitle} ${id} ${model} ${prompt} ${settingsTitle} ${node.data.status}`.toLocaleLowerCase()
    const score = resultScore(normalized, normalizedTitle, id, search)
    if (!Number.isFinite(score)) return []
    return [{
      id: node.id,
      title,
      description: `${model || statusLabel(node.data.status)} · ${node.id}`,
      search,
      score,
    }]
  }).sort((left, right) => left.score - right.score || left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
    .slice(0, Math.min(limit, maximumExistingNodeResults))
    .map(({ score: _score, ...result }) => result)
}

function statusLabel(status: string): string {
  if (status === 'succeeded') return '已完成'
  if (status === 'running') return '运行中'
  if (status === 'queued') return '排队中'
  if (status === 'failed') return '失败'
  return '待运行'
}
