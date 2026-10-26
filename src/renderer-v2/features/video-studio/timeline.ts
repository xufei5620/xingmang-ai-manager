import { VideoStudioError } from './errors'

export type VideoStudioAspect = '16:9' | '9:16' | '1:1'
export type VideoStudioResolution = 480 | 720 | 1080
export type VideoStudioFit = 'cover' | 'contain'
export type VideoStudioFrameRate = 24 | 25 | 30

export const videoStudioAspects: readonly VideoStudioAspect[] = ['16:9', '9:16', '1:1']
export const videoStudioResolutions: readonly VideoStudioResolution[] = [480, 720, 1080]
export const videoStudioFits: readonly VideoStudioFit[] = ['cover', 'contain']
export const videoStudioFrameRates: readonly VideoStudioFrameRate[] = [24, 25, 30]

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

export interface VideoStudioClipSpec {
  /** 片段第一帧的时间（秒）。大多数文件是 0，带编辑表的文件可能不是。 */
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
  if (clips.length === 0) throw new VideoStudioError('至少要放一段片段才能拼成片')
  if (clips.length > maxVideoStudioClips) throw new VideoStudioError(`一次最多拼 ${maxVideoStudioClips} 段片段`)

  const segments: VideoStudioSegment[] = []
  let nextFrame = 0
  clips.forEach((clip, clipIndex) => {
    const label = `第 ${clipIndex + 1} 段`
    const trimStart = clip.trimStart ?? 0
    const trimEnd = clip.trimEnd ?? 0
    if (![clip.start, clip.end, trimStart, trimEnd].every(Number.isFinite) || clip.end <= clip.start) {
      throw new VideoStudioError(`${label}片段的时长读不出来`)
    }
    if (trimStart < 0 || trimEnd < 0) throw new VideoStudioError(`${label}的剪切时间不能是负数`)
    const sourceStart = clip.start + trimStart
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
    segments.push({ clipIndex, sourceStart, firstFrame: nextFrame, frameCount, caption })
    nextFrame += frameCount
  })

  const duration = nextFrame / options.frameRate
  if (duration > maxVideoStudioDurationSeconds) {
    const minutes = Math.floor(duration / 60)
    const seconds = Math.round(duration % 60)
    throw new VideoStudioError(`成片最长 ${maxVideoStudioDurationSeconds / 60} 分钟，现在是 ${minutes} 分 ${seconds} 秒`)
  }
  const { width, height } = resolveVideoStudioOutputSize(options.aspect, options.resolution)
  return { width, height, frameRate: options.frameRate, fit: options.fit, frameCount: nextFrame, duration, segments }
}

/** 这一段每一帧要去源片段上取的时间点（秒）。 */
export function videoStudioSourceFrameTimes(segment: VideoStudioSegment, frameRate: VideoStudioFrameRate): number[] {
  return Array.from({ length: segment.frameCount }, (_, index) => segment.sourceStart + index / frameRate)
}
