import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { EditorNodeRecord } from '../domain/node-definition'
import type { CanvasGroupSummary } from '../host'
import { availableModelsForKind, type MediaCapabilityKind } from '../library/media-groups'
import { canvasNodeMediaKind, type CanvasNodeSourceCatalog } from '../library/node-model-availability'
import { knownNonImageModel, knownNonTextModel } from '../models'

export interface WorkshopModelMappingInput {
  nodes: readonly EditorNodeRecord[]
  nodeIds: readonly string[]
  groups: readonly CanvasGroupSummary[]
  catalog: CanvasNodeSourceCatalog
}
export interface WorkshopModelMappingRow {
  id: string
  purpose: MediaCapabilityKind
  originalGroup?: string
  originalGroupLabel: string
  originalModel: string
  nodeIds: string[]
  title: string
  nodeTitles: string[]
  blockedReason?: string
}
export interface WorkshopModelMappingSource {
  group: string
  label: string
  purposes?: readonly MediaCapabilityKind[]
  models: readonly string[]
  revision?: number
}
export interface WorkshopModelMappingIssue { rowId?: string; nodeId?: string; message: string; blocking?: boolean }
export interface WorkshopModelMappingChoice { rowId: string; group: string; model: string }
export interface WorkshopModelMapping { rows: WorkshopModelMappingRow[]; sources: WorkshopModelMappingSource[] }
export interface WorkshopModelMappingChange { nodeId: string; beforeGroup?: string; beforeModel: string; group: string; model: string }
export interface WorkshopModelMappingPlan { nodes: EditorNodeRecord[]; changes: WorkshopModelMappingChange[]; changedNodeIds: string[] }

const purposes: readonly MediaCapabilityKind[] = ['image', 'video', 'text']
const purposeLabels: Record<MediaCapabilityKind, string> = { image: '图片', video: '视频', text: '文字' }

/** A source's declared purpose does not make every entry in a mixed catalog
 * suitable for that purpose. Unknown aliases retain the existing purpose gate. */
export function workshopModelMappingModels(purpose: MediaCapabilityKind, source: { models: readonly string[]; purposes?: readonly MediaCapabilityKind[] }): string[] {
  const available = availableModelsForKind(purpose, source.models, source.purposes)
  if (purpose === 'image') return available.filter((model) => !knownNonImageModel(model))
  if (purpose === 'text') return available
  return available.filter((model) => knownNonImageModel(model) === knownNonTextModel(model))
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function title(node: EditorNodeRecord): string {
  const value = record(node.data.settings)?.title
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 160) : builtinNodeRegistry.resolve(node.type)?.title || node.id
}

function indexedNodes(nodes: readonly EditorNodeRecord[]): Map<string, EditorNodeRecord> {
  const result = new Map<string, EditorNodeRecord>()
  for (const node of nodes) {
    if (!node.id || result.has(node.id)) throw new Error('画布节点编号重复或不完整，请重新读取工程后映射模型')
    result.set(node.id, node)
  }
  return result
}

function assertScope(input: WorkshopModelMappingInput, byId: ReadonlyMap<string, EditorNodeRecord>): void {
  const seen = new Set<string>()
  for (const id of input.nodeIds) {
    if (seen.has(id)) throw new Error('模型映射范围包含重复节点，请重新打开准备清单')
    if (!byId.has(id)) throw new Error('模型映射范围中的节点已不在画布，请重新打开准备清单')
    seen.add(id)
  }
}

function modificationBlock(node: EditorNodeRecord, byId: ReadonlyMap<string, EditorNodeRecord>): string | undefined {
  const visited = new Set<string>()
  let current: EditorNodeRecord | undefined = node
  while (current) {
    if (visited.has(current.id)) return '所属分组存在循环，无法核对模型映射范围'
    visited.add(current.id)
    const settings = record(current.data.settings)
    const location = current.id === node.id ? `节点“${title(node)}”` : `所属分组“${title(current)}”`
    if (current.locked || settings?.locked === true || Reflect.get(current, 'draggable') === false) return `${location}已锁定，请先解锁后修改模型`
    if (current.disabled || settings?.disabled === true) return `${location}已停用，请先启用后修改模型`
    if (current.data.status === 'running' || current.data.status === 'queued') return `${location}正在运行或排队，请完成或停止原任务后再修改模型`
    if (!current.parentId) return undefined
    const parent = byId.get(current.parentId)
    if (!parent || parent.type !== 'group') return '所属分组已变化，无法核对模型映射范围'
    current = parent
  }
  return undefined
}

function mappingSources(input: WorkshopModelMappingInput): WorkshopModelMappingSource[] {
  const seen = new Set<string>(), result: WorkshopModelMappingSource[] = []
  for (const group of input.groups) {
    if (!group.name || seen.has(group.name)) throw new Error('本人模型来源目录包含重复或空编号，请重新读取来源')
    seen.add(group.name)
    const source = Object.hasOwn(input.catalog, group.name) ? input.catalog[group.name] : undefined
    if (!source || source.state !== 'ready' || group.connectionStatus && group.connectionStatus !== 'ready') continue
    const allowed = purposes.filter((purpose) => (group.purposes === undefined || group.purposes.includes(purpose)) && (source.purposes === undefined || source.purposes.includes(purpose)))
    const models = [...new Set(source.models)]
    const capabilities = allowed.filter((purpose) => workshopModelMappingModels(purpose, { models, ...(group.purposes === undefined && source.purposes === undefined ? {} : { purposes: allowed }) }).length > 0)
    if (!capabilities.length) continue
    result.push({ group: group.name, label: group.description || source.label || group.name, ...(group.purposes === undefined && source.purposes === undefined ? {} : { purposes: capabilities }), models, ...(group.revision === undefined ? {} : { revision: group.revision }) })
  }
  return result
}

