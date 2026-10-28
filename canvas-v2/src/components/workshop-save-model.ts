import type { CanvasWorkshopItem, CanvasWorkshopKind, WorkshopSourcePolicy } from '../lib/workshop-contract'
import { sanitizeOwnerPrivateWorkshopWorkflow, sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'
import { workshopItemPermissions } from '../lib/workshop-transfer-contract'
import type { WorkflowFile } from '../model'
import { collectNodeMediaSources, type NodeMediaSource } from '../lib/node-model-source-contract'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'

export interface WorkshopSourceReview extends NodeMediaSource {
  title: string
}

export interface WorkshopPortableSnapshotOptions {
  removeFixedSources?: boolean
  sourcePolicy?: WorkshopSourcePolicy
}

export function workshopFixedSourceReview(workflow: WorkflowFile): WorkshopSourceReview[] {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]))
  return collectNodeMediaSources(workflow).map((source) => {
    const node = byId.get(source.nodeId)!
    const title = node.data.settings?.title
    return { ...source, title: typeof title === 'string' && title.trim() ? title.trim() : builtinNodeRegistry.resolve(node.kind)?.title ?? node.kind }
  })
}

/** The policy changes only this reviewed copy. Owner-private data must still
 * pass server-scoped provider ownership and availability checks at write time. */
export function buildWorkshopPortableSnapshot(workflow: WorkflowFile, kind: CanvasWorkshopKind, name: string, options: WorkshopPortableSnapshotOptions = {}): WorkflowFile {
  const sources = workshopFixedSourceReview(workflow)
  if (options.sourcePolicy === 'owner-private') return sanitizeOwnerPrivateWorkshopWorkflow(structuredClone(workflow), kind, name)
  if (options.sourcePolicy !== undefined && options.sourcePolicy !== 'portable') throw new Error('请选择有效的模型来源保存方式。')
  if (sources.length && options.removeFixedSources !== true) throw new Error('请先明确确认，为工坊副本移除固定来源；原画布保持不变。')
  const captured = structuredClone(workflow), sourceIds = new Set(sources.map((source) => source.nodeId))
  for (const node of captured.nodes) if (sourceIds.has(node.id)) delete node.data.group
  return sanitizeWorkshopWorkflow(captured, kind, name)
}

export function workshopSaveKind(workflow: WorkflowFile): CanvasWorkshopKind {
  return workflow.nodes.length === 1 && workflow.nodes[0].kind !== 'group' ? 'node' : 'group'
}

export function assertWorkshopContentTarget(workflow: WorkflowFile, target: CanvasWorkshopItem): void {
  if (target.deletedAt) throw new Error('目标条目已在回收站，请恢复后重新选择。')
  if (!workshopItemPermissions(target).canEdit) throw new Error('目标条目仅允许使用，不能更新配置。')
  if (target.kind === 'node' && workshopSaveKind(workflow) !== 'node') throw new Error('节点配置只能保存一个非分组节点，请选择编组模板或缩小选区。')
}

export function buildWorkshopContentDraft(workflow: WorkflowFile, target: CanvasWorkshopItem, options: WorkshopPortableSnapshotOptions = {}): WorkflowFile {
  assertWorkshopContentTarget(workflow, target)
  return buildWorkshopPortableSnapshot(workflow, target.kind, target.name, options)
}

/** Compare the sanitized document, including prompts, parameters and geometry.
 * Equal graph topology alone does not make two reusable configurations equal.
 */
export function workshopContentDifference(before: WorkflowFile, after: WorkflowFile) {
  const oldTypes = before.nodes.map((node) => node.kind).join('、')
  const newTypes = after.nodes.map((node) => node.kind).join('、')
  const settings = (workflow: WorkflowFile) => workflow.nodes.map((node) => ({ kind: node.kind, data: node.data, disabled: node.disabled }))
  const beforeSources = workshopFixedSourceReview(before), afterSources = workshopFixedSourceReview(after)
  return {
    changed: JSON.stringify(before) !== JSON.stringify(after),
    nodeDelta: after.nodes.length - before.nodes.length,
    edgeDelta: after.edges.length - before.edges.length,
    typesChanged: oldTypes !== newTypes,
    configurationChanged: JSON.stringify(settings(before)) !== JSON.stringify(settings(after)),
    sourcesChanged: JSON.stringify(beforeSources.map(({ nodeId, group, model }) => ({ nodeId, group, model }))) !== JSON.stringify(afterSources.map(({ nodeId, group, model }) => ({ nodeId, group, model }))),
    beforeSourceCount: beforeSources.length, afterSourceCount: afterSources.length,
    oldTypes, newTypes,
  }
}

function uuid(value: string | null): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }
export function workshopConfigurationEditHref(id: string): string {
  if (!uuid(id)) throw new Error('工坊条目编号不正确，请重新读取。')
  return `/canvas?workshop=${encodeURIComponent(id)}&workshopEdit=${encodeURIComponent(id)}`
}
export function readWorkshopEditTarget(route: URLSearchParams, projectId: string | null): string | null {
  const id = route.get('workshopEdit')
  if (!uuid(id)) return null
  if (projectId) return route.get('workshopEditProject') === projectId ? id : null
  return route.get('workshop') === id && !route.get('workshopEditProject') ? id : null
}
export function bindWorkshopEditProject(route: URLSearchParams, projectId: string, templateId: string): void {
  const id = route.get('workshopEdit')
  if (uuid(id) && templateId === `workshop-${id}`) route.set('workshopEditProject', projectId)
  else clearWorkshopEditTarget(route)
}
export function clearWorkshopEditTarget(route: URLSearchParams): void {
  route.delete('workshopEdit'); route.delete('workshopEditProject')
}
