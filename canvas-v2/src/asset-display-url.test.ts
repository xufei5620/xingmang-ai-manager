import { afterEach, describe, expect, it, vi } from 'vitest'
import { canvasAssetContentUrlMatches, resolveCanvasAssetDisplayUrl } from './asset-display-url'

const id = 'a'.repeat(43)
const stored = [`xingmang-asset://image/${id}`, `xingmang-asset://video/${id}`, `xingmang-asset://audio/${id}`, `xingmang-asset://thumb/v2/image/${id}`, `xingmang-asset://thumb/v1/video/${id}`]

afterEach(() => { vi.unstubAllGlobals() })

describe('asset display addresses', () => {
  it('shows the stored protocol address when no host maps it', () => {
    for (const value of stored) expect(resolveCanvasAssetDisplayUrl(value)).toBe(value)
    vi.stubGlobal('window', {})
    for (const value of stored) expect(resolveCanvasAssetDisplayUrl(value)).toBe(value)
  })

  it('hands the host the whole stored address and shows only what it returns', () => {
    const resolveAssetDisplayUrl = vi.fn((value: string) => value.includes('/video/') ? undefined : `mapped:${value}`)
    vi.stubGlobal('window', { xingmangCanvasHost: { resolveAssetDisplayUrl } })
    expect(resolveCanvasAssetDisplayUrl(stored[0])).toBe(`mapped:${stored[0]}`)
    expect(resolveCanvasAssetDisplayUrl(stored[3])).toBe(`mapped:${stored[3]}`)
    expect(resolveCanvasAssetDisplayUrl(stored[1])).toBeUndefined()
    expect(resolveAssetDisplayUrl.mock.calls.map(([value]) => value)).toEqual([stored[0], stored[3], stored[1]])
  })

  it('shows inline images as they are and nothing else', () => {
    const inline = 'data:image/png;base64,AAAA'
    const resolveAssetDisplayUrl = vi.fn(() => 'mapped')
    vi.stubGlobal('window', { xingmangCanvasHost: { resolveAssetDisplayUrl } })
    expect(resolveCanvasAssetDisplayUrl(inline)).toBe(inline)
    for (const value of [undefined, '', 'https://example.invalid/a.png', `xingmang-asset://image/${id}x`, `xingmang-asset://thumb/v2/audio/${id}`, `xingmang-asset://thumbnail/${id}`, 'data:image/svg+xml;base64,AAAA']) expect(resolveCanvasAssetDisplayUrl(value)).toBeUndefined()
    expect(resolveAssetDisplayUrl).not.toHaveBeenCalled()
  })
})

describe('asset content address matching', () => {
  it('matches the protocol address of the same asset and kind only', () => {
    expect(canvasAssetContentUrlMatches(`xingmang-asset://image/${id}`, 'image', id)).toBe(true)
    expect(canvasAssetContentUrlMatches(`xingmang-asset://video/${id}`, 'image', id)).toBe(false)
    expect(canvasAssetContentUrlMatches(`xingmang-asset://image/${'b'.repeat(43)}`, 'image', id)).toBe(false)
    expect(canvasAssetContentUrlMatches(undefined, 'image', id)).toBe(false)
    expect(canvasAssetContentUrlMatches({ toString: () => `xingmang-asset://image/${id}` }, 'image', id)).toBe(false)
  })

  it('takes another address only when the host names the same asset, and a project address only where allowed', () => {
    expect(canvasAssetContentUrlMatches('host:account', 'image', id)).toBe(false)
    vi.stubGlobal('window', { xingmangCanvasHost: { resolveHostAssetUrl: (value: string) => value === 'host:account' ? { assetId: id } : value === 'host:project' ? { assetId: id, projectId: 'project' } : undefined } })
    expect(canvasAssetContentUrlMatches('host:account', 'image', id)).toBe(true)
    expect(canvasAssetContentUrlMatches('host:account', 'image', 'b'.repeat(43))).toBe(false)
    expect(canvasAssetContentUrlMatches('host:other', 'image', id)).toBe(false)
    expect(canvasAssetContentUrlMatches('host:project', 'image', id)).toBe(false)
    expect(canvasAssetContentUrlMatches('host:project', 'image', id, { projectScoped: true })).toBe(true)
  })
})
