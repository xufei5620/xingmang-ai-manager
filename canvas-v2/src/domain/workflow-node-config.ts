import {
  availableImageModelPresets,
  availableVideoModelPresets,
  defaultImageModel,
  defaultImageQuality,
  defaultImageResolution,
  defaultImageSize,
  defaultVideoModel,
  defaultVideoSeconds,
  imageModelPreset,
  type ImageResolution,
} from '../models'

export interface OperationDefaultsResult {
  available: boolean
  config: Record<string, unknown>
  reason?: string
}

function isImageResolution(value: unknown): value is ImageResolution {
  return value === '1K' || value === '2K' || value === '4K'
}

export function operationDefaultsForTemplateNode(
  type: string,
  imageModels: readonly string[] = [],
  videoModels: readonly string[] = [],
  preferred: Record<string, unknown> = {},
): OperationDefaultsResult {
  if (['image', 'image-generate', 'image-edit'].includes(type)) {
    const effectiveModels = imageModels.length > 0 ? imageModels : [defaultImageModel]
    const presets = availableImageModelPresets(effectiveModels)
    const requiresEdit = type === 'image-edit'
    const requiresSize = typeof preferred.size === 'string'
    const requiresQuality = typeof preferred.quality === 'string'
    const compatible = presets.filter((preset) => (
      (!requiresEdit || preset.supportsEdits)
      && (!requiresSize || preset.supportsSize)
      && (!requiresQuality || preset.supportsQuality)
    ))
    const preferredModel = typeof preferred.model === 'string' ? preferred.model : ''
    const selected = compatible.find((preset) => preset.id === preferredModel) ?? compatible[0]
    if (!selected) return { available: false, config: { model: '' }, reason: requiresEdit ? '没有兼容的图片编辑模型' : '没有兼容的图片生成模型' }
    const config: Record<string, unknown> = {
      ...preferred,
      model: selected.id,
      ...(selected.supportsQuality ? { quality: typeof preferred.quality === 'string' ? preferred.quality : defaultImageQuality } : {}),
      ...(selected.supportsSize ? { size: typeof preferred.size === 'string' ? preferred.size : defaultImageSize } : {}),
      imageResolution: isImageResolution(preferred.imageResolution) && selected.resolutions.includes(preferred.imageResolution)
        ? preferred.imageResolution
        : defaultImageResolution,
    }
    if (!selected.supportsQuality) delete config.quality
    if (!selected.supportsSize) delete config.size
    return { available: true, config }
  }
  if (['video', 'video-generate'].includes(type)) {
    const effectiveModels = videoModels.length > 0 ? videoModels : [defaultVideoModel]
    const presets = availableVideoModelPresets(effectiveModels)
    const preferredModel = typeof preferred.model === 'string' ? preferred.model : ''
    const selected = presets.find((preset) => preset.id === preferredModel) ?? presets[0]
    if (!selected) return { available: false, config: { model: '' }, reason: '没有兼容的视频模型' }
    const seconds = typeof preferred.seconds === 'string' && /^(?:[1-9]|1[0-5])$/.test(preferred.seconds)
      ? preferred.seconds
      : String(defaultVideoSeconds)
    return { available: true, config: { ...preferred, model: selected.id, seconds } }
  }
  return { available: true, config: { ...preferred } }
}

export function modelSupportsTemplateOptions(model: string, options: readonly ('size' | 'quality')[]): boolean {
  const preset = imageModelPreset(model)
  return (!options.includes('size') || preset.supportsSize) && (!options.includes('quality') || preset.supportsQuality)
}
