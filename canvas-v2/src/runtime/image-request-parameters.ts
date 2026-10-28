export type ImageRequestResolution = '1K' | '2K' | '4K'

export interface ImageRequestParametersInput {
  model: string
  prompt: string
  size?: string
  quality?: string
  imageResolution?: ImageRequestResolution
}

export class ImageRequestParameterError extends Error {}

// This revision belongs in generation cache fingerprints. Revision 2 allowed
// dimensions above GPT Image 2's native pixel and edge limits.
export const imageRequestProtocolRevision = 3

const gptImage2Models = new Set(['gpt-image-2', 'gpt-image-2-2026-04-21'])
const providerSizedModels = new Set(['jimeng_high_aes_general_v21_l', 'grok-imagine-image', 'grok-imagine-image-2.0', 'grok-imagine-image-quality'])
const imageQualities = new Set(['low', 'medium', 'high', 'auto', 'standard', 'hd'])
const gptImageQualities = new Set(['low', 'medium', 'high', 'auto'])
const nativeImageResolutions: readonly ImageRequestResolution[] = ['1K', '2K', '4K']
const baselineImageResolutions: readonly ImageRequestResolution[] = ['1K']
const gptImage1Sizes: readonly string[] = ['1024x1024', '1024x1536', '1536x1024', 'auto']

export interface ImageRequestModelControls {
  supportsSize: boolean
  supportsQuality: boolean
  fixedSizes?: readonly string[]
}

/** Shared wire facts, kept independent of UI presets to avoid an import cycle. */
export function imageRequestModelControls(model: string): ImageRequestModelControls {
  const name = model.trim().toLowerCase()
  if (providerSizedModels.has(name)) return { supportsSize: false, supportsQuality: false }
  if (name === 'gemini-3.1-flash-image') return { supportsSize: true, supportsQuality: false }
  if (name === 'gpt-image-1') return { supportsSize: true, supportsQuality: true, fixedSizes: gptImage1Sizes }
  return { supportsSize: true, supportsQuality: true }
}

/** These are implemented wire capabilities, not promises about a model name. */
export function supportedImageRequestResolutions(model: string): readonly ImageRequestResolution[] {
  return gptImage2Models.has(model.trim().toLowerCase()) ? nativeImageResolutions : baselineImageResolutions
}

// Preserve existing valid 2K presets. 4K uses the documented UHD edge and
// never shrinks a pixel-limited square into a lower resolution under a 4K label.
const gptImage2Sizes: Readonly<Record<Exclude<ImageRequestResolution, '1K'>, Readonly<Record<string, string>>>> = {
  '2K': {
    '1024x1024': '2048x2048',
    '1536x1152': '2048x1536',
    '1152x1536': '1536x2048',
    '1280x720': '1920x1088',
    '720x1280': '1088x1920',
    '1536x1024': '2048x1360',
    '1024x1536': '1360x2048',
    '1280x1024': '2048x1648',
    '1024x1280': '1648x2048',
    '1792x768': '2048x880',
  },
  '4K': {
    '1280x720': '3840x2160',
    '720x1280': '2160x3840',
    '1792x768': '3840x1648',
  },
}

function nonempty(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new ImageRequestParameterError(`${label}不能为空，且不能超过 ${maximum} 个字符`)
  return value.trim()
}

function validateImageSize(size: unknown): string {
  if (typeof size !== 'string' || size !== 'auto' && !/^\d{2,5}x\d{2,5}$/.test(size)) throw new ImageRequestParameterError('图像尺寸格式不正确，请使用宽度x高度')
  if (size !== 'auto') {
    const [width, height] = size.split('x').map(Number)
    if (width < 16 || height < 16 || width > 8192 || height > 8192 || width * height > 32_000_000) throw new ImageRequestParameterError('图像尺寸超过当前工作区范围，请降低尺寸')
  }
  return size
}

function validateGptImage2Size(size: string): string {
  if (size === 'auto') throw new ImageRequestParameterError('GPT Image 2 清晰度需要明确的宽度和高度，请选择图像尺寸')
  const [width, height] = size.split('x').map(Number)
  if (width % 16 !== 0 || height % 16 !== 0) throw new ImageRequestParameterError('GPT Image 2 宽高须为 16 的倍数')
  if (Math.max(width, height) > 3840) throw new ImageRequestParameterError('GPT Image 2 最长边不能超过 3840 像素')
  if (Math.max(width, height) / Math.min(width, height) > 3) throw new ImageRequestParameterError('GPT Image 2 最长边与最短边的比例不能超过 3:1')
  if (width * height < 655_360 || width * height > 8_294_400) throw new ImageRequestParameterError('GPT Image 2 总像素须在 655,360 到 8,294,400 之间，请调整尺寸')
  return `${width}x${height}`
}

function scaleGptImage2Size(size: string, resolution: ImageRequestResolution): string {
  if (resolution === '1K') return size
  const preset = gptImage2Sizes[resolution][size]
  if (preset) return preset
  const [width, height] = size.split('x').map(Number)
  const target = resolution === '2K' ? 2048 : 3840
  const scale = target / Math.max(width, height)
  const scaledWidth = Math.round(width * scale / 16) * 16
  const scaledHeight = Math.round(height * scale / 16) * 16
  if (resolution === '4K' && scaledWidth * scaledHeight > 8_294_400) throw new ImageRequestParameterError('GPT Image 2 在此比例下的 4K 尺寸超过 8,294,400 像素，请选择 2K，或改用 16:9、9:16、21:9')
  return `${scaledWidth}x${scaledHeight}`
}

/** Pure shared wire builder: no credentials, network, browser or server imports. */
export function buildImageRequestParameters(input: ImageRequestParametersInput): Record<string, string | number> {
  const model = nonempty(input.model, '模型名称', 200)
  const resolution = input.imageResolution === undefined ? '1K' : input.imageResolution
  if (!['1K', '2K', '4K'].includes(resolution)) throw new ImageRequestParameterError('图像分辨率不正确，请选择 1K、2K 或 4K')
  const knownGptImage2 = gptImage2Models.has(model.toLowerCase())
  const controls = imageRequestModelControls(model)
  if (!supportedImageRequestResolutions(model).includes(resolution)) throw new ImageRequestParameterError('当前模型的接入通道尚未接入 2K/4K 分辨率转换，请选择 1K；不会静默以较低分辨率提交')
  const body: Record<string, string | number> = { model, prompt: nonempty(input.prompt, '图像提示词', 32_000), n: 1 }
  if (knownGptImage2) {
    const size = validateGptImage2Size(validateImageSize(input.size === undefined ? '1024x1024' : input.size))
    body.size = validateGptImage2Size(scaleGptImage2Size(size, resolution))
  } else if (controls.supportsSize && input.size !== undefined) {
    const size = validateImageSize(input.size)
    if (controls.fixedSizes && !controls.fixedSizes.includes(size)) throw new ImageRequestParameterError('GPT Image 1 仅支持 1024x1024、1024x1536、1536x1024 或 auto，请更换画面比例')
    body.size = size
  }
  // Retain editor values when switching models, but never send controls that
  // the selected adapter ignores. A provider-sized output has no promised px.
  if (controls.supportsQuality && input.quality !== undefined) {
    const qualities = knownGptImage2 || model.toLowerCase() === 'gpt-image-1' ? gptImageQualities : imageQualities
    if (!qualities.has(input.quality)) throw new ImageRequestParameterError('图像质量参数不受支持')
    body.quality = input.quality
  }
  return body
}
