import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CanvasPromptPresetStore } from './canvas-prompt-preset-store'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-prompt-presets-'))
  roots.push(root)
  let id = 0
  const store = new CanvasPromptPresetStore({
    rootDirectory: root,
    now: () => new Date('2026-08-13T03:00:00.000Z'),
    randomUUID: () => `preset-id-${String(++id).padStart(16, '0')}`,
  })
  return { root, store }
}

describe('CanvasPromptPresetStore', () => {
  it('creates, updates, deletes and isolates UTF-8 presets by account', async () => {
    const { root, store } = fixture()
    const created = await store.create(7, { name: '商品光影', prompt: '保持主体，调整光影', tags: ['商品'] })
    expect(await store.list(8)).toEqual([])
    expect((await store.list(7))[0]).toMatchObject({ name: '商品光影', provenance: 'user-created' })
    await expect(store.update(7, { id: created.id, name: '棚拍商品' })).resolves.toMatchObject({ name: '棚拍商品' })
    await expect(store.delete(7, created.id)).resolves.toBe(true)
    await expect(store.delete(7, created.id)).resolves.toBe(false)
    const bytes = fs.readFileSync(path.join(root, 'user-7', 'prompt-presets.json'))
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false)
  })

  it('serializes concurrent mutations and survives a new store instance', async () => {
    const { root, store } = fixture()
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.create(7, {
      name: `预设 ${index}`, prompt: `内容 ${index}`,
    })))
    expect(await new CanvasPromptPresetStore({ rootDirectory: root }).list(7)).toHaveLength(20)
  })

  it('backs up corrupt data and rejects hostile inputs', async () => {
    const { root, store } = fixture()
    await store.create(7, { name: '有效', prompt: '有效内容' })
    const filePath = path.join(root, 'user-7', 'prompt-presets.json')
    fs.writeFileSync(filePath, '{invalid', 'utf8')
    expect(await store.list(7)).toEqual([])
    expect(fs.readdirSync(path.dirname(filePath)).some((entry) => entry.includes('.corrupt-'))).toBe(true)
    await expect(store.create(7, { name: 'bad\0', prompt: '内容' })).rejects.toThrow('名称格式')
    await expect(store.create(7, { name: '重复标签', prompt: '内容', tags: ['a', 'a'] })).rejects.toThrow('不能重复')
  })
})
