import type { VideoStudioCaptionPosition, VideoStudioCaptionSize } from './captions'
import { VideoStudioError } from './errors'

export type VideoStudioAspect = '16:9' | '9:16' | '1:1'
export type VideoStudioResolution = 480 | 720 | 1080
export type VideoStudioFit = 'cover' | 'contain'
export type VideoStudioFrameRate = 24 | 25 | 30
/** 镜头之间怎么接：cut 直接切，fade 前一段淡到黑、后一段从黑里淡出来。 */
export type VideoStudioTransition = 'cut' | 'fade'

export const videoStudioAspects: readonly VideoStudioAspect[] = ['16:9', '9:16', '1:1']
export const videoStudioResolutions: readonly VideoStudioResolution[] = [480, 720, 1080]
export const videoStudioFits: readonly VideoStudioFit[] = ['cover', 'contain']
export const videoStudioFrameRates: readonly VideoStudioFrameRate[] = [24, 25, 30]
export const videoStudioTransitions: readonly VideoStudioTransition[] = ['cut', 'fade']
// 镜头之间淡入淡出每一头多长、成片结尾淡出多长。一段太短时按比例缩（buildVideoStudioRenderPlan），
// 不让淡入淡出吃掉整段画面。
export const videoStudioTransitionFadeSeconds = 0.4
export const videoStudioEndFadeSeconds = 1

// The finished audio is always assembled at 48 kHz stereo. 48 000 divides by
// every frame rate above, so a cut between two clips falls on a whole number of
// audio frames and the picture and the sound cannot drift apart over a long
// timeline. Opus only encodes at 48 kHz anyway.
export const videoStudioAudioSampleRate = 48_000
export const videoStudioAudioChannels = 2

export const maxVideoStudioClips = 50
export const maxVideoStudioDurationSeconds = 600
export const minVideoStudioSegmentSeconds = 0.2
export const maxVideoStudioCaptionLength = 200

/**
 * 视频剪辑里给人看的时长：「45 秒」「10 分 2 秒」「1 小时 5 分钟」。先整体取整到秒再拆，
 * 不会出「10 分 60 秒」；秒不补零；到一小时就不再数秒。
 */
export function formatVideoStudioDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  if (whole >= 3600) return `${Math.floor(whole / 3600)} 小时 ${Math.floor((whole % 3600) / 60)} 分钟`
  if (whole >= 60) return `${Math.floor(whole / 60)} 分 ${whole % 60} 秒`
  return `${whole} 秒`
}

export interface VideoStudioClipSpec {
  /**
   * 片段第一帧的时间（秒）。大多数文件是 0，带编辑表的文件可能不是；可能是负数，负的那几帧播放器不放，
   * 拼的时候也从 0 算起（buildVideoStudioRenderPlan）。
   */
  start: number
  /** 片段最后一帧结束的时间（秒），跟 start 同一个时钟。 */
  end: number
  /** 从开头剪掉的秒数，缺省 0。 */
  trimStart?: number
  /** 从结尾剪掉的秒数，缺省 0。 */
  trimEnd?: number
  /** 整段都显示的字幕，缺省没有。 */
  caption?: string
}

export interface VideoStudioRenderOptions {
  aspect: VideoStudioAspect
  resolution: VideoStudioResolution
  fit: VideoStudioFit
  frameRate: VideoStudioFrameRate
  /** 镜头之间怎么接，缺省直接切。 */
  transition?: VideoStudioTransition
  /** 成片最后淡到黑、声音一起淡掉，缺省不淡。 */
  fadeOut?: boolean
  /** 字幕大小和放哪儿，缺省中号、底部（captions.ts）。 */
  captionSize?: VideoStudioCaptionSize
  captionPosition?: VideoStudioCaptionPosition
}

