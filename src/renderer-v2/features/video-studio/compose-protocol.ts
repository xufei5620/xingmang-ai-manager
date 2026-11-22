import { videoStudioMusicUnreadableMessage } from '../../../../electron/video-studio-plan'
import { isVideoStudioCaptionPosition, isVideoStudioCaptionSize } from './captions'
import { isVideoStudioAudioCodec, isVideoStudioVideoCodec, type VideoStudioAudioCodec, type VideoStudioEncodingPreference, type VideoStudioVideoCodec } from './encoding'
import { VideoStudioError, videoStudioComposeGlitchMessage } from './errors'
import {
  isVideoStudioAspect,
  isVideoStudioFit,
  isVideoStudioFrameRate,
  isVideoStudioResolution,
  isVideoStudioTransition,
  maxVideoStudioCaptionLength,
  maxVideoStudioClips,
  type VideoStudioRenderOptions,
} from './timeline'

const megabyte = 1024 * 1024
const gigabyte = 1024 * megabyte
// 片段整段读进内存再拼，所以要给总量设个顶：一段 AI 片段只有几 MB，这两个数是给
// 以后导入本地长视频留的余量，又不至于让一个窗口吃掉几 GB 内存。合计的顶内存小的电脑还要再收紧（videoStudioTotalBytesLimit）。
export const maxVideoStudioClipBytes = 512 * megabyte
export const maxVideoStudioTotalBytes = gigabyte
// 内存再小也给这么多：一段 AI 片段几 MB，放满 50 段也够。
export const minVideoStudioTotalBytes = 256 * megabyte
// 配乐整首读进来、边拼边解；作品库收音频的上限就是这么大（electron/ai-audio-asset-store.ts）。
export const maxVideoStudioMusicBytes = 128 * 1024 * 1024
export { videoStudioMusicUnreadableMessage }

export interface VideoStudioComposeClip {
  /** 片段文件的全部字节（MP4 / MOV / WebM）。交给后台线程时会被转移走，调用方之后不能再用。 */
  data: ArrayBuffer
  trimStart?: number
  trimEnd?: number
  caption?: string
}

export interface VideoStudioComposeMusic {
  /** 歌的全部字节（MP3 / M4A / WAV / OGG）。和片段一样转移给后台线程。 */
  data: ArrayBuffer
  /** 配乐的音量，0 到 1。 */
  gain: number
}

export interface VideoStudioComposeRequest {
  clips: VideoStudioComposeClip[]
  options: VideoStudioRenderOptions
  /** 背景音乐：从成片开头放，短了从头接着放，结尾淡出。 */
  music?: VideoStudioComposeMusic
  /** 片段原声的音量，0 到 1，缺省 1；0 就是不要原声。 */
  clipGain?: number
  /** 只给测试用：指定编码器的先后。缺省按 encoding.ts 里的顺序挑。 */
  encoding?: VideoStudioEncodingPreference
}

export type VideoStudioComposeStage = 'reading' | 'rendering' | 'finishing'

export interface VideoStudioComposeProgress {
  stage: VideoStudioComposeStage
  /** 整体进度，0 到 1。 */
  ratio: number
}

export interface VideoStudioComposeResult {
  data: ArrayBuffer
  mimeType: string
  videoCodec: VideoStudioVideoCodec
  audioCodec: VideoStudioAudioCodec | null
  width: number
  height: number
  duration: number
}

export interface VideoStudioWorkerMessage {
  kind: 'compose'
  request: VideoStudioComposeRequest
}

export type VideoStudioWorkerReply =
  | { kind: 'progress', progress: VideoStudioComposeProgress }
  | { kind: 'done', result: VideoStudioComposeResult }
  | { kind: 'failed', message: string, detail?: string }

const composeStages: readonly VideoStudioComposeStage[] = ['reading', 'rendering', 'finishing']
// 这里只挡住离谱的长度，精确的字数（去掉空白以后）由 buildVideoStudioRenderPlan 核对。
const maxRawCaptionLength = maxVideoStudioCaptionLength * 5

function readDeviceMemoryGigabytes(): unknown {
  return typeof navigator !== 'undefined' && 'deviceMemory' in navigator ? navigator.deviceMemory : undefined
}

