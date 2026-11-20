import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { assetLargeImageThumbnailUrl, assetThumbnailLargeMaxEdge } from '../../../../electron/asset-thumbnail'
import { ChatImage, chatImageSource, chatImageThumbnailUrl, type ChatImageAsset } from './ChatImage'

const assetId = 'a'.repeat(43)

function asset(overrides: Partial<ChatImageAsset> = {}): ChatImageAsset {
  return { assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png', width: 2048, height: 2048, ...overrides }
}

describe('chatImageThumbnailUrl', () => {
  it('shows a stored picture larger than the chat size through the main process thumbnail', () => {
    expect(chatImageThumbnailUrl(asset())).toBe(assetLargeImageThumbnailUrl(assetId))
    expect(chatImageThumbnailUrl(asset({ mimeType: 'image/jpeg', width: 4096, height: 2304 }))).toBe(assetLargeImageThumbnailUrl(assetId))
  })

  it('asks for the thumbnail when the size was never recorded, since it never upscales', () => {
    expect(chatImageThumbnailUrl(asset({ width: undefined, height: undefined }))).toBe(assetLargeImageThumbnailUrl(assetId))
  })

  it('keeps the original when it is no bigger than the thumbnail would be', () => {
    expect(chatImageThumbnailUrl(asset({ width: assetThumbnailLargeMaxEdge, height: 400 }))).toBeNull()
    expect(chatImageThumbnailUrl(asset({ width: 512, height: 512 }))).toBeNull()
    expect(chatImageThumbnailUrl(asset({ width: assetThumbnailLargeMaxEdge + 1, height: 400 }))).toBe(assetLargeImageThumbnailUrl(assetId))
  })

  it('keeps the original for WebP, which the main process cannot decode on every system', () => {
    expect(chatImageThumbnailUrl(asset({ mimeType: 'image/webp' }))).toBeNull()
  })

  it('only derives from the stored picture the address names', () => {
    expect(chatImageThumbnailUrl(asset({ localUrl: '/assets/brand/v3/symbol-standard.svg' }))).toBeNull()
    expect(chatImageThumbnailUrl(asset({ localUrl: `xingmang-asset://image/${'b'.repeat(43)}` }))).toBeNull()
    expect(chatImageThumbnailUrl(asset({ localUrl: `xingmang-asset://video/${assetId}` }))).toBeNull()
  })
})

describe('chatImageSource', () => {
  it('starts with the thumbnail and falls back to the original once the thumbnail fails', () => {
    const thumbnail = assetLargeImageThumbnailUrl(assetId)
    expect(chatImageSource(asset(), '')).toBe(thumbnail)
    expect(chatImageSource(asset(), thumbnail)).toBe(`xingmang-asset://image/${assetId}`)
  })

  it('uses the original straight away when there is no thumbnail to try', () => {
    expect(chatImageSource(asset({ mimeType: 'image/webp' }), '')).toBe(`xingmang-asset://image/${assetId}`)
  })
})

describe('ChatImage', () => {
  it('loads lazily, decodes off the critical path and reserves its box before it arrives', () => {
    const markup = renderToStaticMarkup(<ChatImage asset={asset({ width: 2048, height: 1152 })} alt="生成的图片" />)
    expect(markup).toContain(`src="${assetLargeImageThumbnailUrl(assetId)}"`)
    expect(markup).toContain('alt="生成的图片"')
    expect(markup).toContain('loading="lazy"')
    expect(markup).toContain('decoding="async"')
    expect(markup).toContain('width="2048"')
    expect(markup).toContain('height="1152"')
  })

  it('leaves the size out when it was never recorded', () => {
    const markup = renderToStaticMarkup(<ChatImage asset={asset({ width: undefined, height: undefined })} alt="你发的图片" />)
    expect(markup).not.toContain('width=')
    expect(markup).not.toContain('height=')
  })
})
