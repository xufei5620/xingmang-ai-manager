import { createEmptyWorkflow, type WorkflowFile, type WorkflowNode, type WorkflowEdge } from '../model'
import { parseImageCandidateCount, type ImageCandidateCount } from '../runtime/image-candidate-count'
import { parseInteriorTask, type InteriorTask } from './interior-task'
import type { ImageReferenceOrder } from '../commerce/image-reference-order'

export interface InteriorWorkflowAsset { assetId: string; label?: string; width?: number; height?: number }
export interface InteriorWorkflowBuildInput {
  name?: string
  task: InteriorTask
  source: InteriorWorkflowAsset
  prompt: string
  model: string
  size?: string
  quality?: string
  imageResolution?: '1K' | '2K' | '4K'
  candidateCount: ImageCandidateCount
  createId: () => string
}

/** A task is an editable graph. Creating it never submits an inference request. */
export function buildInteriorWorkflow(input: InteriorWorkflowBuildInput): WorkflowFile {
  const task = parseInteriorTask(input.task)
  if (parseImageCandidateCount(input.candidateCount, 'image-generate') === undefined) throw new Error('请选择明确的候选数量')
  if (typeof input.prompt !== 'string' || input.prompt.length > 24_000 || input.prompt.includes('\0')) throw new Error('补充要求格式不正确或过长')
  if (!input.source || !/^[A-Za-z0-9_-]{43}$/.test(input.source.assetId)) throw new Error('请选择本人素材库中已保存的室内图片')
  for (const dimension of [input.source.width, input.source.height]) if (dimension !== undefined && (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > 16384)) throw new Error('室内原图的像素尺寸不正确')
  const ids = new Set<string>()
  function nextId(): string {
    const id = input.createId()
    if (typeof id !== 'string' || !id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id) || ids.has(id)) throw new Error('无法生成唯一的节点与连线编号')
    ids.add(id)
    return id
  }
  const source: WorkflowNode = { id: nextId(), kind: 'image-input', definitionVersion: 1, position: { x: 80, y: 80 }, data: {
    prompt: '', model: '', status: 'idle', settings: { title: input.source.label?.slice(0, 160) || '室内原图' },
    result: { kind: 'image', assetId: input.source.assetId, localUrl: `xingmang-asset://image/${input.source.assetId}`, ...(input.source.width ? { width: input.source.width } : {}), ...(input.source.height ? { height: input.source.height } : {}) },
  } }
  const target: WorkflowNode = { id: nextId(), kind: 'image-generate', definitionVersion: 1, position: { x: 440, y: 80 }, data: {
    prompt: input.prompt, model: input.model,
    size: input.size ?? 'auto', quality: input.quality ?? 'low', imageResolution: input.imageResolution ?? '1K', imageCandidateCount: input.candidateCount,
    status: 'idle', settings: { title: '室内一键渲染', interiorTask: task },
  } }
  const gallery: WorkflowNode = { id: nextId(), kind: 'gallery', definitionVersion: 1, position: { x: 800, y: 80 }, data: { prompt: '', model: '', status: 'idle', settings: { title: '室内渲染候选' } } }
  const first: WorkflowEdge = { id: nextId(), source: source.id, target: target.id, sourceHandle: 'out:image', targetHandle: 'in:images' }
  const second: WorkflowEdge = { id: nextId(), source: target.id, target: gallery.id, sourceHandle: 'out:image', targetHandle: 'in:images' }
  target.data.settings = { ...target.data.settings, imageReferenceOrder: { version: 1, slots: [{ role: 'source', edgeId: first.id, outputIndex: 0 }] } satisfies ImageReferenceOrder }
  return { ...createEmptyWorkflow(input.name || '室内一键渲染'), nodes: [source, target, gallery], edges: [first, second] }
}