/**
 * 片段加起来最多多大，按这台电脑的内存取八分之一，再夹在 256 MB 到 1 GB 之间（0.2.24 深查「资源占用」R-7）。
 * 片段、攒在内存里的成片、IPC 来回的那几份复制都压在界面进程上，一次拼片吃的内存是片段合计的两三倍，
 * 4 GB 的电脑照 1 GB 放，界面进程可能被系统杀掉。
 *
 * 内存数用浏览器内核报的 navigator.deviceMemory：页面和拼片线程各自读得到、读到的是同一个数，不用为这个
 * 另开一条问主进程的通道。内核把它取到最近的 2 的幂，标称 8 GB、系统只报 7.8 GB 的电脑照样算 8 GB，
 * 跟 device-profile.ts 不按 8 GB 划线是同一个道理。读不到（没有这个值的内核、单元测试里）照旧 1 GB。
 *
 * 这只是兜底：导入本地长视频开工前，要改成主进程按需读片段、成片直接写临时文件，不再整段攒在内存里。
 */
export function videoStudioTotalBytesLimit(deviceMemoryGigabytes: unknown = readDeviceMemoryGigabytes()): number {
  if (typeof deviceMemoryGigabytes !== 'number' || !Number.isFinite(deviceMemoryGigabytes) || deviceMemoryGigabytes <= 0) return maxVideoStudioTotalBytes
  const share = Math.floor(deviceMemoryGigabytes * 1024 / 8) * megabyte
  return Math.min(maxVideoStudioTotalBytes, Math.max(minVideoStudioTotalBytes, share))
}

// 还是原来那句话，只是数跟着上限走：1 GB、512 MB、256 MB。
function videoStudioTotalTooLargeMessage(limit: number): string {
  const size = limit % gigabyte === 0 ? `${limit / gigabyte} GB` : `${Math.floor(limit / megabyte)} MB`
  return `片段总大小超过 ${size}，请减少片段后再合成`
}

function isComposeStage(value: unknown): value is VideoStudioComposeStage {
  return typeof value === 'string' && (composeStages as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalSeconds(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new VideoStudioError(`${label}的裁剪时间无效`)
  return value
}

function optionalGain(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new VideoStudioError(videoStudioComposeGlitchMessage)
  return value
}

function parseMusic(value: unknown): VideoStudioComposeMusic | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value) || !(value.data instanceof ArrayBuffer) || value.data.byteLength === 0) throw new VideoStudioError(videoStudioMusicUnreadableMessage)
  if (value.data.byteLength > maxVideoStudioMusicBytes) throw new VideoStudioError(videoStudioMusicUnreadableMessage)
  const gain = optionalGain(value.gain)
  if (gain === undefined) throw new VideoStudioError(videoStudioComposeGlitchMessage)
  return { data: value.data, gain }
}

function parseCodecList<T>(value: unknown, guard: (item: unknown) => item is T): readonly T[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || !value.every(guard)) throw new VideoStudioError(videoStudioComposeGlitchMessage)
  return value
}

