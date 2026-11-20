import { useState } from 'react'
import { assetLargeImageThumbnailUrl, assetThumbnailLargeMaxEdge } from '../../../../electron/asset-thumbnail'
import type { AiChatAsset } from '../../../../electron/ipc-contract'

export type ChatImageAsset = Pick<AiChatAsset, 'assetId' | 'localUrl' | 'mimeType' | 'width' | 'height'>

// 对话里的格子最大 300 见方（chat.css 的 .chat-asset-preview），输入框上的小格子 64 见方，都用不着把 2K、4K 的原图
// 整张解开（总单 78 R-2）：先放主进程缩到 768 的那张（electron/asset-thumbnail.ts，高分屏上也不糊），点开大图才读原图。
// 不换的三种：不是星芒存的图（测试夹具的地址）；WebP（有的电脑上主进程解不开，每次都白读一遍原图再退回来）；
// 原图本来就不比那一档大。
export function chatImageThumbnailUrl(asset: ChatImageAsset): string | null {
  if (asset.localUrl !== `xingmang-asset://image/${asset.assetId}`) return null
  if (asset.mimeType === 'image/webp') return null
  if (asset.width && asset.height && Math.max(asset.width, asset.height) <= assetThumbnailLargeMaxEdge) return null
  return assetLargeImageThumbnailUrl(asset.assetId)
}

// skipped 是这一格已经出过错的缩略图地址：缩好的那张出不来（缓存被清了、解不开）就退回原图。
export function chatImageSource(asset: ChatImageAsset, skipped: string): string {
  const thumbnail = chatImageThumbnailUrl(asset)
  return thumbnail && thumbnail !== skipped ? thumbnail : asset.localUrl
}

// 原图也打不开才算图片不见了：标上 data-failed，给了 missingAlt 就把替代文字换成它。
export function ChatImage({ asset, alt, missingAlt }: { asset: ChatImageAsset; alt: string; missingAlt?: string }) {
  const [skipped, setSkipped] = useState('')
  const src = chatImageSource(asset, skipped)
  // 宽高先占好位置：往上翻到才加载（loading="lazy"），没有它们时一屏几十张空图挤在一起，会被当成都看得见一起读。
  return <img src={src} alt={alt} loading="lazy" decoding="async" width={asset.width} height={asset.height} onError={(event) => {
    if (src !== asset.localUrl) {
      setSkipped(src)
      return
    }
    event.currentTarget.dataset.failed = 'true'
    if (missingAlt) event.currentTarget.alt = missingAlt
  }} />
}
