import type { CanvasImageAssetSummary } from '../host'
import { defaultExteriorTask, exteriorTaskKinds, exteriorTaskRoles, exteriorTaskUsesAnalysis, parseExteriorTask, resolveExteriorImageRequest, type ExteriorTask, type ExteriorTaskKind } from '../exterior/exterior-task'
import { parseImageReferenceOrder, type ImageReferenceRole } from '../commerce/image-reference-order'
import { defaultImageQuality, defaultImageSize, imageModelPreset, knownNonImageModel } from '../models'
import { buildImageRequestParameters, type ImageRequestResolution } from '../runtime/image-request-parameters'
import { textImageInputModelSupported, validateTextImageInputConfiguration } from '../runtime/text-image-input'
import { isTemplateImageAsset } from './template-asset-picker-model'

export type ExteriorTaskReferenceBinding = { kind: 'existing'; edgeId: string; outputIndex: number } | { kind: 'asset'; assetId: string } | { kind: 'missing' }
export interface ExteriorTaskReferenceDraft { role: ImageReferenceRole; binding: ExteriorTaskReferenceBinding; asset?: CanvasImageAssetSummary; label?: string; unavailableReason?: string }
export type ExteriorTaskReferenceSubmission = Pick<ExteriorTaskReferenceDraft, 'role' | 'binding'>
export interface ExteriorTaskGenerationDraft { model: string; size: string; imageResolution: ImageRequestResolution; quality: string; imageCandidateCount: 1 | 2 | 3 | 4 }
export interface ExteriorTaskAnalysisDraft { model: string }
export interface ExteriorTaskDialogDraft extends ExteriorTaskGenerationDraft { mode: 'create' | 'edit'; task: ExteriorTask; references: ExteriorTaskReferenceSubmission[]; prompt: string; analysis?: ExteriorTaskAnalysisDraft }
export interface ExteriorTaskForm { task: ExteriorTask; references: ExteriorTaskReferenceDraft[]; prompt: string; generation: ExteriorTaskGenerationDraft; analysis: ExteriorTaskAnalysisDraft }

