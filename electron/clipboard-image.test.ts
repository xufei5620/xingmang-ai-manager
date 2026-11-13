import { describe, expect, it, vi } from 'vitest'
import { CLIPBOARD_FILE_LIST_TYPE, CLIPBOARD_IMAGE_TYPE, parseClipboardFileList, readClipboardFilePaths, readClipboardPng, writeClipboardPng, type ClipboardImageEntry } from './clipboard-image'

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

describe('clipboard file paths', () => {
  const fileNameW = 'electron application/osclipboard;format="FileNameW"'
  const fileUrl = 'electron application/osclipboard;format="public.file-url"'

  it('turns a uri list into file paths, skipping comments, blank lines, duplicates and anything that is not a local file', () => {
    const list = '# copied\r\nfile:///home/%E5%BC%A0%20%E4%B8%89/%E6%88%AA%E5%9B%BE%201.png\r\n\r\nhttps://example.com/a.png\r\nfile:///home/b.jpg\r\nfile:///home/b.jpg\r\n'
    expect(parseClipboardFileList(list, 'linux')).toEqual(['/home/张 三/截图 1.png', '/home/b.jpg'])
    expect(parseClipboardFileList('file://server/share/a.png', 'linux')).toEqual([])
  })

  it('reads Windows drive and network paths from a uri list', () => {
    const list = 'file:///C:/Users/%E5%BC%A0%20%E4%B8%89/Pictures/a.png\r\nfile://nas/photos/b.png'
    expect(parseClipboardFileList(list, 'win32')).toEqual(['C:\\Users\\张 三\\Pictures\\a.png', '\\\\nas\\photos\\b.png'])
  })

  it('reads the files listed by Electron as a uri list', async () => {
    const copied = entry({ [CLIPBOARD_FILE_LIST_TYPE]: new Blob(['file:///home/me/shot.png\r\nfile:///home/me/two.png']) })
    await expect(readClipboardFilePaths({ read: async () => [entry({ 'text/plain': new Blob(['hello']) }), copied] }, 'linux')).resolves.toEqual(['/home/me/shot.png', '/home/me/two.png'])
  })

  it('falls back to the first file Explorer names on Windows', async () => {
    const explorer = entry({ [fileNameW]: new Blob([Buffer.from('C:\\Users\\张三\\Desktop\\截图.png\0', 'utf16le')]) })
    await expect(readClipboardFilePaths({ read: async () => [explorer] }, 'win32')).resolves.toEqual(['C:\\Users\\张三\\Desktop\\截图.png'])
    await expect(readClipboardFilePaths({ read: async () => [explorer] }, 'linux')).resolves.toEqual([])
  })

  it('falls back to the file URL Finder leaves on macOS', async () => {
    const finder = entry({ [fileUrl]: new Blob(['file:///Users/me/Desktop/%E6%88%AA%E5%9B%BE.png']) })
    await expect(readClipboardFilePaths({ read: async () => [finder] }, 'darwin')).resolves.toEqual(['/Users/me/Desktop/截图.png'])
    await expect(readClipboardFilePaths({ read: async () => [finder] }, 'win32')).resolves.toEqual([])
  })

  it('finds no files on a clipboard with only text or a picture, an empty or oversized list, or one that fails to read', async () => {
    await expect(readClipboardFilePaths({ read: async () => [entry({ 'text/plain': new Blob(['/home/me/shot.png']) })] }, 'linux')).resolves.toEqual([])
    await expect(readClipboardFilePaths({ read: async () => [entry({ [CLIPBOARD_IMAGE_TYPE]: new Blob([Buffer.from([0x89])]) })] }, 'win32')).resolves.toEqual([])
    await expect(readClipboardFilePaths({ read: async () => [entry({ [CLIPBOARD_FILE_LIST_TYPE]: new Blob([]) })] }, 'linux')).resolves.toEqual([])
    await expect(readClipboardFilePaths({ read: async () => [entry({ [CLIPBOARD_FILE_LIST_TYPE]: new Blob(['file:///a.png\n'.repeat(80_000)]) })] }, 'linux')).resolves.toEqual([])
    await expect(readClipboardFilePaths({ read: async () => { throw new Error('clipboard busy') } }, 'linux')).resolves.toEqual([])
    const broken = { types: [CLIPBOARD_FILE_LIST_TYPE], getType: vi.fn(async () => { throw new Error('gone') }) }
    await expect(readClipboardFilePaths({ read: async () => [broken] }, 'linux')).resolves.toEqual([])
  })
})
