import type { CanvasImageAssetSummary } from '../host'
import { defaultStoryboardTask, parseStoryboardTask, resolveStoryboardImageRequest, type StoryboardTask } from '../storyboard/storyboard-task'
import { parseImageReferenceOrder } from '../commerce/image-reference-order'
import { defaultImageQuality, defaultImageSize, imageModelPreset, knownNonImageModel } from '../models'
import { buildImageRequestParameters, type ImageRequestResolution } from '../runtime/image-request-parameters'
import { textImageInputModelSupported, validateTextImageInputConfiguration } from '../runtime/text-image-input'
import { isTemplateImageAsset } from './template-asset-picker-model'

export type StoryboardTaskReferenceBinding = { kind: 'existing'; edgeId: string; outputIndex: number } | { kind: 'asset'; assetId: string } | { kind: 'missing' }
export interface StoryboardTaskReferenceDraft { role: 'source' | 'reference'; binding: StoryboardTaskReferenceBinding; asset?: CanvasImageAssetSummary; label?: string; unavailableReason?: string }
export type StoryboardTaskReferenceSubmission = Pick<StoryboardTaskReferenceDraft, 'role' | 'binding'>
export interface StoryboardTaskGenerationDraft { model: string; size: string; imageResolution: ImageRequestResolution; quality: string; imageCandidateCount: 1 | 2 | 3 | 4 }
export interface StoryboardTaskAnalysisDraft { model: string }
export interface StoryboardTaskDialogDraft extends StoryboardTaskGenerationDraft { mode: 'create' | 'edit'; task: StoryboardTask; references: StoryboardTaskReferenceSubmission[]; prompt: string; analysis?: StoryboardTaskAnalysisDraft }
export interface StoryboardTaskForm { task: StoryboardTask; references: StoryboardTaskReferenceDraft[]; prompt: string; generation: StoryboardTaskGenerationDraft; analysis: StoryboardTaskAnalysisDraft }