/** This token is an exact local snapshot, not an authorization or provider probe.
 * It binds old choices to the live source revisions/catalog used for the rows. */
function sourceToken(input: WorkshopModelMappingInput, purpose: MediaCapabilityKind): unknown[] {
  return input.groups.map((group) => {
    const source = Object.hasOwn(input.catalog, group.name) ? input.catalog[group.name] : undefined
    return [group.name, group.revision ?? null, group.connectionStatus ?? null, group.purposes ?? null, group.videoProtocol ?? null, source?.state ?? null, source?.purposes ?? null, source?.videoProtocol ?? null, source ? workshopModelMappingModels(purpose, source) : []]
  }).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
}

/** The caller expands selected groups. This model never adds children or the
 * execution planner's implicit upstream dependencies to the requested scope. */
export function buildWorkshopModelMapping(input: WorkshopModelMappingInput): WorkshopModelMapping {
  const byId = indexedNodes(input.nodes)
  assertScope(input, byId)
  const selected = new Set(input.nodeIds), rows: WorkshopModelMappingRow[] = [], keyed = new Map<string, WorkshopModelMappingRow>()
  const sources = mappingSources(input)
  for (const node of input.nodes) {
    if (!selected.has(node.id)) continue
    const purpose = canvasNodeMediaKind(node.type)
    if (!purpose) continue
    const group = node.data.group, model = node.data.model
    const validGroup = group === undefined || typeof group === 'string' && group.length > 0 && group.trim() === group
    const validModel = typeof model === 'string'
    const originalGroup = typeof group === 'string' ? group : undefined
    const originalModel = typeof model === 'string' ? model : ''
    const key = JSON.stringify([purpose, group === undefined ? ['inherited'] : validGroup ? ['fixed', group] : ['invalid', typeof group], validModel ? model : ['invalid']])
    let row = keyed.get(key)
    if (!row) {
      const source = originalGroup === undefined ? undefined : input.groups.find((entry) => entry.name === originalGroup)
      const originalGroupLabel = group === undefined ? '继承画布默认来源' : source?.description || (source ? source.name : '原来源不可用')
      row = { id: '', purpose, ...(originalGroup === undefined ? {} : { originalGroup }), originalGroupLabel, originalModel, nodeIds: [], title: `${purposeLabels[purpose]} · ${originalGroupLabel} · ${originalModel || '未选择模型'}`, nodeTitles: [] }
      keyed.set(key, row); rows.push(row)
    }
    row.nodeIds.push(node.id); row.nodeTitles.push(title(node))
    const blocked = !validGroup ? '原固定来源格式不正确，请先在节点中核对来源' : !validModel ? '原模型格式不正确，请先在节点中核对模型' : modificationBlock(node, byId)
    if (blocked && !row.blockedReason) row.blockedReason = blocked
  }
  for (const row of rows) row.id = JSON.stringify([row.purpose, row.originalGroup === undefined ? ['inherited'] : ['fixed', row.originalGroup], row.originalModel, [...row.nodeIds].sort(), sourceToken(input, row.purpose)])
  return { rows, sources }
}

/** Only routing fields change here. The App applies its existing downstream
 * dirty/projection transaction exactly once after reviewing this pure plan. */
export function planWorkshopModelMapping(input: WorkshopModelMappingInput & { choices: readonly WorkshopModelMappingChoice[] }): WorkshopModelMappingPlan {
  const mapping = buildWorkshopModelMapping(input), rows = new Map(mapping.rows.map((row) => [row.id, row])), selected = new Map<string, WorkshopModelMappingChoice>(), changes: WorkshopModelMappingChange[] = []
  const rowIds = new Set<string>()
  for (const choice of input.choices) {
    if (!record(choice) || Object.keys(choice).some((key) => !['rowId', 'group', 'model'].includes(key)) || typeof choice.rowId !== 'string' || typeof choice.group !== 'string' || typeof choice.model !== 'string') throw new Error('模型映射选择格式不正确，请重新选择来源与模型')
    if (rowIds.has(choice.rowId)) throw new Error('同一模型映射行不能重复提交，请重新检查选择')
    rowIds.add(choice.rowId)
    const row = rows.get(choice.rowId)
    if (!row) throw new Error('模型映射范围、原配置或来源目录已变化，请重新打开并选择')
    if (row.blockedReason) throw new Error(row.blockedReason)
    const source = mapping.sources.find((entry) => entry.group === choice.group)
    if (!source || source.purposes !== undefined && !source.purposes.includes(row.purpose)) throw new Error('所选模型来源不存在、未就绪或不支持此用途，请重新核对')
    if (!choice.model || !workshopModelMappingModels(row.purpose, source).includes(choice.model)) throw new Error('所选模型已不可用或用途不匹配，请重新读取模型目录')
    for (const id of row.nodeIds) selected.set(id, choice)
  }
  const nodes = input.nodes.map((node) => {
    const choice = selected.get(node.id)
    if (!choice || node.data.group === choice.group && node.data.model === choice.model) return node
    changes.push({ nodeId: node.id, ...(node.data.group === undefined ? {} : { beforeGroup: String(node.data.group) }), beforeModel: String(node.data.model), group: choice.group, model: choice.model })
    return { ...node, data: { ...node.data, group: choice.group, model: choice.model } }
  })
  return { nodes, changes, changedNodeIds: changes.map((change) => change.nodeId) }
}
