// 图像模型预设 —— 事实来源:docs/RECON-image-generation.md(2026-08-12,
// xm.solov.cc 生产全链路实测,含与 OpenAI 账单逐笔对账)。要点:
// - 只暴露 3 个模型;gpt-image-1.5(项目权限 403)与快照版刻意隐藏
// - gpt-image 系必须显式传 quality(auto 会按提示词自动跳档,费用差可达
//   35 倍),默认 low;即梦无 quality 概念,请求里不传
// - 尺寸按模型区分:gpt-image-1 只认三种固定值;gpt-image-2 任意但宽高
//   必须都是 16 的倍数(预设已全部满足);即梦用常规 1024
// - 即梦返回的 CDN URL 24 小时过期,UI 要提示尽快下载转存

export interface ImageModelPreset {
  id: string
  label: string
  sizes: readonly string[]
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
    sizes: ['1024x1024', '1536x1152', '1280x720', '720x1280', '3840x2160'],
    supportsQuality: true,
    supportsEdits: true,
  },
  {
    id: 'gpt-image-1',
    label: 'GPT Image 1',
    sizes: ['1024x1024', '1024x1536', '1536x1024'],
    supportsQuality: true,
    supportsEdits: true,
  },
  {
    id: 'jimeng_high_aes_general_v21_L',
    label: '即梦(快·中文强)',
    sizes: ['1024x1024'],
    supportsQuality: false,
    supportsEdits: false,
    ephemeralUrl: true,
  },
]

export const defaultImageModel: string = imageModelPresets[0].id
export const defaultImageSize = '1024x1024'
export const defaultImageQuality = 'low'

/** 未知(手输)模型按 gpt-image-2 的形状处理,由服务端校验兜底。 */
export function imageModelPreset(id: string): ImageModelPreset {
  return imageModelPresets.find((preset) => preset.id === id) ?? {
    id,
    label: id,
    sizes: imageModelPresets[0].sizes,
    supportsQuality: true,
    supportsEdits: true,
  }
}

/** 画质档位与费用/耗时提示(实测矩阵的口径,给 UI 直接展示)。 */
export const imageQualityOptions = [
  { value: 'low', label: '低 · 约0.06-0.14元 · 最快' },
  { value: 'medium', label: '中 · 约0.5-1元 · ~1分钟' },
  { value: 'high', label: '高 · 约1.9-3.8元 · 2-3分钟' },
] as const

/** 视频渠道尚未在 xm 配好(2026-08-11),接好后在此补预设。 */
export const presetVideoModels: readonly string[] = []
