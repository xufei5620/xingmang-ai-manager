import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { AiAssetMetadataStore, aiAssetMetadataShardOf, mergeAiAssetMetadataItems } from './ai-asset-metadata-store'

const roots: string[] = []
const assetId = 'a'.repeat(43)

function idFor(seed: string): string {
  return createHash('sha256').update(seed).digest('base64url')
}

function shardFiles(accountRoot: string): string[] {
  const directory = path.join(accountRoot, 'asset-metadata')
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => /^shard-[0-9a-f]\.json$/.test(name)).sort() : []
}

function readShards(accountRoot: string): { version: number; userId: number; shard: number; items: { assetId: string }[] }[] {
  return shardFiles(accountRoot).map((name) => JSON.parse(fs.readFileSync(path.join(accountRoot, 'asset-metadata', name), 'utf8')))
}

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
    fs.writeFileSync(path.join(accountRoot, 'asset-metadata.json'), JSON.stringify({
      version: 2,
      userId: 7,
      items: [{ assetId, displayName: '旧名称', updatedAt: '2026-08-01T00:00:00.000Z' }],
    }), 'utf8')
    await expect(store.getMany(7, [assetId])).resolves.toMatchObject({ [assetId]: { displayName: '旧名称' } })

    const otherRoot = path.join(root, 'user-8')
    fs.mkdirSync(otherRoot, { recursive: true })
    fs.writeFileSync(path.join(otherRoot, 'asset-metadata.json'), JSON.stringify({
      version: 3,
      userId: 8,
      items: [{ assetId, deletedAt: 'yesterday', updatedAt: '2026-08-01T00:00:00.000Z' }],
    }), 'utf8')
    // Unparseable state is quarantined rather than reinterpreted, so a bad
    // timestamp cannot silently resurrect a deleted asset.
    await expect(store.getMany(8, [assetId])).resolves.toEqual({})
    expect(fs.readdirSync(otherRoot)).toContain('asset-metadata.json.corrupt-1786698000000-metadata-backup-id.bak')
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

  it('appends a tag next to the user tags and leaves a duplicate or full list as it is', async () => {
    const { root, store } = fixture()
    await store.setSource(7, assetId, 'generated', '一只猫')
    await expect(store.addTag(7, assetId, '已停止，但已扣费')).resolves.toMatchObject({ tags: ['已停止，但已扣费'], source: 'generated' })
    await store.updatePreferences(7, assetId, { tags: ['已停止，但已扣费', '角色'] })
    await expect(store.addTag(7, assetId, '已停止，但已扣费')).resolves.toMatchObject({ tags: ['已停止，但已扣费', '角色'] })
    await expect(store.addTag(7, assetId, '主视觉')).resolves.toMatchObject({ tags: ['已停止，但已扣费', '角色', '主视觉'] })

    const full = Array.from({ length: 12 }, (_, index) => `标签${index}`)
    await store.updatePreferences(7, assetId, { tags: full })
    await expect(store.addTag(7, assetId, '再加一个')).resolves.toMatchObject({ tags: full })
    await expect(store.addTag(7, assetId, 'x'.repeat(33))).rejects.toThrow('标签格式错误')

    const restarted = new AiAssetMetadataStore({ outputRoot: root })
    await expect(restarted.getMany(7, [assetId])).resolves.toMatchObject({ [assetId]: { tags: full, prompt: '一只猫' } })
    await expect(restarted.getMany(8, [assetId])).resolves.toEqual({})
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
    expect(readShards(accountRoot)).toEqual([expect.objectContaining({
      version: 5,
      userId: 7,
      items: [expect.objectContaining({ assetId, displayName: '旧名称', lastUsedAt: '2026-08-14T09:00:00.000Z' })],
    })])
    expect(fs.existsSync(path.join(accountRoot, 'asset-metadata.json'))).toBe(false)

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

  it('backs up malformed state and safely starts fresh metadata', async () => {
    const { root, store } = fixture()
    const accountRoot = path.join(root, 'user-7')
    fs.mkdirSync(accountRoot, { recursive: true })
    fs.writeFileSync(path.join(accountRoot, 'asset-metadata.json'), '{broken', 'utf8')

    await expect(store.getMany(7, [assetId])).resolves.toEqual({})
    expect(fs.readFileSync(path.join(accountRoot, 'asset-metadata.json.corrupt-1786698000000-metadata-backup-id.bak'), 'utf8')).toBe('{broken')
    await store.rename(7, assetId, '恢复后的名称')
    expect(readShards(accountRoot)).toEqual([{
      version: 5,
      userId: 7,
      shard: aiAssetMetadataShardOf(assetId),
      items: [{ assetId, displayName: '恢复后的名称', updatedAt: '2026-08-14T09:00:00.000Z' }],
    }])
    // The new layout never writes the single file again.
    expect(fs.existsSync(path.join(accountRoot, 'asset-metadata.json'))).toBe(false)
  })

  it('backs up a shard holding a record that belongs to another shard', async () => {
    const { root, store } = fixture()
    const shardDirectory = path.join(root, 'user-7', 'asset-metadata')
    fs.mkdirSync(shardDirectory, { recursive: true })
    const wrong = (aiAssetMetadataShardOf(assetId) + 1) % 16
    const misplaced = path.join(shardDirectory, `shard-${wrong.toString(16)}.json`)
    fs.writeFileSync(misplaced, JSON.stringify({
      version: 5,
      userId: 7,
      shard: wrong,
      items: [{ assetId, displayName: '放错了', updatedAt: '2026-08-01T00:00:00.000Z' }],
    }), 'utf8')

    await expect(store.getAll(7)).resolves.toEqual({})
    expect(fs.existsSync(misplaced)).toBe(false)
    expect(fs.readdirSync(shardDirectory)).toContain(`shard-${wrong.toString(16)}.json.corrupt-1786698000000-metadata-backup-id.bak`)
  })

  it('merges legacy records without dropping either side and is idempotent', async () => {
    const { store } = fixture()
    const other = 'b'.repeat(43)
    await store.updatePreferences(7, assetId, { favorite: true })
    const legacy = JSON.stringify({
      version: 4,
      userId: 7,
      items: [
        { assetId: other, tags: ['旧'], deletedAt: '2026-08-01T09:00:00.000Z', updatedAt: '2026-08-01T09:00:00.000Z' },
        { assetId, prompt: '一只猫', favorite: true, updatedAt: '2026-08-01T09:00:00.000Z' },
      ],
    })

    await store.mergeLegacy(7, legacy)
    const once = await store.getAll(7)
    await store.mergeLegacy(7, legacy)

    expect(once).toEqual({
      [assetId]: { favorite: true, prompt: '一只猫', updatedAt: '2026-08-14T09:00:00.000Z' },
      [other]: { tags: ['旧'], deletedAt: '2026-08-01T09:00:00.000Z', updatedAt: '2026-08-01T09:00:00.000Z' },
    })
    await expect(store.getAll(7)).resolves.toEqual(once)
  })

  it('keeps every prompt and still deletes long after the old single file would have filled up', async () => {
    // Before 0.2.24 one file held at most 2 MB and 5,000 records: with prompts
    // of about 300 characters it filled before 2,000 works, then new prompts
    // were dropped silently and, a little later, deleting failed too (M-1).
    const { root, store } = fixture()
    const prompt = '雨夜里的橘猫，霓虹灯倒影'.repeat(25)
    const items = Array.from({ length: 6_000 }, (_, index) => ({
      assetId: idFor(`asset-${index}`),
      source: 'generated',
      prompt,
      updatedAt: '2026-08-01T00:00:00.000Z',
    }))
    await store.mergeLegacy(7, JSON.stringify({ version: 4, userId: 7, items }))

    const accountRoot = path.join(root, 'user-7')
    const bytes = shardFiles(accountRoot)
      .reduce((total, name) => total + fs.statSync(path.join(accountRoot, 'asset-metadata', name)).size, 0)
    // Well past both old ceilings: 2 MB and 5,000 records.
    expect(bytes).toBeGreaterThan(2 * 2 * 1024 * 1024)

    const latest = idFor('asset-latest')
    await expect(store.setSource(7, latest, 'generated', prompt)).resolves.toMatchObject({ prompt })
    await expect(store.rename(7, latest, '最新一张')).resolves.toMatchObject({ displayName: '最新一张' })
    await expect(store.softDelete(7, items[0].assetId)).resolves.toMatchObject({ deletedAt: '2026-08-14T09:00:00.000Z' })
    await expect(store.restore(7, items[0].assetId)).resolves.not.toHaveProperty('deletedAt')
    await store.forget(7, items[1].assetId)

    const restarted = new AiAssetMetadataStore({ outputRoot: root })
    const all = await restarted.getAll(7)
    expect(Object.keys(all)).toHaveLength(6_000)
    expect(all[latest]).toMatchObject({ prompt, displayName: '最新一张' })
    expect(all[items[1].assetId]).toBeUndefined()
    expect(Object.values(all).every((record) => record.prompt === prompt)).toBe(true)
  })

  it('moves the single file into shards once and keeps it byte for byte as a backup', async () => {
    const { root, store } = fixture()
    const accountRoot = path.join(root, 'user-7')
    fs.mkdirSync(accountRoot, { recursive: true })
    const items = Array.from({ length: 40 }, (_, index) => ({
      assetId: idFor(`legacy-${index}`),
      displayName: `作品 ${index}`,
      ...(index % 3 === 0 ? { favorite: true } : {}),
      ...(index % 4 === 0 ? { tags: ['海报'] } : {}),
      ...(index % 5 === 0 ? { deletedAt: '2026-08-02T00:00:00.000Z' } : {}),
      source: 'generated',
      prompt: `第 ${index} 张的提示词`,
      updatedAt: '2026-08-01T00:00:00.000Z',
    }))
    const original = `${JSON.stringify({ version: 4, userId: 7, items }, null, 2)}\n`
    fs.writeFileSync(path.join(accountRoot, 'asset-metadata.json'), original, 'utf8')

    const migrated = await store.getAll(7)
    expect(migrated).toEqual(Object.fromEntries(items.map(({ assetId: id, ...metadata }) => [id, metadata])))
    expect(fs.existsSync(path.join(accountRoot, 'asset-metadata.json'))).toBe(false)
    expect(fs.readFileSync(path.join(accountRoot, 'asset-metadata.json.migrated-1786698000000-metadata-backup-id.bak'), 'utf8')).toBe(original)
    expect(readShards(accountRoot).flatMap((shard) => shard.items)).toHaveLength(40)

    // The backup is never merged again: something forgotten stays forgotten.
    await store.forget(7, items[0].assetId)
    const restarted = new AiAssetMetadataStore({ outputRoot: root })
    const after = await restarted.getAll(7)
    expect(after[items[0].assetId]).toBeUndefined()
    expect(Object.keys(after)).toHaveLength(39)
  })

  it('leaves a single file it cannot read where it is and adopts it once it can', async () => {
    const { root, store } = fixture()
    const accountRoot = path.join(root, 'user-7')
    fs.mkdirSync(accountRoot, { recursive: true })
    const legacyPath = path.join(accountRoot, 'asset-metadata.json')
    const content = JSON.stringify({ version: 4, userId: 7, items: [{ assetId, displayName: '旧名称', updatedAt: '2026-08-01T00:00:00.000Z' }] })
    fs.writeFileSync(legacyPath, content, 'utf8')
    // A second link makes the safe reader refuse the file, as an antivirus
    // lock would: it must not be taken for a broken file and set aside.
    const extraLink = path.join(root, 'extra-link.json')
    fs.linkSync(legacyPath, extraLink)
    const other = 'b'.repeat(43)

    await expect(store.getAll(7)).resolves.toEqual({})
    await store.rename(7, other, '升级后改的名')
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(content)
    expect(fs.readdirSync(accountRoot).filter((name) => name.endsWith('.bak'))).toEqual([])

    fs.rmSync(extraLink)
    await expect(store.getAll(7)).resolves.toMatchObject({
      [assetId]: { displayName: '旧名称' },
      [other]: { displayName: '升级后改的名' },
    })
    expect(fs.existsSync(legacyPath)).toBe(false)
  })

  it('keeps the single file and still shows its records while no shard can be written', async () => {
    const { root, store } = fixture()
    const accountRoot = path.join(root, 'user-7')
    fs.mkdirSync(accountRoot, { recursive: true })
    const legacyPath = path.join(accountRoot, 'asset-metadata.json')
    const content = JSON.stringify({ version: 4, userId: 7, items: [{ assetId, prompt: '一只猫', deletedAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z' }] })
    fs.writeFileSync(legacyPath, content, 'utf8')
    // A plain file where the shard folder belongs: every shard write fails.
    const blocker = path.join(accountRoot, 'asset-metadata')
    fs.writeFileSync(blocker, '', 'utf8')

    await expect(store.getAll(7)).resolves.toEqual({
      [assetId]: { prompt: '一只猫', deletedAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z' },
    })
    await expect(store.getMany(7, [assetId])).resolves.toMatchObject({ [assetId]: { prompt: '一只猫' } })
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(content)

    fs.rmSync(blocker)
    await expect(store.getAll(7)).resolves.toMatchObject({ [assetId]: { prompt: '一只猫' } })
    expect(fs.existsSync(legacyPath)).toBe(false)
    expect(readShards(accountRoot).flatMap((shard) => shard.items)).toHaveLength(1)
  })

  it('lets the recycle bin empty a shard that is too full to take anything new', async () => {
    const { root, store } = fixture()
    await store.setSource(7, assetId, 'generated', '猫'.repeat(2_000))
    const accountRoot = path.join(root, 'user-7')
    const [name] = shardFiles(accountRoot)
    const size = fs.statSync(path.join(accountRoot, 'asset-metadata', name)).size
    // The ceiling sits just above this shard, so the reserve kept for the
    // recycle bin is all the room that is left.
    const full = new AiAssetMetadataStore({
      outputRoot: root,
      now: () => new Date('2026-08-14T09:00:00.000Z'),
      maximumShardBytes: size + 200,
    })

    await expect(full.rename(7, assetId, '新名字')).rejects.toThrow('安全上限')
    await expect(full.softDelete(7, assetId)).resolves.toMatchObject({ deletedAt: '2026-08-14T09:00:00.000Z' })
    await expect(full.restore(7, assetId)).resolves.not.toHaveProperty('deletedAt')
    await full.softDelete(7, assetId)
    await expect(full.forget(7, assetId)).resolves.toBeUndefined()
    await expect(full.getAll(7)).resolves.toEqual({})
  })

  it('merges a shard carried over from another folder and refuses one filed under the wrong shard', async () => {
    const { store } = fixture()
    const shard = aiAssetMetadataShardOf(assetId)
    const record = { assetId, favorite: true, updatedAt: '2026-08-01T00:00:00.000Z' }
    await store.mergeLegacy(7, JSON.stringify({ version: 5, userId: 7, shard, items: [record] }))
    await expect(store.getAll(7)).resolves.toEqual({ [assetId]: { favorite: true, updatedAt: '2026-08-01T00:00:00.000Z' } })

    await expect(store.mergeLegacy(7, JSON.stringify({ version: 5, userId: 7, shard: (shard + 1) % 16, items: [record] }))).rejects.toThrow()
    await expect(store.mergeLegacy(7, JSON.stringify({ version: 5, userId: 8, shard, items: [record] }))).rejects.toThrow()
    await expect(store.mergeLegacy(7, JSON.stringify({ version: 5, userId: 7, shard: 16, items: [] }))).rejects.toThrow()
  })

  it('refuses a legacy file for another account or one it cannot parse', async () => {
    const { store } = fixture()
    await expect(store.mergeLegacy(7, JSON.stringify({ version: 4, userId: 8, items: [] }))).rejects.toThrow()
    await expect(store.mergeLegacy(7, '{')).rejects.toThrow()
  })
})

describe('aiAssetMetadataShardOf', () => {
  it('spreads identifiers over all sixteen shards', () => {
    const counts = new Array<number>(16).fill(0)
    for (let index = 0; index < 1_600; index += 1) counts[aiAssetMetadataShardOf(idFor(String(index)))] += 1
    expect(counts.every((count) => count > 60 && count < 140)).toBe(true)
    expect(aiAssetMetadataShardOf(assetId)).toBe(aiAssetMetadataShardOf('a'.repeat(43)))
  })
})

describe('mergeAiAssetMetadataItems', () => {
  it('lets the newer record decide toggles and fills in write-once fields from the older one', () => {
    const merged = mergeAiAssetMetadataItems(
      [{ assetId, favorite: true, updatedAt: '2026-09-01T00:00:00.000Z', lastUsedAt: '2026-09-01T00:00:00.000Z' }],
      [{ assetId, displayName: '海报', source: 'generated', prompt: '猫', deletedAt: '2026-09-02T00:00:00.000Z', lastUsedAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' }],
    )
    expect(merged).toEqual([{
      assetId,
      displayName: '海报',
      source: 'generated',
      prompt: '猫',
      deletedAt: '2026-09-02T00:00:00.000Z',
      lastUsedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    }])
  })
})
