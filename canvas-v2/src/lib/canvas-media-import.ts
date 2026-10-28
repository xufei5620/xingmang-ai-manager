import type { CanvasAssetSummary } from '../host'
import { assetCategoryUrlValue, isAssetCategoryId, type AssetCategoryUploadTarget } from './asset-category-contract'

export const maximumCanvasMediaFileBytes = 32 * 1024 * 1024
export const maximumCanvasMediaFormBytes = 40 * 1024 * 1024

export type CanvasImportMediaType = 'image' | 'video' | 'audio'
export interface CanvasMediaImportOptions extends AssetCategoryUploadTarget { mediaType?: CanvasImportMediaType }
export interface CanvasImportMedia { mediaType: CanvasImportMediaType; mimeType: CanvasAssetSummary['mimeType'] }
export interface CanvasMediaUpload { body: Blob; contentType: string; media: CanvasImportMedia[] }

const mediaAccept = {
  image: 'image/png,image/jpeg,image/webp',
  video: 'video/mp4',
  audio: 'audio/mpeg,audio/wav',
}
const mp4VideoBrands = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V '])
const nonVideoBrands = new Set(['M4A ', 'M4B ', 'M4P ', 'heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis'])

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function boundedText(value: unknown, maximum: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value) }
function positiveDimension(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 100_000 }

export function canvasMediaFileAccept(mediaType?: CanvasImportMediaType): string {
  return mediaType ? mediaAccept[mediaType] : Object.values(mediaAccept).join(',')
}

export function resolveCanvasImportMedia(head: Uint8Array): CanvasImportMedia | null {
  if (head.length >= 4 && head[0] === 137 && head[1] === 80 && head[2] === 78 && head[3] === 71) return { mediaType: 'image', mimeType: 'image/png' }
  if (head.length >= 3 && head[0] === 255 && head[1] === 216 && head[2] === 255) return { mediaType: 'image', mimeType: 'image/jpeg' }
  const riff = head.length >= 12 && String.fromCharCode(...head.slice(0, 4)) === 'RIFF'
  if (riff && String.fromCharCode(...head.slice(8, 12)) === 'WEBP') return { mediaType: 'image', mimeType: 'image/webp' }
  if (head.length >= 16 && String.fromCharCode(...head.slice(4, 8)) === 'ftyp') {
    const size = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0)
    const brand = String.fromCharCode(...head.slice(8, 12))
    if (size < 16 || size > 4096 || size % 4 !== 0 || !mp4VideoBrands.has(brand)) return null
    for (let offset = 16; offset + 4 <= Math.min(size, head.length); offset += 4) {
      if (nonVideoBrands.has(String.fromCharCode(...head.slice(offset, offset + 4)))) return null
    }
    return { mediaType: 'video', mimeType: 'video/mp4' }
  }
  if (riff && String.fromCharCode(...head.slice(8, 12)) === 'WAVE') return { mediaType: 'audio', mimeType: 'audio/wav' }
  if ((head.length >= 3 && String.fromCharCode(...head.slice(0, 3)) === 'ID3') || (head.length >= 2 && head[0] === 255 && (head[1] & 224) === 224 && (head[1] & 6) !== 0 && (head[1] & 24) !== 8)) return { mediaType: 'audio', mimeType: 'audio/mpeg' }
  return null
}

export function canvasMediaExtension(mimeType: string): string | null {
  switch (mimeType.split(';', 1)[0].trim().toLowerCase()) {
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'video/mp4': return 'mp4'
    case 'audio/mpeg': return 'mp3'
    case 'audio/wav': return 'wav'
    default: return null
  }
}

