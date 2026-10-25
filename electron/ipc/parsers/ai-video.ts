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
