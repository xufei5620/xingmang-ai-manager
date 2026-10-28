import type { CanvasImageAssetSummary } from '../host'
import type { WorkflowFile, WorkflowNode } from '../model'
import type { UpstreamMediaReference } from '../components/upstream-references'
import { parseImageReferenceOrder, type ImageReferenceSlot } from '../commerce/image-reference-order'
import { parsePromptReferences, type PromptReference } from '../library/prompt-references'
import { assertStoryboardTaskConfiguration, buildStoryboardAnalysisPrompt, parseNodeStoryboardTask, parseStoryboardTask, resolveStoryboardImageRequest, storyboardTaskUsesAnalysis, type StoryboardTask } from './storyboard-task'
import { validateTextImageInputConfiguration } from '../runtime/text-image-input'
import { parseImageCandidateCount } from '../runtime/image-candidate-count'
import { canvasNodeDisplayGeometry } from '../domain/node-display-geometry'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { findAvailableCanvasPosition } from '../editor/node-placement'
import { mediaAssetNodeDimensions } from '../library/media-assets'
import { imageTransformRecipeForNode } from '../image-tools/recipe'

export interface StoryboardReferenceSubmission {
  role: 'source' | 'reference'
  binding: { kind: 'existing'; edgeId: string; outputIndex: number } | { kind: 'asset'; assetId: string } | { kind: 'missing' }
}
export interface StoryboardTaskEditDraft {
  mode: 'create' | 'edit'
  task: StoryboardTask
  references: readonly StoryboardReferenceSubmission[]
  prompt: string
  promptReferences?: PromptReference[]
  model: string
  size: string
  quality: string
  imageResolution: '1K' | '2K' | '4K'
  imageCandidateCount: 1 | 2 | 3 | 4
  analysis?: { model: string }
}
export interface StoryboardNodeEditInput {
  workflow: WorkflowFile
  nodeId: string
  draft: StoryboardTaskEditDraft
  currentReferences: readonly UpstreamMediaReference[]
  assets: readonly CanvasImageAssetSummary[]
  analysisGroup?: string
  createId: () => string
}

export function assertStoryboardNodeEditable(nodes: readonly WorkflowNode[], nodeId: string): WorkflowNode {
  const node = nodes.find((entry) => entry.id === nodeId)
  if (!node || node.data.settings?.storyboardTask === undefined) throw new Error('原故事板节点已变化，请重新打开配置')
  const task = parseNodeStoryboardTask(node.kind, node.data.settings.storyboardTask)
  assertStoryboardTaskConfiguration(task, parseImageReferenceOrder(node.data.settings.imageReferenceOrder), node.data.settings.commerceTask, node.data.settings.interiorTask, node.data.settings.exteriorTask)
  const seen = new Set<string>()
  let current: WorkflowNode | undefined = node
  while (current) {
    if (seen.has(current.id) || current.disabled || current.locked) throw new Error('故事板节点或上级分组已锁定、禁用或层级无效，请先解除后再编辑')
    seen.add(current.id)
    if (!current.parentId) break
    current = nodes.find((entry) => entry.id === current!.parentId)
    if (!current || current.kind !== 'group') throw new Error('上级分组已变化，请重新打开工程')
  }
  return node
}

function analysisPromptReferences(task: StoryboardTask, prompt: string, references: PromptReference[]): PromptReference[] {
  const canonical = buildStoryboardAnalysisPrompt(task, prompt)
  if (!references.length) return []
  if (!prompt.trim() || !canonical.endsWith(prompt)) throw new Error('剧情引用无法安全同步到分析，请先展开引用后再编辑')
  const offset = canonical.length - prompt.length
  const shifted = references.map((entry) => ({ ...entry, start: entry.start + offset, end: entry.end + offset }))
  const parsed = parsePromptReferences(canonical, shifted)
  if (parsed.length !== references.length) throw new Error('剧情引用位置已变化，请重新插入引用')
  return parsed
}

