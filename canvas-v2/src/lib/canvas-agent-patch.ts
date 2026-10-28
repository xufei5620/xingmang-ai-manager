import { assertCanvasAgentProposalMediaModels, type CanvasAgentMediaModels } from './canvas-agent-media-models'
import type { WorkflowFile, WorkflowNode } from '../model'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { canvasNodeDisplayGeometry } from '../domain/node-display-geometry'
import { isValidWorkflowConnection } from '../ports'
import { toPersistedWorkflowV2 } from '../persistence/workflow-schema'
import { parseWorkflowFileDetailed } from '../persistence/workflow-serializer'
import { assertCanvasAgentNodeBindings } from './canvas-agent-node-bindings'
import { parseCanvasAgentNodeSettings, canvasAgentSettingsAffectOutput } from './canvas-agent-node-settings'
import { CanvasAgentError, canvasAgentNodeKinds, type CanvasAgentImageReference, type CanvasAgentProposal } from './canvas-agent-contract'
import { assertCanvasAgentProposalImageBindings } from './canvas-agent-image-bindings'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, item]) => [key, canonical(item)]))
  return value
}

export function canvasAgentGraphSnapshot(workflow: WorkflowFile): string {
  const persisted = toPersistedWorkflowV2({ ...workflow, nodes: workflow.nodes.map((node) => ({ ...node, ...canvasNodeDisplayGeometry(node) })) })
  return JSON.stringify(canonical({ mediaGroups: persisted.mediaGroups ?? {}, nodes: persisted.nodes, edges: persisted.edges }))
}

