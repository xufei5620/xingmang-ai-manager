import type { CanvasMediaGroups } from '../store/canvas-state'
import type { CanvasRunGraph, CanvasRunScope } from '../host'
import { selectCanvasRunNodeIds } from '../runtime/run-preflight'

export interface GroupCatalogSnapshot<T> {
  groups: readonly T[] | null
  refreshing: boolean
  error: string | null
}

/** Reads catalog metadata only. It never prepares keys or changes a workflow. */
export function createCanvasGroupCatalog<T>(options: {
  load(): Promise<readonly T[]>
  changed(snapshot: GroupCatalogSnapshot<T>): void
  now?: () => number
}) {
  let groups: readonly T[] | null = null
  let pending: Promise<readonly T[]> | null = null
  let lastRequest = -Infinity
  let disposed = false
  const now = options.now ?? Date.now
  function refresh(force = false): Promise<readonly T[]> {
    if (disposed) return Promise.reject(new Error('画布账号已变化'))
    if (pending) return pending
    if (!force && groups !== null && now() - lastRequest < 300) return Promise.resolve(groups)
    lastRequest = now()
    options.changed({ groups, refreshing: true, error: null })
    const operation = Promise.resolve().then(options.load).then((next) => {
      if (disposed) throw new Error('画布账号已变化')
      groups = [...next]
      options.changed({ groups, refreshing: false, error: null })
      return groups
    }, (error: unknown) => {
      if (disposed) throw new Error('画布账号已变化')
      options.changed({ groups, refreshing: false, error: error instanceof Error ? error.message : '分组刷新失败，请重试' })
      throw error
    }).finally(() => { if (pending === operation) pending = null })
    pending = operation
    return operation
  }
  return { refresh, dispose: () => { disposed = true } }
}

export function missingCanvasMediaGroups(selected: CanvasMediaGroups, available: readonly { name: string }[]): string[] {
  const names = new Set(available.map((group) => group.name))
  return [...new Set([selected.image, selected.video, selected.text].filter((group): group is string => Boolean(group) && !names.has(group!)))]
}

export function groupDropdownKeyOpens(key: string): boolean {
  return key === ' ' || key === 'Enter' || key === 'ArrowDown' || key === 'ArrowUp' || key === 'F4'
}

export function missingCanvasRunGroups(graph: CanvasRunGraph, scope: CanvasRunScope, available: readonly { name: string }[]): string[] {
  const selected = selectCanvasRunNodeIds(graph, scope)
  const names = new Set(available.map((group) => group.name))
  return [...new Set(graph.nodes.filter((node) => selected.has(node.id) && !node.disabled)
    .map((node) => node.data.group).filter((group): group is string => Boolean(group) && !names.has(group!)))]
}
