import { afterEach, describe, expect, it, vi } from 'vitest'
import { capturePanoramaPng, downloadPanoramaPng } from './panorama-download'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('panorama PNG capture', () => {
  it('encodes the bounded view as PNG without including source names', async () => {
    const blob = new Blob(['png'], { type: 'image/png' })
    const toBlob = vi.fn((callback: BlobCallback, type: string) => { expect(type).toBe('image/png'); callback(blob) })
    expect(await capturePanoramaPng({ width: 2048, height: 1024, toBlob })).toBe(blob)
    const link = { href: '', download: '', style: { display: '' }, click: vi.fn(), remove: vi.fn() }
    vi.stubGlobal('document', { createElement: () => link, body: { appendChild: vi.fn() } })
    vi.useFakeTimers()
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned-preview')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    downloadPanoramaPng(blob)
    expect(link.download).toBe('星芒-全景视角.png')
    expect(link.click).toHaveBeenCalledOnce()
    expect(link.remove).toHaveBeenCalledOnce()
    vi.runAllTimers()
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:owned-preview')
    create.mockRestore(); revoke.mockRestore()
  })
  it('rejects over-budget surfaces before encoding', async () => {
    const toBlob = vi.fn()
    await expect(capturePanoramaPng({ width: 2049, height: 1024, toBlob })).rejects.toThrow('导出范围')
    expect(toBlob).not.toHaveBeenCalled()
  })
  it('reports security errors without changing the canvas and times out missing callbacks', async () => {
    await expect(capturePanoramaPng({ width: 1, height: 1, toBlob() { throw new Error('SecurityError') } })).rejects.toThrow('全景预览仍可继续使用')
    vi.useFakeTimers()
    const capture = capturePanoramaPng({ width: 1, height: 1, toBlob() {} })
    const assertion = expect(capture).rejects.toThrow('编码超时')
    await vi.advanceTimersByTimeAsync(10000)
    await assertion
  })
  it('rejects empty or incorrectly typed encoder results', async () => {
    await expect(capturePanoramaPng({ width: 1, height: 1, toBlob(callback) { callback(null) } })).rejects.toThrow('有效的全景 PNG')
    await expect(capturePanoramaPng({ width: 1, height: 1, toBlob(callback) { callback(new Blob(['x'], { type: 'image/jpeg' })) } })).rejects.toThrow('有效的全景 PNG')
  })
})
