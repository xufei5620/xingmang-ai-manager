import { graphHasRouterStrategy } from './router-strategy-contract'
import { graphHasLayerGroups } from './layer-groups-contract'
import { graphHasColorGradeCalibration } from './color-calibration-contract'
import { graphHasColorGradePresence } from './color-presence-contract'
import { graphHasColorGradeDetail } from './color-detail-contract'
import { graphHasStoryboardTask } from './storyboard-task-contract'
import { graphHasColorLut } from './color-lut-contract'
import { parseWorkflowColorLutResources, type WorkflowColorLutResource } from './workflow-color-lut-resources'
import { graphHasExteriorTask } from './exterior-task-contract'
import { graphHasInteriorTask } from './interior-task-contract'
import { graphHasImageTask } from './image-task-contract'
import { graphHasWholeFilter } from './whole-filter-contract'
import { graphHasDocumentFrame } from './document-frame-contract'
import { graphHasColorGrade } from './color-grade-contract'
import { graphHasLiquify } from './liquify-contract'
import { parseCommunityWorkshopSnapshot, type CommunityWorkshopSnapshot } from './community-workshop-contract'
import { maximumWorkshopEdges, maximumWorkshopNodes, sanitizeWorkshopWorkflow, WorkshopError, workshopNodeKinds, workshopText, workshopPromptText } from './workshop-sanitizer'

export const maximumWorkshopTransferBytes = 16 * 1024 * 1024
const maximumLegacyWorkshopTransferBytes = 1024 * 1024
export const workshopTransferFormat = 'xingmang-workshop-item'
export const workshopTransferExtension = '.workshop.json'

export interface WorkshopTransferFile {
  format: typeof workshopTransferFormat
  version: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17
  snapshot: CommunityWorkshopSnapshot
  colorLuts?: WorkflowColorLutResource[]
}

/** The host must obtain these restrictions from the owned record, not the caller. */
export interface WorkshopTransferExportSource {
  kind: 'personal'
  onlyUse?: boolean
  origin?: unknown
}

export class WorkshopTransferFormatError extends WorkshopError {}

function fail(message: string, status = 400): never {
  throw new WorkshopTransferFormatError(message, status)
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('星芒工坊文件的内容结构不正确')
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('星芒工坊文件包含不支持的字段，请重新导出；作者和来源不能由文件声明')
}

function boundedJson(value: unknown, maximumBytes = maximumLegacyWorkshopTransferBytes): string {
  // In-memory export input also crosses a trust boundary. Inspect data
  // descriptors before JSON.stringify so getters/toJSON cannot run here.
  const ancestors = new Set<object>()
  let entries = 0
  function visit(current: unknown, depth: number): void {
    if (++entries > maximumLegacyWorkshopTransferBytes || depth > 32) fail('工坊文件结构过于复杂，请缩小内容后重试')
    if (current === null || current === undefined || typeof current === 'boolean') return
    if (typeof current === 'string') {
      if (current.length > maximumBytes) fail(`星芒工坊文件不能超过 ${maximumBytes / 1024 / 1024} MiB`, 413)
      return
    }
    if (typeof current === 'number' && Number.isFinite(current)) return
    if (typeof current !== 'object') fail('工坊文件只允许普通 JSON 数据，不能包含可执行内容')
    const proto: unknown = Object.getPrototypeOf(current)
    if (Array.isArray(current) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail('工坊文件只允许普通 JSON 对象')
    if (ancestors.has(current)) fail('工坊文件包含循环引用')
    ancestors.add(current)
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype' || !('value' in descriptor)) fail('工坊文件包含不安全的对象字段')
      visit(descriptor.value, depth + 1)
    }
    ancestors.delete(current)
  }
  visit(value, 0)
  const encoded = JSON.stringify(value)
  if (typeof encoded !== 'string') fail('星芒工坊文件内容不能为空')
  if (new TextEncoder().encode(encoded).byteLength > maximumBytes) fail(`星芒工坊文件不能超过 ${maximumBytes / 1024 / 1024} MiB`, 413)
  return encoded
}

function assertExportAllowed(source: WorkshopTransferExportSource): void {
  boundedJson(source)
  const value = object(source)
  if (value.kind !== 'personal' || (value.onlyUse !== undefined && typeof value.onlyUse !== 'boolean')) fail('无法确认工坊内容的导出权限，请重新读取来源')
  const origin = value.origin
  if (value.onlyUse === true || (origin && typeof origin === 'object' && 'onlyUse' in origin && origin.onlyUse === true)) fail('此内容仅允许使用，不能下载或再次分享')
}

