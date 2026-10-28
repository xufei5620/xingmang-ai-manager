import { imageModelPreset, imageSizeLabel, knownNonImageModel } from '../models'
import { buildImageRequestParameters, type ImageRequestResolution } from '../runtime/image-request-parameters'

export interface TemplateImageModelCompatibility {
  available: boolean
  reasons: string[]
}

function isImageResolution(value: unknown): value is ImageRequestResolution {
  return value === '1K' || value === '2K' || value === '4K'
}

/** Template readiness must use the same concrete limits as the eventual wire. */
export function templateImageModelCompatibility(
  model: string,
  operation: 'generate' | 'edit',
  config: Readonly<Record<string, unknown>> = {},
  requiredOptions: readonly ('size' | 'quality')[] = [],
): TemplateImageModelCompatibility {
  const preset = imageModelPreset(model)
  const reasons: string[] = []
  if (!model.trim() || knownNonImageModel(model.trim())) reasons.push('请选择图像模型，已知文字或视频模型不能用于模板图像生成')
  if (operation === 'edit' && !preset.supportsEdits) reasons.push(`模型「${preset.label}」不支持模板所需的图片编辑`)
  if ((config.size !== undefined || requiredOptions.includes('size')) && !preset.supportsSize) reasons.push(`模型「${preset.label}」不能明确指定模板尺寸`)
  if ((config.quality !== undefined || requiredOptions.includes('quality')) && !preset.supportsQuality) reasons.push(`模型「${preset.label}」不支持模板所需的画质参数`)
  if (config.size !== undefined && typeof config.size !== 'string') reasons.push('模板图片尺寸格式不正确')
  if (config.quality !== undefined && typeof config.quality !== 'string') reasons.push('模板图片画质格式不正确')
  if (config.imageResolution !== undefined && !isImageResolution(config.imageResolution)) reasons.push('模板图片清晰度不受支持，请明确选择 1K、2K 或 4K')
  if (reasons.length === 0) {
    try {
      buildImageRequestParameters({
        model,
        prompt: '模板参数预检',
        ...(typeof config.size === 'string' ? { size: config.size } : {}),
        ...(typeof config.quality === 'string' ? { quality: config.quality } : {}),
        ...(isImageResolution(config.imageResolution) ? { imageResolution: config.imageResolution } : {}),
      })
    } catch (error) {
      const requested = typeof config.size === 'string' ? `模板尺寸 ${imageSizeLabel(config.size)}；` : ''
      reasons.push(`${requested}模型「${preset.label}」：${error instanceof Error ? error.message : '不支持模板图像参数'}`)
    }
  }
  return { available: reasons.length === 0, reasons }
}
