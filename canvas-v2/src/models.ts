// 图像模型能力预设 —— UI 最终只显示当前分组 /v1/models 返回值与本表
// 的交集，因此预设存在不等于当前账号一定可用。事实来源:
// docs/RECON-image-generation.md(2026-08-12, xm.solov.cc 生产全链路实测,
// 含与 OpenAI 账单逐笔对账)。要点:
// - gpt-image-1.5(项目权限 403)与快照版刻意隐藏
// - gpt-image 系必须显式传 quality(auto 会按提示词自动跳档,费用差可达
//   35 倍),默认 low;即梦无 quality 概念,请求里不传
// - 尺寸按模型区分:gpt-image-1 只认三种固定值;gpt-image-2 任意但宽高
//   必须都是 16 的倍数(预设已全部满足);即梦用常规 1024
// - 即梦返回的 CDN URL 24 小时过期,UI 要提示尽快下载转存

export interface ImageModelPreset {
  id: string
  label: string
  sizes: readonly string[]
  /** Whether the relay accepts a size field for this model. */
  supportsSize: boolean
  supportsQuality: boolean
  /** 支持 /v1/images/edits(图生图)。仅 gpt-image 系,即梦不支持。 */
  supportsEdits: boolean
  /** 生成产物为带签名的临时 URL(24h 过期),需提示用户尽快下载。 */
  ephemeralUrl?: boolean
}

export const imageModelPresets: readonly ImageModelPreset[] = [
  {
    id: 'gpt-image-2',
    label: 'GPT Image 2(推荐)',
    sizes: [
      '1024x1024', '1536x1152', '1152x1536', '1280x720', '720x1280',
      '1536x1024', '1024x1536', '1280x1024', '1024x1280', '1792x768',
    ],
    supportsSize: true,
    supportsQuality: true,
    supportsEdits: true,
  },
  {
    id: 'gpt-image-1',
    label: 'GPT Image 1',
    sizes: ['1024x1024', '1024x1536', '1536x1024'],
    supportsSize: true,
    supportsQuality: true,
    supportsEdits: true,
  },
  {
    id: 'jimeng_high_aes_general_v21_L',
    label: '即梦(快·中文强)',
    sizes: [],
    supportsSize: false,
    supportsQuality: false,
    supportsEdits: false,
    ephemeralUrl: true,
  },
  {
    id: 'grok-imagine-image',
    label: 'Grok Imagine',
    sizes: [],
    supportsSize: false,
    supportsQuality: false,
    supportsEdits: true,
  },
  {
    id: 'grok-imagine-image-2.0',
    label: 'Grok Imagine 2.0',
    sizes: [],
    supportsSize: false,
    supportsQuality: false,
    supportsEdits: true,
  },
  {
    id: 'grok-imagine-image-quality',
    label: 'Grok Imagine Quality',
    sizes: [],
    supportsSize: false,
    supportsQuality: false,
    supportsEdits: true,
  },
]

export const defaultImageModel: string = imageModelPresets[0].id
export const defaultImageSize = '1024x1024'
export const defaultImageQuality = 'low'

export function availableImageModelPresets(models: readonly string[]): ImageModelPreset[] {
  const available = new Set(models)
  return imageModelPresets.filter((preset) => available.has(preset.id))
}

/** 未知(手输)模型按 gpt-image-2 的形状处理,由服务端校验兜底。 */
export function imageModelPreset(id: string): ImageModelPreset {
  return imageModelPresets.find((preset) => preset.id === id) ?? {
    id,
    label: id,
    sizes: imageModelPresets[0].sizes,
    supportsSize: true,
    supportsQuality: true,
    supportsEdits: true,
  }
}

/** 画质档位与费用/耗时提示(实测矩阵的口径,给 UI 直接展示)。 */
export const imageQualityOptions = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
] as const

const imageRatioBySize: Readonly<Record<string, string>> = {
  '1024x1024': '1:1',
  '1536x1152': '4:3',
  '1152x1536': '3:4',
  '1280x720': '16:9',
  '720x1280': '9:16',
  '1536x1024': '3:2',
  '1024x1536': '2:3',
  '1280x1024': '5:4',
  '1024x1280': '4:5',
  '1792x768': '21:9',
}

export function imageSizeLabel(size: string): string {
  const ratio = imageRatioBySize[size]
  return ratio ? `${ratio} · ${size}` : size
}

/** 当前由 xm.solov.cc 暴露的视频模型能力预设。 */
export interface VideoModelPreset {
  id: string
  label: string
  maximumSeconds: number
  defaultSeconds: number
  supportsImage: boolean
  sizes: readonly string[]
  defaultSize: string
}

