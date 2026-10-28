import { textSearchOnlyModel } from '../runtime/text-web-search'
import type { CanvasMediaGroups } from '../store/canvas-state'
import { availableImageModelPresets, availableVideoModelPresets, defaultImageModel, knownNonImageModel, knownNonTextModel } from '../models'

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

// xm 站 2026-10-16 删掉了这些老的默认分组名（桌面 #1004）。按老名字存的工程，老名字不在了就换成现在认出的分组。
const legacyDefaultGroupAliases: Readonly<Record<MediaCapabilityKind, readonly string[]>> = {
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

// xm 站 2026-10 改分组本名，图片、视频两个分组去掉了「中转」。老名字删掉以后只能按名字里的词认；
// 带这个词的分组不止一个就说明认不准，不认（桌面 #1004）。
function onlyGroupNamed(availableGroups: readonly { name: string }[], word: string): string[] {
  const matches = availableGroups.filter((entry) => entry.name.includes(word))
  return matches.length === 1 ? [matches[0].name] : []
}

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
  // Provider purpose describes the whole catalog. Only reject known media
  // families; unknown relay names can still identify compatible chat models.
  return [...new Set(models)].filter((id) => !knownNonTextModel(id) && !textSearchOnlyModel(id))
}

export function availableModelsForKind(kind: MediaCapabilityKind, models: readonly string[], purposes?: readonly MediaCapabilityKind[]): string[] {
  if (purposes !== undefined) {
    if (!purposes.includes(kind)) return []
    if (kind === 'text') return availableTextModels(models)
    // A declared purpose applies to a source, not each entry in its catalog.
    // Preserve unknown relay aliases while rejecting known incompatible families.
    const available = [...new Set(models)]
    return kind === 'image' ? available.filter((model) => !knownNonImageModel(model))
      : available.filter((model) => knownNonImageModel(model) === knownNonTextModel(model))
  }
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
  // Preserve unknown custom model names, without defaulting text requests to
  // known image/video models from a mixed provider catalog.
  const preferredImages = availableImageModelPresets(imageModels).map((entry) => entry.id)
  const preferredVideos = availableVideoModelPresets(videoModels).map((entry) => entry.id)
  const preferredText = availableTextModels(textModels).filter((id) => /^(gpt-[345]|o[134](?:-|$)|claude-|gemini-)/i.test(id))
  // A saved choice is part of the document, even after a provider withdraws it.
  // Availability belongs to preflight; refresh must never select another model.
  const imageModel = mediaGroups.imageModel || pickAvailableModel(undefined, [...preferredImages, ...imageModels])
  const videoModel = mediaGroups.videoModel || pickAvailableModel(undefined, [...preferredVideos, ...videoModels])
  const textModel = mediaGroups.textModel || pickAvailableModel(undefined, [...preferredText, ...availableTextModels(textModels)])
  return {
    ...(mediaGroups.image ? { image: mediaGroups.image } : {}),
    ...(mediaGroups.video ? { video: mediaGroups.video } : {}),
    ...(mediaGroups.text ? { text: mediaGroups.text } : {}),
    ...(imageModel ? { imageModel } : {}),
    ...(videoModel ? { videoModel } : {}),
    ...(textModel ? { textModel } : {}),
  }
}

export function groupsForCapability<T extends { name: string; purposes?: readonly MediaCapabilityKind[] }>(groups: readonly T[], kind: MediaCapabilityKind): T[] {
  return groups.filter((group) => group.purposes === undefined || group.purposes.includes(kind))
}

export function preferredMediaGroups(availableGroups: readonly { name: string; purposes?: readonly MediaCapabilityKind[] }[], siteId: 'solov' | 'solov-api' = 'solov'): CanvasMediaGroups {
  if (availableGroups.length === 0) return {}
  if (availableGroups.some((group) => group.purposes !== undefined)) {
    const image = groupsForCapability(availableGroups, 'image')[0]?.name
    const video = groupsForCapability(availableGroups, 'video')[0]?.name
    const text = groupsForCapability(availableGroups, 'text')[0]?.name
    return { ...(image ? { image } : {}), ...(video ? { video } : {}), ...(text ? { text } : {}) }
  }
  const defaults = siteId === 'solov-api' ? sub2ApiCanvasMediaPreferences : defaultCanvasMediaPreferences
  const image = pickPreferredGroup(availableGroups, defaults.image, siteId === 'solov-api' ? [] : ['生图分组', '图片模型-中转/订阅', '图片模型', 'openai', /图片.*中转/i, ...onlyGroupNamed(availableGroups, '图片')], siteId !== 'solov-api')
  // 视频模型暂未上线。不要把图片分组当作视频分组，否则首次打开画布
  // 会为视频节点准备错误的 API Key。Grok 分组也不认：站上有好几个带 Grok 的，
  // 认不出视频分组时宁可留空让客户自己选（桌面 #1004）。
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
  availableGroups: readonly { name: string; purposes?: readonly MediaCapabilityKind[] }[],
  siteId: 'solov' | 'solov-api' = 'solov',
): CanvasMediaGroups {
  const preferred = preferredMediaGroups(availableGroups, siteId)
  // A source in a list that declares purposes (the web's own sources) is the
  // user's explicit choice and stays even when missing. Only the xm group
  // list, which declares none, had its default groups renamed. An empty list
  // says nothing about what was renamed, so a saved name stays until one is read.
  const renamedDefaults = availableGroups.length > 0 && !availableGroups.some((group) => group.purposes !== undefined)
  function savedGroup(kind: MediaCapabilityKind, saved: string | undefined, fallback: string | undefined): string | undefined {
    if (!saved) return fallback
    if (renamedDefaults && legacyDefaultGroupAliases[kind].includes(saved) && !availableGroups.some((group) => group.name === saved)) return fallback
    return saved
  }
  const image = savedGroup('image', current.image, preferred.image)
  const video = savedGroup('video', current.video, preferred.video)
  const text = savedGroup('text', current.text, preferred.text)
  return {
    ...(image ? { image } : {}),
    ...(video ? { video } : {}),
    ...(text ? { text } : {}),
    ...(current.imageModel ? { imageModel: current.imageModel } : {}),
    ...(current.videoModel ? { videoModel: current.videoModel } : {}),
    ...(current.textModel ? { textModel: current.textModel } : {}),
  }
}

export function needsPreferredMediaDefaults(mediaGroups: CanvasMediaGroups): boolean {
  return !mediaGroups.image
    || !mediaGroups.text
    || !mediaGroups.imageModel
    || !mediaGroups.textModel
}
