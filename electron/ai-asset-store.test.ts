import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AiAssetStore,
  inspectAiImage,
  isPublicAiAssetAddress,
  resolveAiOutputRoot,
  validateAiAssetRemoteUrl,
  type AiAssetContextMenuItem,
  type AiAssetNativeOperations,
} from './ai-asset-store'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-ai-assets-'))
  temporaryDirectories.push(directory)
  return directory
}

function png(width = 2, height = 3): Buffer {
  const bytes = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function jpeg(width = 4, height = 5): Buffer {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ])
}

function webp(width = 6, height = 7): Buffer {
  const bytes = Buffer.alloc(30)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(22, 4)
  bytes.write('WEBP', 8, 'ascii')
  bytes.write('VP8X', 12, 'ascii')
  bytes.writeUIntLE(width - 1, 24, 3)
  bytes.writeUIntLE(height - 1, 27, 3)
  return bytes
}

function fixedRandomBytes(): Buffer {
  return Buffer.alloc(32, 0x5a)
}

function storeOptions(outputRoot = path.join(temporaryDirectory(), 'output')) {
  return {
    outputRoot,
    now: () => new Date(2026, 7, 12, 12, 0, 0),
    randomBytes: fixedRandomBytes,
    dnsLookup: vi.fn(async () => ['93.184.216.34']),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('output root and image inspection', () => {
  it('resolves development and packaged output roots exactly', () => {
    expect(resolveAiOutputRoot({ isPackaged: false, projectRoot: 'C:\\work\\manager' }))
      .toBe(path.join(path.resolve('C:\\work\\manager'), 'output'))
    expect(resolveAiOutputRoot({ isPackaged: true, execPath: 'C:\\Program Files\\Xingmang\\xingmang.exe' }))
      .toBe(path.join(path.dirname(path.resolve('C:\\Program Files\\Xingmang\\xingmang.exe')), 'output'))
  })

  it('recognizes PNG, JPEG, and WebP dimensions by magic bytes', () => {
    expect(inspectAiImage(png())).toMatchObject({ mimeType: 'image/png', width: 2, height: 3 })
    expect(inspectAiImage(jpeg())).toMatchObject({ mimeType: 'image/jpeg', width: 4, height: 5 })
    expect(inspectAiImage(webp())).toMatchObject({ mimeType: 'image/webp', width: 6, height: 7 })
  })

  it('rejects SVG/HTML and MIME spoofing', () => {
    expect(() => inspectAiImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'))
      .toThrow('仅支持 PNG、JPEG 或 WebP')
    expect(() => inspectAiImage(Buffer.from('<html>not an image</html>'), 'text/html'))
      .toThrow('仅支持 PNG、JPEG 或 WebP')
    expect(() => inspectAiImage(png(), 'image/jpeg')).toThrow('MIME 与实际内容不一致')
  })
})

describe('AiAssetStore base64 and ownership', () => {
  it('stores under output/user/date and returns no absolute path', async () => {
    const options = storeOptions()
    const store = new AiAssetStore(options)
    const asset = await store.storeBase64(42, `data:image/png;base64,${png().toString('base64')}`, {
      revisedPrompt: 'revised',
    })

    expect(asset).toMatchObject({
      mimeType: 'image/png',
      width: 2,
      height: 3,
      revisedPrompt: 'revised',
    })
    expect(Object.keys(asset).sort()).toEqual([
      'assetId', 'fileName', 'height', 'localUrl', 'mimeType', 'revisedPrompt', 'width',
    ])
    expect(JSON.stringify(asset)).not.toContain(path.resolve(options.outputRoot))
    expect(fs.existsSync(path.join(options.outputRoot, 'user-42', '2026-08-12', asset.fileName))).toBe(true)
  })

  it('accepts raw b64_json and restores ownership after a process restart', async () => {
    const options = storeOptions()
    const firstStore = new AiAssetStore(options)
    const asset = await firstStore.storeBase64(42, jpeg().toString('base64'))
    const restartedStore = new AiAssetStore({ ...options, randomBytes: () => Buffer.alloc(32, 0x33) })

    await expect(restartedStore.readOwned(42, asset.assetId)).resolves.toMatchObject({
      asset: { assetId: asset.assetId, mimeType: 'image/jpeg' },
      bytes: jpeg(),
    })
  })

  it('rejects forged ids, traversal, and cross-account ownership', async () => {
    const store = new AiAssetStore(storeOptions())
    const asset = await store.storeBase64(42, png().toString('base64'))

    await expect(store.readOwned(99, asset.assetId)).rejects.toThrow('无权访问')
    await expect(store.readOwned(42, '../secret')).rejects.toThrow('资产标识无效')
    await expect(store.readOwned(42, 'A'.repeat(43))).rejects.toThrow('不存在或无权访问')
  })

  it('enforces a bounded base64 decode before persisting', async () => {
    const options = storeOptions()
    const store = new AiAssetStore({ ...options, maximumImageBytes: 23 })
    await expect(store.storeBase64(42, png().toString('base64'))).rejects.toThrow('64 MB 安全上限')
    expect(fs.existsSync(options.outputRoot)).toBe(false)
  })

  it('reports an explicit output write-permission failure', async () => {
    const parent = temporaryDirectory()
    const outputRoot = path.join(parent, 'output')
    fs.writeFileSync(outputRoot, 'this blocks directory creation')
    const store = new AiAssetStore(storeOptions(outputRoot))

    await expect(store.storeBase64(42, png().toString('base64')))
      .rejects.toThrow('无法写入 output 目录，请检查安装目录写入权限')
  })
})

describe('AiAssetStore remote URL safety', () => {
  it('rejects non-HTTPS, credentials, localhost, and private or reserved DNS answers before fetch', async () => {
    expect(() => validateAiAssetRemoteUrl('http://example.com/image.png')).toThrow('HTTPS')
    expect(() => validateAiAssetRemoteUrl('https://user:pass@example.com/image.png')).toThrow('HTTPS')
    expect(() => validateAiAssetRemoteUrl('https://localhost/image.png')).toThrow('HTTPS')
    expect(isPublicAiAssetAddress('127.0.0.1')).toBe(false)
    expect(isPublicAiAssetAddress('10.0.0.1')).toBe(false)
    expect(isPublicAiAssetAddress('::1')).toBe(false)
    expect(isPublicAiAssetAddress('93.184.216.34')).toBe(true)

    const fetchImpl = vi.fn()
    const store = new AiAssetStore({
      ...storeOptions(),
      dnsLookup: vi.fn(async () => ['192.168.1.2']),
      fetchImpl,
    })
    await expect(store.storeRemoteUrl(42, 'https://example.com/image.png')).rejects.toThrow('私网、回环或保留地址')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('validates every redirect hop and refuses a redirect to a private host', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://internal.example/image.png' },
    }))
    const dnsLookup = vi.fn(async (hostname: string) => (
      hostname === 'internal.example' ? ['10.0.0.1'] : ['93.184.216.34']
    ))
    const store = new AiAssetStore({ ...storeOptions(), fetchImpl, dnsLookup })

    await expect(store.storeRemoteUrl(42, 'https://cdn.example/image.png')).rejects.toThrow('私网、回环或保留地址')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(dnsLookup).toHaveBeenCalledTimes(2)
  })

  it('streams a public PNG into the owned output store with manual redirects disabled', async () => {
    const image = png(20, 30)
    const fetchImpl = vi.fn(async () => new Response(image, {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(image.length) },
    }))
    const store = new AiAssetStore({ ...storeOptions(), fetchImpl })

    const asset = await store.storeRemoteUrl(42, 'https://cdn.example/image.png')

    expect(asset).toMatchObject({ mimeType: 'image/png', width: 20, height: 30 })
    expect(fetchImpl).toHaveBeenCalledWith('https://cdn.example/image.png', expect.objectContaining({
      method: 'GET',
      redirect: 'manual',
    }))
  })

  it('rejects remote MIME spoofing and stream overflow', async () => {
    const spoofed = new AiAssetStore({
      ...storeOptions(),
      fetchImpl: vi.fn(async () => new Response(png(), { headers: { 'Content-Type': 'text/html' } })),
    })
    await expect(spoofed.storeRemoteUrl(42, 'https://cdn.example/image')).rejects.toThrow('响应类型不受支持')

    const oversized = new AiAssetStore({
      ...storeOptions(),
      maximumImageBytes: 16,
      fetchImpl: vi.fn(async () => new Response(png(), { headers: { 'Content-Type': 'image/png' } })),
    })
    await expect(oversized.storeRemoteUrl(42, 'https://cdn.example/image')).rejects.toThrow('64 MB 安全上限')
  })
})

