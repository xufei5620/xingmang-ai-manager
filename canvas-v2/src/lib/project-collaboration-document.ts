import { parseWorkflowFileDetailed, serializeWorkflow } from '../model'
import type { PersistedWorkflowV2 } from '../persistence/workflow-schema'
import { maximumProjectContentBytes, maximumProjectEdges, maximumProjectNodes, utf8ByteLength } from './canvas-limits'
import { assertProjectSnapshotContent } from './project-snapshot-content'
import { ProjectCollaborationError, type ProjectCollaborationChange, type ProjectCollaborationNode, type ProjectCollaborationNodeProperties } from './project-collaboration-contract'
import { collaborationKeys, collaborationRecord, parseProjectCollaborationChanges, parseProjectCollaborationNode } from './project-collaboration-values'

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, stable(item)]))
  return value
}
export function projectCollaborationEqual(left: unknown, right: unknown): boolean { return JSON.stringify(stable(left)) === JSON.stringify(stable(right)) }
function conflict(): never { throw new ProjectCollaborationError('这些字段已由其他编辑更新，当前草稿仍保留；请核对差异后再提交', 409, 'COLLABORATION_FIELD_CONFLICT') }
function unsafe(): never { throw new ProjectCollaborationError('工程包含当前协作无法完整保留的配置，请先保留原稿并核对；不会静默修复或丢弃字段', 409, 'COLLABORATION_DOCUMENT_UNSUPPORTED') }

/** Collaboration never treats a lossy parser repair as an authorized edit. The
 * canonical document has the existing workflow schema, not a new file format. */
export function parseProjectCollaborationDocument(content: string): PersistedWorkflowV2 {
  if (typeof content !== 'string' || utf8ByteLength(content) > maximumProjectContentBytes) throw new ProjectCollaborationError('工程超过协作整图容量，请保留草稿并拆分工程', 422)
  assertProjectSnapshotContent(content, unsafe)
  const raw = collaborationRecord(JSON.parse(content)); collaborationKeys(raw, ['schemaVersion', 'name', 'viewport', 'mediaGroups', 'nodes', 'edges'])
  if (raw.schemaVersion !== 2 || !Array.isArray(raw.nodes) || raw.nodes.length > maximumProjectNodes || !Array.isArray(raw.edges) || raw.edges.length > maximumProjectEdges) unsafe()
  for (const node of raw.nodes) parseProjectCollaborationNode(node)
  const parsed = parseWorkflowFileDetailed(content)
  if (!parsed || parsed.warnings.length) unsafe()
  const canonical = JSON.parse(serializeWorkflow(parsed.workflow)) as PersistedWorkflowV2
  if (!projectCollaborationEqual(raw, canonical)) unsafe()
  return canonical
}
function properties(node: ProjectCollaborationNode): ProjectCollaborationNodeProperties { const { id: ignoredId, position: ignoredPosition, data: ignoredData, ...rest } = node; return rest }

