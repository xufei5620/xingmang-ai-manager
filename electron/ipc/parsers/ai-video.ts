// 主窗口出视频片段、视频剪辑页分镜和存成片这几条通道的入参（I5）。出片段的请求和画布共用一份解析
// （canvas-request-parser.ts 的 parseVideoGenerateInput），这里是剩下几条。
import { isRecord } from '../../input-guards'
import { parseVideoGenerateInput } from '../../canvas-request-parser'
import type { AiVideoGenerationInput } from '../../ai-video-service'
import type { VideoStudioPlanInput } from '../../ipc-contract'
import { videoStudioPlanLimits, type VideoStudioPlanAspect } from '../../video-studio-plan'
import { requiredString } from './common'

// 和作品库一样的上限（ai-video-asset-store.ts）：成片要存进同一处。
export const maximumVideoStudioExportBytes = 512 * 1024 * 1024

const assetIdPattern = /^[A-Za-z0-9_-]{43}$/
const planFields = new Set(['requestId', 'group', 'model', 'idea', 'shotCount', 'secondsPerShot', 'aspect', 'captions'])

function isPlanAspect(value: unknown): value is VideoStudioPlanAspect {
  return value === '16:9' || value === '9:16' || value === '1:1'
}

export function parseAiVideoGenerateInput(value: unknown): AiVideoGenerationInput {
  return parseVideoGenerateInput(value, { video: '视频', miniMax: 'MiniMax', references: 'images' })
}

export function parseAiVideoAssetId(value: unknown): string {
  if (typeof value !== 'string' || !assetIdPattern.test(value)) throw new Error('视频编号格式错误')
  return value
}

// 文件名里 Windows 不认的字、控制字符和改写显示方向的那几个（防「片名.mp4」显示成别的扩展名）。
const unsafeFileNameCharacters = /[\u0000-\u001f\u007f<>:"/\\|?*\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
// Windows 的保留名：点前面那一截是它们的，整个文件名都不能用（CON.mp4 也不行）。
const reservedWindowsFileNames = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
export const maximumVideoSaveNameLength = 80

/**
 * 另存成片时系统对话框里默认的文件名（视频剪辑页传片名）。它只是对话框的默认值，存到哪儿仍由用户在系统对话框里点、
 * 落盘照旧走原子写；这里只收一个干净的文件名：路径分隔符和 Windows 不认的字换成空格，去掉首尾的点和空白，
 * 最长 80 个字，接上 .mp4。洗完是空的、是 Windows 保留名就不用（交回 undefined，用作品库里原来的名字）。
 */
export function parseVideoSaveName(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 200) throw new Error('另存的文件名格式错误')
  const cleaned = value.replace(unsafeFileNameCharacters, ' ').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '')
  const name = Array.from(cleaned).slice(0, maximumVideoSaveNameLength).join('').replace(/[\s.]+$/, '')
  if (!name || reservedWindowsFileNames.test(name.split('.')[0].trim())) return undefined
  return `${name}.mp4`
}

export function parseAiAudioAssetId(value: unknown): string {
  if (typeof value !== 'string' || !assetIdPattern.test(value)) throw new Error('音频编号格式错误')
  return value
}

function wholeNumberBetween(value: unknown, minimum: number, maximum: number, message: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(message)
  return value
}

export function parseVideoStudioPlanInput(value: unknown): VideoStudioPlanInput {
  if (!isRecord(value)) throw new Error('分镜请求格式错误')
  if (Object.keys(value).some((key) => !planFields.has(key))) throw new Error('分镜请求包含未知字段')
  const { maximumIdeaLength, minimumShots, maximumShots, minimumSecondsPerShot, maximumSecondsPerShot } = videoStudioPlanLimits
  // 想法是多行输入框里打的字，换行和制表照收，别的控制字符拒掉。
  if (typeof value.idea !== 'string' || !value.idea.trim() || value.idea.length > maximumIdeaLength
    || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value.idea)) {
    throw new Error(`想法要写 1 到 ${maximumIdeaLength} 个字`)
  }
  const aspect = value.aspect
  if (!isPlanAspect(aspect)) throw new Error('成片画面比例不受支持')
  if (typeof value.captions !== 'boolean') throw new Error('字幕开关格式错误')
  return {
    requestId: requiredString(value.requestId, '分镜请求标识', 160),
    group: requiredString(value.group, '分镜分组', 128),
    model: requiredString(value.model, '分镜模型', 128),
    idea: value.idea,
    shotCount: wholeNumberBetween(value.shotCount, minimumShots, maximumShots, `镜头数要在 ${minimumShots} 到 ${maximumShots} 个之间`),
    secondsPerShot: wholeNumberBetween(value.secondsPerShot, minimumSecondsPerShot, maximumSecondsPerShot,
      `每个镜头要在 ${minimumSecondsPerShot} 到 ${maximumSecondsPerShot} 秒之间`),
    aspect,
    captions: value.captions,
  }
}

/**
 * 页面拼好的成片字节（渲染层的 Uint8Array 过 IPC 到这边还是 Uint8Array，几百 MB 也一次过得来）。
 * 是不是 MP4 由作品库按文件头再核一遍。
 */
export function parseVideoStudioExportBytes(value: unknown): Buffer {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value
  if (!(bytes instanceof Uint8Array)) throw new Error('成片内容格式错误')
  if (bytes.byteLength === 0) throw new Error('成片是空的，请重新导出')
  if (bytes.byteLength > maximumVideoStudioExportBytes) throw new Error('成片超过 512 MB，存不进作品库；调低清晰度或少放几段再试')
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}
