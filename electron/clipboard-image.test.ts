import { describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_IMAGE_TYPE, readClipboardPng, writeClipboardPng, type ClipboardImageEntry } from './clipboard-image'

function entry(payloads: Record<string, unknown>): ClipboardImageEntry {
  return {
    types: Object.keys(payloads),
    getType: vi.fn(async (type: string) => {
      if (!(type in payloads)) throw new Error(`${type} is not on the clipboard`)
      return payloads[type]
    }),
  }
}

describe('clipboard-image', () => {
  it('reads the PNG bytes of the first entry that carries an image', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const textOnly = entry({ 'text/plain': new Blob(['hello']) })
    const image = entry({ 'text/html': new Blob(['<img>']), [CLIPBOARD_IMAGE_TYPE]: new Blob([png]) })

    const bytes = await readClipboardPng({ read: async () => [textOnly, image] })

    expect(bytes).toEqual(png)
    expect(textOnly.getType).not.toHaveBeenCalled()
    expect(image.getType).toHaveBeenCalledExactlyOnceWith(CLIPBOARD_IMAGE_TYPE)
  })

  it('returns null when the clipboard holds no image', async () => {
    await expect(readClipboardPng({ read: async () => [] })).resolves.toBeNull()
    await expect(readClipboardPng({ read: async () => [entry({ 'text/plain': new Blob(['sk-not-an-image']) })] })).resolves.toBeNull()
  })

  it('skips a payload that is not binary content', async () => {
    const odd = entry({ [CLIPBOARD_IMAGE_TYPE]: { title: 'x', url: 'https://example.com' } })
    await expect(readClipboardPng({ read: async () => [odd] })).resolves.toBeNull()
  })

  it('lets a failed read reach the caller', async () => {
    await expect(readClipboardPng({ read: async () => { throw new Error('clipboard busy') } })).rejects.toThrow('clipboard busy')
  })

  it('writes exactly the image bytes as one PNG entry', async () => {
    const pool = Buffer.from([9, 9, 0x89, 0x50, 0x4e, 0x47, 7, 9, 9])
    const png = pool.subarray(2, 7)
    const written: Array<Record<string, Blob>> = []
    const clipboard = { write: vi.fn(async (items: Array<Record<string, Blob>>) => { written.push(...items) }) }

    await writeClipboardPng(clipboard, (payload) => payload, png)

    expect(clipboard.write).toHaveBeenCalledOnce()
    expect(written).toHaveLength(1)
    expect(Object.keys(written[0]!)).toEqual([CLIPBOARD_IMAGE_TYPE])
    const blob = written[0]![CLIPBOARD_IMAGE_TYPE]!
    expect(blob.type).toBe(CLIPBOARD_IMAGE_TYPE)
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 7]))
  })

  it('lets a failed write reach the caller', async () => {
    const clipboard = { write: vi.fn(async () => { throw new Error('clipboard busy') }) }
    await expect(writeClipboardPng(clipboard, (payload) => payload, Buffer.from([1]))).rejects.toThrow('clipboard busy')
  })
})
