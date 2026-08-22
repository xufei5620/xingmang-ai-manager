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
// - Gemini 3.1 Flash Image 通过 Chat Completions 返回内嵌图片，size
//   在主进程转换为 aspect_ratio，不支持 Images API 编辑

export interface ImageModelPreset {
  id: string
  label: string
  sizes: readonly string[]
  /** Whether the relay accepts a size field for this model. */
  supportsSize: boolean
  supportsQuality: boolean
  resolutions: readonly ImageResolution[]
  resolutionNote?: string
  /** 支持 /v1/images/edits(图生图)。仅 gpt-image 系,即梦不支持。 */
  supportsEdits: boolean
  /** 生成产物为带签名的临时 URL(24h 过期),需提示用户尽快下载。 */
  ephemeralUrl?: boolean
}

export type ImageResolution = '1K' | '2K' | '4K'
export const imageResolutionOptions: readonly { value: ImageResolution; label: string }[] = [
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
  { value: '4K', label: '4K' },
]

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
    resolutions: ['1K', '2K', '4K'],
    supportsEdits: true,
  },
  {
    id: 'gemini-3.1-flash-image',
    label: 'Gemini 3.1 Flash Image',
    sizes: [
      '1024x1024', '1536x1152', '1152x1536', '1280x720', '720x1280',
      '1536x1024', '1024x1536', '1280x1024', '1024x1280', '1792x768',
    ],
    supportsSize: true,
    supportsQuality: false,
    resolutions: ['1K', '2K', '4K'],
    supportsEdits: false,
  },
  {
    id: 'gpt-image-1',
    label: 'GPT Image 1',
    sizes: ['1024x1024', '1024x1536', '1536x1024'],
    supportsSize: true,
    supportsQuality: true,
    resolutions: ['1K'],
    resolutionNote: 'GPT Image 1 接口最高只支持 1024/1536 固定尺寸',
    supportsEdits: true,
  },
  {
    id: 'jimeng_high_aes_general_v21_L',
    label: '即梦(快·中文强)',
    sizes: [],
    supportsSize: false,
    supportsQuality: false,
    resolutions: ['1K'],
    resolutionNote: '即梦当前接口没有 2K/4K 原生档位',
    supportsEdits: false,
    ephemeralUrl: true,
  },
  {
    id: 'grok-imagine-image',
    label: 'Grok Imagine',
    sizes: [],
    supportsSize: false,
    supportsQuality: false,
    resolutions: ['1K'],
    resolutionNote: 'Grok 当前接口由上游决定输出尺寸',
    supportsEdits: true,
  },
  {
    id: 'grok-imagine-image-2.0',
    label: 'Grok Imagine 2.0',
    sizes: [],
    supportsSize: false,
    supportsQuality: false,
    resolutions: ['1K'],
    resolutionNote: 'Grok 当前接口由上游决定输出尺寸',
    supportsEdits: true,
  },
  {
    id: 'grok-imagine-image-quality',
    label: 'Grok Imagine Quality',
    sizes: [],
    supportsSize: false,
    supportsQuality: false,
    resolutions: ['1K'],
    resolutionNote: 'Grok 当前接口由上游决定输出尺寸',
    supportsEdits: true,
  },
]

export const defaultImageModel: string = imageModelPresets[0].id
export const defaultImageSize = '1024x1024'
export const defaultImageQuality = 'low'
export const defaultImageResolution: ImageResolution = '1K'

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
    resolutions: ['1K', '2K', '4K'],
    supportsEdits: true,
  }
}

/** 画质档位与费用/耗时提示(实测矩阵的口径,给 UI 直接展示)。 */
export const imageQualityOptions = [
  { value: 'low', label: '标准' },
  { value: 'medium', label: '高' },
  { value: 'high', label: '极高' },
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
  provider: 'grok' | 'minimax-h3'
  minimumSeconds: number
  maximumSeconds: number
  defaultSeconds: number
  supportsImage: boolean
  supportsVideo: boolean
  supportsAudio: boolean
  sizes: readonly string[]
  defaultSize: string
}

export type MiniMaxVideoMode = 't2va' | 'i2va' | 'fl2va' | 'l2va' | 'ref2va'
export type CanvasVideoMode = 'auto' | MiniMaxVideoMode
export type MiniMaxVideoResolution = '480p' | '720p'
export type MiniMaxVideoAspectRatio = '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | '21:9' | '9:21' | '4:5' | '5:4'

