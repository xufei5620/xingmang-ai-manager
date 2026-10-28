import { createEmptyWorkflow, type WorkflowFile, type WorkflowNode, type WorkflowEdge } from '../model'
import { parseImageCandidateCount, type ImageCandidateCount } from '../runtime/image-candidate-count'
import { commerceTaskLabels, commerceViews, parseCommerceTask, type CommerceTask } from './commerce-task'
import type { ImageReferenceOrder } from './image-reference-order'

export interface CommerceWorkflowAsset { assetId: string; label?: string; width?: number; height?: number }
export interface CommerceWorkflowBuildInput {
  name?: string
  tasks: CommerceTask[]
  source: CommerceWorkflowAsset
  reference?: CommerceWorkflowAsset
  prompt: string
  model: string
  group?: string
  size?: string
  quality?: string
  imageResolution?: '1K' | '2K' | '4K'
  candidateCount: ImageCandidateCount
  analysis?: { model: string; group?: string; prompt: string }
  createId: () => string
}

/** This constructs ordinary explicit graph dependencies, never submits work. */
export function buildCommerceWorkflow(input: CommerceWorkflowBuildInput): WorkflowFile {
  const tasks = input.tasks.map(parseCommerceTask)
  if (!tasks.length || tasks.length > 6 || tasks.length > 1 && tasks.some((task) => task.kind !== 'product-view')) throw new Error('请选择 1 个创作任务，或最多 6 个商品视角')
  if (tasks.length > 1 && new Set(tasks.map((task) => task.kind === 'product-view' ? task.view : '')).size !== tasks.length) throw new Error('商品视角不能重复')
  parseImageCandidateCount(input.candidateCount, 'image-generate')
  if (!Number.isInteger(input.candidateCount) || input.candidateCount < 1 || input.candidateCount > 4) throw new Error('每个视角需要 1 到 4 张候选')
  if (typeof input.prompt !== 'string' || input.prompt.length > 24_000 || input.prompt.includes('\0')) throw new Error('补充要求格式不正确或过长')
  const needReference = tasks[0].kind === 'style-reference'
  if (needReference !== (input.reference !== undefined)) throw new Error(needReference ? '参考风格迁移需要原图和参考图' : '此任务只接受一张原图')
  for (const asset of [input.source, ...(input.reference ? [input.reference] : [])]) if (!asset || !/^[A-Za-z0-9_-]{43}$/.test(asset.assetId)) throw new Error('请选择本人素材库中已保存的图片')
  if (input.source.assetId === input.reference?.assetId) throw new Error('原图和参考图必须是不同的图片')
  const ids = new Set<string>()
  function nextId(): string {
    const id = input.createId()
    if (!id || id.length > 256 || ids.has(id)) throw new Error('无法生成唯一的节点与连线编号')
    ids.add(id)
    return id
  }
  const nodes: WorkflowNode[] = [], edges: WorkflowEdge[] = []
  function addNode(kind: WorkflowNode['kind'], x: number, y: number, prompt = '', settings?: Record<string, unknown>): WorkflowNode {
    const result: WorkflowNode = { id: nextId(), kind, definitionVersion: 1, position: { x, y }, data: { prompt, model: '', status: 'idle', ...(settings ? { settings } : {}) } }
    nodes.push(result)
    return result
  }
  function connect(source: WorkflowNode, target: WorkflowNode, sourceHandle: string, targetHandle: string): WorkflowEdge {
    const edge = { id: nextId(), source: source.id, target: target.id, sourceHandle, targetHandle }
    edges.push(edge)
    return edge
  }
  const source = addNode('image-input', 80, 80, '', { title: input.source.label || '原始商品图' })
  source.data.result = { kind: 'image', assetId: input.source.assetId, localUrl: `xingmang-asset://image/${input.source.assetId}`, ...(input.source.width ? { width: input.source.width } : {}), ...(input.source.height ? { height: input.source.height } : {}) }
  const reference = input.reference ? addNode('image-input', 80, 400, '', { title: input.reference.label || '风格参考图' }) : undefined
  if (reference && input.reference) reference.data.result = { kind: 'image', assetId: input.reference.assetId, localUrl: `xingmang-asset://image/${input.reference.assetId}`, ...(input.reference.width ? { width: input.reference.width } : {}), ...(input.reference.height ? { height: input.reference.height } : {}) }
  function bindImages(target: WorkflowNode): void {
    const first = connect(source, target, 'out:image', 'in:images')
    const slots: ImageReferenceOrder['slots'] = [{ role: 'source', edgeId: first.id, outputIndex: 0 }]
    if (reference) slots.push({ role: 'reference', edgeId: connect(reference, target, 'out:image', 'in:images').id, outputIndex: 0 })
    target.data.settings = { ...target.data.settings, imageReferenceOrder: { version: 1, slots } satisfies ImageReferenceOrder }
  }
  let analysis: WorkflowNode | undefined
  if (input.analysis) {
    if (!input.analysis.model.trim() || !input.analysis.prompt.trim() || input.analysis.prompt.length > 24_000) throw new Error('自动分析需要可用的视觉文字模型和明确的分析指令')
    analysis = addNode('text-generate', 440, 80, input.analysis.prompt, { title: '共享参考图分析' })
    analysis.data.model = input.analysis.model
    if (input.analysis.group) analysis.data.group = input.analysis.group
    bindImages(analysis)
  }
  const galleries: WorkflowNode[] = []
  for (const [index, task] of tasks.entries()) {
    const title = task.kind === 'product-view' ? `${commerceTaskLabels[task.kind]} · ${commerceViews.find((view) => view.value === task.view)!.label}` : commerceTaskLabels[task.kind]
    const image = addNode(task.kind === 'material-a' ? 'image-edit' : 'image-generate', analysis ? 800 : 440, 80 + index * 360, input.prompt, { title, commerceTask: task })
    image.data.model = input.model
    if (input.group) image.data.group = input.group
    image.data.size = task.kind === 'material-b' ? 'auto' : input.size ?? '1024x1024'
    image.data.quality = input.quality ?? 'low'
    image.data.imageResolution = task.kind === 'material-b' ? '1K' : input.imageResolution ?? '1K'
    image.data.imageCandidateCount = input.candidateCount
    bindImages(image)
    if (analysis) connect(analysis, image, 'out:text', 'in:text')
    const gallery = addNode('gallery', analysis ? 1160 : 800, 80 + index * 360, '', { title: `${title}候选` })
    connect(image, gallery, 'out:image', 'in:images')
    galleries.push(gallery)
  }
  if (galleries.length > 1) {
    const viewsPerOverview = Math.floor(16 / input.candidateCount)
    for (let start = 0; start < galleries.length; start += viewsPerOverview) {
      const batch = galleries.slice(start, start + viewsPerOverview)
      const title = galleries.length <= viewsPerOverview ? '全部商品视角' : `商品视角总览 ${start + 1}–${start + batch.length}`
      const all = addNode('gallery', analysis ? 1520 : 1160, 80 + Math.floor(start / viewsPerOverview) * 360, '', { title })
      for (const gallery of batch) connect(gallery, all, 'out:image', 'in:images')
    }
  }
  return { ...createEmptyWorkflow(input.name || '商品与参考图创作'), nodes, edges }
}
