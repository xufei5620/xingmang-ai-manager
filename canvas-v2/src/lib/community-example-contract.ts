import { workshopText } from './workshop-sanitizer'

export const maximumCommunityExampleImages = 7
export const maximumCommunityExampleImageBytes = 8 * 1024 * 1024
export const maximumCommunityExampleGalleryBytes = 32 * 1024 * 1024
export interface CommunityExampleSelection { version: 1; items: Array<{ assetId: string; alt: string }> }
export interface CommunityExampleImage { id: string; sha256: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; byteSize: number; width: number; height: number; alt: string }
export interface CommunityExampleGallery { version: 1; items: CommunityExampleImage[] }

function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(); return value as Record<string, unknown> }
function invalid(): never { throw new Error('公开样图资料不完整，请重新选择并核对发布预览') }
function keys(value: Record<string, unknown>, allowed: string[]) { if (Object.keys(value).length !== allowed.length || Object.keys(value).some((key) => !allowed.includes(key))) invalid() }
function items(value: unknown): unknown[] { if (!Array.isArray(value) || !value.length || value.length > maximumCommunityExampleImages) invalid(); return value }
function alt(value: unknown): string { if (typeof value !== 'string' || value.length > 200 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid(); return workshopText(value, '样图说明', 200, true) }
function digest(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(); return value }

export function parseCommunityExampleSelection(value: unknown): CommunityExampleSelection {
  const v = object(value); keys(v, ['version', 'items']); if (v.version !== 1) invalid()
  const parsed = items(v.items).map((entry) => { const item = object(entry); keys(item, ['assetId', 'alt']); if (typeof item.assetId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(item.assetId)) invalid(); return { assetId: item.assetId, alt: alt(item.alt) } })
  if (new Set(parsed.map((item) => item.assetId)).size !== parsed.length) throw new Error('同一张素材只能选择一次，请移除重复样图')
  return { version: 1, items: parsed }
}

/** Public presentation descriptors never contain the original asset ID or URL. */
export function parseCommunityExampleGallery(value: unknown): CommunityExampleGallery {
  const v = object(value); keys(v, ['version', 'items']); if (v.version !== 1) invalid()
  const parsed = items(v.items).map((entry): CommunityExampleImage => {
    const item = object(entry); keys(item, ['id', 'sha256', 'mimeType', 'byteSize', 'width', 'height', 'alt'])
    const id = digest(item.id), sha256 = digest(item.sha256)
    if (id !== sha256 || item.mimeType !== 'image/png' && item.mimeType !== 'image/jpeg' && item.mimeType !== 'image/webp') invalid()
    if (!Number.isSafeInteger(item.byteSize) || Number(item.byteSize) < 1 || Number(item.byteSize) > maximumCommunityExampleImageBytes || !Number.isSafeInteger(item.width) || Number(item.width) < 1 || Number(item.width) > 16384 || !Number.isSafeInteger(item.height) || Number(item.height) < 1 || Number(item.height) > 16384 || Number(item.width) * Number(item.height) > 100_000_000) invalid()
    return { id, sha256, mimeType: item.mimeType, byteSize: Number(item.byteSize), width: Number(item.width), height: Number(item.height), alt: alt(item.alt) }
  })
  if (new Set(parsed.map((item) => item.id)).size !== parsed.length || parsed.reduce((sum, item) => sum + item.byteSize, 0) > maximumCommunityExampleGalleryBytes) invalid()
  return { version: 1, items: parsed }
}
