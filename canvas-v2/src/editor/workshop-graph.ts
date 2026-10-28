import { remapImageReferenceOrderSettings } from '../commerce/image-reference-order'
import { remapVideoReferenceOrderSettings } from '../video-tools/video-reference-order'
import { remapCollageInputOrderSettings } from '../image-tools/collage-input-order'
import { remapTileInputSettings } from '../image-tools/tile-input'
import { createEmptyWorkflow, type WorkflowFile, type WorkflowNode } from '../model'
import { buildCompareInputSlots, parseImageCompareSettings, persistImageCompareView, portableImageCompareSettings, remapImageCompareSettings, resolveImageCompareView } from '../image-tools/viewer-settings'
import { buildCanvasUpstreamReferences } from '../components/upstream-references'
import { collectNodeMediaSources } from '../lib/node-model-source-contract'

/** Capture private routes for explicit local review, never as a portable file. */
export function buildWorkshopSelectionForSourceReview(workflow: WorkflowFile, selectedIds: readonly string[]): WorkflowFile {
  const captured = buildWorkshopSelection(workflow, selectedIds)
  collectNodeMediaSources(captured)
  return captured
}

/** Include descendants of a selected group, and detach from unselected parents. */
export function buildWorkshopSelection(workflow: WorkflowFile, selectedIds: readonly string[]): WorkflowFile {
  const ids = new Set(selectedIds)
  let changed = true
  while (changed) {
    changed = false
    for (const node of workflow.nodes) if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) { ids.add(node.id); changed = true }
  }
  const nodes = workflow.nodes.filter((node) => ids.has(node.id)).map((node) => {
    const copy = structuredClone(node)
    if (copy.parentId && !ids.has(copy.parentId)) { copy.position = absolutePosition(node, workflow.nodes); delete copy.parentId }
    return copy
  })
  if (!nodes.some((node) => node.kind !== 'group')) throw new Error('请先选择至少一个内容节点，再保存到工坊')
  const roots = nodes.filter((node) => !node.parentId)
  const minX = Math.min(...roots.map((node) => node.position.x))
  const minY = Math.min(...roots.map((node) => node.position.y))
  for (const node of roots) node.position = { x: node.position.x - minX + 80, y: node.position.y - minY + 80 }
  const edges = workflow.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map((edge) => ({ ...edge }))
  for (const node of nodes) node.data.settings = remapImageReferenceOrderSettings(node.data.settings, new Map(edges.filter((edge) => edge.target === node.id).map((edge) => [edge.id, edge.id])))
  for (const node of nodes) if (node.kind === 'image-tile') node.data.settings = remapTileInputSettings(node.data.settings, new Map(edges.filter((edge) => edge.target === node.id).map((edge) => [edge.id, edge.id])), workflow.edges.find((edge) => edge.target === node.id && edge.targetHandle === 'in:image')?.id)
  for (const node of nodes) if (node.kind === 'image-collage') node.data.settings = remapCollageInputOrderSettings(node.data.settings, new Map(edges.filter((edge) => edge.target === node.id).map((edge) => [edge.id, edge.id])))
  for (const node of nodes) if ((node.kind === 'video' || node.kind === 'video-generate')) node.data.settings = remapVideoReferenceOrderSettings(node.data.settings, new Map(edges.filter((edge) => edge.target === node.id).map((edge) => [edge.id, edge.id])))
  if (nodes.length > 1) {
    const references = buildCanvasUpstreamReferences(workflow.nodes.map((node) => ({ id: node.id, type: node.kind, data: { ...node.data } })), workflow.edges, [])
    const retainedEdges = new Set(edges.map((edge) => edge.id))
    for (const node of nodes) if (node.kind === 'image-compare' && node.data.settings?.imageCompare !== undefined) {
      const settings = parseImageCompareSettings(node.data.settings.imageCompare)
      if (settings.inputSlots) {
        node.data.settings.imageCompare = portableImageCompareSettings(settings, new Map(edges.filter((edge) => edge.target === node.id).map((edge) => [edge.id, edge.id])))
        continue
      }
      const inputs = references.get(node.id) ?? []
      const all = buildCompareInputSlots(inputs.filter((reference) => reference.kind === 'image'))
      const retained = buildCompareInputSlots(inputs.filter((reference) => reference.kind === 'image' && retainedEdges.has(reference.edgeId)))
      const current = persistImageCompareView(resolveImageCompareView(node.data.settings.imageCompare, all), all)
      node.data.settings.imageCompare = persistImageCompareView(resolveImageCompareView(current, retained), retained)
    }
  }
  return { ...createEmptyWorkflow('个人工坊'), nodes, edges }
}