function assertGraphStructure(value: unknown): void {
  const workflow = object(value)
  if (workflow.schemaVersion !== 2 || !Array.isArray(workflow.nodes) || !Array.isArray(workflow.edges)) fail('工坊文件需要版本 2 的画布节点结构')
  if (!workflow.nodes.length || workflow.nodes.length > maximumWorkshopNodes || workflow.edges.length > maximumWorkshopEdges) fail('工坊文件需要 1–200 个节点，且不超过 800 条连线')
  const nodes = new Map<string, Record<string, unknown>>()
  for (const raw of workflow.nodes) {
    const node = object(raw)
    if (typeof node.id !== 'string' || !node.id || node.id.length > 256 || nodes.has(node.id)) fail('工坊文件的节点编号为空、重复或过长')
    nodes.set(node.id, node)
  }
  for (const node of nodes.values()) {
    if (node.parentId !== undefined && (typeof node.parentId !== 'string' || !node.parentId || nodes.get(node.parentId)?.kind !== 'group')) fail('工坊文件的节点分组引用无效')
  }
  const edgeIds = new Set<string>()
  for (const raw of workflow.edges) {
    const edge = object(raw)
    if (typeof edge.id !== 'string' || !edge.id || edge.id.length > 256 || edgeIds.has(edge.id)) fail('工坊文件的连线编号为空、重复或过长')
    edgeIds.add(edge.id)
    if (typeof edge.source !== 'string' || typeof edge.target !== 'string' || !nodes.has(edge.source) || !nodes.has(edge.target)) fail('工坊文件包含指向文件外节点的连线')
    if (typeof edge.sourceHandle !== 'string' || typeof edge.targetHandle !== 'string') fail('工坊文件的连线端口不完整')
  }
}

export function canonicalWorkshopTransferSnapshot(input: unknown): CommunityWorkshopSnapshot {
  const value = object(input)
  const kind = value.kind
  if (kind !== 'prompt' && kind !== 'node' && kind !== 'group') fail('星芒工坊文件仅支持提示词、节点和编组三种内容')
  const name = workshopText(value.name, '工坊名称', 160)
  const description = workshopText(value.description, '工坊简介', kind === 'prompt' ? 1000 : 4000, true)
  const category = workshopText(value.category, '工坊分类', 64)
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(category)) fail('工坊分类格式不正确')
  if (!Array.isArray(value.tags) || value.tags.length > 20) fail('工坊标签最多支持 20 个')
  const tags = value.tags.map((tag) => workshopText(tag, '工坊标签', 40))
  if (!Number.isSafeInteger(value.nodeCount) || !Number.isSafeInteger(value.edgeCount) || !Array.isArray(value.nodeKinds)) fail('工坊文件的节点摘要不完整')
  if (kind === 'prompt') {
    if (value.nodeCount !== 0 || value.edgeCount !== 0 || value.nodeKinds.length || value.workflow !== undefined) fail('提示词文件不能混入画布节点')
    const prompt = workshopPromptText(value.prompt, '提示词正文', 24_000)
    const promptGroup = workshopText(value.promptGroup ?? '', '提示词分组', 64, true)
    if (/[\u0000-\u001f\u007f]/.test(promptGroup)) fail('提示词分组不能包含换行或控制字符')
    return parseCommunityWorkshopSnapshot({ kind, name, description, category, tags, nodeCount: 0, edgeCount: 0, nodeKinds: [], prompt, promptGroup })
  }
  if (value.prompt !== undefined || value.promptGroup !== undefined) fail('节点文件不能混入独立提示词内容')
  assertGraphStructure(value.workflow)
  const workflow = sanitizeWorkshopWorkflow(value.workflow, kind, name, true)
  const nodeKinds = workshopNodeKinds(workflow), declaredKinds = value.nodeKinds
  if (value.nodeCount !== workflow.nodes.length || value.edgeCount !== workflow.edges.length || declaredKinds.length !== nodeKinds.length || declaredKinds.some((entry) => typeof entry !== 'string') || new Set(declaredKinds).size !== nodeKinds.length || nodeKinds.some((entry) => !declaredKinds.includes(entry))) fail('工坊文件摘要与实际节点、连线不一致，请重新导出')
  return parseCommunityWorkshopSnapshot({ kind, name, description, category, tags, nodeCount: workflow.nodes.length, edgeCount: workflow.edges.length, nodeKinds, workflow })
}