export function exteriorTaskKindFromRoute(value: unknown): ExteriorTaskKind | null { return typeof value === 'string' && exteriorTaskKinds.some((kind) => kind === value) ? value as ExteriorTaskKind : null }
export function exteriorTaskFromRoute(value: unknown): ExteriorTask | null { const kind = exteriorTaskKindFromRoute(value); return kind ? defaultExteriorTask(kind) : null }
export function initialExteriorGeneration(initial: Partial<ExteriorTaskGenerationDraft> = {}, models: readonly { id: string }[] = []): ExteriorTaskGenerationDraft {
  return { model: initial.model ?? models.find((model) => !knownNonImageModel(model.id) && imageModelPreset(model.id).supportsEdits)?.id ?? '', size: initial.size ?? defaultImageSize, imageResolution: initial.imageResolution ?? '1K', quality: initial.quality ?? defaultImageQuality, imageCandidateCount: initial.imageCandidateCount ?? 1 }
}
export function initialExteriorAnalysis(initial: Partial<ExteriorTaskAnalysisDraft> = {}, models: readonly { id: string }[] = []): ExteriorTaskAnalysisDraft { return { model: initial.model ?? models.find((model) => textImageInputModelSupported(model.id))?.id ?? '' } }
export function exteriorTaskReferenceLabel(role: ImageReferenceRole, task?: ExteriorTask): string {
  if (role === 'source') return task?.kind === 'landscape-redesign' ? '场地原图' : task?.kind === 'storefront-redesign' ? '店面原图' : '建筑原图'
  if (task?.kind === 'exterior-redraw') return '色调参考图'
  if (task?.kind === 'landscape-redesign') return '景观参考图'
  if (task?.kind === 'facade-renovation') return '立面参考图'
  if (task?.kind === 'exterior-style-transfer') return '风格参考图'
  if (task?.kind === 'storefront-redesign') return '门头参考图'
  return '辅助参考图'
}
export function exteriorTaskReferences(task: ExteriorTask, initial: readonly ExteriorTaskReferenceDraft[]): ExteriorTaskReferenceDraft[] { return exteriorTaskRoles(task).map((role) => initial.find((entry) => entry.role === role) ?? { role, binding: { kind: 'missing' } }) }
export function chooseExteriorTaskAsset(references: readonly ExteriorTaskReferenceDraft[], role: ImageReferenceRole, asset: CanvasImageAssetSummary): ExteriorTaskReferenceDraft[] {
  if (!isTemplateImageAsset(asset)) throw new Error('请选择本人素材库中可用的室外图片')
  if (references.some((entry) => entry.role !== role && (entry.asset?.assetId === asset.assetId || entry.binding.kind === 'asset' && entry.binding.assetId === asset.assetId))) throw new Error('建筑原图和参考图必须使用不同的实际图片')
  return references.map((entry) => entry.role === role ? { role, binding: { kind: 'asset', assetId: asset.assetId }, asset, label: asset.displayName || asset.fileName } : entry)
}
export function exteriorTaskDraftKey(form: ExteriorTaskForm): string { return JSON.stringify({ task: form.task, references: form.references.map(({ role, binding }) => ({ role, binding })), prompt: form.prompt, generation: form.generation, analysis: exteriorTaskUsesAnalysis(form.task) ? form.analysis : undefined }) }
export function buildExteriorTaskSubmission(mode: 'create' | 'edit', form: ExteriorTaskForm): ExteriorTaskDialogDraft {
  const task = parseExteriorTask(form.task), roles = exteriorTaskRoles(task), generation = { ...form.generation }
  if (form.references.length !== roles.length || form.references.some((entry, index) => entry.role !== roles[index])) throw new Error('请核对建筑原图与参考图的角色位置')
  const ids = new Set<string>(), edges = new Set<string>()
  const references = form.references.map((entry): ExteriorTaskReferenceSubmission => {
    const { binding, role } = entry
    if (entry.unavailableReason) throw new Error(entry.unavailableReason)
    if (binding.kind === 'missing') throw new Error(`请先为${exteriorTaskReferenceLabel(role, task)}绑定图片`)
    if (binding.kind === 'existing') {
      if (mode === 'create') throw new Error('新建任务请从素材库选择或上传室外图片')
      parseImageReferenceOrder({ version: 1, slots: [{ role: 'source', edgeId: binding.edgeId, outputIndex: binding.outputIndex }] })
      const key = JSON.stringify([binding.edgeId, binding.outputIndex]); if (edges.has(key)) throw new Error('原图与参考图不能重复使用同一连线位置'); edges.add(key)
    } else if (!/^[A-Za-z0-9_-]{43}$/.test(binding.assetId) || !entry.asset || !isTemplateImageAsset(entry.asset) || entry.asset.assetId !== binding.assetId) throw new Error('所选图片尚未核对，请从素材库重新选择')
    const id = binding.kind === 'asset' ? binding.assetId : entry.asset?.assetId
    if (id && ids.has(id)) throw new Error('建筑原图和参考图必须使用不同的实际图片')
    if (id) ids.add(id)
    return { role, binding: { ...binding } }
  })
  if (typeof form.prompt !== 'string' || form.prompt.length > 24000) throw new Error('补充要求不能超过 24000 个字符')
  if ('automaticPrompt' in task && !task.automaticPrompt && !form.prompt.trim()) throw new Error('手动模式请填写创作要求')
  if (![1, 2, 3, 4].includes(generation.imageCandidateCount)) throw new Error('候选数量须为 1–4 张')
  if (generation.model) {
    if (knownNonImageModel(generation.model)) throw new Error('当前选择的是文字或视频模型，请选择支持参考图片的图像模型')
    if (!imageModelPreset(generation.model).supportsEdits) throw new Error('当前模型不支持参考图片，请选择兼容的图像模型')
    buildImageRequestParameters(resolveExteriorImageRequest(task, { ...generation, prompt: form.prompt }))
  }
  let analysis: ExteriorTaskAnalysisDraft | undefined
  if (exteriorTaskUsesAnalysis(task)) {
    if (!form.analysis.model.trim()) throw new Error('自动提示需要选择已支持图片理解的文字模型')
    validateTextImageInputConfiguration(form.analysis.model, 2)
    analysis = { model: form.analysis.model }
  }
  return { mode, task, references, prompt: form.prompt, ...generation, ...(analysis ? { analysis } : {}) }
}