describe('AiAssetStore native operations', () => {
  it('supports copy, save-as, reveal, and an ownership-checked context menu', async () => {
    const savedPath = path.join(temporaryDirectory(), 'saved.png')
    let menuItems: readonly AiAssetContextMenuItem[] = []
    const nativeOperations: AiAssetNativeOperations = {
      copyImage: vi.fn(),
      selectSavePath: vi.fn(async () => savedPath),
      revealInFolder: vi.fn(),
      showContextMenu: vi.fn(async (items) => { menuItems = items }),
    }
    const store = new AiAssetStore({ ...storeOptions(), nativeOperations })
    const asset = await store.storeBase64(42, png().toString('base64'))

    await store.copy(42, asset.assetId)
    await expect(store.saveAs(42, asset.assetId)).resolves.toBe(true)
    await store.revealInFolder(42, asset.assetId)
    await store.contextMenu(42, asset.assetId)

    expect(nativeOperations.copyImage).toHaveBeenCalledWith(png(), 'image/png')
    expect(fs.readFileSync(savedPath)).toEqual(png())
    expect(nativeOperations.revealInFolder).toHaveBeenCalledWith(expect.stringContaining(asset.fileName))
    expect(menuItems.map((item) => item.id)).toEqual(['copy', 'save-as', 'reveal-in-folder'])
    await menuItems[0].run()
    expect(nativeOperations.copyImage).toHaveBeenCalledTimes(2)
    await expect(store.contextMenu(99, asset.assetId)).rejects.toThrow('无权访问')
  })

  it('treats a canceled save dialog as a normal no-op', async () => {
    const store = new AiAssetStore({
      ...storeOptions(),
      nativeOperations: { selectSavePath: vi.fn(async () => null) },
    })
    const asset = await store.storeBase64(42, png().toString('base64'))
    await expect(store.saveAs(42, asset.assetId)).resolves.toBe(false)
  })
})