export function storyboardTaskFromRoute(value: unknown): StoryboardTask | null { return value === 'storyboard' ? defaultStoryboardTask() : null }
export function initialStoryboardGeneration(initial: Partial<StoryboardTaskGenerationDraft> = {}, models: readonly { id: string }[] = []): StoryboardTaskGenerationDraft {
  return { model: initial.model ?? models.find((model) => !knownNonImageModel(model.id) && imageModelPreset(model.id).supportsEdits)?.id ?? '', size: initial.size ?? defaultImageSize, imageResolution: initial.imageResolution ?? '1K', quality: initial.quality ?? defaultImageQuality, imageCandidateCount: initial.imageCandidateCount ?? 1 }
}
export function initialStoryboardAnalysis(initial: Partial<StoryboardTaskAnalysisDraft> = {}, models: readonly { id: string }[] = []): StoryboardTaskAnalysisDraft { return { model: initial.model ?? models.find((model) => textImageInputModelSupported(model.id))?.id ?? '' } }
export function storyboardTaskReferences(_task: StoryboardTask, initial: readonly StoryboardTaskReferenceDraft[]): StoryboardTaskReferenceDraft[] { return initial.length ? initial.map((entry, index) => ({ ...entry, role: index === 0 ? 'source' : 'reference' })) : [{ role: 'source', binding: { kind: 'missing' } }] }
export function storyboardTaskReferenceLabel(index: number, _task?: StoryboardTask): string { return index === 0 ? '故事原图 · 输入 1' : `辅助参考图 · 输入 ${index + 1}` }
export function chooseStoryboardTaskAsset(references: readonly StoryboardTaskReferenceDraft[], index: number, asset: CanvasImageAssetSummary): StoryboardTaskReferenceDraft[] {
  if (!Number.isInteger(index) || !references[index] || !isTemplateImageAsset(asset)) throw new Error('请选择本人素材库中可用的故事图片')
  if (references.some((entry, at) => at !== index && (entry.asset?.assetId === asset.assetId || entry.binding.kind === 'asset' && entry.binding.assetId === asset.assetId))) throw new Error('故事原图和参考图不能重复使用同一张图片')
  return references.map((entry, at) => at === index ? { role: at === 0 ? 'source' : 'reference', binding: { kind: 'asset', assetId: asset.assetId }, asset, label: asset.displayName || asset.fileName } : entry)
}
export function addStoryboardTaskReference(references: readonly StoryboardTaskReferenceDraft[]): StoryboardTaskReferenceDraft[] {
  if (references.length >= 4) throw new Error('当前接入通道最多支持 4 张有序图片')
  return [...references, { role: references.length ? 'reference' : 'source', binding: { kind: 'missing' } }]
}
export function removeStoryboardTaskReference(references: readonly StoryboardTaskReferenceDraft[], index: number): StoryboardTaskReferenceDraft[] {
  if (references.length <= 1 || !Number.isInteger(index) || !references[index]) throw new Error('请保留至少一张故事原图的位置')
  return storyboardTaskReferences(defaultStoryboardTask(), references.filter((_, at) => at !== index))
}
export function moveStoryboardTaskReference(references: readonly StoryboardTaskReferenceDraft[], index: number, offset: -1 | 1): StoryboardTaskReferenceDraft[] {
  if (!Number.isInteger(index) || !references[index] || !references[index + offset]) throw new Error('图片排序位置已变化，请重新选择')
  const next = [...references]; [next[index], next[index + offset]] = [next[index + offset], next[index]]
  return storyboardTaskReferences(defaultStoryboardTask(), next)
}
export function storyboardTaskDraftKey(form: StoryboardTaskForm): string { return JSON.stringify({ task: form.task, references: form.references.map(({ role, binding }) => ({ role, binding })), prompt: form.prompt, generation: form.generation, analysis: form.task.automaticPlot ? form.analysis : undefined }) }
export function buildStoryboardTaskSubmission(mode: 'create' | 'edit', form: StoryboardTaskForm): StoryboardTaskDialogDraft {
  const task = parseStoryboardTask(form.task), generation = { ...form.generation }
  if (form.references.length < 1 || form.references.length > 4) throw new Error('当前故事板接入通道支持 1–4 张有序图片')
  const identities = new Set<string>(), assetIds = new Set<string>()
  const references = form.references.map((entry, index): StoryboardTaskReferenceSubmission => {
    if (entry.role !== (index === 0 ? 'source' : 'reference')) throw new Error('第一张必须为故事原图，其余为有序参考图')
    const binding = entry.binding
    if (entry.unavailableReason) throw new Error(entry.unavailableReason)
    if (binding.kind === 'missing') throw new Error(`请先绑定输入 ${index + 1} 的故事图片`)
    if (binding.kind === 'existing') {
      if (mode === 'create') throw new Error('新建故事板请从素材库选择或上传图片')
      parseImageReferenceOrder({ version: 1, slots: [{ role: 'source', edgeId: binding.edgeId, outputIndex: binding.outputIndex }] })
      const identity = JSON.stringify([binding.edgeId, binding.outputIndex])
      if (identities.has(identity)) throw new Error('故事图片不能重复使用同一连线位置')
      identities.add(identity)
    } else if (!/^[A-Za-z0-9_-]{43}$/.test(binding.assetId) || !entry.asset || !isTemplateImageAsset(entry.asset) || entry.asset.assetId !== binding.assetId) throw new Error('故事图片尚未核对，请重新选择素材')
    const assetId = binding.kind === 'asset' ? binding.assetId : entry.asset?.assetId
    if (assetId && assetIds.has(assetId)) throw new Error('故事图片不能重复使用同一张实际素材')
    if (assetId) assetIds.add(assetId)
    return { role: entry.role, binding: { ...binding } }
  })
  if (typeof form.prompt !== 'string' || form.prompt.length > 24000 || form.prompt.includes('\0')) throw new Error('剧情补充格式不正确或超过 24000 个字符')
  if (!task.automaticPlot && !form.prompt.trim()) throw new Error('手动模式请填写剧情内容')
  if (![1, 2, 3, 4].includes(generation.imageCandidateCount)) throw new Error('候选数量须为 1–4 张故事板成图')
  if (generation.model) {
    if (knownNonImageModel(generation.model)) throw new Error('请选择支持参考原图的图像模型，文字或视频模型不能生成故事板')
    if (!imageModelPreset(generation.model).supportsEdits) throw new Error('当前模型不支持参考图片，请选择兼容的图像模型')
    buildImageRequestParameters(resolveStoryboardImageRequest(task, { ...generation, prompt: form.prompt }))
  }
  let analysis: StoryboardTaskAnalysisDraft | undefined
  if (task.automaticPlot) {
    if (!form.analysis.model.trim()) throw new Error('自动剧情需要选择已支持图片理解的文字模型')
    validateTextImageInputConfiguration(form.analysis.model, references.length)
    analysis = { model: form.analysis.model }
  }
  return { mode, task, references, prompt: form.prompt, ...generation, ...(analysis ? { analysis } : {}) }
}
