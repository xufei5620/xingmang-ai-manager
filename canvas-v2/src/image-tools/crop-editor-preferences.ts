import type { ImageCropRecipe } from './recipe'

export const cropRatioModes = ['自由', '原图', '1:1', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4', '16:9', '9:16', '21:9', '9:21', '2:1', '1:2', '3:1', '1:3', '自定义'] as const

/** Editing preferences are separate from the executable image recipe/digest. */
export interface ImageCropEditorPreferences {
  version: 1
  ratioMode: typeof cropRatioModes[number]
  customWidth: number
  customHeight: number
  cropLocked: boolean
  outputLocked: boolean
  outputRatio: number
  snapping: boolean
}

export function defaultImageCropEditorPreferences(recipe: ImageCropRecipe): ImageCropEditorPreferences {
  return { version: 1, ratioMode: '自由', customWidth: 7, customHeight: 5, cropLocked: false, outputLocked: true, outputRatio: recipe.outputWidth / recipe.outputHeight, snapping: true }
}

export function reconcileUnlockedCropOutputRatio(recipe: ImageCropRecipe, preferences: ImageCropEditorPreferences): ImageCropEditorPreferences {
  if (preferences.outputLocked) return preferences
  // Older editors left the previous lock behind after unlocked manual edits.
  // Preserve exact ratios that explain either integer edge after rounding.
  const width = Math.max(1, Math.round(recipe.outputHeight * preferences.outputRatio))
  const height = Math.max(1, Math.round(recipe.outputWidth / preferences.outputRatio))
  return width === recipe.outputWidth || height === recipe.outputHeight ? preferences : { ...preferences, outputRatio: recipe.outputWidth / recipe.outputHeight }
}

export function parseImageCropEditorPreferences(value: unknown): ImageCropEditorPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('裁剪编辑偏好格式不正确')
  const input = value as Record<string, unknown>
  const keys = ['version', 'ratioMode', 'customWidth', 'customHeight', 'cropLocked', 'outputLocked', 'outputRatio', 'snapping']
  if (Object.keys(input).some((key) => !keys.includes(key)) || input.version !== 1 || !cropRatioModes.includes(input.ratioMode as ImageCropEditorPreferences['ratioMode'])) throw new Error('裁剪编辑偏好版本或比例模式无效')
  for (const key of ['cropLocked', 'outputLocked', 'snapping']) if (typeof input[key] !== 'boolean') throw new Error('裁剪编辑锁定与吸附设置无效')
  for (const key of ['customWidth', 'customHeight', 'outputRatio']) {
    const number = input[key], low = key === 'outputRatio' ? 1 / 4096 : 1, high = key === 'outputRatio' ? 4096 : 100
    if (typeof number !== 'number' || !Number.isFinite(number) || number < low || number > high) throw new Error('裁剪编辑比例超出支持范围')
  }
  return { version: 1, ratioMode: input.ratioMode as ImageCropEditorPreferences['ratioMode'], customWidth: Number(input.customWidth), customHeight: Number(input.customHeight), cropLocked: Boolean(input.cropLocked), outputLocked: Boolean(input.outputLocked), outputRatio: Number(input.outputRatio), snapping: Boolean(input.snapping) }
}