export function buildProjectCollaborationChanges(baseContent: string, nextContent: string): ProjectCollaborationChange[] {
  const before = parseProjectCollaborationDocument(baseContent), after = parseProjectCollaborationDocument(nextContent), changes: ProjectCollaborationChange[] = []
  const old = new Map(before.nodes.map(node => [node.id, node])), current = new Map(after.nodes.map(node => [node.id, node]))
  for (const node of before.nodes) if (!current.has(node.id)) changes.push({ kind: 'node-remove', node })
  for (const node of after.nodes) {
    const previous = old.get(node.id)
    if (!previous) { changes.push({ kind: 'node-add', node }); continue }
    if (!projectCollaborationEqual(previous.position, node.position)) changes.push({ kind: 'node-set', nodeId: node.id, slot: 'position', before: previous.position, after: node.position })
    if (!projectCollaborationEqual(previous.data, node.data)) changes.push({ kind: 'node-set', nodeId: node.id, slot: 'data', before: previous.data, after: node.data })
    if (!projectCollaborationEqual(properties(previous), properties(node))) changes.push({ kind: 'node-set', nodeId: node.id, slot: 'properties', before: properties(previous), after: properties(node) })
  }
  const oldOrder = before.nodes.map(node => node.id), nextOrder = after.nodes.map(node => node.id)
  if (!projectCollaborationEqual(oldOrder, nextOrder)) changes.push({ kind: 'node-order-set', before: oldOrder, after: nextOrder })
  if (!projectCollaborationEqual(before.edges, after.edges)) changes.push({ kind: 'edges-set', before: before.edges, after: after.edges })
  if (before.name !== after.name) changes.push({ kind: 'document-set', slot: 'name', before: before.name, after: after.name })
  if (!projectCollaborationEqual(before.mediaGroups ?? null, after.mediaGroups ?? null)) changes.push({ kind: 'document-set', slot: 'mediaGroups', before: before.mediaGroups ?? null, after: after.mediaGroups ?? null })
  return parseProjectCollaborationChanges(changes, true)
}

export function invertProjectCollaborationChanges(changes: ProjectCollaborationChange[]): ProjectCollaborationChange[] {
  return parseProjectCollaborationChanges(changes).map(change => {
    if (change.kind === 'node-add') return { kind: 'node-remove', node: change.node }
    if (change.kind === 'node-remove') return { kind: 'node-add', node: change.node }
    return { ...change, before: change.after, after: change.before } as ProjectCollaborationChange
  })
}

export function applyProjectCollaborationChanges(content: string, rawChanges: ProjectCollaborationChange[]): string {
  const document = parseProjectCollaborationDocument(content), changes = parseProjectCollaborationChanges(rawChanges, true)
  if (!changes.length) return content
  if (changes.some(change => change.kind === 'node-add' || change.kind === 'node-remove') && !changes.some(change => change.kind === 'node-order-set')) throw new ProjectCollaborationError('新增或删除节点必须同时明确完整节点顺序，才能核对原操作和撤销')
  const original = new Map(document.nodes.map(node => [node.id, node])), changed = new Map(original), slots = new Set<string>()
  let order: string[] | undefined, next = structuredClone(document)
  for (const change of changes) {
    const key = change.kind === 'node-add' || change.kind === 'node-remove' ? `entity:${change.node.id}` : change.kind === 'node-set' ? `node:${change.nodeId}:${change.slot}` : change.kind === 'document-set' ? `document:${change.slot}` : change.kind
    if (slots.has(key)) throw new ProjectCollaborationError('同一协作批次不能重复更改同一字段')
    slots.add(key)
    if (change.kind === 'node-add') { if (original.has(change.node.id)) conflict(); changed.set(change.node.id, structuredClone(change.node)) }
    else if (change.kind === 'node-remove') { if (!projectCollaborationEqual(original.get(change.node.id), change.node)) conflict(); changed.delete(change.node.id) }
    else if (change.kind === 'node-set') {
      if (slots.has(`entity:${change.nodeId}`) || changes.some(item => (item.kind === 'node-add' || item.kind === 'node-remove') && item.node.id === change.nodeId)) throw new ProjectCollaborationError('节点整体操作不能与同节点字段操作混用')
      const node = original.get(change.nodeId), target = changed.get(change.nodeId); if (!node || !target) conflict()
      if (change.slot === 'properties') { if (!projectCollaborationEqual(properties(node), change.before)) conflict(); changed.set(change.nodeId, { id: node.id, position: target.position, data: target.data, ...structuredClone(change.after) }) }
      else if (change.slot === 'position') { if (!projectCollaborationEqual(node.position, change.before)) conflict(); changed.set(change.nodeId, { ...target, position: structuredClone(change.after) }) }
      else { if (!projectCollaborationEqual(node.data, change.before)) conflict(); changed.set(change.nodeId, { ...target, data: structuredClone(change.after) }) }
    } else if (change.kind === 'node-order-set') { if (!projectCollaborationEqual(document.nodes.map(node => node.id), change.before)) conflict(); order = change.after }
    else if (change.kind === 'edges-set') { if (!projectCollaborationEqual(document.edges, change.before)) conflict(); next.edges = structuredClone(change.after) }
    else if (change.slot === 'name') { if (document.name !== change.before) conflict(); next.name = change.after }
    else { if (!projectCollaborationEqual(document.mediaGroups ?? null, change.before)) conflict(); if (change.after === null) delete next.mediaGroups; else next.mediaGroups = structuredClone(change.after) }
  }
  const ids = order ?? [...changed.keys()]
  if (ids.length !== changed.size || ids.some(id => !changed.has(id))) throw new ProjectCollaborationError('协作节点顺序与新增或删除范围不一致')
  next.nodes = ids.map(id => changed.get(id)!)
  // Existing serializer validates ports, groups and feature placement. Compare
  // all resulting values so it cannot silently discard an invalid new edge.
  const raw = JSON.stringify(next), parsed = parseWorkflowFileDetailed(raw)
  if (!parsed || parsed.warnings.length) unsafe()
  const saved = serializeWorkflow(parsed.workflow)
  if (!projectCollaborationEqual(next, JSON.parse(saved))) unsafe()
  if (utf8ByteLength(saved) > maximumProjectContentBytes) throw new ProjectCollaborationError('协作结果超过整图容量，当前草稿保留', 422)
  return saved
}