export async function buildCanvasMediaUpload(files: readonly File[], projectId?: string | null, options: CanvasMediaImportOptions = {}): Promise<CanvasMediaUpload> {
  if (!files.length || files.length > 8) throw new Error('请一次选择 1–8 个素材')
  if (files.some((file) => !file.size)) throw new Error('素材文件为空，请重新选择文件')
  if (files.some((file) => file.size > maximumCanvasMediaFileBytes)) throw new Error('单个素材不能超过 32 MB')
  if (files.reduce((total, file) => total + file.size, 0) > maximumCanvasMediaFormBytes) throw new Error('一次上传请求不能超过 40 MB，请分批导入')
  if (projectId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) throw new Error('工程编号无效，请重新打开工程后导入素材')
  const form = new FormData()
  const media: CanvasImportMedia[] = []
  for (const file of files) {
    const actual = resolveCanvasImportMedia(new Uint8Array(await file.slice(0, 64).arrayBuffer()))
    if (!actual) throw new Error('支持 PNG、JPEG、WebP 图片，MP4 视频与 MP3、WAV 音频')
    if (options.mediaType && options.mediaType !== actual.mediaType) throw new Error(`该节点只接受${options.mediaType === 'video' ? 'MP4 视频' : options.mediaType === 'audio' ? 'MP3、WAV 音频' : 'PNG、JPEG、WebP 图片'}，请重新选择素材`)
    const fileName = file.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160) || `素材.${canvasMediaExtension(actual.mimeType)}`
    // Browsers may omit or misidentify a file MIME type. The server checks the
    // signature again; send the detected type so an owned MP4 stays a video.
    form.append('file', new Blob([file], { type: actual.mimeType }), fileName)
    media.push(actual)
  }
  if (projectId) form.append('projectId', projectId)
  const categoryValue = assetCategoryUrlValue(options.categoryId)
  if (options.categoryId != null) {
    if (!isAssetCategoryId(options.categoryId) || typeof options.expectedCategoryVersion !== 'number' || !Number.isSafeInteger(options.expectedCategoryVersion) || options.expectedCategoryVersion < 1) throw new Error('上传分类版本无效，请刷新后重新选择')
    form.append('expectedCategoryVersion', String(options.expectedCategoryVersion))
  } else if (options.expectedCategoryVersion !== undefined) throw new Error('请先选择有效的上传分类')
  if (categoryValue !== undefined) form.append('categoryId', categoryValue)
  const response = new Response(form)
  const body = await response.blob()
  if (body.size > maximumCanvasMediaFormBytes) throw new Error('一次上传请求不能超过 40 MB（含文件表单），请分批导入')
  const contentType = response.headers.get('content-type')
  if (!contentType?.startsWith('multipart/form-data; boundary=')) throw new Error('浏览器无法准备素材上传，请重新选择文件')
  return { body, contentType, media }
}

export function isUploadedCanvasAsset(value: unknown, expected: CanvasImportMedia): value is CanvasAssetSummary {
  if (!record(value) || !boundedText(value.assetId, 43) || !/^[A-Za-z0-9_-]{43}$/.test(value.assetId)
    || value.mediaType !== expected.mediaType || value.mimeType !== expected.mimeType
    || value.localUrl !== `xingmang-asset://${expected.mediaType}/${value.assetId}`
    || !boundedText(value.fileName, 160) || !boundedText(value.createdAt, 64) || !Number.isFinite(Date.parse(value.createdAt))
    || (value.displayName !== undefined && !boundedText(value.displayName, 160))
    || value.deletedAt !== undefined || (value.source !== undefined && value.source !== 'imported')
    || (value.favorite !== undefined && typeof value.favorite !== 'boolean')
    || (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > 100 || !value.tags.every((tag) => boundedText(tag, 160))))) return false
  const thumbnail = value.thumbnailUrl
  if (thumbnail !== value.localUrl && thumbnail !== `xingmang-asset://thumbnail/${value.assetId}` && thumbnail !== `xingmang-asset://thumb/v1/${expected.mediaType}/${value.assetId}`) return false
  if (expected.mediaType === 'video' && !boundedText(value.taskId, 256)) return false
  if (value.width !== undefined && !positiveDimension(value.width)) return false
  if (value.height !== undefined && !positiveDimension(value.height)) return false
  if (value.durationSeconds !== undefined && (typeof value.durationSeconds !== 'number' || !Number.isFinite(value.durationSeconds) || value.durationSeconds < 0)) return false
  return true
}

export function isUploadedAssetCategoryTarget(value: unknown, target: AssetCategoryUploadTarget = {}): boolean {
  if (target.categoryId === undefined) return true
  return record(value) && value.categoryId === (target.categoryId === null ? null : target.categoryId.toLowerCase()) && value.organizationVersion === (target.categoryId === null ? 0 : 1)
}

export function parseCanvasMediaUploadResponse(value: unknown, expected: CanvasImportMedia, target: AssetCategoryUploadTarget = {}): CanvasAssetSummary {
  if (!record(value) || !Array.isArray(value.items) || value.items.length !== 1 || !isUploadedCanvasAsset(value.items[0], expected) || !isUploadedAssetCategoryTarget(value.items[0], target)) throw new Error('素材上传返回信息无法确认，请到素材库核对；系统不会自动再次上传')
  return value.items[0]
}
