import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { searchCanvasNodes } from './node-search'

export interface ExistingCanvasNodeSearchResult {
  id: string
  title: string
  description: string
  search: string
}

export function searchExistingCanvasNodes(
  nodes: readonly CanvasNode[],
  query: string,
  limit = Number.POSITIVE_INFINITY,
): ExistingCanvasNodeSearchResult[] {
  const searchable = nodes.map((node) => {
    const definition = builtinNodeRegistry.resolve(node.type ?? 'unknown') ?? builtinNodeRegistry.require('unknown')
    const settingsTitle = typeof node.data.settings?.title === 'string' ? node.data.settings.title.trim().slice(0, 128) : ''
    const prompt = node.data.prompt
    const model = node.data.model
    const title = settingsTitle || definition.title
    return { id: node.id, title, kind: node.type ?? 'unknown', kindLabel: definition.title, prompt, model, status: node.data.status }
  })
  return searchCanvasNodes(searchable, query, limit).map((hit) => ({ id: hit.id, title: hit.title, description: hit.detail, search: query }))
}
