import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AssetThumbnailStore, MAXIMUM_THUMBNAIL_BYTES } from './asset-thumbnail-store'
import { assetThumbnailVersion } from './asset-thumbnail'

const assetId = 'a'.repeat(43)
const roots: string[] = []

function store() {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-thumb-'))
  roots.push(cacheRoot)
  return { cacheRoot, thumbnails: new AssetThumbnailStore({ cacheRoot }) }
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('AssetThumbnailStore', () => {
  it('round trips a derived image under the versioned account directory', async () => {
    const { cacheRoot, thumbnails } = store()
    await thumbnails.write(7, assetId, { bytes: Buffer.from('derived'), mimeType: 'image/jpeg' })
    await expect(thumbnails.read(7, assetId)).resolves.toEqual({ bytes: Buffer.from('derived'), mimeType: 'image/jpeg' })
    expect(fs.existsSync(path.join(cacheRoot, 'user-7', assetThumbnailVersion, `${assetId}.jpg`))).toBe(true)
  })

  it('reports a miss for an asset that has never been derived', async () => {
    const { thumbnails } = store()
    await expect(thumbnails.read(7, assetId)).resolves.toBeNull()
  })

  it('keeps accounts apart', async () => {
    const { thumbnails } = store()
    await thumbnails.write(7, assetId, { bytes: Buffer.from('seven'), mimeType: 'image/png' })
    await expect(thumbnails.read(8, assetId)).resolves.toBeNull()
  })

  it('drops one account without touching another', async () => {
    const { thumbnails } = store()
    await thumbnails.write(7, assetId, { bytes: Buffer.from('seven'), mimeType: 'image/png' })
    await thumbnails.write(8, assetId, { bytes: Buffer.from('eight'), mimeType: 'image/png' })
    await thumbnails.clear(7)
    await expect(thumbnails.read(7, assetId)).resolves.toBeNull()
    await expect(thumbnails.read(8, assetId)).resolves.toMatchObject({ bytes: Buffer.from('eight') })
  })

  it('clearing an account that never cached anything is not an error', async () => {
    const { thumbnails } = store()
    await expect(thumbnails.clear(7)).resolves.toBeUndefined()
  })

  it('rejects identifiers and account numbers that could escape the cache directory', async () => {
    const { thumbnails } = store()
    await expect(thumbnails.read(7, '../../etc/passwd')).rejects.toThrow('资产标识无效')
    await expect(thumbnails.write(7, `${assetId}/x`, { bytes: Buffer.from('x'), mimeType: 'image/png' })).rejects.toThrow('资产标识无效')
    await expect(thumbnails.read(0, assetId)).rejects.toThrow('账号标识格式错误')
    await expect(thumbnails.read(-1, assetId)).rejects.toThrow('账号标识格式错误')
  })

  it('refuses to store something that is not a thumbnail', async () => {
    const { thumbnails } = store()
    await expect(thumbnails.write(7, assetId, { bytes: Buffer.alloc(0), mimeType: 'image/png' })).rejects.toThrow('内容为空')
    await expect(thumbnails.write(7, assetId, { bytes: Buffer.alloc(MAXIMUM_THUMBNAIL_BYTES + 1), mimeType: 'image/png' }))
      .rejects.toThrow('超过安全上限')
  })

  it('treats a damaged cache entry as a miss so the caller can regenerate', async () => {
    const { cacheRoot, thumbnails } = store()
    const directory = path.join(cacheRoot, 'user-7', assetThumbnailVersion)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, `${assetId}.png`), Buffer.alloc(MAXIMUM_THUMBNAIL_BYTES + 1))
    await expect(thumbnails.read(7, assetId)).resolves.toBeNull()
  })

  it('replaces an existing entry atomically without leaving temporary files behind', async () => {
    const { cacheRoot, thumbnails } = store()
    await thumbnails.write(7, assetId, { bytes: Buffer.from('first'), mimeType: 'image/png' })
    await thumbnails.write(7, assetId, { bytes: Buffer.from('second'), mimeType: 'image/png' })
    await expect(thumbnails.read(7, assetId)).resolves.toMatchObject({ bytes: Buffer.from('second') })
    expect(fs.readdirSync(path.join(cacheRoot, 'user-7', assetThumbnailVersion))).toEqual([`${assetId}.png`])
  })
})
