import { generatedImageInfo } from './generation-protocol'
import { generatedVideoInfo } from './video-request-protocol'

export type ProjectMediaType = 'image' | 'video' | 'audio'
export type ProjectMediaMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'video/mp4' | 'audio/mpeg' | 'audio/wav'
export interface ProjectMediaInfo { mediaType: ProjectMediaType; mimeType: ProjectMediaMimeType; extension: string; width?: number; height?: number; durationSeconds?: number }
export const maximumProjectMediaBytes = 32 * 1024 * 1024

export function projectMediaTypeForMime(value: unknown): ProjectMediaType | undefined {
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/webp') return 'image'
  if (value === 'video/mp4') return 'video'
  if (value === 'audio/mpeg' || value === 'audio/wav') return 'audio'
  return undefined
}
export function isProjectMediaFileName(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 160 && value === value.trim() && !/[\\/\x00-\x1f\x7f]/.test(value) && value !== '.' && value !== '..' }
function invalid(): never { throw new Error('音频容器结构不完整或编码不受支持；请使用完整 MP3 或 PCM/浮点 WAV 原文件') }
function ascii(bytes: Uint8Array, start: number, size: number): string { return String.fromCharCode(...bytes.subarray(start, start + size)) }

/** Container/frame validation only; no decoding, transcoding, or synthesized metadata. */
function audioInfo(bytes: Uint8Array, mime: 'audio/wav' | 'audio/mpeg'): ProjectMediaInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mime === 'audio/wav') {
    if (bytes.length < 44 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.length) invalid()
    let offset = 12, chunks = 0, dataBytes = 0, byteRate = 0, blockAlign = 0, formatSeen = false
    while (offset < bytes.length) {
      if (++chunks > 10_000 || offset + 8 > bytes.length) invalid()
      const name = ascii(bytes, offset, 4), size = view.getUint32(offset + 4, true), start = offset + 8, end = start + size
      if (end + (size % 2) > bytes.length) invalid()
      if (name === 'fmt ') {
        if (formatSeen || size < 16) invalid()
        formatSeen = true
        let format = view.getUint16(start, true)
        const channels = view.getUint16(start + 2, true), sampleRate = view.getUint32(start + 4, true), bits = view.getUint16(start + 14, true)
        byteRate = view.getUint32(start + 8, true); blockAlign = view.getUint16(start + 12, true)
        if (size > 16 && (size < 18 || view.getUint16(start + 16, true) + 18 > size)) invalid()
        if (format === 0xfffe) {
          if (size < 40 || view.getUint16(start + 16, true) < 22 || view.getUint16(start + 18, true) < 1 || view.getUint16(start + 18, true) > bits) invalid()
          const tail = [0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]
          if (!tail.every((value, index) => bytes[start + 28 + index] === value)) invalid()
          format = view.getUint32(start + 24, true)
        }
        if (![1, 3].includes(format) || channels < 1 || channels > 32 || sampleRate < 1 || sampleRate > 384_000 || ![8, 16, 24, 32, 64].includes(bits) || format === 3 && ![32, 64].includes(bits) || blockAlign !== channels * bits / 8 || byteRate !== sampleRate * blockAlign) invalid()
      } else if (name === 'data') {
        if (dataBytes || !size) invalid()
        dataBytes = size
      }
      offset = end + (size % 2)
    }
    if (!formatSeen || !dataBytes || dataBytes % blockAlign) invalid()
    return { mediaType: 'audio', mimeType: mime, extension: 'wav', durationSeconds: dataBytes / byteRate }
  }
  let offset = 0, end = bytes.length, frames = 0, duration = 0, streamVersion = -1, streamRate = -1
  if (ascii(bytes, 0, 3) === 'ID3') {
    if (bytes.length < 10 || ![2, 3, 4].includes(bytes[3]) || bytes[4] === 255 || bytes.subarray(6, 10).some((byte) => byte > 127)) invalid()
    const length = bytes[6] * 0x200000 + bytes[7] * 0x4000 + bytes[8] * 128 + bytes[9]
    const footer = bytes[3] === 4 && (bytes[5] & 16) !== 0 ? 10 : 0
    offset = 10 + length + footer
    if (offset > end || footer && ascii(bytes, offset - 10, 3) !== '3DI') invalid()
  }
  if (end >= 128 && ascii(bytes, end - 128, 3) === 'TAG') end -= 128
  while (offset < end) {
    if (++frames > 1_000_000 || offset + 4 > end) invalid()
    const b = bytes[offset + 1], c = bytes[offset + 2], d = bytes[offset + 3]
    const version = (b >> 3) & 3, layer = (b >> 1) & 3, rateIndex = (c >> 2) & 3, bitrateIndex = c >> 4
    if (bytes[offset] !== 255 || (b & 0xe0) !== 0xe0 || version === 1 || layer !== 1 || rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15 || (d & 3) === 2) invalid()
    const rate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4)
    const bitrate = (version === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bitrateIndex] * 1000
    const length = Math.floor((version === 3 ? 144 : 72) * bitrate / rate) + ((c >> 1) & 1)
    if (offset + length > end || length < 4 + ((b & 1) ? 0 : 2) + (version === 3 ? ((d >> 6) === 3 ? 17 : 32) : ((d >> 6) === 3 ? 9 : 17)) || frames > 1 && (version !== streamVersion || rate !== streamRate)) invalid()
    streamVersion = version; streamRate = rate
    duration += (version === 3 ? 1152 : 576) / rate
    offset += length
  }
  if (!frames || !Number.isFinite(duration) || duration <= 0) invalid()
  // Frame duration includes encoder delay/padding and may include an Info/Xing
  // metadata frame. Without a decoded gapless timeline, omit playback duration.
  return { mediaType: 'audio', mimeType: mime, extension: 'mp3' }
}

export function projectMediaInfo(bytes: Uint8Array, declaredMime: string): ProjectMediaInfo {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > maximumProjectMediaBytes) throw new Error('素材原文件必须非空且不超过 32 MB')
  const mediaType = projectMediaTypeForMime(declaredMime)
  if (mediaType === 'image') {
    const info = generatedImageInfo(bytes, maximumProjectMediaBytes)
    if (info.mimeType !== declaredMime) throw new Error('图片实际类型与清单不一致')
    return { ...info, mediaType }
  }
  if (mediaType === 'video') {
    try {
      const info = generatedVideoInfo(bytes, declaredMime)
      if (info.width !== undefined && info.width > 16384 || info.height !== undefined && info.height > 16384 || info.width !== undefined && info.height !== undefined && info.width * info.height > 32_000_000) throw new Error('视频像素预算超限')
      return { ...info, mediaType, extension: 'mp4' }
    } catch { throw new Error('MP4 原文件容器不完整、不受支持或超过 16384 边长 / 3200 万像素；没有转码或替换原文件') }
  }
  if (declaredMime === 'audio/wav' || declaredMime === 'audio/mpeg') return audioInfo(bytes, declaredMime)
  throw new Error('便携包仅支持 PNG、JPEG、WebP、MP4、MP3 和 PCM/浮点 WAV 原文件')
}
