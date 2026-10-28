import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { NodeCategory } from '../domain/node-definition'
import type { WorkflowFile } from '../model'
import { markCopiedInputsChanged } from '../editor/copied-inputs'

export interface ResourceNode {
  id: string
  type?: string
  parentId?: string
  selected?: boolean
  draggable?: boolean
  data: { settings?: Record<string, unknown> }
}

export interface ResourceTreeRow {
  id: string
  parentId?: string
  title: string
  type: string
  typeTitle: string
  category: NodeCategory
  depth: number
  childCount: number
  expanded: boolean
  matches: boolean
  selected: boolean
  locked: boolean
}

export function resourceNodeTitle(node: ResourceNode): string {
  const title = node.data.settings?.title
  return typeof title === 'string' && title.trim() ? title.trim() : builtinNodeRegistry.resolve(node.type ?? 'unknown')?.title ?? '未知节点'
}

export function buildResourceTree(nodes: readonly ResourceNode[], query = '', type = '', collapsed: ReadonlySet<string> = new Set()): { rows: ResourceTreeRow[]; matches: number; topLevelCount: number } {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const children = new Map<string, ResourceNode[]>()
  const roots: ResourceNode[] = []
  for (const node of nodes) {
    if (node.parentId && byId.get(node.parentId)?.type === 'group' && node.parentId !== node.id) {
      const entries = children.get(node.parentId) ?? []
      entries.push(node); children.set(node.parentId, entries)
    } else roots.push(node)
  }
  const normalized = query.trim().toLocaleLowerCase()
  const filtering = Boolean(normalized || type)
  const matches = new Set(nodes.filter((node) => (!type || node.type === type) && (!normalized || `${resourceNodeTitle(node)} ${node.id}`.toLocaleLowerCase().includes(normalized))).map((node) => node.id))
  const included = new Set(matches)
  for (const id of matches) {
    const seen = new Set([id])
    let parentId = byId.get(id)?.parentId
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId); included.add(parentId); parentId = byId.get(parentId)?.parentId
    }
  }
  const rows: ResourceTreeRow[] = []
  const visited = new Set<string>()
  function append(node: ResourceNode, depth: number) {
    if (visited.has(node.id)) return
    visited.add(node.id)
    if (filtering && !included.has(node.id)) return
    const descendants = children.get(node.id) ?? []
    const definition = builtinNodeRegistry.resolve(node.type ?? 'unknown')
    const expanded = filtering || !collapsed.has(node.id)
    rows.push({ id: node.id, parentId: node.parentId, title: resourceNodeTitle(node), type: node.type ?? 'unknown', typeTitle: definition?.title ?? '未知节点', category: definition?.category ?? 'structural', depth, childCount: descendants.length, expanded, matches: matches.has(node.id), selected: node.selected === true, locked: node.draggable === false })
    if (expanded) descendants.forEach((child) => append(child, depth + 1))
    else {
      // Collapsed descendants remain part of the document, not orphan roots.
      const pending = [...descendants]
      while (pending.length) { const child = pending.pop()!; if (visited.has(child.id)) continue; visited.add(child.id); pending.push(...(children.get(child.id) ?? [])) }
    }
  }
  roots.forEach((node) => append(node, 0))
  // A malformed legacy graph must still be navigable rather than disappear.
  nodes.filter((node) => !visited.has(node.id)).forEach((node) => append(node, 0))
  return { rows, matches: matches.size, topLevelCount: roots.length }
}

export function resourceSelectionIds(current: readonly string[], visible: readonly string[], target: string, options: { toggle?: boolean; range?: boolean; anchor?: string | null }): string[] {
  if (options.range && options.anchor) {
    const start = visible.indexOf(options.anchor), end = visible.indexOf(target)
    if (start >= 0 && end >= 0) return [...new Set([...(options.toggle ? current : []), ...visible.slice(Math.min(start, end), Math.max(start, end) + 1)])]
  }
  if (options.toggle) return current.includes(target) ? current.filter((id) => id !== target) : [...current, target]
  return [target]
}

export function resourceGroupSelectionIds(nodes: readonly ResourceNode[], selected: readonly string[]): string[] {
  const selectedIds = new Set(selected)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const roots = nodes.filter((node) => {
    if (!selectedIds.has(node.id)) return false
    const seen = new Set([node.id]); let parentId = node.parentId
    while (parentId && !seen.has(parentId)) {
      if (selectedIds.has(parentId)) return false
      seen.add(parentId); parentId = byId.get(parentId)?.parentId
    }
    return true
  })
  return roots.length >= 2 && new Set(roots.map((node) => node.parentId)).size === 1 ? roots.map((node) => node.id) : []
}

/** A scoped package keeps real results and assets; it is not a preset scrubber. */
export function buildResourceExportWorkflow(workflow: WorkflowFile, selected: readonly string[]): WorkflowFile {
  const ids = new Set(selected)
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]))
  let changed = true
  while (changed) {
    changed = false
    for (const node of workflow.nodes) if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) { ids.add(node.id); changed = true }
  }
  const nodes = workflow.nodes.filter((node) => ids.has(node.id)).map((node) => {
    const copy = structuredClone(node)
    if (copy.parentId && !ids.has(copy.parentId)) {
      const seen = new Set([copy.id]); let parentId: string | undefined = copy.parentId
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId); const parent = byId.get(parentId)
        if (!parent) break
        copy.position.x += parent.position.x; copy.position.y += parent.position.y; parentId = parent.parentId
      }
      delete copy.parentId
    }
    return copy
  })
  if (!nodes.length) throw new Error('请先选择要打包的节点')
  const included = new Set(nodes.map((node) => node.id))
  const records = nodes.map((node) => ({ ...node, type: node.kind, definitionVersion: node.definitionVersion ?? 1, data: { ...node.data } }))
  markCopiedInputsChanged(records, workflow.edges, included)
  records.forEach((record, index) => { if (record.data.dirty) nodes[index].data.dirty = true })
  const single = selected.length === 1 ? byId.get(selected[0]) : null
  return { ...structuredClone(workflow), name: single ? resourceNodeTitle({ ...single, type: single.kind }) : `${workflow.name.slice(0, 150)} · 选区`, nodes, edges: workflow.edges.filter((edge) => included.has(edge.source) && included.has(edge.target)).map((edge) => structuredClone(edge)) }
}