export interface ProjectCollaborationFootprint { readKeys: string[]; writeKeys: string[] }
function field(...parts: string[]): string { return JSON.stringify(parts) }
/** These keys are derived only on the server, never accepted from an RPC. */
export function projectCollaborationFootprint(content: string, rawChanges: ProjectCollaborationChange[]): ProjectCollaborationFootprint {
  const document = parseProjectCollaborationDocument(content), changes = parseProjectCollaborationChanges(rawChanges), nodes = new Map(document.nodes.map(node => [node.id, node])), reads = new Set<string>(), writes = new Set<string>()
  function read(...parts: string[]) { reads.add(field(...parts)) }
  function write(...parts: string[]) { const key = field(...parts); reads.add(key); writes.add(key) }
  for (const change of changes) {
    if (change.kind === 'node-add' || change.kind === 'node-remove') {
      const node = change.node; for (const slot of ['entity', 'position', 'data', 'properties', 'children', 'incident']) write('node', node.id, slot)
      write('node-order')
      if (node.parentId) { read('node', node.parentId, 'entity'); write('node', node.parentId, 'children') }
    } else if (change.kind === 'node-set') {
      read('node', change.nodeId, 'entity'); write('node', change.nodeId, change.slot)
      if (change.slot === 'properties' && change.before.parentId !== change.after.parentId) for (const parent of [change.before.parentId, change.after.parentId]) if (parent) { read('node', parent, 'entity'); write('node', parent, 'children') }
    } else if (change.kind === 'node-order-set') write('node-order')
    else if (change.kind === 'edges-set') {
      write('edges')
      for (const edge of [...change.before, ...change.after]) for (const id of [edge.source, edge.target]) { read('node', id, 'entity'); write('node', id, 'incident') }
    } else write('document', change.slot)
  }
  for (const change of changes) if (change.kind === 'node-remove') {
    if (document.edges.some(edge => (edge.source === change.node.id || edge.target === change.node.id) && !changes.some(item => item.kind === 'edges-set'))) conflict()
    if (document.nodes.some(node => node.parentId === change.node.id && !changes.some(item => item.kind === 'node-remove' && item.node.id === node.id || item.kind === 'node-set' && item.nodeId === node.id && item.slot === 'properties' && item.after.parentId !== change.node.id))) conflict()
  }
  for (const change of changes) if (change.kind === 'node-set' && !nodes.has(change.nodeId)) conflict()
  return { readKeys: [...reads].sort(), writeKeys: [...writes].sort() }
}
