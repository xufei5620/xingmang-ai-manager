import type { VideoRequestAspectRatio } from '../lib/video-request-protocol'

const supportedAspectRatios = new Set<string>(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', '4:5', '5:4'])

function isAspectRatio(value: unknown): value is VideoRequestAspectRatio {
  return typeof value === 'string' && supportedAspectRatios.has(value)
}

export function templateVideoAspectRatio(size: unknown): VideoRequestAspectRatio {
  if (typeof size !== 'string' || !/^\d{1,5}x\d{1,5}$/.test(size)) throw new Error('模板视频尺寸无法确认，请选择有效的宽高尺寸')
  const [width, height] = size.split('x').map(Number)
  if (width < 1 || height < 1 || width > 8192 || height > 8192) throw new Error('模板视频尺寸超过当前支持范围')
  let divisor = width
  let remainder = height
  while (remainder !== 0) { const next = divisor % remainder; divisor = remainder; remainder = next }
  const ratio = `${width / divisor}:${height / divisor}`
  if (!isAspectRatio(ratio)) throw new Error('模板视频尺寸无法映射为已支持的视频比例，请明确设置视频比例')
  return ratio
}

export function normalizeTemplateVideoConfiguration(config: Record<string, unknown>, defaultSize = '1280x720'): Record<string, unknown> {
  if (config.videoAspectRatio !== undefined && !isAspectRatio(config.videoAspectRatio)) throw new Error('模板视频比例不正确，请选择已支持的视频比例')
  // Grok uses pixel dimensions, while MiniMax uses an explicit aspect_ratio.
  // A template's declared layout must reach both protocols, not only the UI.
  return { ...config, videoAspectRatio: config.videoAspectRatio ?? templateVideoAspectRatio(config.size ?? defaultSize) }
}
