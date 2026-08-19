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
  it('moves assets to the recycle bin and back without touching any file', async () => {
    const { store } = fixture()
    await store.rename(7, assetId, '产品主视觉')
    await expect(store.softDelete(7, assetId)).resolves.toMatchObject({ deletedAt: '2026-08-14T09:00:00.000Z' })
    // The logical record survives the delete: restoring has to give the name
    // and tags back, not an anonymous file.
    await expect(store.getMany(7, [assetId])).resolves.toMatchObject({
      [assetId]: { displayName: '产品主视觉', deletedAt: '2026-08-14T09:00:00.000Z' },
    })
    await expect(store.restore(7, assetId)).resolves.toMatchObject({ displayName: '产品主视觉' })
    expect((await store.getMany(7, [assetId]))[assetId]?.deletedAt).toBeUndefined()
  })

  it('keeps the moment an asset was first thrown away', async () => {
    // Otherwise re-deleting would shuffle the bin, and a bin ordered by
    // anything other than when things went in is not a bin.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-asset-metadata-'))
    roots.push(root)
    let clock = new Date('2026-08-14T09:00:00.000Z')
    const store = new AiAssetMetadataStore({ outputRoot: root, now: () => clock })
    await store.softDelete(7, assetId)
    clock = new Date('2026-08-15T09:00:00.000Z')
    await expect(store.softDelete(7, assetId)).resolves.toMatchObject({ deletedAt: '2026-08-14T09:00:00.000Z' })
  })

  it('refuses to restore something that was never deleted', async () => {
    const { store } = fixture()
    await expect(store.restore(7, assetId)).rejects.toThrow('不在回收站')
    await store.rename(7, assetId, '产品主视觉')
    await expect(store.restore(7, assetId)).rejects.toThrow('不在回收站')
  })

  it('forgets a record entirely so it cannot outlive its file', async () => {
    const { store } = fixture()
    await store.rename(7, assetId, '产品主视觉')
    await store.forget(7, assetId)
    await expect(store.getMany(7, [assetId])).resolves.toEqual({})
    // Idempotent: purging twice must not fail the second caller.
    await expect(store.forget(7, assetId)).resolves.toBeUndefined()
  })

  it('reads state written by version 2 and rejects a deletedAt it cannot parse', async () => {
    const { root, store } = fixture()
    const accountRoot = path.join(root, 'user-7')
    fs.mkdirSync(accountRoot, { recursive: true })
    const filePath = path.join(accountRoot, 'asset-metadata.json')
    fs.writeFileSync(filePath, JSON.stringify({
      version: 2,
      userId: 7,
      items: [{ assetId, displayName: '旧名称', updatedAt: '2026-08-01T00:00:00.000Z' }],
    }), 'utf8')
    await expect(store.getMany(7, [assetId])).resolves.toMatchObject({ [assetId]: { displayName: '旧名称' } })

    fs.writeFileSync(filePath, JSON.stringify({
      version: 3,
      userId: 7,
      items: [{ assetId, deletedAt: 'yesterday', updatedAt: '2026-08-01T00:00:00.000Z' }],
    }), 'utf8')
    // Unparseable state is quarantined rather than reinterpreted, so a bad
    // timestamp cannot silently resurrect a deleted asset.
    await expect(store.getMany(7, [assetId])).resolves.toEqual({})
  })

  it('records the generating prompt beside the source and keeps it out of user edits', async () => {
    const { root, store } = fixture()
    await store.setSource(7, assetId, 'generated', '  一只在雨里的橘猫\u0007，霓虹灯背景  ')
    // Control characters would corrupt the stored view and are never typed.
    await expect(store.getMany(7, [assetId])).resolves.toMatchObject({
      [assetId]: { source: 'generated', prompt: '一只在雨里的橘猫 ，霓虹灯背景' },
    })

    // Renaming, tagging and re-marking the source must not disturb the record
    // of how the asset came to exist.
    await store.rename(7, assetId, '橘猫海报')
    await store.updatePreferences(7, assetId, { favorite: true })
    await store.setSource(7, assetId, 'generated')
    const restarted = new AiAssetMetadataStore({ outputRoot: root })
    await expect(restarted.getMany(7, [assetId])).resolves.toMatchObject({
      [assetId]: { prompt: '一只在雨里的橘猫 ，霓虹灯背景', displayName: '橘猫海报', favorite: true },
    })

    await expect(store.setSource(7, assetId, 'generated', '   ')).rejects.toThrow('提示词格式错误')
    await expect(store.setSource(7, assetId, 'generated', 42 as unknown as string)).rejects.toThrow('提示词格式错误')
  })

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

  it('persists favorites, bounded tags, source and recent usage independently from display names', async () => {
    const { root, store } = fixture()
    await expect(store.updatePreferences(7, assetId, { favorite: true, tags: ['角色', '主视觉'] })).resolves.toMatchObject({
      assetId,
      favorite: true,
      tags: ['角色', '主视觉'],
    })
    await store.setSource(7, assetId, 'imported')
    await store.markUsed(7, assetId)

    const restarted = new AiAssetMetadataStore({ outputRoot: root })
    await expect(restarted.getMany(7, [assetId])).resolves.toEqual({
      [assetId]: {
        favorite: true,
        tags: ['角色', '主视觉'],
        source: 'imported',
        lastUsedAt: '2026-08-14T09:00:00.000Z',
        updatedAt: '2026-08-14T09:00:00.000Z',
      },
    })
    await expect(store.updatePreferences(7, assetId, { favorite: false, tags: [] })).resolves.not.toHaveProperty('favorite')
    await expect(store.getMany(7, [assetId])).resolves.toMatchObject({ [assetId]: { source: 'imported' } })
  })

  it('migrates version 1 metadata and rejects invalid or duplicate tags', async () => {
    const { root, store } = fixture()
    const accountRoot = path.join(root, 'user-7')
    fs.mkdirSync(accountRoot, { recursive: true })
    fs.writeFileSync(path.join(accountRoot, 'asset-metadata.json'), JSON.stringify({
      version: 1,
      userId: 7,
      items: [{ assetId, displayName: '旧名称', updatedAt: '2026-08-14T08:00:00.000Z' }],
    }), 'utf8')
    await expect(store.getMany(7, [assetId])).resolves.toMatchObject({ [assetId]: { displayName: '旧名称' } })
    await store.markUsed(7, assetId)
    expect(JSON.parse(fs.readFileSync(path.join(accountRoot, 'asset-metadata.json'), 'utf8'))).toMatchObject({ version: 4 })

    await expect(store.updatePreferences(7, assetId, { tags: ['重复', '重复'] })).rejects.toThrow('不能重复')
    await expect(store.updatePreferences(7, assetId, { tags: ['x'.repeat(33)] })).rejects.toThrow('标签格式错误')
    await expect(store.updatePreferences(7, assetId, { tags: Array.from({ length: 13 }, (_, index) => String(index)) })).rejects.toThrow('标签格式错误')
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
      version: 4,
      userId: 7,
      items: [{ assetId, displayName: '恢复后的名称' }],
    })
  })
})
