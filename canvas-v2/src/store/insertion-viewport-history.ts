import type { CanvasViewport } from './canvas-state'

export interface InsertionViewportToken { id: number; navigationRevision: number }
export type InsertionViewportAction =
  | { kind: 'restore'; viewport: CanvasViewport }
  | { kind: 'focus'; token: InsertionViewportToken; nodeIds: readonly string[] }

interface InsertionEffect {
  token: InsertionViewportToken
  before: CanvasViewport
  nodeIds: string[]
  previousOwner: InsertionViewportToken | null
}

/** Camera ownership belongs to an editing action, never the serialized graph.
 * Ordinary navigation supersedes auto-focus and remains outside graph undo.
 */
export function createInsertionViewportHistory() {
  let past: Array<InsertionEffect | null> = [], future: Array<InsertionEffect | null> = []
  let active: InsertionViewportToken | null = null, revision = 0, sequence = 0

  function reset(): void { past = []; future = []; active = null; revision++ }
  function userNavigation(): void { active = null; revision++ }
  function record(newEntry: boolean, pastLength: number, insertion?: { viewport: CanvasViewport; nodeIds: readonly string[] }): InsertionViewportToken | null {
    future = []
    if (!newEntry) return null
    const effect = insertion && insertion.nodeIds.length > 0 ? {
      token: { id: ++sequence, navigationRevision: revision }, before: { ...insertion.viewport },
      nodeIds: [...insertion.nodeIds], previousOwner: active,
    } : null
    past = [...past, effect].slice(-pastLength)
    if (effect) active = effect.token
    return effect?.token ?? null
  }
  function current(token: InsertionViewportToken): boolean {
    return active === token && token.navigationRevision === revision && past.some((effect) => effect?.token === token)
  }
  function undo(): InsertionViewportAction | null {
    if (past.length === 0) return null
    const effect = past.pop() ?? null
    future.unshift(effect)
    if (!effect || !currentUndo(effect)) return null
    active = effect.previousOwner
    return { kind: 'restore', viewport: { ...effect.before } }
  }
  function currentUndo(effect: InsertionEffect): boolean { return active === effect.token && effect.token.navigationRevision === revision }
  function redo(): InsertionViewportAction | null {
    if (future.length === 0) return null
    const effect = future.shift() ?? null
    past.push(effect)
    if (!effect || effect.token.navigationRevision !== revision || active !== effect.previousOwner) return null
    active = effect.token
    return { kind: 'focus', token: effect.token, nodeIds: [...effect.nodeIds] }
  }
  return { reset, userNavigation, record, current, undo, redo }
}