function absolutePosition(node: WorkflowNode, nodes: readonly WorkflowNode[]): { x: number; y: number } {
  const position = { ...node.position }
  const visited = new Set([node.id])
  let parentId = node.parentId
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId)
    const parent = nodes.find((entry) => entry.id === parentId)
    if (!parent) break
    position.x += parent.position.x
    position.y += parent.position.y
    parentId = parent.parentId
  }
  return position
}

/** A template insertion is one add-nodes command. All graph identities are fresh. */
export function instantiateWorkshopGraph(workflow: WorkflowFile, createId: () => string, origin = { x: 80, y: 80 }): WorkflowFile {
  const issued = new Set<string>()
  function nextId(): string {
    const id = createId()
    if (!id || issued.has(id)) throw new Error('无法为工坊内容生成唯一节点编号')
    issued.add(id)
    return id
  }
  const ids = new Map(workflow.nodes.map((node) => [node.id, nextId()]))
  const originalIds = new Map([...ids].map(([original, inserted]) => [inserted, original]))
  const roots = workflow.nodes.filter((node) => !node.parentId || !ids.has(node.parentId))
  const minX = roots.length ? Math.min(...roots.map((node) => node.position.x)) : 0
  const minY = roots.length ? Math.min(...roots.map((node) => node.position.y)) : 0
  const nodes = workflow.nodes.map((node) => {
    const copy = structuredClone(node)
    copy.id = ids.get(node.id)!
    if (node.parentId && ids.has(node.parentId)) copy.parentId = ids.get(node.parentId)!
    else { delete copy.parentId; copy.position = { x: node.position.x - minX + origin.x, y: node.position.y - minY + origin.y } }
    copy.data.status = 'idle'
    return copy
  })
  // Parent-first order is required by React Flow, including imported nested groups.
  nodes.sort((a, b) => depth(a, nodes) - depth(b, nodes))
  const edgeIds = new Map<string, string>()
  const edges = workflow.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map((edge) => {
    const id = nextId()
    edgeIds.set(edge.id, id)
    return { ...edge, id, source: ids.get(edge.source)!, target: ids.get(edge.target)! }
  })
  for (const node of nodes) node.data.settings = remapImageReferenceOrderSettings(node.data.settings, edgeIds)
  for (const node of nodes) if (node.kind === 'image-compare' && node.data.settings?.imageCompare !== undefined) {
    node.data.settings.imageCompare = remapImageCompareSettings(node.data.settings.imageCompare, edgeIds)
  }
  for (const node of nodes) if (node.kind === 'image-collage') node.data.settings = remapCollageInputOrderSettings(node.data.settings, edgeIds)
  for (const node of nodes) if (node.kind === 'image-tile') {
    const incoming = workflow.edges.filter((edge) => edge.target === originalIds.get(node.id) && edge.targetHandle === 'in:image')
    node.data.settings = remapTileInputSettings(node.data.settings, new Map(incoming.flatMap((edge) => edgeIds.has(edge.id) ? [[edge.id, edgeIds.get(edge.id)!] as const] : [])), incoming[0]?.id)
  }
  for (const node of nodes) if ((node.kind === 'video' || node.kind === 'video-generate')) node.data.settings = remapVideoReferenceOrderSettings(node.data.settings, edgeIds)
  return { ...createEmptyWorkflow(workflow.name), nodes, edges }
}

function depth(node: WorkflowNode, nodes: readonly WorkflowNode[]): number {
  const visited = new Set([node.id])
  let parent = node.parentId
  while (parent && !visited.has(parent)) { visited.add(parent); parent = nodes.find((entry) => entry.id === parent)?.parentId }
  return visited.size
}