export interface VideoStudioSegment {
  clipIndex: number
  /** 在源片段上从哪儿开始取（秒）。 */
  sourceStart: number
  /** 成片上的第一帧编号。 */
  firstFrame: number
  frameCount: number
  /** 去掉首尾空白、统一换行之后的字幕；没有字幕是空串。 */
  caption: string
  /** 这一段开头从黑里淡出来用几帧、结尾淡到黑用几帧；0 是不淡。画面和声音都跟着它。 */
  fadeInFrames: number
  fadeOutFrames: number
}

export interface VideoStudioRenderPlan {
  width: number
  height: number
  frameRate: VideoStudioFrameRate
  fit: VideoStudioFit
  frameCount: number
  /** 成片总长（秒），等于 frameCount / frameRate。 */
  duration: number
  segments: VideoStudioSegment[]
}

export function isVideoStudioAspect(value: unknown): value is VideoStudioAspect {
  return typeof value === 'string' && (videoStudioAspects as readonly string[]).includes(value)
}

export function isVideoStudioResolution(value: unknown): value is VideoStudioResolution {
  return typeof value === 'number' && (videoStudioResolutions as readonly number[]).includes(value)
}

export function isVideoStudioFit(value: unknown): value is VideoStudioFit {
  return typeof value === 'string' && (videoStudioFits as readonly string[]).includes(value)
}

export function isVideoStudioTransition(value: unknown): value is VideoStudioTransition {
  return typeof value === 'string' && (videoStudioTransitions as readonly string[]).includes(value)
}

export function isVideoStudioFrameRate(value: unknown): value is VideoStudioFrameRate {
  return typeof value === 'number' && (videoStudioFrameRates as readonly number[]).includes(value)
}

// 清晰度说的是短边：720 的竖屏是 720×1280，不是 405×720。H.264 的 4:2:0 要求宽高都是
// 偶数，所以 480 的横屏取 854 而不是 853。
export function resolveVideoStudioOutputSize(aspect: VideoStudioAspect, resolution: VideoStudioResolution): { width: number, height: number } {
  if (aspect === '1:1') return { width: resolution, height: resolution }
  const long = Math.ceil(resolution * 16 / 9 / 2) * 2
  return aspect === '16:9' ? { width: long, height: resolution } : { width: resolution, height: long }
}

export function normalizeVideoStudioCaption(value: string | undefined): string {
  if (!value) return ''
  return value.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean).join('\n')
}

/** 每一帧对应多少个音频采样帧；上面挑的帧率都能整除，所以是整数。 */
export function videoStudioSamplesPerFrame(frameRate: VideoStudioFrameRate): number {
  return videoStudioAudioSampleRate / frameRate
}

