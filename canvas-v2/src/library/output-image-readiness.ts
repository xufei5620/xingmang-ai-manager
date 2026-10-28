import { resolveCanvasAssetDisplayUrl } from '../asset-display-url'
import type { CanvasImageAssetSummary } from '../host'

/** Decode the actual owner-scoped content before claiming a usable snapshot. */
export function verifyOutputImageReadable(asset: CanvasImageAssetSummary, signal: AbortSignal): Promise<void> {
  const url = /^xingmang-asset:\/\/image\/[A-Za-z0-9_-]{43}$/.test(asset.localUrl) ? resolveCanvasAssetDisplayUrl(asset.localUrl) : undefined
  if (!url || asset.deletedAt) return Promise.reject(new Error('图片成品不可读取，请先在素材库中核对'))
  return new Promise((resolve, reject) => {
    const image = new Image()
    let finished = false
    const timer = window.setTimeout(() => settle(new Error('图片成品读取超时，请重试；已保存的成品仍在素材库')), 25_000)
    function settle(error?: Error) {
      if (finished) return
      finished = true
      window.clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      image.onload = null
      image.onerror = null
      image.src = ''
      if (error) reject(error)
      else resolve()
    }
    function abort() { settle(new Error('图片成品读取已停止')) }
    image.onload = () => image.naturalWidth > 0 && image.naturalHeight > 0 && image.naturalWidth === asset.width && image.naturalHeight === asset.height
      ? settle() : settle(new Error('图片成品的实际尺寸与保存记录不一致，请在素材库中核对'))
    image.onerror = () => settle(new Error('图片成品内容不可读取，请在素材库中核对后重试'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else image.src = url
  })
}