/** Viewport and transient run/UI fields cannot invalidate a reviewed graph. */
export async function canvasAgentGraphDigest(workflow: WorkflowFile): Promise<string> {
  const bytes = new TextEncoder().encode(canvasAgentGraphSnapshot(workflow))
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function locked(node: WorkflowNode, byId: Map<string, WorkflowNode>): boolean {
  const seen = new Set<string>()
  let current: WorkflowNode | undefined = node
  while (current) {
    if (current.locked || current.disabled || seen.has(current.id)) return true
    seen.add(current.id)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return false
}

function updateText(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new CanvasAgentError('Agent 提案的节点参数格式不正确')
  return value
}

function assertDataKind(kind: string, data: Record<string, unknown>): void {
  if ((data.size !== undefined || data.quality !== undefined || data.imageResolution !== undefined) && !['image', 'image-generate', 'image-edit'].includes(kind)) throw new CanvasAgentError('图像参数不能应用到此节点类型')
  if (data.seconds !== undefined && !['video', 'video-generate'].includes(kind)) throw new CanvasAgentError('视频参数不能应用到此节点类型')
  if (['image-input', 'video-input', 'audio-input'].includes(kind) && (data.prompt !== undefined && data.prompt !== '' || data.size !== undefined || data.quality !== undefined || data.imageResolution !== undefined || data.seconds !== undefined || data.settings !== undefined)) throw new CanvasAgentError('素材占位节点不能预置素材、提示词或处理参数')
}

/**
 * The model never receives a replace-project capability. Only the reviewed
 * additions and scalar patches are applied; existing assets, layout, provider
 * configuration and edges stay owned by the current editor document.
 */
export function buildCanvasAgentProposalWorkflow(base: WorkflowFile, proposal: CanvasAgentProposal, options: { planningVersion?: 2 | 3; imageReferences?: readonly CanvasAgentImageReference[]; mediaModels?: CanvasAgentMediaModels } = {}): WorkflowFile {
  if (options.planningVersion !== undefined && options.planningVersion !== 2 && options.planningVersion !== 3) throw new CanvasAgentError('Agent 规划版本不受支持')
  assertCanvasAgentProposalMediaModels(proposal, options.mediaModels, base)
  const advanced = options.planningVersion === 2 || options.planningVersion === 3
  assertCanvasAgentProposalImageBindings(proposal, options.planningVersion, options.imageReferences)
  if (!advanced && (proposal.nodes.some((node) => !canvasAgentNodeKinds.slice(0, 7).some((kind) => kind === node.kind)) || proposal.updates.some((patch) => patch.data?.settings !== undefined))) throw new CanvasAgentError('原规划版本不支持本地节点参数，请重新发起规划')
  if (proposal.nodes.length > 40 || proposal.edges.length > 100 || proposal.updates.length > 40 || !proposal.nodes.length && !proposal.updates.length && !proposal.edges.length) throw new CanvasAgentError('Agent 提案为空或超过单次修改范围')
  const originalById = new Map(base.nodes.map((node) => [node.id, node]))
  const nodeIds = new Set(originalById.keys())
  const edgeIds = new Set(base.edges.map((edge) => edge.id))
  const updates = new Map<string, CanvasAgentProposal['updates'][number]>()
  for (const update of proposal.updates) {
    const node = originalById.get(update.nodeId)
    if (!node || node.unknownKind || locked(node, originalById)) throw new CanvasAgentError('要修改的节点不存在、被锁定或类型暂不支持，请重新规划')
    if (updates.has(node.id)) throw new CanvasAgentError('Agent 提案重复修改同一节点')
    if (Object.keys(update).some((key) => !['nodeId', 'title', 'data'].includes(key))) throw new CanvasAgentError('Agent 提案包含不支持的修改')
    if (update.title !== undefined) updateText(update.title, 160)
    if (update.data) {
      if (Object.keys(update.data).some((key) => !['prompt', 'size', 'quality', 'imageResolution', 'seconds', 'model', 'group', 'settings'].includes(key))) throw new CanvasAgentError('Agent 提案包含不支持的节点参数')
      for (const [key, value] of Object.entries(update.data)) if (key !== 'settings') updateText(value, key === 'prompt' ? 24_000 : key === 'model' ? 200 : 128)
      if (update.data.settings) parseCanvasAgentNodeSettings(update.data.settings, node.kind)
      assertDataKind(node.kind, update.data)
      if (update.data.imageResolution && !['1K', '2K', '4K'].includes(update.data.imageResolution)) throw new CanvasAgentError('Agent 提案的清晰度无效')
    }
    updates.set(node.id, update)
  }
  for (const node of proposal.nodes) {
    if (nodeIds.has(node.id)) throw new CanvasAgentError('提案节点已存在，不能重复应用；请核对原操作')
    if (!canvasAgentNodeKinds.some((kind) => kind === node.kind) || !builtinNodeRegistry.resolve(node.kind) || node.parentId || node.unknownKind || node.disabled || node.locked) throw new CanvasAgentError('Agent 提案包含不支持的新节点')
    if (node.data.result || node.data.outputText || node.data.candidateAssetIds || node.data.candidates) throw new CanvasAgentError('Agent 提案不能带入生成结果、素材或模型来源')
    if (Object.keys(node.data).some((key) => !['prompt', 'model', 'group', 'status', 'settings', 'size', 'quality', 'imageResolution', 'seconds'].includes(key)) || !['idle', undefined].includes(node.data.status)) throw new CanvasAgentError('Agent 新节点包含不允许的参数')
    const { title: _title, ...localSettings } = node.data.settings ?? {}
    if (Object.keys(localSettings).length) parseCanvasAgentNodeSettings(localSettings, node.kind)
    assertDataKind(node.kind, { ...node.data, ...(Object.keys(localSettings).length ? { settings: localSettings } : { settings: undefined }) })
    nodeIds.add(node.id)
  }
  const nodes = base.nodes.map((node) => {
    const update = updates.get(node.id)
    if (!update) return structuredClone(node)
    const { settings, ...scalar } = update.data ?? {}
    return { ...structuredClone(node), data: { ...structuredClone(node.data), ...scalar, ...((settings || update.title !== undefined) ? { settings: { ...structuredClone(node.data.settings ?? {}), ...(settings ? parseCanvasAgentNodeSettings(settings, node.kind) : {}), ...(update.title !== undefined ? { title: update.title } : {}) } } : {}) } }
  })
  const bindings = new Map((proposal.imageBindings ?? []).map((binding) => [binding.nodeId, binding]))
  nodes.push(...structuredClone(proposal.nodes).map((node) => {
    const binding = bindings.get(node.id)
    return { ...node, data: { ...node.data, status: 'idle' as const, ...(binding ? { result: { kind: 'image' as const, assetId: binding.assetId, localUrl: `xingmang-asset://image/${binding.assetId}` } } : {}) } }
  }))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const edges = base.edges.map((edge) => ({ ...edge }))
  for (const edge of proposal.edges) {
    if (edgeIds.has(edge.id) || !isValidWorkflowConnection(edge, { edges, nodeKindOf: (id) => byId.get(id)?.kind ?? null })) throw new CanvasAgentError('Agent 提案的连线重复、端口不匹配或会形成循环')
    if (edges.some((existing) => existing.source === edge.source && existing.sourceHandle === edge.sourceHandle && existing.target === edge.target && existing.targetHandle === edge.targetHandle)) throw new CanvasAgentError('Agent 提案包含已有连线')
    edgeIds.add(edge.id)
    edges.push({ ...edge })
  }
  const next: WorkflowFile = { ...structuredClone(base), nodes, edges }
  const affected = new Set([...proposal.nodes.map((node) => node.id), ...proposal.edges.map((edge) => edge.target), ...proposal.updates.map((patch) => patch.nodeId)])
  for (const id of advanced ? affected : []) {
    const node = byId.get(id)!
    const patch = updates.get(id)
    const rawSettings = originalById.has(id) ? patch?.data?.settings : node.data.settings
    const local = Object.fromEntries(Object.entries(rawSettings ?? {}).filter(([key]) => key !== 'title'))
    assertCanvasAgentNodeBindings(node, next, Object.keys(local).length ? parseCanvasAgentNodeSettings(local, node.kind) : undefined)
  }
  // Legacy reviewed graph digests include the old dirty flags. Keep their
  // exact application semantics while advanced local proposals propagate changes.
  const dirty = new Set(advanced ? proposal.edges.map((edge) => edge.target) : [])
  for (const patch of proposal.updates) if (patch.data && (Object.keys(patch.data).some((key) => key !== 'settings') || patch.data.settings && canvasAgentSettingsAffectOutput(patch.data.settings))) dirty.add(patch.nodeId)
  const queue = advanced ? [...dirty] : []
  while (queue.length) { const source = queue.shift()!; for (const edge of edges) if (edge.source === source && !dirty.has(edge.target)) { dirty.add(edge.target); queue.push(edge.target) } }
  for (const node of nodes) if (dirty.has(node.id) && originalById.has(node.id)) node.data.dirty = true

  const parsed = parseWorkflowFileDetailed(JSON.stringify(toPersistedWorkflowV2(next)))
  const previous = parseWorkflowFileDetailed(JSON.stringify(toPersistedWorkflowV2(base)))
  if (!parsed || parsed.workflow.nodes.length !== nodes.length || parsed.workflow.edges.length !== edges.length || parsed.warnings.some((warning) => !previous?.warnings.includes(warning))) throw new CanvasAgentError('Agent 提案包含无法保存的节点或连接，请重新规划')
  return next
}