export const videoModeOptions: readonly { value: CanvasVideoMode; label: string }[] = [
  { value: 'auto', label: '自动识别素材' },
  { value: 't2va', label: 'T2VA · 文生视频' },
  { value: 'i2va', label: 'I2VA · 首帧生视频' },
  { value: 'fl2va', label: 'FL2VA · 首尾帧' },
  { value: 'l2va', label: 'L2VA · 尾帧生视频' },
  { value: 'ref2va', label: 'Ref2VA · 多模态参考' },
]

export const videoResolutionOptions: readonly { value: MiniMaxVideoResolution; label: string }[] = [
  { value: '480p', label: '480p · 省成本' },
  { value: '720p', label: '720p · 高清' },
]

export const videoAspectRatioOptions: readonly { value: MiniMaxVideoAspectRatio; label: string }[] = [
  { value: '16:9', label: '16:9 · 横屏' },
  { value: '9:16', label: '9:16 · 竖屏' },
  { value: '1:1', label: '1:1 · 方屏' },
  { value: '4:3', label: '4:3 · 横屏' },
  { value: '3:4', label: '3:4 · 竖屏' },
  { value: '21:9', label: '21:9 · 超宽屏' },
  { value: '9:21', label: '9:21 · 超长屏' },
  { value: '4:5', label: '4:5 · 竖幅' },
  { value: '5:4', label: '5:4 · 横幅' },
]

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
    provider: 'grok',
    minimumSeconds: 1,
    maximumSeconds: 15,
    defaultSeconds: 5,
    supportsImage: true,
    supportsVideo: false,
    supportsAudio: false,
    sizes: videoSizeOptions.map((entry) => entry.value),
    defaultSize: '1280x720',
  },
  {
    id: 'grok-imagine-video-1.5',
    label: 'Grok Imagine Video 1.5 · 1080p',
    provider: 'grok',
    minimumSeconds: 1,
    maximumSeconds: 15,
    defaultSeconds: 5,
    supportsImage: true,
    supportsVideo: false,
    supportsAudio: false,
    sizes: videoSizeOptions.map((entry) => entry.value),
    defaultSize: '1280x720',
  },
  {
    id: 'minimax-h3-mini',
    label: 'MiniMax H3 Mini · 经济',
    provider: 'minimax-h3',
    minimumSeconds: 5,
    maximumSeconds: 15,
    defaultSeconds: 5,
    supportsImage: true,
    supportsVideo: true,
    supportsAudio: true,
    sizes: [],
    defaultSize: '1280x736',
  },
  {
    id: 'minimax-h3-fast',
    label: 'MiniMax H3 Fast · 快速',
    provider: 'minimax-h3',
    minimumSeconds: 5,
    maximumSeconds: 15,
    defaultSeconds: 5,
    supportsImage: true,
    supportsVideo: true,
    supportsAudio: true,
    sizes: [],
    defaultSize: '1280x736',
  },
  {
    id: 'minimax-h3-base',
    label: 'MiniMax H3 Base · 质量',
    provider: 'minimax-h3',
    minimumSeconds: 5,
    maximumSeconds: 15,
    defaultSeconds: 5,
    supportsImage: true,
    supportsVideo: true,
    supportsAudio: true,
    sizes: [],
    defaultSize: '1280x736',
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
    provider: 'grok',
    minimumSeconds: 1,
    maximumSeconds: 15,
    defaultSeconds: defaultVideoSeconds,
    supportsImage: true,
    supportsVideo: false,
    supportsAudio: false,
    sizes: videoSizeOptions.map((entry) => entry.value),
    defaultSize: defaultVideoSize,
  }
}

export function isMiniMaxVideoModel(model: string): boolean {
  return videoModelPreset(model).provider === 'minimax-h3'
}

