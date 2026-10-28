import type { CanvasImageAssetSummary } from '../host'
import { commerceTaskLabels, commerceViews, parseCommerceTask, resolveCommerceImageRequest, resolveCommerceTargetSize, type CommerceTask, type CommerceTaskKind, type CommerceView } from '../commerce/commerce-task'
import { parseImageReferenceOrder, type ImageReferenceRole } from '../commerce/image-reference-order'
import { imageModelPreset } from '../models'
import { buildImageRequestParameters, type ImageRequestResolution } from '../runtime/image-request-parameters'
import { isTemplateImageAsset } from './template-asset-picker-model'

export type CommerceTaskReferenceBinding = { kind: 'existing'; edgeId: string; outputIndex: number } | { kind: 'asset'; assetId: string } | { kind: 'missing' }
export interface CommerceTaskReferenceDraft {
  role: ImageReferenceRole
  binding: CommerceTaskReferenceBinding
  asset?: CanvasImageAssetSummary
  label?: string
  unavailableReason?: string
}
export type CommerceTaskReferenceSubmission = Pick<CommerceTaskReferenceDraft, 'role' | 'binding'>
export interface CommerceTaskGenerationDraft { model: string; size: string; imageResolution: ImageRequestResolution; quality: string; imageCandidateCount: 1 | 2 | 3 | 4 }
export type CommerceTaskDialogDraft = {
  mode: 'create'; tasks: CommerceTask[]; references: CommerceTaskReferenceSubmission[]; prompt: string; autoAnalyze: boolean
} & CommerceTaskGenerationDraft | { mode: 'edit'; task: CommerceTask; references: CommerceTaskReferenceSubmission[] }

export function commerceTaskKindFromRoute(value: unknown): CommerceTaskKind | null {
  return typeof value === 'string' && Object.hasOwn(commerceTaskLabels, value) ? value as CommerceTaskKind : null
}
export function commerceTaskRoles(task: CommerceTask): ImageReferenceRole[] { return task.kind === 'style-reference' ? ['source', 'reference'] : ['source'] }
export function commerceTaskReferences(task: CommerceTask, initial: readonly CommerceTaskReferenceDraft[]): CommerceTaskReferenceDraft[] {
  return commerceTaskRoles(task).map((role) => initial.find((entry) => entry.role === role) ?? { role, binding: { kind: 'missing' } })
}
export function chooseCommerceTaskAsset(references: readonly CommerceTaskReferenceDraft[], role: ImageReferenceRole, asset: CanvasImageAssetSummary): CommerceTaskReferenceDraft[] {
  if (!isTemplateImageAsset(asset)) throw new Error('请选择本人素材库中可用的图片')
  if (references.some((entry) => entry.role !== role && (entry.asset?.assetId === asset.assetId || entry.binding.kind === 'asset' && entry.binding.assetId === asset.assetId))) throw new Error('原图和参考图必须使用不同的图片')
  return references.map((entry) => entry.role === role ? { role, binding: { kind: 'asset', assetId: asset.assetId }, asset, label: asset.displayName || asset.fileName } : entry)
}
export function serializeCommerceTaskReferences(task: CommerceTask, references: readonly CommerceTaskReferenceDraft[]): CommerceTaskReferenceSubmission[] {
  const roles = commerceTaskRoles(task)
  if (references.length !== roles.length || references.some((entry, index) => entry.role !== roles[index])) throw new Error('请核对原图与参考图的角色位置')
  const ids = new Set<string>(), edges = new Set<string>()
  return references.map((entry) => {
    const { binding, role } = entry
    if (binding.kind === 'missing') throw new Error(`请为${role === 'source' ? '原始主体图' : '风格参考图'}绑定图片`)
    if (entry.unavailableReason) throw new Error(entry.unavailableReason)
    if (binding.kind === 'existing') {
      parseImageReferenceOrder({ version: 1, slots: [{ role: 'source', edgeId: binding.edgeId, outputIndex: binding.outputIndex }] })
      const key = JSON.stringify([binding.edgeId, binding.outputIndex]); if (edges.has(key)) throw new Error('参考图片位置重复'); edges.add(key)
    } else if (!/^[A-Za-z0-9_-]{43}$/.test(binding.assetId) || !entry.asset || !isTemplateImageAsset(entry.asset) || entry.asset.assetId !== binding.assetId) throw new Error('新选图片尚未核对，请从素材库重新选择')
    const id = binding.kind === 'asset' ? binding.assetId : entry.asset?.assetId
    if (id && ids.has(id)) throw new Error('原图和参考图必须使用不同的图片')
    if (id) ids.add(id)
    return { role, binding: { ...binding } }
  })
}
export function buildCommerceTaskBranches(task: CommerceTask, views: readonly CommerceView[]): CommerceTask[] {
  const parsed = parseCommerceTask(task)
  if (parsed.kind !== 'product-view') return [parsed]
  if (!views.length || views.length > 6 || new Set(views).size !== views.length || views.some((view) => !commerceViews.some((entry) => entry.value === view))) throw new Error('请选择 1–6 个不重复的商品视角')
  return views.map((view) => parseCommerceTask({ ...parsed, view }))
}
export function inspectCommerceTaskSize(task: CommerceTask, source: { width?: number; height?: number } | undefined, generation: Pick<CommerceTaskGenerationDraft, 'model' | 'quality'>): { size?: string; error: string } {
  try {
    const target = resolveCommerceTargetSize(task, source)
    if (!target) return { error: '' }
    if (!generation.model) return { size: target.size, error: '请先选择支持精确输出尺寸的图像模型' }
    try { resolveCommerceImageRequest(task, { ...generation, prompt: '', size: 'auto', imageResolution: '1K' }, source) }
    catch (cause) { return { size: target.size, error: cause instanceof Error ? cause.message : '当前模型无法表达目标尺寸' } }
    return { size: target.size, error: '' }
  } catch (cause) { return { error: cause instanceof Error ? cause.message : '原图尺寸尚未确认' } }
}
export function buildCommerceTaskSubmission(input: { mode: 'create' | 'edit'; task: CommerceTask; references: readonly CommerceTaskReferenceDraft[]; views: readonly CommerceView[]; prompt: string; autoAnalyze: boolean; generation: CommerceTaskGenerationDraft }): CommerceTaskDialogDraft {
  const task = parseCommerceTask(input.task), references = serializeCommerceTaskReferences(task, input.references)
  if (input.mode === 'edit') return { mode: 'edit', task, references }
  const tasks = buildCommerceTaskBranches(task, input.views), generation = { ...input.generation }
  if (typeof input.prompt !== 'string' || input.prompt.length > 24000) throw new Error('补充要求不能超过 24000 个字符')
  if (![1, 2, 3, 4].includes(generation.imageCandidateCount)) throw new Error('每个任务的候选数量须为 1–4')
  if (task.kind === 'material-b') { generation.size = 'auto'; generation.imageResolution = '1K' }
  if (generation.model) {
    if (!imageModelPreset(generation.model).supportsEdits) throw new Error('当前模型不支持参考图编辑，请更换模型')
    const parameters = resolveCommerceImageRequest(task, { ...generation, prompt: input.prompt }, input.references[0]?.asset)
    buildImageRequestParameters(parameters)
  }
  return { mode: 'create', tasks, references, prompt: input.prompt, autoAnalyze: input.autoAnalyze, ...generation }
}
