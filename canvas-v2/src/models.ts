// xm.solov.cc 已配渠道的模型预设(老板提供,2026-08-11)。
// 后续可改为运行时从 relay 拉取;在那之前这里是唯一维护点,
// UI 用 datalist 呈现——既有下拉建议,也允许手输新模型名。
export const presetImageModels = [
  'gpt-image-1',
  'gpt-image-1.5',
  'gpt-image-2',
  'gpt-image-2-2026-04-21',
] as const

export const defaultImageModel: string = presetImageModels[0]

/** 视频渠道尚未在 xm 配好(2026-08-11),接好后在此补预设。 */
export const presetVideoModels: readonly string[] = []