export function parseVideoStudioComposeRequest(value: unknown, totalBytesLimit = videoStudioTotalBytesLimit()): VideoStudioComposeRequest {
  if (!isRecord(value) || !Array.isArray(value.clips) || !isRecord(value.options)) throw new VideoStudioError(videoStudioComposeGlitchMessage)
  const { aspect, resolution, fit, frameRate, transition, fadeOut, captionSize, captionPosition } = value.options
  if (!isVideoStudioAspect(aspect) || !isVideoStudioResolution(resolution) || !isVideoStudioFit(fit) || !isVideoStudioFrameRate(frameRate)
    || (transition !== undefined && !isVideoStudioTransition(transition)) || (fadeOut !== undefined && typeof fadeOut !== 'boolean')
    || (captionSize !== undefined && !isVideoStudioCaptionSize(captionSize)) || (captionPosition !== undefined && !isVideoStudioCaptionPosition(captionPosition))) {
    throw new VideoStudioError('成片的画面设置无效')
  }
  if (value.clips.length === 0) throw new VideoStudioError('至少需要一段片段才能合成成片')
  if (value.clips.length > maxVideoStudioClips) throw new VideoStudioError(`一次最多拼 ${maxVideoStudioClips} 段片段`)
  let totalBytes = 0
  const clips = value.clips.map((clip: unknown, index): VideoStudioComposeClip => {
    const label = `第 ${index + 1} 段`
    if (!isRecord(clip) || !(clip.data instanceof ArrayBuffer) || clip.data.byteLength === 0) {
      throw new VideoStudioError(`${label}片段是空的`)
    }
    if (clip.data.byteLength > maxVideoStudioClipBytes) throw new VideoStudioError(`${label}片段过大，单段最大 512 MB`)
    totalBytes += clip.data.byteLength
    if (clip.caption !== undefined && (typeof clip.caption !== 'string' || clip.caption.length > maxRawCaptionLength)) {
      throw new VideoStudioError(`${label}的字幕过长，最多 ${maxVideoStudioCaptionLength} 个字`)
    }
    return {
      data: clip.data,
      trimStart: optionalSeconds(clip.trimStart, label),
      trimEnd: optionalSeconds(clip.trimEnd, label),
      caption: clip.caption,
    }
  })
  if (totalBytes > totalBytesLimit) throw new VideoStudioError(videoStudioTotalTooLargeMessage(totalBytesLimit))
  let encoding: VideoStudioEncodingPreference | undefined
  if (value.encoding !== undefined) {
    if (!isRecord(value.encoding)) throw new VideoStudioError(videoStudioComposeGlitchMessage)
    encoding = { video: parseCodecList(value.encoding.video, isVideoStudioVideoCodec), audio: parseCodecList(value.encoding.audio, isVideoStudioAudioCodec) }
  }
  const music = parseMusic(value.music)
  const clipGain = optionalGain(value.clipGain)
  const options = {
    aspect, resolution, fit, frameRate, ...(transition === 'fade' ? { transition } : {}), ...(fadeOut ? { fadeOut } : {}),
    ...(captionSize && captionSize !== 'medium' ? { captionSize } : {}), ...(captionPosition && captionPosition !== 'bottom' ? { captionPosition } : {}),
  }
  return { clips, options, encoding, ...(music ? { music } : {}), ...(clipGain === undefined ? {} : { clipGain }) }
}

/**
 * 页面读片段时边读边加（useVideoStudio.ts）：加起来超过拼片线程收得下的总量就停在这一段，报和线程同一句话，
 * 不把剩下的也读进来、全攒在内存里再被线程拒掉。回加上这一段以后的总数。
 * 上限缺省跟拼片线程一样按本机内存算（videoStudioTotalBytesLimit），两边读的是同一个数。
 */
export function addVideoStudioClipBytes(totalBytes: number, clipBytes: number, totalBytesLimit = videoStudioTotalBytesLimit()): number {
  const next = totalBytes + clipBytes
  if (next > totalBytesLimit) throw new VideoStudioError(videoStudioTotalTooLargeMessage(totalBytesLimit))
  return next
}

export function parseVideoStudioWorkerMessage(value: unknown): VideoStudioWorkerMessage {
  if (!isRecord(value) || value.kind !== 'compose') throw new VideoStudioError('合成任务收到无法识别的消息')
  return { kind: 'compose', request: parseVideoStudioComposeRequest(value.request) }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// 回包来自自家的后台线程，但页面照样按白名单读：读不懂的整条丢掉，交给调用方报错。
export function parseVideoStudioWorkerReply(value: unknown): VideoStudioWorkerReply | null {
  if (!isRecord(value)) return null
  if (value.kind === 'progress') {
    const progress = value.progress
    if (!isRecord(progress) || !isComposeStage(progress.stage) || !isFiniteNumber(progress.ratio)) return null
    return { kind: 'progress', progress: { stage: progress.stage, ratio: Math.min(1, Math.max(0, progress.ratio)) } }
  }
  if (value.kind === 'done') {
    const result = value.result
    if (!isRecord(result) || !(result.data instanceof ArrayBuffer) || typeof result.mimeType !== 'string') return null
    if (!isVideoStudioVideoCodec(result.videoCodec) || !(result.audioCodec === null || isVideoStudioAudioCodec(result.audioCodec))) return null
    if (!isFiniteNumber(result.width) || !isFiniteNumber(result.height) || !isFiniteNumber(result.duration)) return null
    return {
      kind: 'done',
      result: { data: result.data, mimeType: result.mimeType, videoCodec: result.videoCodec, audioCodec: result.audioCodec, width: result.width, height: result.height, duration: result.duration },
    }
  }
  if (value.kind === 'failed') {
    if (typeof value.message !== 'string' || !value.message) return null
    return { kind: 'failed', message: value.message, detail: typeof value.detail === 'string' ? value.detail : undefined }
  }
  return null
}
