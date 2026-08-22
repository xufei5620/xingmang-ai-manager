import type { CanvasMediaGroups } from '../store/canvas-state'
import { availableImageModelPresets, availableVideoModelPresets, defaultImageModel, imageModelPresets, videoModelPresets } from '../models'

export type MediaCapabilityKind = 'image' | 'video' | 'text'

export const defaultCanvasMediaPreferences = {
  image: '生图分组',
  video: '视频分组',
  text: 'Gemini',
  imageModel: defaultImageModel,
  videoModel: 'minimax-h3-base',
  textModel: 'gemini-3.7-flash',
} as const

function pickPreferredGroup(
  availableGroups: readonly { name: string }[],
  preferred: string,
  fallbacks: readonly (string | RegExp)[],
  fallbackToFirst = true,
): string | undefined {
  const exact = availableGroups.find((entry) => entry.name === preferred)
  if (exact) return exact.name
  for (const fallback of fallbacks) {
    const match = typeof fallback === 'string'
      ? availableGroups.find((entry) => entry.name.toLowerCase() === fallback.toLowerCase())
      : availableGroups.find((entry) => fallback.test(entry.name))
    if (match) return match.name
  }
  return fallbackToFirst ? availableGroups[0]?.name : undefined
}

const imagePresetIds = new Set(imageModelPresets.map((preset) => preset.id))
const videoPresetIds = new Set(videoModelPresets.map((preset) => preset.id))

export function mediaGroupsSignature(mediaGroups: CanvasMediaGroups): string {
  return `${mediaGroups.image ?? ''}\u0000${mediaGroups.video ?? ''}\u0000${mediaGroups.text ?? ''}`
}

export function mediaGroupsEqual(left: CanvasMediaGroups, right: CanvasMediaGroups): boolean {
  return left.image === right.image
    && left.video === right.video
    && left.text === right.text
    && left.imageModel === right.imageModel
    && left.videoModel === right.videoModel
    && left.textModel === right.textModel
}

export function pickAvailableModel(preferred: string | undefined, available: readonly string[]): string | undefined {
  if (preferred && available.includes(preferred)) return preferred
  return available[0]
}

export function availableTextModels(models: readonly string[]): string[] {
  const filtered = models.filter((id) => !imagePresetIds.has(id) && !videoPresetIds.has(id))
  return filtered.length > 0 ? filtered : [...models]
}

export function availableModelsForKind(kind: MediaCapabilityKind, models: readonly string[]): string[] {
  if (kind === 'image') return availableImageModelPresets(models).map((preset) => preset.id)
  if (kind === 'video') return availableVideoModelPresets(models).map((preset) => preset.id)
  return availableTextModels(models)
}

export function preferredModelForNodeType(type: string, mediaGroups: CanvasMediaGroups): string | undefined {
  if (['image', 'image-generate', 'image-edit'].includes(type)) return mediaGroups.imageModel
  if (['video', 'video-generate'].includes(type)) return mediaGroups.videoModel
  if (type === 'text-generate' || type === 'drama-parse') return mediaGroups.textModel
  return undefined
}

export function withResolvedMediaModels(
  mediaGroups: CanvasMediaGroups,
  imageModels: readonly string[],
  videoModels: readonly string[],
  textModels: readonly string[],
): CanvasMediaGroups {
  const imageModel = pickAvailableModel(mediaGroups.imageModel, availableModelsForKind('image', imageModels))
  const videoModel = pickAvailableModel(mediaGroups.videoModel, availableModelsForKind('video', videoModels))
  const textModel = pickAvailableModel(mediaGroups.textModel, availableModelsForKind('text', textModels))
  return {
    ...(mediaGroups.image ? { image: mediaGroups.image } : {}),
    ...(mediaGroups.video ? { video: mediaGroups.video } : {}),
    ...(mediaGroups.text ? { text: mediaGroups.text } : {}),
    ...(imageModel ? { imageModel } : {}),
    ...(videoModel ? { videoModel } : {}),
    ...(textModel ? { textModel } : {}),
  }
}

export function preferredMediaGroups(availableGroups: readonly { name: string }[]): CanvasMediaGroups {
  if (availableGroups.length === 0) return {}
  const image = pickPreferredGroup(availableGroups, defaultCanvasMediaPreferences.image, ['openai'])
  const video = pickPreferredGroup(availableGroups, defaultCanvasMediaPreferences.video, ['grok', /grok/i])
    ?? image
  const text = pickPreferredGroup(
    availableGroups,
    defaultCanvasMediaPreferences.text,
    [/gemini/i, /chat|文字|对话|文本/i],
    false,
  )
  return {
    ...(image ? { image } : {}),
    ...(video ? { video } : {}),
    ...(text ? { text } : {}),
    imageModel: defaultCanvasMediaPreferences.imageModel,
    videoModel: defaultCanvasMediaPreferences.videoModel,
    textModel: defaultCanvasMediaPreferences.textModel,
  }
}

export function withPreferredMediaDefaults(
  current: CanvasMediaGroups,
  availableGroups: readonly { name: string }[],
): CanvasMediaGroups {
  const preferred = preferredMediaGroups(availableGroups)
  return {
    ...(current.image ?? preferred.image ? { image: current.image ?? preferred.image } : {}),
    ...(current.video ?? preferred.video ? { video: current.video ?? preferred.video } : {}),
    ...(current.text ?? preferred.text ? { text: current.text ?? preferred.text } : {}),
    imageModel: current.imageModel ?? preferred.imageModel,
    videoModel: current.videoModel ?? preferred.videoModel,
    textModel: current.textModel ?? preferred.textModel,
  }
}

export function needsPreferredMediaDefaults(mediaGroups: CanvasMediaGroups): boolean {
  return !mediaGroups.image
    || !mediaGroups.video
    || !mediaGroups.text
    || !mediaGroups.imageModel
    || !mediaGroups.videoModel
    || !mediaGroups.textModel
}
