import { createEmptyWorkflow, type WorkflowFile, type WorkflowNode, type WorkflowEdge } from '../model'
import type { CommerceWorkflowAsset } from '../commerce/commerce-workflow'
import { parseImageReferenceOrder, type ImageReferenceOrder } from '../commerce/image-reference-order'
import { parseImageCandidateCount, type ImageCandidateCount } from '../runtime/image-candidate-count'
import { validateTextImageInputConfiguration } from '../runtime/text-image-input'
import { mediaAssetNodeDimensions } from '../library/media-assets'
import { canvasNodeDisplayGeometry } from '../domain/node-display-geometry'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { findAvailableCanvasPosition } from '../editor/node-placement'
import { buildStoryboardAnalysisPrompt, parseStoryboardTask, resolveStoryboardImageRequest, storyboardTaskUsesAnalysis, type StoryboardTask } from './storyboard-task'

export interface StoryboardWorkflowBuildInput {
  name?: string
  task: StoryboardTask
  sources: readonly CommerceWorkflowAsset[]
  prompt: string
  model: string
  group?: string
  size?: string
  quality?: string
  imageResolution?: '1K' | '2K' | '4K'
  candidateCount: ImageCandidateCount
  analysis?: { model: string; group?: string; prompt?: string }
  createId: () => string
}

/** Panels describe one image's composition; only candidateCount creates requests. */
export function buildStoryboardWorkflow(input: StoryboardWorkflowBuildInput): WorkflowFile {
  const task = parseStoryboardTask(input.task), automatic = storyboardTaskUsesAnalysis(task)
  if (typeof input.prompt !== 'string' || input.prompt.length > 24_000 || input.prompt.includes('\0')) throw new Error('剧情或补充要求格式不正确或过长')
  resolveStoryboardImageRequest(task, { model: input.model, prompt: input.prompt })
  if (parseImageCandidateCount(input.candidateCount, 'image-generate') === undefined) throw new Error('请选择明确的候选数量')
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 4) throw new Error('故事板需要按顺序选择 1 到 4 张图片')
  const assetIds = new Set<string>()
  for (const asset of input.sources) {
    if (!asset || !/^[A-Za-z0-9_-]{43}$/.test(asset.assetId) || [asset.width, asset.height].some((value) => value !== undefined && (!Number.isFinite(value) || value <= 0))) throw new Error('请选择本人素材库中已保存的有效图片')
    if (assetIds.has(asset.assetId)) throw new Error('故事板不能重复使用同一张实际图片')
    assetIds.add(asset.assetId)
  }
  if (automatic !== Boolean(input.analysis)) throw new Error('自动剧情必须明确配置可见的图片分析节点与文字模型')
  if (input.analysis) validateTextImageInputConfiguration(input.analysis.model, input.sources.length)
  const ids = new Set<string>(), nodes: WorkflowNode[] = [], edges: WorkflowEdge[] = []
  function nextId(): string {
    const id = input.createId()
    if (typeof id !== 'string' || !id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id) || ids.has(id)) throw new Error('节点与连线编号冲突')
    ids.add(id)
    return id
  }
  function addNode(kind: WorkflowNode['kind'], x: number, y: number, title: string, prompt = ''): WorkflowNode {
    const node: WorkflowNode = { id: nextId(), kind, definitionVersion: 1, position: { x, y }, data: { prompt, model: '', status: 'idle', settings: { title } } }
    nodes.push(node)
    return node
  }
  function connect(source: WorkflowNode, target: WorkflowNode, sourceHandle: string, targetHandle: string): WorkflowEdge {
    const edge = { id: nextId(), source: source.id, target: target.id, sourceHandle, targetHandle }
    edges.push(edge)
    return edge
  }
  const sources = input.sources.map((asset, index) => {
    const node = addNode('image-input', 80, 80 + index * 400, (asset.label || (index === 0 ? '故事主体图' : `故事参考图 ${index + 1}`)).slice(0, 160))
    node.data.status = 'succeeded'
    node.data.result = { kind: 'image', assetId: asset.assetId, localUrl: `xingmang-asset://image/${asset.assetId}`, ...(asset.width !== undefined ? { width: asset.width } : {}), ...(asset.height !== undefined ? { height: asset.height } : {}) }
    return node
  })
  function bindImages(target: WorkflowNode): void {
    const slots: ImageReferenceOrder['slots'] = sources.map((source, index) => ({ role: index === 0 ? 'source' : 'reference', edgeId: connect(source, target, 'out:image', 'in:images').id, outputIndex: 0 }))
    target.data.settings = { ...target.data.settings, imageReferenceOrder: parseImageReferenceOrder({ version: 1, slots }) }
  }
  const analysis = input.analysis ? addNode('text-generate', 440, 80, '故事板剧情分析', buildStoryboardAnalysisPrompt(task, input.prompt)) : undefined
  if (analysis && input.analysis) {
    analysis.data.model = input.analysis.model
    if (input.analysis.group) analysis.data.group = input.analysis.group
    bindImages(analysis)
  }
  const image = addNode('image-generate', analysis ? 800 : 440, 80, '故事板', input.prompt)
  image.data = { ...image.data, model: input.model, ...(input.group ? { group: input.group } : {}), size: input.size ?? '1024x1024', quality: input.quality ?? 'low', imageResolution: input.imageResolution ?? '1K', imageCandidateCount: input.candidateCount, settings: { ...image.data.settings, storyboardTask: task } }
  bindImages(image)
  if (analysis) connect(analysis, image, 'out:text', 'in:text')
  const gallery = addNode('gallery', analysis ? 1160 : 800, 80, '故事板候选')
  connect(image, gallery, 'out:image', 'in:images')
  // Actual media geometry is authoritative, including tall portrait references.
  const placed: WorkflowNode[] = []
  for (const node of nodes) {
    const geometry = canvasNodeDisplayGeometry(node), fallback = builtinNodeRegistry.require(node.kind).dimensions
    const dimensions = node.kind === 'image-input' && node.data.result ? mediaAssetNodeDimensions(node.data.result) : { width: geometry.width ?? fallback.width, height: geometry.height ?? fallback.height }
    const obstacles = placed.map((entry) => { const size = canvasNodeDisplayGeometry(entry), fallback = builtinNodeRegistry.require(entry.kind).dimensions; return { ...entry, type: entry.kind, width: size.width ?? fallback.width, height: size.height ?? fallback.height } })
    node.position = findAvailableCanvasPosition(obstacles, { x: node.position.x + dimensions.width / 2, y: node.position.y + dimensions.height / 2 }, dimensions)
    node.width = dimensions.width
    if (node.kind === 'image-input') node.height = dimensions.height
    placed.push(node)
  }
  return { ...createEmptyWorkflow(input.name || '故事板创作'), nodes: placed, edges }
}
