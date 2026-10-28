import type { CanvasImageAssetSummary } from '../host'
import { defaultInteriorTask, parseInteriorTask, resolveInteriorImageRequest, type InteriorTask } from '../interior/interior-task'
import { parseImageReferenceOrder } from '../commerce/image-reference-order'
import { defaultImageQuality, defaultImageSize, imageModelPreset, knownNonImageModel } from '../models'
import { buildImageRequestParameters, type ImageRequestResolution } from '../runtime/image-request-parameters'
import { isTemplateImageAsset } from './template-asset-picker-model'

export type InteriorTaskSourceBinding = { kind: 'existing'; edgeId: string; outputIndex: number } | { kind: 'asset'; assetId: string } | { kind: 'missing' }
export interface InteriorTaskSourceDraft { binding: InteriorTaskSourceBinding; asset?: CanvasImageAssetSummary; label?: string; unavailableReason?: string }
export interface InteriorTaskGenerationDraft { model: string; size: string; imageResolution: ImageRequestResolution; quality: string; imageCandidateCount: 1 | 2 | 3 | 4 }
export interface InteriorTaskDialogDraft extends InteriorTaskGenerationDraft { mode: 'create' | 'edit'; task: InteriorTask; source: { binding: InteriorTaskSourceBinding }; prompt: string }
export interface InteriorTaskForm { task: InteriorTask; source: InteriorTaskSourceDraft; prompt: string; generation: InteriorTaskGenerationDraft }

export function interiorTaskFromRoute(value: unknown): InteriorTask | null { return value === 'render' ? defaultInteriorTask() : null }
export function initialInteriorGeneration(initial: Partial<InteriorTaskGenerationDraft> = {}, models: readonly { id: string }[] = []): InteriorTaskGenerationDraft {
  return { model: initial.model ?? models.find((model) => !knownNonImageModel(model.id) && imageModelPreset(model.id).supportsEdits)?.id ?? '', size: initial.size ?? defaultImageSize, imageResolution: initial.imageResolution ?? '1K', quality: initial.quality ?? defaultImageQuality, imageCandidateCount: initial.imageCandidateCount ?? 1 }
}
export function chooseInteriorTaskAsset(asset: CanvasImageAssetSummary): InteriorTaskSourceDraft {
  if (!isTemplateImageAsset(asset)) throw new Error('请选择本人素材库中可用的室内图片')
  return { binding: { kind: 'asset', assetId: asset.assetId }, asset, label: asset.displayName || asset.fileName }
}
export function interiorTaskDraftKey(form: InteriorTaskForm): string {
  return JSON.stringify({ task: form.task, source: form.source.binding, prompt: form.prompt, generation: form.generation })
}
export function buildInteriorTaskSubmission(mode: 'create' | 'edit', form: InteriorTaskForm): InteriorTaskDialogDraft {
  const task = parseInteriorTask(form.task), { source, prompt } = form, generation = { ...form.generation }
  if (source.unavailableReason) throw new Error(source.unavailableReason)
  if (source.binding.kind === 'missing') throw new Error('请先选择一张室内原图')
  if (source.binding.kind === 'existing') {
    if (mode === 'create') throw new Error('新建任务请从素材库选择或上传室内原图')
    parseImageReferenceOrder({ version: 1, slots: [{ role: 'source', edgeId: source.binding.edgeId, outputIndex: source.binding.outputIndex }] })
  } else if (!/^[A-Za-z0-9_-]{43}$/.test(source.binding.assetId) || !source.asset || !isTemplateImageAsset(source.asset) || source.asset.assetId !== source.binding.assetId) throw new Error('所选图片尚未核对，请重新选择室内原图')
  if (typeof prompt !== 'string' || prompt.length > 24000) throw new Error('补充要求不能超过 24000 个字符')
  if (![1, 2, 3, 4].includes(generation.imageCandidateCount)) throw new Error('候选数量须为 1–4 张')
  if (generation.model) {
    if (knownNonImageModel(generation.model)) throw new Error('当前选择的是文字或视频模型，请选择支持参考图片的图像模型')
    if (!imageModelPreset(generation.model).supportsEdits) throw new Error('当前模型不支持参考图片，请选择兼容的图像模型')
    buildImageRequestParameters(resolveInteriorImageRequest(task, { ...generation, prompt }))
  }
  return { mode, task, source: { binding: { ...source.binding } }, prompt, ...generation }
}