/** This format conveys content, never ownership, an author's identity or a license. */
export function buildWorkshopTransferFile(snapshot: unknown, source: WorkshopTransferExportSource, colorLuts: WorkflowColorLutResource[] = []): WorkshopTransferFile {
  assertExportAllowed(source)
  boundedJson(snapshot)
  const normalized = canonicalWorkshopTransferSnapshot(snapshot)
  const version = transferVersion(normalized)
  if (version < 12 && colorLuts.length) fail('没有 LUT 的工坊文件不能包含调色资源')
  const file: WorkshopTransferFile = { format: workshopTransferFormat, version, snapshot: normalized, ...(version >= 12 ? { colorLuts: parseWorkflowColorLutResources(normalized.workflow, colorLuts) } : {}) }
  boundedJson(file, version >= 12 ? maximumWorkshopTransferBytes : maximumLegacyWorkshopTransferBytes)
  return file
}

function transferVersion(snapshot: CommunityWorkshopSnapshot): WorkshopTransferFile['version'] {
  if (graphHasRouterStrategy(snapshot.workflow)) return 17
  if (graphHasLayerGroups(snapshot.workflow)) return 16
  if (graphHasColorGradeCalibration(snapshot.workflow)) return 15
  if (graphHasColorGradePresence(snapshot.workflow)) return 14
  if (graphHasColorGradeDetail(snapshot.workflow)) return 13
  if (graphHasColorLut(snapshot.workflow)) return 12
  if (graphHasStoryboardTask(snapshot.workflow)) return 11
  if (graphHasExteriorTask(snapshot.workflow)) return 10
  if (graphHasInteriorTask(snapshot.workflow)) return 9
  if (graphHasImageTask(snapshot.workflow)) return 8
  if (graphHasWholeFilter(snapshot.workflow)) return 7
  // Older readers cannot retain the original raster replay domain or wide layer geometry.
  if (graphHasDocumentFrame(snapshot.workflow)) return 6
  // A strict old reader cannot replay a new ordered deformation. Preserve the
  // workflow schema and fail before an old file importer can change its meaning.
  if (graphHasLiquify(snapshot.workflow)) return 5
  // Strict older layer readers cannot reproduce the new color processing.
  if (graphHasColorGrade(snapshot.workflow)) return 4
  // Older readers drop tileInput and cannot preserve its selected occurrence.
  // Gate the envelope while leaving the established workflow schema intact.
  if (snapshot.workflow?.nodes.some((node) => {
    if (node.kind !== 'image-tile') return false
    const incoming = snapshot.workflow!.edges.filter((edge) => edge.target === node.id)
    return node.data.settings?.tileInput !== undefined || incoming.length > 1 || incoming.some((edge) => edge.sourceHandle === 'out:images')
  })) return 3
  // Old file readers sanitized away stable comparison slots before upload.
  // Version 2 makes them fail closed, including explicit empty tombstone slots.
  return snapshot.kind === 'group' && snapshot.workflow?.nodes.some((node) => {
    const compare = node.data.settings?.imageCompare
    return node.kind === 'image-compare' && compare !== null && typeof compare === 'object' && Object.prototype.hasOwnProperty.call(compare, 'inputSlots')
  }) ? 2 : 1
}

