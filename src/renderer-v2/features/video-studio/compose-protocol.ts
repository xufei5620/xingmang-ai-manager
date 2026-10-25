import { isVideoStudioAudioCodec, isVideoStudioVideoCodec, type VideoStudioAudioCodec, type VideoStudioEncodingPreference, type VideoStudioVideoCodec } from './encoding'
import { VideoStudioError } from './errors'
import {
  isVideoStudioAspect,
  isVideoStudioFit,
  isVideoStudioFrameRate,
  isVideoStudioResolution,
  maxVideoStudioCaptionLength,
  maxVideoStudioClips,
  type VideoStudioRenderOptions,
} from './timeline'

// 片段整段读进内存再拼，所以要给总量设个顶：一段 AI 片段只有几 MB，这两个数是给
// 以后导入本地长视频留的余量，又不至于让一个窗口吃掉几 GB 内存。
export const maxVideoStudioClipBytes = 512 * 1024 * 1024
export const maxVideoStudioTotalBytes = 1024 * 1024 * 1024

export interface VideoStudioComposeClip {
  /** 片段文件的全部字节（MP4 / MOV / WebM）。交给后台线程时会被转移走，调用方之后不能再用。 */
  data: ArrayBuffer
  trimStart?: number
  trimEnd?: number
  caption?: string
}

export interface VideoStudioComposeRequest {
  clips: VideoStudioComposeClip[]
  options: VideoStudioRenderOptions
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

function isComposeStage(value: unknown): value is VideoStudioComposeStage {
  return typeof value === 'string' && (composeStages as readonly string[]).includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalSeconds(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new VideoStudioError(`${label}的剪切时间不对`)
  return value
}

function parseCodecList<T>(value: unknown, guard: (item: unknown) => item is T): readonly T[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || !value.every(guard)) throw new VideoStudioError('指定的编码器不对')
  return value
}

export function parseVideoStudioComposeRequest(value: unknown): VideoStudioComposeRequest {
  if (!isRecord(value) || !Array.isArray(value.clips) || !isRecord(value.options)) throw new VideoStudioError('拼片请求的格式不对')
  const { aspect, resolution, fit, frameRate } = value.options
  if (!isVideoStudioAspect(aspect) || !isVideoStudioResolution(resolution) || !isVideoStudioFit(fit) || !isVideoStudioFrameRate(frameRate)) {
    throw new VideoStudioError('成片的画面设置不对')
  }
  if (value.clips.length === 0) throw new VideoStudioError('至少要放一段片段才能拼成片')
  if (value.clips.length > maxVideoStudioClips) throw new VideoStudioError(`一次最多拼 ${maxVideoStudioClips} 段片段`)
  let totalBytes = 0
  const clips = value.clips.map((clip: unknown, index): VideoStudioComposeClip => {
    const label = `第 ${index + 1} 段`
    if (!isRecord(clip) || !(clip.data instanceof ArrayBuffer) || clip.data.byteLength === 0) {
      throw new VideoStudioError(`${label}片段是空的`)
    }
    if (clip.data.byteLength > maxVideoStudioClipBytes) throw new VideoStudioError(`${label}片段太大了，一段最多 512 MB`)
    totalBytes += clip.data.byteLength
    if (clip.caption !== undefined && (typeof clip.caption !== 'string' || clip.caption.length > maxRawCaptionLength)) {
      throw new VideoStudioError(`${label}的字幕太长了，最多 ${maxVideoStudioCaptionLength} 个字`)
    }
    return {
      data: clip.data,
      trimStart: optionalSeconds(clip.trimStart, label),
      trimEnd: optionalSeconds(clip.trimEnd, label),
      caption: clip.caption,
    }
  })
  if (totalBytes > maxVideoStudioTotalBytes) throw new VideoStudioError('片段加起来超过 1 GB 了，少放几段再拼')
  let encoding: VideoStudioEncodingPreference | undefined
  if (value.encoding !== undefined) {
    if (!isRecord(value.encoding)) throw new VideoStudioError('指定的编码器不对')
    encoding = { video: parseCodecList(value.encoding.video, isVideoStudioVideoCodec), audio: parseCodecList(value.encoding.audio, isVideoStudioAudioCodec) }
  }
  return { clips, options: { aspect, resolution, fit, frameRate }, encoding }
}

export function parseVideoStudioWorkerMessage(value: unknown): VideoStudioWorkerMessage {
  if (!isRecord(value) || value.kind !== 'compose') throw new VideoStudioError('拼片线程收到了看不懂的消息')
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
