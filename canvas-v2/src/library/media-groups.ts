import type { CanvasMediaGroups } from '../store/canvas-state'
import { availableImageModelPresets, availableVideoModelPresets, defaultImageModel, imageModelPresets, videoModelPresets } from '../models'

export type MediaCapabilityKind = 'image' | 'video' | 'text'

export const defaultCanvasMediaPreferences = {
  image: '图片模型-中转/订阅',
  video: '视频模型-中转/订阅',
  text: 'Gemini-中转/订阅',
  imageModel: defaultImageModel,
  videoModel: 'minimax-h3-base',
  textModel: 'gemini-3.7-flash',
} as const

export const sub2ApiCanvasMediaPreferences = {
  // 画布默认跟随账号自动创建的分组。视频能力尚未上线，保持空值，
  // 避免首次打开时误准备一个并不存在的视频分组。
  image: 'GPT-image2',
  video: '',
  text: 'Gemini',
  imageModel: defaultImageModel,
  videoModel: '',
  textModel: 'gemini-3.7-flash',
} as const

const legacyDefaultGroupAliases: Record<MediaCapabilityKind, readonly string[]> = {
  image: ['生图分组', '图片模型-中转/订阅'],
  video: ['视频分组', '视频模型-中转/订阅'],
  text: ['Gemini', 'Gemini-中转/订阅'],
}

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

// xm 站 2026-10 改分组本名，图片、视频两个分组去掉了「中转」。老名字删掉以后只能按
// 名字里的词认；站上同时有好几个分组时，带这个词的不止一个就说明认不准，不认。
function onlyGroupNamed(availableGroups: readonly { name: string }[], word: string): string[] {
  const matches = availableGroups.filter((entry) => entry.name.includes(word))
  return matches.length === 1 ? [matches[0].name] : []
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

export function preferredMediaGroups(availableGroups: readonly { name: string }[], siteId: 'solov' | 'solov-api' = 'solov'): CanvasMediaGroups {
  if (availableGroups.length === 0) return {}
  const defaults = siteId === 'solov-api' ? sub2ApiCanvasMediaPreferences : defaultCanvasMediaPreferences
  const image = pickPreferredGroup(availableGroups, defaults.image, siteId === 'solov-api' ? [] : ['生图分组', '图片模型-中转/订阅', '图片模型', 'openai', /图片.*中转/i, ...onlyGroupNamed(availableGroups, '图片')], siteId !== 'solov-api')
  // 视频模型暂未上线。不要把图片分组当作视频分组，否则首次打开画布
  // 会为视频节点准备错误的 API Key。Grok 分组也不认：站上有好几个带 Grok 的，
  // 认不出视频分组时宁可留空让客户自己选。
  const video = defaults.video
    ? pickPreferredGroup(availableGroups, defaults.video, ['视频分组', '视频模型-中转/订阅', '视频模型', /视频.*中转/i, ...onlyGroupNamed(availableGroups, '视频')], false)
    : undefined
  const text = pickPreferredGroup(
    availableGroups,
    defaults.text,
    siteId === 'solov-api' ? [] : ['Gemini', /gemini/i, /chat|文字|对话|文本/i],
    false,
  )
  return {
    ...(image ? { image } : {}),
    ...(video ? { video } : {}),
    ...(text ? { text } : {}),
    imageModel: defaults.imageModel,
    videoModel: defaults.videoModel,
    textModel: defaults.textModel,
  }
}

export function withPreferredMediaDefaults(
  current: CanvasMediaGroups,
  availableGroups: readonly { name: string }[],
  siteId: 'solov' | 'solov-api' = 'solov',
): CanvasMediaGroups {
  const preferred = preferredMediaGroups(availableGroups, siteId)
  const availableNames = new Set(availableGroups.map((entry) => entry.name))
  const resolveGroup = (kind: MediaCapabilityKind, value: string | undefined, fallback: string | undefined) => {
    if (value && availableNames.has(value)) return value
    if (value && legacyDefaultGroupAliases[kind].includes(value)) return fallback
    return value ?? fallback
  }
  const image = resolveGroup('image', current.image, preferred.image)
  const video = resolveGroup('video', current.video, preferred.video)
  const text = resolveGroup('text', current.text, preferred.text)
  return {
    ...(image ? { image } : {}),
    ...(video ? { video } : {}),
    ...(text ? { text } : {}),
    imageModel: current.imageModel ?? preferred.imageModel,
    videoModel: current.videoModel ?? preferred.videoModel,
    textModel: current.textModel ?? preferred.textModel,
  }
}

export function needsPreferredMediaDefaults(mediaGroups: CanvasMediaGroups): boolean {
  return !mediaGroups.image
    || !mediaGroups.text
    || !mediaGroups.imageModel
    || !mediaGroups.textModel
}
