import { isMediaSourceKind } from './port-geometry'

const mediaResultKinds = new Set([
  'image',
  'image-generate',
  'image-edit',
  'video',
  'video-generate',
])

/** 生成/编辑节点用媒体盒子：有产物看图，没有就显示「待生成」。 */
export function isMediaResultKind(kind: string): boolean {
  return mediaResultKinds.has(kind)
}

export function usesMediaBoundLayout(kind: string, assetId?: string | null): boolean {
  if (isMediaResultKind(kind)) return true
  return Boolean(assetId) && isMediaSourceKind(kind)
}

export function mediaBoundChipKind(kind: string): 'image' | 'video' | 'audio' {
  if (kind === 'video-input' || kind === 'video' || kind === 'video-generate') return 'video'
  if (kind === 'audio-input') return 'audio'
  return 'image'
}

export function mediaBoundChipLabel(kind: string): string {
  if (isMediaResultKind(kind)) {
    return mediaBoundChipKind(kind) === 'video' ? '视频节点' : '图像节点'
  }
  const media = mediaBoundChipKind(kind)
  return media === 'video' ? '视频' : media === 'audio' ? '音频' : '图像'
}