/** Return one complete graph command payload; shared inputs and old outputs stay intact. */
export function buildStoryboardNodeEdit(input: StoryboardNodeEditInput): WorkflowFile {
  if (input.draft.mode !== 'edit') throw new Error('故事板编辑会话不正确')
  const task = parseStoryboardTask(input.draft.task), original = assertStoryboardNodeEditable(input.workflow.nodes, input.nodeId)
  const draft = input.draft
  if (typeof draft.prompt !== 'string' || draft.prompt.length > 24_000 || draft.prompt.includes('\0')) throw new Error('剧情或补充要求格式不正确或过长')
  resolveStoryboardImageRequest(task, { model: draft.model, prompt: draft.prompt })
  if (parseImageCandidateCount(draft.imageCandidateCount, original.kind) === undefined) throw new Error('请选择明确的候选数量')
  if (!Array.isArray(draft.references) || draft.references.length < 1 || draft.references.length > 4 || draft.references.some((entry) => !['source', 'reference'].includes(entry.role))) throw new Error('故事板需要按顺序选择 1 到 4 张图片')
  const automatic = storyboardTaskUsesAnalysis(task)
  if (automatic) {
    if (!draft.analysis) throw new Error('自动剧情需要明确选择视觉文字模型')
    validateTextImageInputConfiguration(draft.analysis.model, draft.references.length)
  }
  const oldTask = parseStoryboardTask(original.data.settings!.storyboardTask)
  function sourceIdentities(order: ReturnType<typeof parseImageReferenceOrder>, nodeId: string): string {
    return JSON.stringify(order.slots.map((slot) => {
      const edge = 'edgeId' in slot ? input.workflow.edges.find((entry) => entry.id === slot.edgeId && entry.target === nodeId && entry.targetHandle === 'in:images' && ['out:image', 'out:images'].includes(entry.sourceHandle)) : undefined
      return edge && 'outputIndex' in slot ? [slot.role, edge.source, edge.sourceHandle, slot.outputIndex] : [slot.role, 'missing']
    }))
  }
  const originalOrder = parseImageReferenceOrder(original.data.settings?.imageReferenceOrder)
  const configured = new Set(originalOrder.slots.flatMap((slot) => 'edgeId' in slot ? [slot.edgeId] : []))
  if (input.workflow.edges.some((edge) => edge.target === original.id && ['in:image', 'in:images'].includes(edge.targetHandle) && !configured.has(edge.id))) throw new Error('有新连接的图片尚未分配顺序，请先核对或断开未选图片')
  const originalIdentity = sourceIdentities(originalOrder, original.id), analysisEdges = new Set<string>(), privateAnalyses: string[] = []
  for (const edge of input.workflow.edges.filter((entry) => entry.target === original.id && entry.targetHandle === 'in:text')) {
    const source = input.workflow.nodes.find((entry) => entry.id === edge.source)
    const visual = source?.kind === 'text-generate' && (source.data.settings?.imageReferenceOrder !== undefined || input.workflow.edges.some((incoming) => incoming.target === source.id && ['out:image', 'out:images'].includes(incoming.sourceHandle)))
    if (!visual) { if (automatic) throw new Error('自动剧情还存在其他文字输入，请先核对或断开'); continue }
    if (!source || edge.sourceHandle !== 'out:text' || source.disabled || source.data.textWebSearch || !storyboardTaskUsesAnalysis(oldTask) || source.data.prompt !== buildStoryboardAnalysisPrompt(oldTask, original.data.prompt) || sourceIdentities(parseImageReferenceOrder(source.data.settings?.imageReferenceOrder), source.id) !== originalIdentity) throw new Error('此任务连接了另一组图片、旧剧情或不明确的分析，请先核对文字连接')
    const order = parseImageReferenceOrder(source.data.settings?.imageReferenceOrder), allowed = new Set(order.slots.flatMap((slot) => 'edgeId' in slot ? [slot.edgeId] : []))
    if (input.workflow.edges.some((incoming) => incoming.target === source.id && (incoming.targetHandle !== 'in:images' || !allowed.has(incoming.id)))) throw new Error('图片分析存在额外的图片或文字输入，请先核对')
    const shared = input.workflow.edges.some((outgoing) => outgoing.source === source.id && outgoing.id !== edge.id)
    let editable = !source.locked, ancestor = source.parentId
    const seen = new Set<string>([source.id])
    while (ancestor) {
      const parent = input.workflow.nodes.find((entry) => entry.id === ancestor)
      if (!parent || parent.kind !== 'group' || seen.has(parent.id)) throw new Error('图片分析分组层级已变化，请重新打开工程')
      seen.add(parent.id)
      if (parent.locked || parent.disabled) editable = false
      ancestor = parent.parentId
    }
    if (!shared && editable) privateAnalyses.push(source.id)
    analysisEdges.add(edge.id)
  }
  if (analysisEdges.size > 1) throw new Error('此任务存在多个图片分析，请先核对唯一分析关系')
  const selected = draft.references.map((reference) => {
    if (reference.binding.kind === 'existing') {
      const binding = reference.binding
      const edge = input.workflow.edges.find((entry) => entry.id === binding.edgeId && entry.target === original.id && entry.targetHandle === 'in:images')
      const resolved = input.currentReferences.find((entry) => entry.edgeId === binding.edgeId && (entry.outputIndex ?? 0) === binding.outputIndex)
      if (!edge || !resolved || resolved.kind !== 'image' || resolved.status !== 'ready' || resolved.sourceNodeId !== edge.source || resolved.asset?.kind !== 'image' || !/^[A-Za-z0-9_-]{43}$/.test(resolved.asset.assetId ?? '') || !Number.isInteger(binding.outputIndex) || binding.outputIndex < 0) throw new Error('原图片连接已变化或尚未就绪，请重新选择')
      const source = input.workflow.nodes.find((entry) => entry.id === edge.source)
      if (!source || edge.sourceHandle === 'out:image' && binding.outputIndex !== 0 || !['out:image', 'out:images'].includes(edge.sourceHandle)) throw new Error('图片输出位置已变化，请重新绑定')
      if (edge.sourceHandle === 'out:images') {
        const recipe = imageTransformRecipeForNode(source.kind, source.data.settings)
        if (source.kind !== 'image-grid-split' || recipe?.kind !== 'grid-split' || binding.outputIndex >= recipe.rows * recipe.columns) throw new Error('此批次无法核对稳定图片位置，请改用单图输出')
      }
      return { assetId: resolved.asset.assetId!, edgeId: edge.id, outputIndex: binding.outputIndex }
    }
    if (reference.binding.kind !== 'asset') throw new Error('请重新绑定缺失的故事板图片')
    const binding = reference.binding, asset = input.assets.find((entry) => entry.assetId === binding.assetId)
    if (!asset || asset.deletedAt || !/^[A-Za-z0-9_-]{43}$/.test(asset.assetId) || asset.localUrl !== `xingmang-asset://image/${asset.assetId}`) throw new Error('新图片尚未核对或已失效，请重新选择')
    return { assetId: asset.assetId, asset }
  })
  if (new Set(selected.map((entry) => entry.assetId)).size !== selected.length) throw new Error('故事板不能重复使用同一张实际图片')
  const mask = original.data.settings?.imageEditMask
  if (mask && typeof mask === 'object' && !Array.isArray(mask) && Reflect.get(mask, 'sourceAssetId') !== selected[0].assetId) throw new Error('主体图已更换，请先清除旧蒙版再重新绘制')
  const references = parsePromptReferences(draft.prompt, draft.promptReferences ?? original.data.promptReferences)
  const analysisReferences = automatic ? analysisPromptReferences(task, draft.prompt, references) : []
  const workflow = structuredClone(input.workflow), node = workflow.nodes.find((entry) => entry.id === input.nodeId)!
  const ids = new Set([...workflow.nodes, ...workflow.edges].map((entry) => entry.id))
  function nextId(): string {
    const id = input.createId()
    if (typeof id !== 'string' || !id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id) || ids.has(id)) throw new Error('节点与连线编号冲突')
    ids.add(id)
    return id
  }
  const origin = { ...node.position }
  let parentId = node.parentId
  while (parentId) { const parent = workflow.nodes.find((entry) => entry.id === parentId)!; origin.x += parent.position.x; origin.y += parent.position.y; parentId = parent.parentId }
  const keepEdges = new Set<string>()
  const slots = selected.map((entry, index): ImageReferenceSlot => {
    const role = index === 0 ? 'source' : 'reference'
    if (entry.edgeId !== undefined) { keepEdges.add(entry.edgeId); return { role, edgeId: entry.edgeId, outputIndex: entry.outputIndex } }
    const asset = entry.asset!
    const source: WorkflowNode = { id: nextId(), kind: 'image-input', definitionVersion: 1, position: { x: origin.x - 380, y: origin.y + index * 400 }, data: { prompt: '', model: '', status: 'succeeded', dirty: false, settings: { title: (asset.displayName || asset.fileName).slice(0, 160) }, result: { kind: 'image', assetId: asset.assetId, localUrl: asset.localUrl, mimeType: asset.mimeType, width: asset.width, height: asset.height } } }
    workflow.nodes.push(source)
    const edge = { id: nextId(), source: source.id, target: node.id, sourceHandle: 'out:image', targetHandle: 'in:images' }
    workflow.edges.push(edge); keepEdges.add(edge.id)
    return { role, edgeId: edge.id, outputIndex: 0 }
  })
  const order = parseImageReferenceOrder({ version: 1, slots })
  workflow.edges = workflow.edges.filter((edge) => !analysisEdges.has(edge.id) && (edge.target !== node.id || !['in:image', 'in:images'].includes(edge.targetHandle) || keepEdges.has(edge.id)))
  node.data = { ...node.data, prompt: draft.prompt, promptReferences: references, model: draft.model, size: draft.size, quality: draft.quality, imageResolution: draft.imageResolution, imageCandidateCount: draft.imageCandidateCount, dirty: true, settings: { ...node.data.settings, title: '故事板', storyboardTask: task, imageReferenceOrder: order } }
  if (automatic) {
    const reusable = privateAnalyses.length === 1 ? workflow.nodes.find((entry) => entry.id === privateAnalyses[0]) : undefined
    const analysis: WorkflowNode = reusable ?? { id: nextId(), kind: 'text-generate', definitionVersion: 1, position: { x: origin.x - 420, y: origin.y + 560 }, data: { prompt: '', model: '', status: 'idle' } }
    analysis.data = { ...analysis.data, prompt: buildStoryboardAnalysisPrompt(task, draft.prompt), promptReferences: analysisReferences, model: draft.analysis!.model, group: input.analysisGroup, dirty: true, settings: { ...analysis.data.settings, title: '当前故事板剧情分析' } }
    if (reusable) workflow.edges = workflow.edges.filter((edge) => edge.target !== reusable.id || edge.targetHandle !== 'in:images')
    const analysisSlots = order.slots.map((slot): ImageReferenceSlot => {
      if (!('edgeId' in slot)) throw new Error('自动剧情图片尚未绑定')
      const edge = workflow.edges.find((entry) => entry.id === slot.edgeId)!, copy = { ...edge, id: nextId(), target: analysis.id }
      workflow.edges.push(copy)
      return { role: slot.role, edgeId: copy.id, outputIndex: slot.outputIndex }
    })
    analysis.data.settings = { ...analysis.data.settings, imageReferenceOrder: { version: 1, slots: analysisSlots } }
    if (!reusable) workflow.nodes.push(analysis)
    workflow.edges.push({ id: nextId(), source: analysis.id, target: node.id, sourceHandle: 'out:text', targetHandle: 'in:text' })
  } else for (const id of privateAnalyses) workflow.nodes.find((entry) => entry.id === id)!.disabled = true
  const dirty = new Set([node.id])
  for (let changed = true; changed;) { changed = false; for (const edge of workflow.edges) if (dirty.has(edge.source) && !dirty.has(edge.target)) { dirty.add(edge.target); changed = true } }
  for (const entry of workflow.nodes) if (dirty.has(entry.id)) entry.data.dirty = true
  const originalIds = new Set(input.workflow.nodes.map((entry) => entry.id)), placed = workflow.nodes.filter((entry) => originalIds.has(entry.id))
  for (const added of workflow.nodes.filter((entry) => !originalIds.has(entry.id))) {
    const geometry = canvasNodeDisplayGeometry(added), fallback = builtinNodeRegistry.require(added.kind).dimensions
    const dimensions = added.kind === 'image-input' && added.data.result ? mediaAssetNodeDimensions(added.data.result) : { width: geometry.width ?? fallback.width, height: geometry.height ?? fallback.height }
    const obstacles = placed.map((entry) => { const size = canvasNodeDisplayGeometry(entry), fallback = builtinNodeRegistry.require(entry.kind).dimensions; return { ...entry, type: entry.kind, width: size.width ?? entry.width ?? fallback.width, height: size.height ?? entry.height ?? fallback.height } })
    added.position = findAvailableCanvasPosition(obstacles, { x: added.position.x + dimensions.width / 2, y: added.position.y + dimensions.height / 2 }, dimensions)
    added.width = dimensions.width
    if (added.kind === 'image-input') added.height = dimensions.height
    placed.push(added)
  }
  return workflow
}

