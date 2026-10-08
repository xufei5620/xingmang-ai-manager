import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createManagedKeyReplacementStore,
  createMemoryManagedKeyReplacementStore,
  ManagedKeyReplacementUnreadableError,
} from './managed-key-replacement-store'

const directories: string[] = []

function storeFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-key-replacement-store-'))
  directories.push(directory)
  return path.join(directory, 'managed-key-replacements.json')
}

const capped = { remainQuota: 5_000, unlimitedQuota: false, expiredAt: '2099-01-01T00:00:00.000Z' }

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('managed key replacement store', () => {
  it('keeps a record across a fresh store instance and forgets it once removed', async () => {
    const filePath = storeFile()
    await createManagedKeyReplacementStore({ filePath }).set('solov:42:codex', capped)

    const reopened = createManagedKeyReplacementStore({ filePath })
    await expect(reopened.get('solov:42:codex')).resolves.toEqual(capped)
    await expect(reopened.get('solov:42:claude')).resolves.toBeNull()
    await reopened.remove('solov:42:codex')
    await expect(createManagedKeyReplacementStore({ filePath }).get('solov:42:codex')).resolves.toBeNull()
  })

  it('treats a missing file as having no records', async () => {
    await expect(createManagedKeyReplacementStore({ filePath: storeFile() }).get('solov:42:codex')).resolves.toBeNull()
  })

  it('refuses to guess when the file or any entry cannot be read', async () => {
    for (const content of ['{ not json', JSON.stringify({ version: 2, entries: {} }),
      JSON.stringify({ version: 1, entries: { 'solov:42:codex': { remainQuota: 'lots', unlimitedQuota: false, expiredAt: null } } })]) {
      const filePath = storeFile()
      fs.writeFileSync(filePath, content)
      await expect(createManagedKeyReplacementStore({ filePath }).get('solov:42:codex'))
        .rejects.toBeInstanceOf(ManagedKeyReplacementUnreadableError)
    }
  })

  it('does not let a new record overwrite an unreadable file that may hold another tool\'s limits', async () => {
    const filePath = storeFile()
    fs.writeFileSync(filePath, '{ not json')
    const store = createManagedKeyReplacementStore({ filePath })
    await expect(store.set('solov:42:claude', capped)).rejects.toBeInstanceOf(ManagedKeyReplacementUnreadableError)
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{ not json')
    await expect(store.get('solov:42:codex')).rejects.toBeInstanceOf(ManagedKeyReplacementUnreadableError)
  })

  it('reset clears an unreadable file so later reads start empty', async () => {
    const filePath = storeFile()
    fs.writeFileSync(filePath, '{ not json')
    const store = createManagedKeyReplacementStore({ filePath })
    await store.reset()
    await expect(store.get('solov:42:codex')).resolves.toBeNull()
  })

  it('never writes anything but the limits', async () => {
    const filePath = storeFile()
    await createManagedKeyReplacementStore({ filePath }).set('solov:42:codex', { ...capped, key: 'sk-secret' } as typeof capped)
    expect(fs.readFileSync(filePath, 'utf8')).not.toContain('sk-secret')
  })

  it('offers the same behavior in memory', async () => {
    const store = createMemoryManagedKeyReplacementStore()
    await store.set('solov:42:codex', capped)
    await expect(store.get('solov:42:codex')).resolves.toEqual(capped)
    await store.remove('solov:42:codex')
    await expect(store.get('solov:42:codex')).resolves.toBeNull()
  })
})
