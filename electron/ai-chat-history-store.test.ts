import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiChatHistoryWrite } from './ipc-contract'
import { chatHistoryDirectoryName, createAiChatHistoryStore, MAX_CHAT_HISTORY_SCOPES, parseAiChatHistoryScope, parseAiChatHistoryWrite } from './ai-chat-history-store'

const scope = 'xm-account:7'
const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-chat-history-'))
  temporaryRoots.push(directory)
  return path.join(directory, 'chat-history')
}

function write(patch: Partial<AiChatHistoryWrite> = {}): AiChatHistoryWrite {
  return { scope, index: '{"version":3}', keys: ['a'], put: [{ key: 'a', content: '{"conversation":"a"}' }], ...patch }
}

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('ai chat history store', () => {
  it('reports no record before anything was saved, without creating a directory', async () => {
    const root = temporaryRoot()
    const store = createAiChatHistoryStore({ root })
    await expect(store.read(scope)).resolves.toEqual({ index: null, conversations: [] })
    expect(fs.existsSync(root)).toBe(false)
  })

  it('keeps each account under a hashed directory and reads back exactly what was written', async () => {
    const root = temporaryRoot()
    const store = createAiChatHistoryStore({ root })
    await store.write(write({ keys: ['a', 'b'], put: [{ key: 'a', content: '甲' }, { key: 'b', content: '乙' }] }))
    expect(fs.readdirSync(root)).toEqual([chatHistoryDirectoryName(scope)])
    expect(chatHistoryDirectoryName(scope)).toMatch(/^[0-9a-f]{32}$/)
    const snapshot = await store.read(scope)
    expect(snapshot.index).toBe('{"version":3}')
    expect(snapshot.conversations.sort((left, right) => left.key.localeCompare(right.key))).toEqual([{ key: 'a', content: '甲' }, { key: 'b', content: '乙' }])
    await expect(store.read('xm-account:8')).resolves.toEqual({ index: null, conversations: [] })
  })

  it('stores far more than the former 4 MB renderer limit', async () => {
    const store = createAiChatHistoryStore({ root: temporaryRoot() })
    const large = '文'.repeat(3 * 1024 * 1024)
    await store.write(write({ keys: ['a', 'b'], put: [{ key: 'a', content: large }, { key: 'b', content: large }] }))
    const snapshot = await store.read(scope)
    expect(snapshot.conversations.map((file) => file.content.length)).toEqual([large.length, large.length])
  })

  it('rewrites only the listed conversations and removes the ones the index dropped', async () => {
    const root = temporaryRoot()
    const store = createAiChatHistoryStore({ root })
    await store.write(write({ keys: ['a', 'b', 'c'], put: [{ key: 'a', content: 'A1' }, { key: 'b', content: 'B1' }, { key: 'c', content: 'C1' }] }))
    await store.write(write({ index: 'second', keys: ['a', 'b'], put: [{ key: 'b', content: 'B2' }] }))
    const snapshot = await store.read(scope)
    expect(snapshot.index).toBe('second')
    expect(Object.fromEntries(snapshot.conversations.map((file) => [file.key, file.content]))).toEqual({ a: 'A1', b: 'B2' })
    expect(fs.readdirSync(path.join(root, chatHistoryDirectoryName(scope))).sort()).toEqual(['c-a.json', 'c-b.json', 'index.json'])
  })

  it('refuses to keep a conversation whose file is gone instead of saving an index that cannot be read back', async () => {
    const store = createAiChatHistoryStore({ root: temporaryRoot() })
    await store.write(write())
    await expect(store.write(write({ index: 'second', keys: ['a', 'missing'], put: [] }))).rejects.toThrow('缺少已保存的对话')
    expect((await store.read(scope)).index).toBe('{"version":3}')
  })

  it('applies the total size bound on both write and read', async () => {
    const root = temporaryRoot()
    const small = createAiChatHistoryStore({ root, maxTotalBytes: 1024 * 1024 })
    await expect(small.write(write({ put: [{ key: 'a', content: 'x'.repeat(1024 * 1024) }] }))).rejects.toThrow('本次没有保存')
    await expect(small.read(scope)).resolves.toEqual({ index: null, conversations: [] })
    await createAiChatHistoryStore({ root }).write(write({ put: [{ key: 'a', content: 'x'.repeat(1024 * 1024) }] }))
    await expect(small.read(scope)).rejects.toThrow('原始记录已保留')
  })

  it('runs saves for one account strictly in order', async () => {
    const store = createAiChatHistoryStore({ root: temporaryRoot() })
    const writes = ['1', '2', '3'].map((content) => store.write(write({ index: content, put: [{ key: 'a', content }] })))
    await store.idle()
    await Promise.all(writes)
    const snapshot = await store.read(scope)
    expect(snapshot).toEqual({ index: '3', conversations: [{ key: 'a', content: '3' }] })
  })

  it('lets a read wait for saves already accepted for that account', async () => {
    const store = createAiChatHistoryStore({ root: temporaryRoot() })
    await store.write(write({ keys: ['a', 'b'], put: [{ key: 'a', content: 'A' }, { key: 'b', content: 'B' }] }))
    const saving = store.write(write({ index: 'final save', keys: ['b', 'c'], put: [{ key: 'c', content: 'C' }] }))
    const snapshot = await store.read(scope)
    await saving
    expect(snapshot.index).toBe('final save')
    expect(snapshot.conversations.map((file) => file.key).sort()).toEqual(['b', 'c'])
  })

  it('lets a failed save be followed by a successful one', async () => {
    const store = createAiChatHistoryStore({ root: temporaryRoot() })
    await store.write(write())
    const failed = store.write(write({ keys: ['a', 'missing'], put: [] }))
    const next = store.write(write({ index: 'after failure' }))
    await expect(failed).rejects.toThrow()
    await expect(next).resolves.toBeUndefined()
    expect((await store.read(scope)).index).toBe('after failure')
  })

  it('refuses to open a new account directory past the account limit but keeps saving existing ones', async () => {
    const root = temporaryRoot()
    const store = createAiChatHistoryStore({ root })
    await store.write(write())
    for (let index = 1; index < MAX_CHAT_HISTORY_SCOPES; index += 1) fs.mkdirSync(path.join(root, `placeholder-${index}`))
    await expect(store.write(write({ scope: 'xm-account:99' }))).rejects.toThrow('账号过多')
    await expect(store.write(write({ index: 'still saving' }))).resolves.toBeUndefined()
    expect((await store.read(scope)).index).toBe('still saving')
  })

  it('rejects a history directory that is a link to somewhere else', async () => {
    const root = temporaryRoot()
    fs.mkdirSync(root, { recursive: true })
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-chat-history-elsewhere-'))
    temporaryRoots.push(elsewhere)
    fs.writeFileSync(path.join(elsewhere, 'index.json'), 'planted')
    fs.symlinkSync(elsewhere, path.join(root, chatHistoryDirectoryName(scope)), process.platform === 'win32' ? 'junction' : 'dir')
    const store = createAiChatHistoryStore({ root })
    await expect(store.read(scope)).rejects.toThrow()
    await expect(store.write(write())).rejects.toThrow()
    expect(fs.readFileSync(path.join(elsewhere, 'index.json'), 'utf8')).toBe('planted')
  })

  it('validates every field of a save request', () => {
    expect(parseAiChatHistoryWrite(write())).toEqual(write())
    expect(() => parseAiChatHistoryWrite(null)).toThrow('格式无效')
    expect(() => parseAiChatHistoryWrite(write({ scope: '' }))).toThrow('归属无效')
    expect(() => parseAiChatHistoryWrite(write({ scope: 'a\nb' }))).toThrow('归属无效')
    expect(() => parseAiChatHistoryWrite(write({ keys: ['../a'], put: [] }))).toThrow('标识无效')
    expect(() => parseAiChatHistoryWrite(write({ keys: ['a', 'a'], put: [] }))).toThrow('重复')
    expect(() => parseAiChatHistoryWrite(write({ keys: Array.from({ length: 51 }, (_, index) => `k${index}`), put: [] }))).toThrow('数量')
    expect(() => parseAiChatHistoryWrite(write({ put: [{ key: 'b', content: 'x' }] }))).toThrow('写入列表无效')
    expect(() => parseAiChatHistoryWrite(write({ keys: ['a', 'b'], put: [{ key: 'a', content: 'x' }, { key: 'a', content: 'y' }] }))).toThrow('重复')
    expect(() => parseAiChatHistoryWrite({ ...write(), index: 42 })).toThrow('格式无效')
    expect(parseAiChatHistoryScope('solov/7')).toBe('solov/7')
    expect(() => parseAiChatHistoryScope('x'.repeat(257))).toThrow('归属无效')
  })
})
