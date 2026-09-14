import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AnnouncementReadStore } from './announcement-read-store'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-announcement-reads-'))
  roots.push(root)
  const directory = path.join(root, 'announcement-reads')
  return { root, directory, filePath: path.join(directory, 'xm-account-7.json'), store: new AnnouncementReadStore(directory) }
}

function id(index: number, kind = 'newapi'): string { return `${kind}-${index.toString(16).padStart(64, '0')}` }

describe('AnnouncementReadStore', () => {
  it('persists read markers across process-like store recreation and isolates accounts', async () => {
    const f = fixture()
    await expect(f.store.sync('xm-account:7', [id(1), id(2, 'legacy'), id(1)])).resolves.toEqual([id(1), id(2, 'legacy')])
    const restarted = new AnnouncementReadStore(f.directory)
    await expect(restarted.sync('xm-account:7', [])).resolves.toEqual([id(1), id(2, 'legacy')])
    await expect(restarted.sync('xm-account:8', [])).resolves.toEqual([])
    await restarted.sync('xm-account:8', [id(3)])
    await expect(restarted.sync('xm-account:7', [id(4)])).resolves.toEqual([id(1), id(2, 'legacy'), id(4)])
    const bytes = fs.readFileSync(f.filePath)
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false)
    expect(fs.readdirSync(f.directory).sort()).toEqual(['xm-account-7.json', 'xm-account-8.json'])
  })

  it('avoids writes when reading or synchronizing unchanged state', async () => {
    const f = fixture()
    await expect(f.store.sync('xm-account:7', [])).resolves.toEqual([])
    expect(fs.existsSync(f.directory)).toBe(false)
    await f.store.sync('xm-account:7', [id(1), id(2)])
    const oldTime = new Date('2020-01-01T00:00:00Z')
    fs.utimesSync(f.filePath, oldTime, oldTime)
    const before = fs.statSync(f.filePath).mtimeMs
    await f.store.sync('xm-account:7', [])
    await f.store.sync('xm-account:7', [id(1), id(1)])
    await f.store.sync('xm-account:7', [id(2), id(1)])
    expect(fs.statSync(f.filePath).mtimeMs).toBe(before)
  })

  it('serializes concurrent merges without losing already read entries', async () => {
    const f = fixture()
    await Promise.all(Array.from({ length: 30 }, (_, index) => f.store.sync('xm-account:7', [id(index)])))
    await expect(new AnnouncementReadStore(f.directory).sync('xm-account:7', [])).resolves.toEqual(Array.from({ length: 30 }, (_, index) => id(index)))
  })

  it('retains only the most recent 200 distinct markers', async () => {
    const f = fixture()
    await f.store.sync('xm-account:7', Array.from({ length: 200 }, (_, index) => id(index)))
    const result = await f.store.sync('xm-account:7', [id(0), id(200), id(200)])
    expect(result).toHaveLength(200)
    expect(result).not.toContain(id(0))
    expect(result.slice(-2)).toEqual([id(199), id(200)])
    await expect(new AnnouncementReadStore(f.directory).sync('xm-account:7', [])).resolves.toEqual(result)
  })

  it.each([
    '{invalid', '',
    JSON.stringify({ version: 2, scope: 'xm-account:7', ids: [] }),
    JSON.stringify({ version: 1, scope: 'xm-account:8', ids: [] }),
    JSON.stringify({ version: 1, scope: 'xm-account:7', ids: [id(1), id(1)] }),
    JSON.stringify({ version: 1, scope: 'xm-account:7', ids: ['../unsafe'] }),
    JSON.stringify({ version: 1, scope: 'xm-account:7', ids: [], extra: true }),
  ])('preserves corrupt state and reports failure instead of clearing it: %#', async (content) => {
    const f = fixture()
    fs.mkdirSync(f.directory)
    fs.writeFileSync(f.filePath, content, 'utf8')
    await expect(f.store.sync('xm-account:7', [id(1)])).rejects.toThrow('原文件已保留')
    expect(fs.readFileSync(f.filePath, 'utf8')).toBe(content)
    expect(fs.readdirSync(f.directory)).toEqual(['xm-account-7.json'])
    fs.writeFileSync(f.filePath, JSON.stringify({ version: 1, scope: 'xm-account:7', ids: [id(2)] }), 'utf8')
    await expect(f.store.sync('xm-account:7', [id(1)])).resolves.toEqual([id(2), id(1)])
  })

  it('rejects oversized or linked files without overwriting either target', async () => {
    const f = fixture()
    fs.mkdirSync(f.directory)
    const content = 'x'.repeat(24 * 1024 + 1)
    fs.writeFileSync(f.filePath, content, 'utf8')
    await expect(f.store.sync('xm-account:7', [id(1)])).rejects.toThrow('安全上限')
    expect(fs.readFileSync(f.filePath, 'utf8')).toBe(content)
    const linked = path.join(f.root, 'linked.json')
    fs.linkSync(f.filePath, linked)
    await expect(f.store.sync('xm-account:7', [id(1)])).rejects.toThrow('单链接普通文件')
    expect(fs.readFileSync(linked, 'utf8')).toBe(content)
  })

  it('rejects invalid scopes and entry arrays before creating local files', async () => {
    const f = fixture()
    for (const scope of [undefined, null, 7, '', 'xm-account:0', 'xm-account:01', 'xm-account:-1', 'xm-account:1.5',
      'xm-account:9007199254740992', 'xm-account:7/../../escape', 'api-account:7', 'xm-account:guest']) {
      await expect(f.store.sync(scope as string, [id(1)])).rejects.toThrow('账号标识')
    }
    for (const ids of [undefined, null, {}, [null], [7], ['newapi-short'], ['legacy-' + 'X'.repeat(64)],
      new Array(1), Array.from({ length: 201 }, (_, index) => id(index))]) {
      await expect(f.store.sync('xm-account:7', ids as string[])).rejects.toThrow('条目标识')
    }
    expect(fs.existsSync(f.directory)).toBe(false)
  })
})
