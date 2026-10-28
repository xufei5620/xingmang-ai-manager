import { describe, expect, it } from 'vitest'
import type { ProjectCollaborationMutationInput } from '../lib/project-collaboration-contract'
import { parseProjectCollaborationMutationInput } from '../lib/project-collaboration-values'
import { createProjectCollaborationJournal, type CollaborationJournalRequest, type CollaborationJournalStorage } from './project-collaboration-journal'

const ownerId = '11111111-1111-4111-8111-111111111111'
const projectId = '22222222-2222-4222-8222-222222222222'
const operationId = '33333333-3333-4333-8333-333333333333'
const nextOperationId = '44444444-4444-4444-8444-444444444444'
function input(id = operationId): ProjectCollaborationMutationInput {
  return { version: 1, operationId: id, clientId: '55555555-5555-4555-8555-555555555555', epoch: '66666666-6666-4666-8666-666666666666', expectedAccessVersion: 2, baseProjectVersion: 3, expectedActorSequence: 0, action: 'edit', changes: [{ kind: 'document-set', slot: 'name', before: 'Original', after: 'Changed' }] }
}
class Storage implements CollaborationJournalStorage {
  values = new Map<string, string>()
  writes = 0
  removes = 0
  dropWrite = false
  get length() { return this.values.size }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.writes++; if (!this.dropWrite) this.values.set(key, value) }
  removeItem(key: string) { this.removes++; this.values.delete(key) }
}
function fixture(storage = new Storage(), active = () => true) {
  const accepted = [input(), input(nextOperationId)]
  const journal = createProjectCollaborationJournal({
    ownerId, projectId, storage, active, now: () => 100,
    // Protocol parsing belongs to the shared contract; this fixture only gives
    // the journal known typed requests so its byte/storage fences are isolated.
    parseRequest(method, value): CollaborationJournalRequest {
      const request = accepted.find((candidate) => JSON.stringify(candidate) === JSON.stringify(value))
      if (method !== 'mutate' || !request) throw new Error('Invalid fixture request')
      return parseProjectCollaborationMutationInput(structuredClone(request))
    },
  })
  return { journal, storage }
}

describe('independent immutable collaboration journal', () => {
  it('stores exact bytes before returning and refresh reads without writes or cleanup', async () => {
    const { journal, storage } = fixture()
    const record = await journal.prepare('mutate', input())
    expect(record.requestJson).toBe(JSON.stringify(input()))
    expect(record.payloadDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(storage.writes).toBe(1)
    expect(await fixture(storage).journal.read()).toEqual([record])
    expect(storage.writes).toBe(1)
    expect(storage.removes).toBe(0)
    expect(journal.request(record)).toEqual(input())
  })

  it('reuses an identical original but refuses another pending operation without replacing it', async () => {
    const { journal, storage } = fixture()
    const record = await journal.prepare('mutate', input())
    expect(await journal.prepare('mutate', input())).toEqual(record)
    expect(storage.writes).toBe(1)
    await expect(journal.prepare('mutate', input(nextOperationId))).rejects.toThrow('原协作操作尚未确认')
    expect(await journal.read()).toEqual([record])
  })

  it('rejects changed, malformed or future records without removing their original bytes', async () => {
    for (const corruption of ['digest', 'request', 'version', 'future-key']) {
      const { journal, storage } = fixture()
      await journal.prepare('mutate', input())
      const [key, raw] = [...storage.values][0]
      const value = JSON.parse(raw)
      if (corruption === 'digest') value.payloadDigest = '0'.repeat(64)
      if (corruption === 'request') value.requestJson = '{"version":99}'
      if (corruption === 'version') value.version = 2
      if (corruption === 'future-key') { storage.values.delete(key); storage.values.set(key.replace(':v1:', ':v2:'), raw) }
      else storage.values.set(key, JSON.stringify(value))
      const before = [...storage.values]
      await expect(journal.read()).rejects.toThrow()
      expect([...storage.values]).toEqual(before)
      expect(storage.removes).toBe(0)
    }
  })

  it('does not return a dispatchable operation if storage silently drops the write', async () => {
    const { journal, storage } = fixture(); storage.dropWrite = true
    await expect(journal.prepare('mutate', input())).rejects.toThrow('尚未提交')
    expect(storage.length).toBe(0)
  })

  it('checks owner lifetime across asynchronous hashing before writing or returning', async () => {
    let active = true
    const { journal, storage } = fixture(new Storage(), () => active)
    const pending = journal.prepare('mutate', input())
    active = false
    await expect(pending).rejects.toThrow('账号或工程已变化')
    expect(storage.length).toBe(0)
  })

  it('clears only an exact current record and cannot delete a changed or foreign record', async () => {
    const { journal, storage } = fixture()
    const record = await journal.prepare('mutate', input())
    expect(() => journal.confirm({ ...record, ownerId: nextOperationId })).toThrow()
    const [key] = [...storage.values.keys()]
    const original = storage.getItem(key)!
    storage.values.set(key, original + ' ')
    expect(() => journal.confirm(record)).toThrow()
    expect(storage.removes).toBe(0)
    storage.values.set(key, original)
    journal.confirm(record)
    expect(storage.length).toBe(0)
    expect(storage.removes).toBe(1)
  })

  it('archives rejected original bytes without making them replayable or clearing on a dropped archive write', async () => {
    const { journal, storage } = fixture()
    const record = await journal.prepare('mutate', input()), original = [...storage.values.values()][0]
    storage.dropWrite = true
    expect(() => journal.archiveRejected(record)).toThrow('未放弃重试')
    expect(await journal.read()).toEqual([record])
    storage.dropWrite = false
    journal.archiveRejected(record)
    expect(await journal.read()).toEqual([])
    expect([...storage.values.values()]).toEqual([original])
    expect([...storage.values.keys()][0]).toContain('project-collaboration-abandoned:')
    await expect(journal.prepare('mutate', input())).rejects.toThrow('不能再次发送')
  })
})
