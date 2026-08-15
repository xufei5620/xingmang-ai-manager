import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
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

describe('video image inputs', () => {
  it('returns an owned bounded image data URI without exposing a local path', async () => {
    const store = new AiAssetStore(storeOptions())
    const asset = await store.storeBase64(42, png().toString('base64'))
    await expect(store.readImageDataUri(42, asset.assetId)).resolves.toBe(
      `data:image/png;base64,${png().toString('base64')}`,
    )
    await expect(store.readImageDataUri(99, asset.assetId)).rejects.toThrow('无权访问')
  })
})

describe('AiAssetStore base64 and ownership', () => {
  it('imports a local image after validating bytes and account ownership', async () => {
    const sourceRoot = temporaryDirectory()
    const sourcePath = path.join(sourceRoot, 'reference.png')
    fs.writeFileSync(sourcePath, png(640, 480))
    const store = new AiAssetStore(storeOptions())

    const asset = await store.storeLocalFile(42, sourcePath)

    expect(asset).toMatchObject({ mimeType: 'image/png', width: 640, height: 480 })
    await expect(store.readOwned(99, asset.assetId)).rejects.toThrow('无权访问')
  })

  it('reuses a content-addressed asset for repeated local imports', async () => {
    const sourceRoot = temporaryDirectory()
    const sourcePath = path.join(sourceRoot, 'reference.png')
    fs.writeFileSync(sourcePath, png(640, 480))
    const options = storeOptions()
    const store = new AiAssetStore(options)

    const first = await store.storeLocalFile(42, sourcePath)
    const second = await store.storeLocalFile(42, sourcePath)
    const assetDirectory = path.join(options.outputRoot, 'user-42', '2026-08-12')
    fs.copyFileSync(
      path.join(assetDirectory, first.fileName),
      path.join(assetDirectory, `xingmang-${'L'.repeat(43)}.png`),
    )

    expect(second.assetId).toBe(first.assetId)
    await expect(store.listOwned(42)).resolves.toEqual([expect.objectContaining({ assetId: first.assetId })])
  })

  it('rejects relative paths and files that are not valid images', async () => {
    const sourceRoot = temporaryDirectory()
    const invalidPath = path.join(sourceRoot, 'invalid.png')
    fs.writeFileSync(invalidPath, 'not an image')
    const store = new AiAssetStore(storeOptions())

    await expect(store.storeLocalFile(42, 'relative.png')).rejects.toThrow('路径无效')
    await expect(store.storeLocalFile(42, invalidPath)).rejects.toThrow('图片内容无效')
  })
  it('creates the output directory when the asset store initializes', () => {
    const options = storeOptions()
    expect(fs.existsSync(options.outputRoot)).toBe(false)

    const store = new AiAssetStore(options)
    store.ensureOutputDirectory()

    expect(fs.statSync(options.outputRoot).isDirectory()).toBe(true)
  })

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

  it('removes only an owned safe asset and treats missing or cross-account targets as unauthorized', async () => {
    const options = storeOptions()
    const store = new AiAssetStore(options)
    const stored = await store.storeBase64(42, png().toString('base64'))
    const filePath = path.join(options.outputRoot, 'user-42', '2026-08-12', stored.fileName)

    await expect(store.removeOwned(99, stored.assetId)).rejects.toThrow('无权访问')
    expect(fs.existsSync(filePath)).toBe(true)
    await expect(store.removeOwned(42, stored.assetId)).resolves.toBeUndefined()
    expect(fs.existsSync(filePath)).toBe(false)
    await expect(store.removeOwned(42, stored.assetId)).rejects.toThrow('不存在或无权访问')
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

describe('AiAssetStore listing', () => {
  it('scans owned assets after restart and never returns another user assets', async () => {
    const options = storeOptions()
    const firstStore = new AiAssetStore(options)
    const owned = await firstStore.storeBase64(42, png().toString('base64'))
    await firstStore.storeBase64(99, jpeg().toString('base64'))
    const restartedStore = new AiAssetStore({ ...options, randomBytes: () => Buffer.alloc(32, 0x33) })

    await expect(restartedStore.listOwned(42)).resolves.toEqual([
      expect.objectContaining({ assetId: owned.assetId, mimeType: 'image/png' }),
    ])
    expect(JSON.stringify(await restartedStore.listOwned(42))).not.toContain('user-99')
  })

  it('omits malformed and missing files while keeping valid owned assets', async () => {
    const options = storeOptions()
    const store = new AiAssetStore(options)
    const valid = await store.storeBase64(42, png().toString('base64'))
    const directory = path.join(options.outputRoot, 'user-42', '2026-08-12')
    fs.writeFileSync(path.join(directory, `xingmang-${'m'.repeat(43)}.png`), 'not an image')
    const missingId = 'n'.repeat(43)
    fs.writeFileSync(path.join(directory, `xingmang-${missingId}.png`), png())
    fs.rmSync(path.join(directory, `xingmang-${missingId}.png`))

    await expect(store.listOwned(42)).resolves.toEqual([
      expect.objectContaining({ assetId: valid.assetId }),
    ])
  })

  it.runIf(process.platform === 'win32')('rejects a reparse directory instead of following it', async () => {
    const options = storeOptions()
    const external = temporaryDirectory()
    const accountRoot = path.join(options.outputRoot, 'user-42')
    fs.mkdirSync(accountRoot, { recursive: true })
    fs.mkdirSync(path.join(external, '2026-08-12'), { recursive: true })
    fs.symlinkSync(external, path.join(accountRoot, '2026-08-12'), 'junction')
    const store = new AiAssetStore(options)

    await expect(store.listOwned(42)).rejects.toThrow(/符号链接|目录联接|读取/)
  })

  it('uses 200 by default and allows an explicit bounded maximum of 500', async () => {
    const options = storeOptions()
    const directory = path.join(options.outputRoot, 'user-42', '2026-08-12')
    fs.mkdirSync(directory, { recursive: true })
    for (let index = 0; index < 510; index += 1) {
      // A zero-filled buffer with only the final uint changed produces
      // base64url names that can differ by case only. NTFS is case-insensitive,
      // so those fixtures silently overwrite one another and undercount.
      const assetId = createHash('sha256').update(`asset-${index}`).digest()
      fs.writeFileSync(path.join(directory, `xingmang-${assetId.toString('base64url')}.png`), png(index + 1, index + 1))
    }
    const store = new AiAssetStore(options)

    await expect(store.listOwned(42)).resolves.toHaveLength(200)
    await expect(store.listOwned(42, 500)).resolves.toHaveLength(500)
    await expect(store.listOwned(42, 501)).rejects.toThrow('列表数量无效')
  })

  it('folds historical random identifiers with identical image content in the asset list', async () => {
    const options = storeOptions()
    const directory = path.join(options.outputRoot, 'user-42', '2026-08-12')
    fs.mkdirSync(directory, { recursive: true })
    for (const label of ['first', 'second']) {
      const assetId = createHash('sha256').update(label).digest('base64url')
      fs.writeFileSync(path.join(directory, `xingmang-${assetId}.png`), png(20, 20))
    }

    await expect(new AiAssetStore(options).listOwned(42)).resolves.toHaveLength(1)
  })

  it('pages, filters and searches 100 owned assets with stable metadata', async () => {
    const options = storeOptions()
    const directory = path.join(options.outputRoot, 'user-42', '2026-08-12')
    fs.mkdirSync(directory, { recursive: true })
    for (let index = 0; index < 100; index += 1) {
      const assetId = createHash('sha256').update(`paged-asset-${index}`).digest('base64url')
      fs.writeFileSync(path.join(directory, `xingmang-${assetId}.png`), png(index + 1, index + 2))
    }
    const store = new AiAssetStore(options)

    const first = await store.listOwnedPage(42, { offset: 0, limit: 24, mediaType: 'image' })
    const second = await store.listOwnedPage(42, { offset: 24, limit: 24 })
    expect(first).toMatchObject({ offset: 0, limit: 24, total: 100, hasMore: true })
    expect(first.items).toHaveLength(24)
    expect(second.items).toHaveLength(24)
    expect(new Set([...first.items, ...second.items].map((asset) => asset.assetId))).toHaveLength(48)
    expect(first.items[0]).toMatchObject({ mediaType: 'image', thumbnailUrl: expect.stringMatching(/^xingmang-asset:\/\/image\//) })

    const target = first.items[0]
    await expect(store.listOwnedPage(42, { search: target.assetId })).resolves.toMatchObject({
      total: 1,
      items: [expect.objectContaining({ assetId: target.assetId })],
    })
    await expect(store.listOwnedPage(42, { offset: 501 })).rejects.toThrow('分页位置无效')
    await expect(store.listOwnedPage(42, { limit: 101 })).rejects.toThrow('分页数量无效')
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

  it('uses the proxy-aware fetch only for the exact xAI image host', async () => {
    const image = png(20, 30)
    const fetchImpl = vi.fn(async () => new Response(image, {
      status: 200, headers: { 'Content-Type': 'image/png' },
    }))
    const trustedProxyFetchImpl = vi.fn(async () => new Response(image, {
      status: 200, headers: { 'Content-Type': 'image/png' },
    }))
    const dnsLookup = vi.fn(async () => ['10.64.0.7'])
    const proxyStore = new AiAssetStore({
      ...storeOptions(), fetchImpl, trustedProxyFetchImpl, dnsLookup,
    })

    await expect(proxyStore.storeRemoteUrl(42, 'https://imgen.x.ai/result.png')).resolves.toMatchObject({
      mimeType: 'image/png', width: 20, height: 30,
    })
    expect(trustedProxyFetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(dnsLookup).not.toHaveBeenCalled()
    await expect(new AiAssetStore({
      ...storeOptions(), fetchImpl, trustedProxyFetchImpl, dnsLookup: vi.fn(async () => ['10.64.0.7']),
    }).storeRemoteUrl(42, 'https://cdn.example/result.png')).rejects.toThrow('私网、回环或保留地址')
  })

  it('revalidates redirects from the trusted xAI host before following them', async () => {
    const trustedProxyFetchImpl = vi.fn(async () => new Response(null, {
      status: 302, headers: { Location: 'https://internal.example/result.png' },
    }))
    const fetchImpl = vi.fn()
    const store = new AiAssetStore({
      ...storeOptions(), fetchImpl, trustedProxyFetchImpl,
      dnsLookup: vi.fn(async () => ['127.0.0.1']),
    })

    await expect(store.storeRemoteUrl(42, 'https://imgen.x.ai/result.png')).rejects.toThrow('私网、回环或保留地址')
    expect(trustedProxyFetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl).not.toHaveBeenCalled()
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
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cdn.example/image.png',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
      ['93.184.216.34'],
    )
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

  it('re-checks account authorization when a delayed native menu action runs', async () => {
    let menuItems: readonly AiAssetContextMenuItem[] = []
    let currentUserId = 42
    const store = new AiAssetStore({
      ...storeOptions(),
      nativeOperations: {
        copyImage: vi.fn(),
        showContextMenu: vi.fn(async (items) => { menuItems = items }),
      },
    })
    const asset = await store.storeBase64(42, png().toString('base64'))
    await store.contextMenu(42, asset.assetId, () => {
      if (currentUserId !== 42) throw new Error('账号已切换')
    })

    currentUserId = 99
    await expect(menuItems[0].run()).rejects.toThrow('账号已切换')
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
