// 批量素材的编号和可用性核对，画布内核和网页都用；读详情、打包下载要连站点，留在 asset-batch-export（#3）。
import type { CanvasListedAssetSummary } from '../host'
import { canvasMediaExtension } from './canvas-media-import'

export function validateAssetBatchIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 50 || value.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) || new Set(value).size !== value.length) throw new Error('请选择 1–50 项不同的已保存素材')
  return [...value]
}

export function assertBatchAssetAvailable(asset: CanvasListedAssetSummary): void {
  if (asset.deletedAt || asset.localUrl !== `xingmang-asset://${asset.mediaType}/${asset.assetId}` || !canvasMediaExtension(asset.mimeType)) throw new Error('素材已回收或原文件不可用，请先到素材库核对')
}
