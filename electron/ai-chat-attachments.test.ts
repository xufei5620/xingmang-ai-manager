import { describe, expect, it, vi } from 'vitest'
import { CHAT_ATTACHMENT_LIMITS, createChatAttachmentService, prepareChatImage, type ChatAttachmentStore, type ChatImageCodec } from './ai-chat-attachments'
import type { AiStoredAsset } from './ai-asset-store'

function png(width: number, height: number, size = 64): Buffer {
  const bytes = Buffer.alloc(Math.max(size, 24))
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function codec(pngSize: number, jpegSizes: Record<number, number> = {}): ChatImageCodec & { decode: ReturnType<typeof vi.fn> } {
  return {
    decode: vi.fn(() => ({
      width: 2048,
      height: 1024,
      png: () => png(2048, 1024, pngSize),
      jpeg: (quality: number) => Buffer.alloc(jpegSizes[quality] ?? CHAT_ATTACHMENT_LIMITS.storedBytes * 2, 1),
    })),
  }
}

function asset(assetId: string): AiStoredAsset {
  return { assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png', fileName: `xingmang-${assetId}.png` }
}

function store(overrides: Partial<ChatAttachmentStore> = {}): ChatAttachmentStore & { stored: Buffer[] } {
  const stored: Buffer[] = []
  return {
    stored,
    readLocalFile: vi.fn(async () => png(800, 600)),
    storeLocalBytes: vi.fn(async (_userId: number, bytes: Buffer) => { stored.push(bytes); return asset(String(stored.length).padStart(43, 'a')) }),
    readOwned: vi.fn(async (_userId: number, assetId: string) => ({ asset: asset(assetId), bytes: png(10, 10) })),
    ...overrides,
  }
}

describe('prepareChatImage', () => {
  it('keeps a small image byte for byte', () => {
    const bytes = png(800, 600)
    const images = codec(10)
    expect(prepareChatImage(bytes, images)).toBe(bytes)
    expect(images.decode).not.toHaveBeenCalled()
  })

  it('shrinks an oversized screenshot and prefers PNG when it fits', () => {
    const result = prepareChatImage(png(5000, 2500), codec(1000))
    expect(result.readUInt32BE(16)).toBe(2048)
  })

  it('falls back to JPEG at falling quality when PNG stays too big', () => {
    const tooBig = CHAT_ATTACHMENT_LIMITS.storedBytes + 1
    const result = prepareChatImage(png(5000, 2500), codec(tooBig, { 85: tooBig, 70: 500 }))
    expect(result.length).toBe(500)
  })

  it('explains when nothing fits, when the file is not an image, and when it is far too big', () => {
    const tooBig = CHAT_ATTACHMENT_LIMITS.storedBytes + 1
    expect(() => prepareChatImage(png(5000, 2500), codec(tooBig))).toThrow('截小一点')
    expect(() => prepareChatImage(Buffer.from('not an image at all, just text'), codec(10))).toThrow('PNG、JPG 和 WebP')
    expect(() => prepareChatImage(Buffer.alloc(CHAT_ATTACHMENT_LIMITS.sourceBytes + 1), codec(10))).toThrow('20 MB')
    expect(() => prepareChatImage(png(5000, 2500), { decode: () => null })).toThrow('打不开')
  })
})

describe('chat attachment service', () => {
  it('stores every picked image after all of them were checked', async () => {
    const files = store()
    const service = createChatAttachmentService({ store: files, codec: codec(10), pickFiles: async () => ['/a.png', '/b.png'], readClipboardImage: async () => null, readClipboardFiles: async () => [] })
    const assets = await service.pick(7, 4)
    expect(assets).toHaveLength(2)
    expect(files.storeLocalBytes).toHaveBeenCalledTimes(2)
    expect(files.storeLocalBytes).toHaveBeenCalledWith(7, expect.any(Buffer))
  })

  it('stores nothing when the picker is canceled, too many are chosen, or one file is bad', async () => {
    const canceled = store()
    await expect(createChatAttachmentService({ store: canceled, codec: codec(10), pickFiles: async () => [], readClipboardImage: async () => null, readClipboardFiles: async () => [] }).pick(7, 4)).resolves.toEqual([])

    const crowded = store()
    await expect(createChatAttachmentService({ store: crowded, codec: codec(10), pickFiles: async () => ['/a', '/b', '/c'], readClipboardImage: async () => null, readClipboardFiles: async () => [] }).pick(7, 2))
      .rejects.toThrow('还能加 2 张')

    let calls = 0
    const mixed = store({ readLocalFile: vi.fn(async () => (++calls === 2 ? Buffer.from('text file contents here!!') : png(10, 10))) })
    await expect(createChatAttachmentService({ store: mixed, codec: codec(10), pickFiles: async () => ['/a', '/b'], readClipboardImage: async () => null, readClipboardFiles: async () => [] }).pick(7, 4))
      .rejects.toThrow('不是能用的图片')

    for (const files of [canceled, crowded, mixed]) expect(files.storeLocalBytes).not.toHaveBeenCalled()
  })

  it('rejects an out-of-range remaining count before opening the picker', async () => {
    const pickFiles = vi.fn(async () => ['/a'])
    const service = createChatAttachmentService({ store: store(), codec: codec(10), pickFiles, readClipboardImage: async () => null, readClipboardFiles: async () => [] })
    for (const remaining of [0, 5, 1.5, Number.NaN]) await expect(service.pick(7, remaining)).rejects.toThrow('最多带 4 张')
    expect(pickFiles).not.toHaveBeenCalled()
  })

  it('reads a pasted screenshot from the clipboard, or nothing when it holds no image', async () => {
    const files = store()
    const empty = createChatAttachmentService({ store: files, codec: codec(10), pickFiles: async () => [], readClipboardImage: async () => null, readClipboardFiles: async () => [] })
    await expect(empty.paste(7, 4)).resolves.toEqual([])
    const full = createChatAttachmentService({ store: files, codec: codec(10), pickFiles: async () => [], readClipboardImage: async () => png(1280, 720), readClipboardFiles: async () => [] })
    await expect(full.paste(7, 4)).resolves.toEqual([expect.objectContaining({ localUrl: expect.stringMatching(/^xingmang-asset:\/\/image\//) })])
  })

  it('takes image files copied in a file manager through the same checks as the picker', async () => {
    const files = store()
    const readClipboardFiles = vi.fn(async () => ['/shots/a.png', '/shots/b.png'])
    const service = createChatAttachmentService({ store: files, codec: codec(10), pickFiles: async () => { throw new Error('the picker is not opened on paste') }, readClipboardImage: async () => null, readClipboardFiles })
    await expect(service.paste(7, 4)).resolves.toHaveLength(2)
    expect(files.readLocalFile).toHaveBeenNthCalledWith(1, '/shots/a.png', CHAT_ATTACHMENT_LIMITS.sourceBytes)
    expect(files.readLocalFile).toHaveBeenNthCalledWith(2, '/shots/b.png', CHAT_ATTACHMENT_LIMITS.sourceBytes)
    expect(files.storeLocalBytes).toHaveBeenCalledTimes(2)
  })

  it('prefers the bitmap when the clipboard carries both a picture and files, as pasting always did', async () => {
    const files = store()
    const readClipboardFiles = vi.fn(async () => ['/cache/a.dat'])
    const service = createChatAttachmentService({ store: files, codec: codec(10), pickFiles: async () => [], readClipboardImage: async () => png(640, 480), readClipboardFiles })
    await expect(service.paste(7, 4)).resolves.toHaveLength(1)
    expect(readClipboardFiles).not.toHaveBeenCalled()
    expect(files.readLocalFile).not.toHaveBeenCalled()
  })

  it('stores no copied file when too many are copied, one cannot be read, or one is not a usable image', async () => {
    const crowded = store()
    await expect(createChatAttachmentService({ store: crowded, codec: codec(10), pickFiles: async () => [], readClipboardImage: async () => null, readClipboardFiles: async () => ['/a.png', '/b.png', '/c.png'] }).paste(7, 2))
      .rejects.toThrow('还能加 2 张')
    expect(crowded.readLocalFile).not.toHaveBeenCalled()

    const unreadable = store({ readLocalFile: vi.fn(async (filePath: string) => { if (filePath === '/b.png') throw new Error('AI 图片资产文件无效或超过安全上限'); return png(10, 10) }) })
    await expect(createChatAttachmentService({ store: unreadable, codec: codec(10), pickFiles: async () => [], readClipboardImage: async () => null, readClipboardFiles: async () => ['/a.png', '/b.png'] }).paste(7, 4))
      .rejects.toThrow('有一张图片读不出来，或者超过 20 MB')

    const notAnImage = store({ readLocalFile: vi.fn(async () => Buffer.from('GIF89a and then some bytes')) })
    await expect(createChatAttachmentService({ store: notAnImage, codec: codec(10), pickFiles: async () => [], readClipboardImage: async () => null, readClipboardFiles: async () => ['/moving.gif'] }).paste(7, 4))
      .rejects.toThrow('只支持 PNG、JPG 和 WebP')

    for (const files of [crowded, unreadable, notAnImage]) expect(files.storeLocalBytes).not.toHaveBeenCalled()
  })

  it('rejects an out-of-range remaining count before reading the clipboard', async () => {
    const readClipboardImage = vi.fn(async () => png(10, 10))
    const readClipboardFiles = vi.fn(async () => ['/a.png'])
    const service = createChatAttachmentService({ store: store(), codec: codec(10), pickFiles: async () => [], readClipboardImage, readClipboardFiles })
    for (const remaining of [0, 5, 1.5, Number.NaN]) await expect(service.paste(7, remaining)).rejects.toThrow('最多带 4 张')
    expect(readClipboardImage).not.toHaveBeenCalled()
    expect(readClipboardFiles).not.toHaveBeenCalled()
  })

  it('sends only attachment-sized images from the store', async () => {
    const service = createChatAttachmentService({ store: store(), codec: codec(10), pickFiles: async () => [], readClipboardImage: async () => null, readClipboardFiles: async () => [] })
    await expect(service.readDataUri(7, 'a'.repeat(43))).resolves.toMatch(/^data:image\/png;base64,/)
    const large = createChatAttachmentService({
      store: store({ readOwned: vi.fn(async (_userId: number, assetId: string) => ({ asset: asset(assetId), bytes: Buffer.alloc(CHAT_ATTACHMENT_LIMITS.storedBytes + 1) })) }),
      codec: codec(10),
      pickFiles: async () => [],
      readClipboardImage: async () => null,
      readClipboardFiles: async () => [],
    })
    await expect(large.readDataUri(7, 'a'.repeat(43))).rejects.toThrow()
  })
})