export const videoSizeOptions = [
  { value: '1280x720', label: '16:9 · 横屏' },
  { value: '720x1280', label: '9:16 · 竖屏' },
  { value: '1024x1024', label: '1:1 · 方形' },
  { value: '1024x768', label: '4:3 · 横屏' },
  { value: '768x1024', label: '3:4 · 竖屏' },
] as const

export const videoModelPresets: readonly VideoModelPreset[] = [
  {
    id: 'grok-imagine-video',
    label: 'Grok Imagine Video',
    maximumSeconds: 15,
    defaultSeconds: 5,
    supportsImage: true,
    sizes: videoSizeOptions.map((entry) => entry.value),
    defaultSize: '1280x720',
  },
  {
    id: 'grok-imagine-video-1.5',
    label: 'Grok Imagine Video 1.5 · 1080p',
    maximumSeconds: 15,
    defaultSeconds: 5,
    supportsImage: true,
    sizes: videoSizeOptions.map((entry) => entry.value),
    defaultSize: '1280x720',
  },
]

export const presetVideoModels: readonly string[] = videoModelPresets.map((preset) => preset.id)
export const defaultVideoModel = videoModelPresets[0].id
export const defaultVideoSeconds = videoModelPresets[0].defaultSeconds
export const defaultVideoSize = videoModelPresets[0].defaultSize

export function availableVideoModelPresets(models: readonly string[]): VideoModelPreset[] {
  const available = new Set(models)
  return videoModelPresets.filter((preset) => available.has(preset.id))
}

export function videoModelPreset(id: string): VideoModelPreset {
  return videoModelPresets.find((preset) => preset.id === id) ?? {
    id,
    label: id,
    maximumSeconds: 15,
    defaultSeconds: defaultVideoSeconds,
    supportsImage: true,
    sizes: videoSizeOptions.map((entry) => entry.value),
    defaultSize: defaultVideoSize,
  }
}

export function parseImageSize(size: string): { width: number; height: number } | null {
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(size)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  return width > 0 && height > 0 ? { width, height } : null
}

export function validateImageModelOptions(input: {
  model: string
  operation: 'generate' | 'edit'
  size?: string
  quality?: string
  referenceImageCount?: number
}): string[] {
  const errors: string[] = []
  const preset = imageModelPreset(input.model)
  if (!input.model.trim()) errors.push('请选择图像模型')
  if (input.operation === 'edit' && !preset.supportsEdits) errors.push(`模型「${preset.label}」不支持图片编辑`)
  if (input.operation === 'edit' && (input.referenceImageCount ?? 0) < 1) errors.push('图片编辑至少需要 1 张参考图')
  if ((input.referenceImageCount ?? 0) > 4) errors.push('图片编辑最多支持 4 张参考图')
  if (!preset.supportsSize && input.size) errors.push(`模型「${preset.label}」不接受尺寸参数`)
  if (!preset.supportsQuality && input.quality) errors.push(`模型「${preset.label}」不接受画质参数`)
  if (preset.supportsQuality && input.quality && !['low', 'medium', 'high', 'auto'].includes(input.quality)) {
    errors.push('画质只能为 low、medium、high 或 auto')
  }
  if (preset.supportsSize && input.size) {
    const dimensions = parseImageSize(input.size)
    if (!dimensions) errors.push('图片尺寸格式必须为“宽x高”')
    else if (input.model === 'gpt-image-2' && (dimensions.width % 16 !== 0 || dimensions.height % 16 !== 0)) {
      errors.push('GPT Image 2 的宽高必须都是 16 的倍数')
    } else if (input.model === 'gpt-image-1' && !preset.sizes.includes(input.size)) {
      errors.push('GPT Image 1 不支持这个图片尺寸')
    }
  }
  return errors
}

export function normalizeVideoSeconds(value: unknown, model: string): string | null {
  const preset = videoModelPreset(model)
  if (value === undefined) return String(preset.defaultSeconds)
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const raw = typeof value === 'string' ? value.trim() : value
  if (raw === '') return null
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > preset.maximumSeconds) return null
  return String(parsed)
}

export function validateVideoModelOptions(input: { model: string; seconds: unknown; size?: unknown; hasImage?: boolean }): string[] {
  const errors: string[] = []
  const preset = videoModelPreset(input.model)
  if (!input.model.trim()) errors.push('请选择视频模型')
  if (normalizeVideoSeconds(input.seconds, input.model) === null) {
    errors.push(`视频时长必须在 1-${preset.maximumSeconds} 秒之间`)
  }
  if (input.hasImage && !preset.supportsImage) errors.push(`模型「${preset.label}」不支持图生视频`)
  if (input.size !== undefined && (typeof input.size !== 'string' || !preset.sizes.includes(input.size))) {
    errors.push(`模型「${preset.label}」不支持这个视频比例`)
  }
  return errors
}
