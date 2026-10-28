export interface FrameEditorMetadata { duration: number; width: number; height: number }
export interface FrameEditorSelection { sourceAssetId: string; timestampSeconds: number }
export const frameEditorMaximumBytes = 32 * 1024 * 1024

export function validateFrameEditorBlob(blob: Blob): void {
  if (!(blob instanceof Blob) || blob.size <= 0 || blob.size > frameEditorMaximumBytes || blob.type !== 'video/mp4') throw new Error('请选择本账户可读取的 MP4 视频，单文件不超过 32 MB')
}

export function frameEditorMetadata(duration: number, width: number, height: number): FrameEditorMetadata {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 86_400) throw new Error('视频时长无法读取或超过 24 小时，请重新选择视频')
  if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0) || width > 4096 || height > 4096 || width * height > 16_777_216) throw new Error('视频尺寸无法读取或超过 4096 边长的抽帧预算')
  return { duration, width, height }
}

export function parseFrameEditorTimestamp(text: string, metadata: FrameEditorMetadata | null): { value: number | null; error: string } {
  if (!metadata) return { value: null, error: '正在读取视频，完成后可选择画面' }
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text.trim())) return { value: null, error: '请输入有效秒数，例如 1.25' }
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0 || value > 86_400) return { value: null, error: '抽帧时间点必须在 0 到 86400 秒之间' }
  if (value >= metadata.duration) return { value: null, error: '时间点必须小于当前视频时长，请重新选择画面' }
  return { value: Object.is(value, -0) ? 0 : value, error: '' }
}

/** End-of-file itself has no frame. This is a time step, never a frame-rate claim. */
export function frameEditorLastTimestamp(duration: number): number {
  return Math.max(0, Math.floor((duration - Math.min(.001, duration / 2)) * 1_000) / 1_000)
}

export function moveFrameEditorTimestamp(current: number, delta: number, metadata: FrameEditorMetadata): number {
  return Math.max(0, Math.min(frameEditorLastTimestamp(metadata.duration), Math.round((current + delta) * 1_000) / 1_000))
}

export function frameEditorSeconds(value: number): string { return Number.isFinite(value) ? String(Math.round(value * 1_000) / 1_000) : '0' }

export function frameEditorTimecode(seconds: number): string {
  const total = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1_000))
  const hours = Math.floor(total / 3_600_000), minutes = Math.floor(total / 60_000) % 60, whole = Math.floor(total / 1_000) % 60, fraction = total % 1_000
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(fraction).padStart(3, '0')}`
}

export function frameEditorSelectionMatches(left: FrameEditorSelection | null, right: FrameEditorSelection | null): boolean {
  return Boolean(left && right && left.sourceAssetId === right.sourceAssetId && left.timestampSeconds === right.timestampSeconds)
}

export function frameEditorComposing(event: { isComposing?: boolean; keyCode?: number }): boolean { return event.isComposing === true || event.keyCode === 229 }
