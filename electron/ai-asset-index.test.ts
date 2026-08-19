import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { indexOwnedAssetFiles } from './ai-asset-index'

const imagePattern = /^xingmang-([A-Za-z0-9_-]{43})\.(png|jpg|webp)$/
const roots: string[] = []

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-asset-index-'))
  roots.push(root)
  return root
}

function writeAsset(root: string, date: string, assetId: string, extension = 'png'): void {
  const directory = path.join(root, date)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, `xingmang-${assetId}.${extension}`), 'x')
}

function assetId(seed: string): string {
  return seed.padEnd(43, 'z').slice(0, 43)
}

afterEach(() => {
  while (roots.length > 0) fs.rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('indexOwnedAssetFiles', () => {
  it('returns an empty index when the account has never stored anything', async () => {
    const root = temporaryRoot()
    await expect(indexOwnedAssetFiles({
      accountRoot: path.join(root, 'user-9'), mediaType: 'image', filePattern: imagePattern, label: 'AI 图片资产',
    })).resolves.toEqual([])
  })

  it('indexes every matching file across date directories without reading media', async () => {
    const root = temporaryRoot()
    writeAsset(root, '2026-08-12', assetId('old'))
    writeAsset(root, '2026-08-14', assetId('new'), 'webp')
    fs.writeFileSync(path.join(root, '2026-08-14', 'notes.txt'), 'ignored')
    fs.mkdirSync(path.join(root, 'not-a-date'), { recursive: true })
    fs.writeFileSync(path.join(root, 'not-a-date', `xingmang-${assetId('hid')}.png`), 'x')

    const index = await indexOwnedAssetFiles({
      accountRoot: root, mediaType: 'image', filePattern: imagePattern, label: 'AI 图片资产',
    })
    expect(index.map((entry) => entry.assetId)).toEqual([assetId('new'), assetId('old')])
    expect(index[0]).toMatchObject({ extension: 'webp', mediaType: 'image', fileName: `xingmang-${assetId('new')}.webp` })
    expect(new Date(index[0]?.createdAt ?? '').getTime()).not.toBeNaN()
  })

  it('keeps the newest copy when one identifier appears under two date directories', async () => {
    const root = temporaryRoot()
    writeAsset(root, '2026-08-10', assetId('dup'))
    writeAsset(root, '2026-08-15', assetId('dup'))
    const index = await indexOwnedAssetFiles({
      accountRoot: root, mediaType: 'image', filePattern: imagePattern, label: 'AI 图片资产',
    })
    expect(index).toHaveLength(1)
  })

  it('stops at the requested ceiling', async () => {
    const root = temporaryRoot()
    for (let position = 0; position < 5; position += 1) writeAsset(root, '2026-08-14', assetId(`a${position}`))
    const index = await indexOwnedAssetFiles({
      accountRoot: root, mediaType: 'image', filePattern: imagePattern, label: 'AI 图片资产', maximum: 3,
    })
    expect(index).toHaveLength(3)
  })
})