/** Keep ordinary prompt editing synchronous with its explicit automatic analysis. */
export function buildStoryboardPromptEdit(input: { workflow: WorkflowFile; nodeId: string; prompt: string; promptReferences?: PromptReference[]; currentReferences: readonly UpstreamMediaReference[]; createId: () => string }): WorkflowFile | undefined {
  const node = input.workflow.nodes.find((entry) => entry.id === input.nodeId)
  if (node?.data.settings?.storyboardTask === undefined) return undefined
  const task = parseNodeStoryboardTask(node.kind, node.data.settings.storyboardTask)
  if (!storyboardTaskUsesAnalysis(task)) return undefined
  const references = parsePromptReferences(input.prompt, input.promptReferences ?? node.data.promptReferences)
  if (node.data.prompt === input.prompt && JSON.stringify(node.data.promptReferences ?? []) === JSON.stringify(references)) return undefined
  const analysisEdges = input.workflow.edges.filter((edge) => edge.target === node.id && edge.targetHandle === 'in:text')
  const analysis = analysisEdges.length === 1 ? input.workflow.nodes.find((entry) => entry.id === analysisEdges[0].source) : undefined
  if (!analysis) throw new Error('故事板自动剧情分析已变化，请重新打开配置')
  if (!node.data.size || !node.data.quality || !node.data.imageResolution || node.data.imageCandidateCount === undefined) throw new Error('故事板生成参数已变化，请重新打开配置')
  const order = parseImageReferenceOrder(node.data.settings.imageReferenceOrder)
  return buildStoryboardNodeEdit({ ...input, assets: [], analysisGroup: analysis.data.group, draft: { mode: 'edit', task, references: order.slots.map((slot) => { if (!('edgeId' in slot)) throw new Error('故事板图片已失联，请重新绑定'); return { role: slot.role, binding: { kind: 'existing', edgeId: slot.edgeId, outputIndex: slot.outputIndex } } }), prompt: input.prompt, promptReferences: references, model: node.data.model, size: node.data.size, quality: node.data.quality, imageResolution: node.data.imageResolution, imageCandidateCount: node.data.imageCandidateCount, analysis: { model: analysis.data.model } } })
}
