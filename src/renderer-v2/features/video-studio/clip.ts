import { assetThumbnailUrl } from '../../../../electron/asset-thumbnail'
import type { AiVideoClip } from '../../../../electron/ipc-contract'

// 存着的一段视频读回来。视频工作台的镜头和对话里出的视频（chat/storage.ts）用同一份；单独一个文件，
// 只依赖主进程那两个零依赖模块，对话的存盘那一层引它不会绕回 project.ts。

const assetIdPattern = /^[A-Za-z0-9_-]{43}$/
const requestIdPattern = /^[A-Za-z0-9-]{1,64}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readPositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** 存着的视频请求号：只收页面自己起的那种（crypto.randomUUID），别的当没有。 */
export function readVideoRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && requestIdPattern.test(value) ? value : undefined
}

export function readVideoClip(value: unknown): AiVideoClip | undefined {
  if (!isRecord(value) || typeof value.assetId !== 'string' || !assetIdPattern.test(value.assetId)) return undefined
  // 缩略图地址只收主进程给的那种（electron/asset-thumbnail.ts），而且要是同一段视频的。存着的地址带着当时的版本号，
  // 缩略图一升版主进程就不认旧的了（回 404，镜头上全是裂图），所以按编号换成现在的版本再用。
  if (typeof value.thumbnailUrl !== 'string' || !/^xingmang-asset:\/\/thumb\/v[0-9]{1,4}\/video\/[A-Za-z0-9_-]{43}$/.test(value.thumbnailUrl) || !value.thumbnailUrl.endsWith(`/${value.assetId}`)) return undefined
  const width = readPositive(value.width), height = readPositive(value.height), durationSeconds = readPositive(value.durationSeconds)
  return {
    assetId: value.assetId, thumbnailUrl: assetThumbnailUrl(value.assetId, 'video'),
    ...(width ? { width } : {}), ...(height ? { height } : {}), ...(durationSeconds ? { durationSeconds } : {}),
  }
}

/** 页面里直接放这一段用的地址（主窗口只放得了作品库里当前账号的音视频，见 electron/app-protocol.ts 的 media-src）。 */
export function videoClipPlayUrl(assetId: string): string {
  return `xingmang-asset://video/${assetId}`
}