export function buildVideoStudioRenderPlan(clips: readonly VideoStudioClipSpec[], options: VideoStudioRenderOptions): VideoStudioRenderPlan {
  if (!isVideoStudioAspect(options.aspect)) throw new VideoStudioError('不支持这个画面比例')
  if (!isVideoStudioResolution(options.resolution)) throw new VideoStudioError('不支持这个清晰度')
  if (!isVideoStudioFit(options.fit)) throw new VideoStudioError('不支持这种画面填充方式')
  if (!isVideoStudioFrameRate(options.frameRate)) throw new VideoStudioError('不支持这个帧率')
  if (options.transition !== undefined && !isVideoStudioTransition(options.transition)) throw new VideoStudioError('不支持这种转场')
  if (clips.length === 0) throw new VideoStudioError('至少要放一段片段才能拼成片')
  if (clips.length > maxVideoStudioClips) throw new VideoStudioError(`一次最多拼 ${maxVideoStudioClips} 段片段`)

  const segments: VideoStudioSegment[] = []
  let nextFrame = 0
  clips.forEach((clip, clipIndex) => {
    const label = `第 ${clipIndex + 1} 段`
    const trimStart = clip.trimStart ?? 0
    const trimEnd = clip.trimEnd ?? 0
    // Frames stamped before zero are a lead-in the file hides on purpose (an
    // edit list, or an encoder priming its first GOP), and players never show
    // them. Cutting from the first frame instead put that hidden picture at the
    // head of the film and pushed the clip's sound back by the same amount, so
    // the cut starts at zero; the sound follows through segment.sourceStart
    // (compose.ts). A positive start is a real offset and is kept.
    const origin = Math.max(0, clip.start)
    if (![clip.start, clip.end, trimStart, trimEnd].every(Number.isFinite) || clip.end <= origin) {
      throw new VideoStudioError(`${label}片段的时长读不出来`)
    }
    if (trimStart < 0 || trimEnd < 0) throw new VideoStudioError(`${label}的剪切时间不能是负数`)
    const sourceStart = origin + trimStart
    const length = clip.end - trimEnd - sourceStart
    if (length < minVideoStudioSegmentSeconds) {
      throw new VideoStudioError(`${label}剪掉首尾后不到 ${minVideoStudioSegmentSeconds} 秒，没法用`)
    }
    const caption = normalizeVideoStudioCaption(clip.caption)
    if (Array.from(caption).length > maxVideoStudioCaptionLength) {
      throw new VideoStudioError(`${label}的字幕太长了，最多 ${maxVideoStudioCaptionLength} 个字`)
    }
    // 按帧四舍五入，误差不超过半帧，而且不会一段一段累加下去。
    const frameCount = Math.max(1, Math.round(length * options.frameRate))
    segments.push({ clipIndex, sourceStart, firstFrame: nextFrame, frameCount, caption, fadeInFrames: 0, fadeOutFrames: 0 })
    nextFrame += frameCount
  })
  // 片头不淡入（成片第一帧就是画面），镜头之间两头各淡一下，片尾按 fadeOut 淡出。每一头最多占这一段的
  // 三分之一（片尾一半），短片段也留得下看得清的画面。
  const transitionFrames = Math.round(videoStudioTransitionFadeSeconds * options.frameRate)
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1
    if (options.transition === 'fade' && index > 0) segment.fadeInFrames = Math.min(transitionFrames, Math.floor(segment.frameCount / 3))
    if (options.transition === 'fade' && !last) segment.fadeOutFrames = Math.min(transitionFrames, Math.floor(segment.frameCount / 3))
    if (options.fadeOut && last) segment.fadeOutFrames = Math.min(Math.round(videoStudioEndFadeSeconds * options.frameRate), Math.floor(segment.frameCount / 2))
  })

  const duration = nextFrame / options.frameRate
  if (duration > maxVideoStudioDurationSeconds) {
    // 往上取整：只超出零点几秒时不写成「现在是 10 分 0 秒」，看着像没超。
    throw new VideoStudioError(`成片最长 ${maxVideoStudioDurationSeconds / 60} 分钟，现在是 ${formatVideoStudioDuration(Math.ceil(duration))}`)
  }
  const { width, height } = resolveVideoStudioOutputSize(options.aspect, options.resolution)
  return { width, height, frameRate: options.frameRate, fit: options.fit, frameCount: nextFrame, duration, segments }
}

/** 这一段每一帧要去源片段上取的时间点（秒）。 */
/**
 * 这一段在 position（从这一段开头数的帧数，可以带小数）处亮多少：1 是原样，0 是全黑、没声音。
 * 画面在每一帧中间取一次（第 i 帧传 i + 0.5），声音按每个采样点的时间取，两边对得上。
 */
export function videoStudioFadeLevel(segment: Pick<VideoStudioSegment, 'frameCount' | 'fadeInFrames' | 'fadeOutFrames'>, position: number): number {
  let level = 1
  if (segment.fadeInFrames > 0) level = Math.min(level, position / segment.fadeInFrames)
  if (segment.fadeOutFrames > 0) level = Math.min(level, (segment.frameCount - position) / segment.fadeOutFrames)
  return Math.min(1, Math.max(0, level))
}

export function videoStudioSourceFrameTimes(segment: VideoStudioSegment, frameRate: VideoStudioFrameRate): number[] {
  return Array.from({ length: segment.frameCount }, (_, index) => segment.sourceStart + index / frameRate)
}