function canonicalFile(value: unknown): WorkshopTransferFile {
  const file = object(value)
  if (file.format !== workshopTransferFormat) fail('这不是星芒工坊文件；不支持其他站点的加密模板格式')
  if (file.version !== 1 && file.version !== 2 && file.version !== 3 && file.version !== 4 && file.version !== 5 && file.version !== 6 && file.version !== 7 && file.version !== 8 && file.version !== 9 && file.version !== 10 && file.version !== 11 && file.version !== 12 && file.version !== 13 && file.version !== 14 && file.version !== 15 && file.version !== 16 && file.version !== 17) fail('暂不支持此星芒工坊文件版本，请更新页面后重试')
  exactKeys(file, file.version >= 12 ? ['format', 'version', 'snapshot', 'colorLuts'] : ['format', 'version', 'snapshot'])
  exactKeys(object(file.snapshot), ['kind', 'name', 'description', 'category', 'tags', 'nodeCount', 'edgeCount', 'nodeKinds', 'workflow', 'prompt', 'promptGroup'])
  boundedJson(file.snapshot)
  if (graphHasRouterStrategy(object(file.snapshot).workflow) && file.version !== 17) fail('旧版工坊文件不能携带显式路由策略，请使用第 17 版完整文件')
  if (graphHasLayerGroups(object(file.snapshot).workflow) && file.version !== 16 && file.version !== 17) fail('旧版工坊文件不能携带持久图层编组，请使用第 16 版完整文件')
  if (graphHasColorGradeCalibration(object(file.snapshot).workflow) && Number(file.version) < 15) fail('旧版工坊文件不能携带 RGB 原色校准，请使用第 15 版完整文件')
  if (graphHasColorGradePresence(object(file.snapshot).workflow) && Number(file.version) < 14) fail('旧版工坊文件不能携带纹理、清晰度与去雾，请使用第 14 版完整文件')
  if (graphHasColorGradeDetail(object(file.snapshot).workflow) && Number(file.version) < 13) fail('旧版工坊文件不能携带细节与降噪，请使用第 13 版完整文件')
  const snapshot = canonicalWorkshopTransferSnapshot(file.snapshot)
  const version = transferVersion(snapshot)
  if ((version === 17) !== (file.version === 17)) fail('工坊文件版本与路由策略不一致，请重新导出完整文件')
  if (Number(file.version) < 17 && (version === 16) !== (file.version === 16)) fail('工坊文件版本与持久图层编组不一致，请重新导出完整文件')
  if (file.version !== 16 && (version === 15) !== (file.version === 15)) fail('工坊文件版本与 RGB 原色校准配置不一致，请重新导出完整文件')
  if (Number(file.version) < 15 && (version === 14) !== (file.version === 14)) fail('工坊文件版本与纹理、清晰度及去雾配置不一致，请重新导出完整文件')
  if (Number(file.version) < 14 && (version === 13) !== (file.version === 13)) fail('工坊文件版本与细节降噪配置不一致，请重新导出完整文件')
  if ((version >= 12) !== (file.version >= 12)) fail('工坊文件版本与 LUT 设置不一致，请重新导出完整文件')
  const result: WorkshopTransferFile = { format: workshopTransferFormat, version, snapshot, ...(version >= 12 ? { colorLuts: parseWorkflowColorLutResources(snapshot.workflow, file.colorLuts) } : {}) }
  boundedJson(result, version >= 12 ? maximumWorkshopTransferBytes : maximumLegacyWorkshopTransferBytes)
  return result
}

export function serializeWorkshopTransferFile(file: WorkshopTransferFile): string {
  boundedJson(file, maximumWorkshopTransferBytes)
  const result = canonicalFile(file)
  return boundedJson(result, result.version >= 12 ? maximumWorkshopTransferBytes : maximumLegacyWorkshopTransferBytes)
}

export function parseWorkshopTransferFile(content: string | Uint8Array): WorkshopTransferFile {
  let text: string
  if (typeof content === 'string') {
    if (content.length > maximumWorkshopTransferBytes || new TextEncoder().encode(content).byteLength > maximumWorkshopTransferBytes) fail('星芒工坊文件不能超过 16 MiB', 413)
    text = content
  } else if (content instanceof Uint8Array) {
    if (content.byteLength > maximumWorkshopTransferBytes) fail('星芒工坊文件不能超过 16 MiB', 413)
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(content) } catch { fail('星芒工坊文件必须使用有效的 UTF-8 编码') }
  } else fail('请选择有效的星芒工坊 JSON 文件')
  let decoded: unknown
  try { decoded = JSON.parse(text.replace(/^\uFEFF/, '')) } catch { fail('无法读取星芒工坊文件，请检查 JSON 是否完整；其他站点的加密模板暂不支持') }
  boundedJson(decoded, maximumWorkshopTransferBytes)
  return canonicalFile(decoded)
}

export function workshopTransferFilename(name: string): string {
  const base = String(name).replace(/\.workshop\.json$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 100).replace(/[\uD800-\uDBFF]$/, '').replace(/[.\s]+$/g, '')
  return `${base || '星芒工坊'}${workshopTransferExtension}`
}
