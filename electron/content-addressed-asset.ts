import path from 'node:path'
import { createHash } from 'node:crypto'

const assetIdPattern = /^[A-Za-z0-9_-]{43}$/

function assertContent(bytes: Buffer): void {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('媒体内容不能为空')
}

export function mediaContentDigest(bytes: Buffer): string {
  assertContent(bytes)
  return createHash('sha256').update(bytes).digest('base64url')
}

export function scopedLocalAssetId(outputRoot: string, userId: number, bytes: Buffer): string {
  if (typeof outputRoot !== 'string' || outputRoot.includes('\0')) throw new Error('媒体资产根目录无效')
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('媒体资产账号标识无效')
  assertContent(bytes)
  const assetId = createHash('sha256')
    .update('xingmang-local-asset-v1\0', 'utf8')
    .update(path.resolve(outputRoot), 'utf8')
    .update('\0', 'utf8')
    .update(String(userId), 'utf8')
    .update('\0', 'utf8')
    .update(bytes)
    .digest('base64url')
  if (!assetIdPattern.test(assetId)) throw new Error('媒体内容资产标识无效')
  return assetId
}