export function resolveMiniMaxVideoMode(input: {
  mode?: unknown
  imageCount?: number
  videoCount?: number
  audioCount?: number
}): MiniMaxVideoMode | null {
  const requested = typeof input.mode === 'string' ? input.mode : 'auto'
  if (requested !== 'auto') {
    return videoModeOptions.some((option) => option.value === requested)
      ? requested as MiniMaxVideoMode
      : null
  }
  const images = input.imageCount ?? 0
  const videos = input.videoCount ?? 0
  const audios = input.audioCount ?? 0
  if (videos > 0 || audios > 0 || images > 2) return 'ref2va'
  if (images === 2) return 'fl2va'
  if (images === 1) return 'i2va'
  return 't2va'
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
  imageResolution?: string
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
  const imageResolution = input.imageResolution ?? defaultImageResolution
  if (!preset.resolutions.includes(imageResolution as ImageResolution)) {
    errors.push(`模型「${preset.label}」不支持 ${imageResolution} 清晰度`)
  }
  if (preset.supportsQuality && input.quality && !['low', 'medium', 'high', 'auto'].includes(input.quality)) {
    errors.push('画质只能为 low、medium、high 或 auto')
  }
  if (preset.supportsSize && input.size) {
    const dimensions = parseImageSize(input.size)
    if (!dimensions) errors.push('图片尺寸格式必须为“宽x高”')
    else if (input.model === 'gpt-image-2' && (dimensions.width % 16 !== 0 || dimensions.height % 16 !== 0)) {
      errors.push('GPT Image 2 的宽高必须都是 16 的倍数')
    } else if (input.model !== 'gpt-image-2' && !preset.sizes.includes(input.size)) {
      errors.push(`模型「${preset.label}」不支持这个图片尺寸`)
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
  if (!Number.isInteger(parsed) || parsed < preset.minimumSeconds || parsed > preset.maximumSeconds) return null
  return String(parsed)
}

export function validateVideoModelOptions(input: {
  model: string
  seconds: unknown
  size?: unknown
  mode?: unknown
  resolution?: unknown
  aspectRatio?: unknown
  imageCount?: number
  videoCount?: number
  audioCount?: number
}): string[] {
  const errors: string[] = []
  const preset = videoModelPreset(input.model)
  const imageCount = input.imageCount ?? 0
  const videoCount = input.videoCount ?? 0
  const audioCount = input.audioCount ?? 0
  if (!input.model.trim()) errors.push('请选择视频模型')
  if (normalizeVideoSeconds(input.seconds, input.model) === null) {
    errors.push(`视频时长必须在 ${preset.minimumSeconds}-${preset.maximumSeconds} 秒之间`)
  }
  if (imageCount > 0 && !preset.supportsImage) errors.push(`模型「${preset.label}」不支持图片参考`)
  if (videoCount > 0 && !preset.supportsVideo) errors.push(`模型「${preset.label}」不支持视频参考`)
  if (audioCount > 0 && !preset.supportsAudio) errors.push(`模型「${preset.label}」不支持音频参考`)

  if (preset.provider === 'grok') {
    if (imageCount > 1) errors.push('Grok 视频模型最多使用 1 张参考图')
    if (input.size !== undefined && (typeof input.size !== 'string' || !preset.sizes.includes(input.size))) {
      errors.push(`模型「${preset.label}」不支持这个视频比例`)
    }
    return errors
  }

  const mode = resolveMiniMaxVideoMode({
    mode: input.mode,
    imageCount,
    videoCount,
    audioCount,
  })
  if (!mode) errors.push('MiniMax 生成模式无效')
  if (!videoResolutionOptions.some((option) => option.value === (input.resolution ?? '720p'))) {
    errors.push('MiniMax 分辨率只能为 480p 或 720p')
  }
  if (!videoAspectRatioOptions.some((option) => option.value === (input.aspectRatio ?? '16:9'))) {
    errors.push('MiniMax 视频比例不受支持')
  }
  if (imageCount > 9) errors.push('MiniMax 最多支持 9 张参考图')
  if (videoCount > 3) errors.push('MiniMax 最多支持 3 个参考视频')
  if (audioCount > 3) errors.push('MiniMax 最多支持 3 个参考音频')
  if (imageCount + videoCount + audioCount > 15) errors.push('MiniMax 单次最多支持 15 个参考素材')
  if (mode === 't2va' && imageCount + videoCount + audioCount > 0) errors.push('T2VA 文生视频不能连接媒体素材')
  if ((mode === 'i2va' || mode === 'l2va') && (imageCount !== 1 || videoCount > 0 || audioCount > 0)) {
    errors.push(`${mode.toUpperCase()} 需要且只能连接 1 张图片`)
  }
  if (mode === 'fl2va' && ((imageCount !== 1 && imageCount !== 2) || videoCount > 0 || audioCount > 0)) {
    errors.push('FL2VA 需要连接 1-2 张图片，顺序为首帧、尾帧')
  }
  if (mode === 'ref2va' && imageCount + videoCount + audioCount === 0) {
    errors.push('Ref2VA 至少需要连接 1 个图片、视频或音频素材')
  }
  if (input.size !== undefined && input.size !== '' && typeof input.size !== 'string') {
    errors.push(`模型「${preset.label}」不支持这个视频比例`)
  }
  return errors
}
