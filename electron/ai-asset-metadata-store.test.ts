import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AiAssetMetadataStore } from './ai-asset-metadata-store'

const roots: string[] = []
const assetId = 'a'.repeat(43)

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-asset-metadata-'))
  roots.push(root)
  return {
    root,
    store: new AiAssetMetadataStore({
      outputRoot: root,
      now: () => new Date('2026-08-14T09:00:00.000Z'),
      randomUUID: () => 'metadata-backup-id',
    }),
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('AiAssetMetadataStore', () => {
  it('persists UTF-8 display names while isolating the same asset id by account', async () => {
    const { root, store } = fixture()
    await expect(store.rename(7, assetId, ' 产品主视觉 ')).resolves.toMatchObject({
      assetId,
      displayName: '产品主视觉',
      updatedAt: '2026-08-14T09:00:00.000Z',
    })
    await expect(store.getMany(8, [assetId])).resolves.toEqual({})
    await expect(store.getMany(7, [assetId])).resolves.toEqual({
      [assetId]: { displayName: '产品主视觉', updatedAt: '2026-08-14T09:00:00.000Z' },
    })

    const restarted = new AiAssetMetadataStore({ outputRoot: root })
    await expect(restarted.getMany(7, [assetId])).resolves.toMatchObject({
      [assetId]: { displayName: '产品主视觉' },
    })
  })

  it('accepts 1-120 characters and rejects empty, oversized or path-like names', async () => {
    const { store } = fixture()
    await expect(store.rename(7, assetId, '名')).resolves.toMatchObject({ displayName: '名' })
    await expect(store.rename(7, assetId, 'x'.repeat(120))).resolves.toMatchObject({ displayName: 'x'.repeat(120) })
    for (const name of ['', '   ', 'x'.repeat(121), 'bad\0name', 'folder/name', 'folder\\name']) {
      await expect(store.rename(7, assetId, name)).rejects.toThrow('显示名称格式错误')
    }
  })

  it('backs up malformed state and safely starts a fresh metadata file', async () => {
    const { root, store } = fixture()
    const accountRoot = path.join(root, 'user-7')
    fs.mkdirSync(accountRoot, { recursive: true })
    fs.writeFileSync(path.join(accountRoot, 'asset-metadata.json'), '{broken', 'utf8')

    await expect(store.getMany(7, [assetId])).resolves.toEqual({})
    expect(fs.readdirSync(accountRoot)).toContain('asset-metadata.json.corrupt-1786698000000-metadata-backup-id.bak')
    await store.rename(7, assetId, '恢复后的名称')
    expect(JSON.parse(fs.readFileSync(path.join(accountRoot, 'asset-metadata.json'), 'utf8'))).toMatchObject({
      version: 1,
      userId: 7,
      items: [{ assetId, displayName: '恢复后的名称' }],
    })
  })
})
