import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasImageAssetSummary } from '../host'
import { verifyOutputImageReadable } from './output-image-readiness'

function asset(): CanvasImageAssetSummary { const assetId = 'a'.repeat(43); return { assetId, mediaType: 'image', mimeType: 'image/png', localUrl: `xingmang-asset://image/${assetId}`, thumbnailUrl: '', fileName: 'image.png', width: 960, height: 720, createdAt: '' } }
// A web-like host: it maps the protocol address to the site's owner-scoped content address.
const webHost = { resolveAssetDisplayUrl: (url: string) => `/api/assets/${url.slice('xingmang-asset://image/'.length)}/content` }
function fixture(host: object | null = webHost) {
  const images: Array<{ onload: (() => void) | null; onerror: (() => void) | null; src: string; naturalWidth: number; naturalHeight: number }> = []
  class TestImage { onload: (() => void) | null = null; onerror: (() => void) | null = null; src = ''; naturalWidth = 960; naturalHeight = 720; constructor() { images.push(this) } }
  vi.stubGlobal('Image', TestImage); vi.stubGlobal('window', { setTimeout, clearTimeout, ...(host ? { xingmangCanvasHost: host } : {}) }); return images
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
describe('output image content readiness', () => {
  it('loads only the owner-scoped asset content and verifies decoded dimensions', async () => {
    const images = fixture(), done = verifyOutputImageReadable(asset(), new AbortController().signal)
    expect(images[0].src).toBe(`/api/assets/${asset().assetId}/content`); images[0].onload!(); await done; expect(images[0].src).toBe('')
  })
  it('loads the stored protocol address when the host does not map it', async () => {
    const images = fixture(null), done = verifyOutputImageReadable(asset(), new AbortController().signal)
    expect(images[0].src).toBe(asset().localUrl); images[0].onload!(); await done; expect(images[0].src).toBe('')
  })
  it.each(['missing', 'dimensions', 'abort'] as const)('rejects %s and cleans up handlers', async (kind) => {
    const images = fixture(), controller = new AbortController(), done = verifyOutputImageReadable(asset(), controller.signal), rejected = expect(done).rejects.toThrow()
    if (kind === 'missing') images[0].onerror!()
    if (kind === 'dimensions') { images[0].naturalHeight = 1; images[0].onload!() }
    if (kind === 'abort') controller.abort()
    await rejected; expect(images[0].src).toBe(''); expect(images[0].onload).toBeNull()
  })
  it('rejects external URLs and times out a stalled content load', async () => {
    fixture(); await expect(verifyOutputImageReadable({ ...asset(), localUrl: 'https://foreign.invalid/a.png' }, new AbortController().signal)).rejects.toThrow('不可读取')
    vi.useFakeTimers(); fixture(); const done = verifyOutputImageReadable(asset(), new AbortController().signal), rejected = expect(done).rejects.toThrow('超时'); await vi.advanceTimersByTimeAsync(25_000); await rejected
  })
})
