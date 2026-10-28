import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertProjectHistoryRecoveryStored, clearProjectHistoryRecovery, parseProjectHistoryRecoveryRecord, projectHistoryRecoveryKey, readProjectHistoryRecovery, withProjectHistoryRecoveryLock, writeProjectHistoryRecovery, type ProjectHistoryRecoveryLock, type ProjectHistoryRecoveryRecord } from './project-history-recovery'

const ownerId = '11111111-1111-4111-8111-111111111111'
const projectId = '22222222-2222-4222-8222-222222222222'
const input = { operationId: '33333333-3333-4333-8333-333333333333', revisionId: 'a'.repeat(32), expectedVersion: 8 }
function record(): ProjectHistoryRecoveryRecord { return { version: 1, ownerId, projectId, input: { ...input }, createdAt: '2026-10-23T10:00:00.000Z' } }
function storage() {
  const values = new Map<string, string>()
  return { values, getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value) }), removeItem: vi.fn((key: string) => { values.delete(key) }) }
}
afterEach(() => vi.unstubAllGlobals())

describe('durable project history recovery identity', () => {
  it('survives a new view with only safe identity fields', () => {
    const data = storage(), original = record()
    writeProjectHistoryRecovery(data, original)
    original.input.expectedVersion = 99
    expect(readProjectHistoryRecovery(data, ownerId, projectId)).toEqual(record())
    expect([...data.values.values()].join('')).not.toMatch(/content|prompt|token|password|asset|url|secret/i)
    expect(readProjectHistoryRecovery(data, projectId, ownerId)).toBeNull()
    expect(readProjectHistoryRecovery(data, ownerId, input.operationId)).toBeNull()
  })
  it.each([
    (value: Record<string, unknown>) => { value.version = 2 },
    (value: Record<string, unknown>) => { value.ownerId = projectId },
    (value: Record<string, unknown>) => { value.projectId = ownerId },
    (value: Record<string, unknown>) => { value.content = 'private workflow' },
    (value: Record<string, unknown>) => { value.createdAt = 'invalid' },
    (value: Record<string, unknown>) => { value.input = { ...input, content: 'private workflow' } },
    (value: Record<string, unknown>) => { value.input = { ...input, expectedVersion: Number.MAX_SAFE_INTEGER } },
    (value: Record<string, unknown>) => { value.input = { ...input, operationId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' } },
    (value: Record<string, unknown>) => { value.input = { ...input, revisionId: 'b'.repeat(33) } },
  ])('preserves an unsupported or malformed carrier without overwriting or clearing it', (mutate) => {
    const data = storage(), value: Record<string, unknown> = { ...record() }, key = projectHistoryRecoveryKey(ownerId, projectId)
    mutate(value); const raw = JSON.stringify(value); data.values.set(key, raw)
    expect(() => readProjectHistoryRecovery(data, ownerId, projectId)).toThrow('记录')
    expect(() => writeProjectHistoryRecovery(data, record())).toThrow('记录')
    expect(() => clearProjectHistoryRecovery(data, record())).toThrow('记录')
    expect(data.values.get(key)).toBe(raw); expect(data.setItem).not.toHaveBeenCalled(); expect(data.removeItem).not.toHaveBeenCalled()
  })
  it('rejects malformed JSON and an oversized journal without deleting the bytes', () => {
    const data = storage(), key = projectHistoryRecoveryKey(ownerId, projectId)
    for (const raw of ['{', ' '.repeat(2049)]) {
      data.values.set(key, raw)
      expect(() => readProjectHistoryRecovery(data, ownerId, projectId)).toThrow()
      expect(data.values.get(key)).toBe(raw)
    }
  })
  it('does not replace another operation or clear a replacement from another page', () => {
    const data = storage(), original = writeProjectHistoryRecovery(data, record()), other = { ...record(), input: { ...input, operationId: ownerId } }
    expect(() => writeProjectHistoryRecovery(data, other)).toThrow('还有一项')
    data.values.set(projectHistoryRecoveryKey(ownerId, projectId), JSON.stringify(other))
    expect(() => assertProjectHistoryRecoveryStored(data, original)).toThrow()
    expect(() => clearProjectHistoryRecovery(data, original)).toThrow()
    expect(data.removeItem).not.toHaveBeenCalled()
  })
  it('blocks before a request if the write or readback is unavailable', () => {
    const data = storage(); data.setItem.mockImplementationOnce(() => { throw new Error('quota') })
    expect(() => writeProjectHistoryRecovery(data, record())).toThrow('请求未提交')
    data.setItem.mockImplementationOnce(() => undefined)
    expect(() => writeProjectHistoryRecovery(data, record())).toThrow('请求未提交')
  })
  it('retains a confirmed journal when deletion cannot be acknowledged', () => {
    const data = storage(); writeProjectHistoryRecovery(data, record()); data.removeItem.mockImplementationOnce(() => undefined)
    expect(() => clearProjectHistoryRecovery(data, record())).toThrow('尚未清除')
    expect(readProjectHistoryRecovery(data, ownerId, projectId)).toEqual(record())
  })
  it('clears only the exact known operation and does not persist a receipt', () => {
    const data = storage(); writeProjectHistoryRecovery(data, record()); clearProjectHistoryRecovery(data, record())
    expect(readProjectHistoryRecovery(data, ownerId, projectId)).toBeNull()
    expect(data.values.size).toBe(0)
  })
  it('requires canonical public account and project identities', () => {
    expect(() => parseProjectHistoryRecoveryRecord(record(), '../owner', projectId)).toThrow()
    expect(() => projectHistoryRecoveryKey(ownerId.toUpperCase().replace('1111', 'AAAA'), projectId)).toThrow()
  })
})

describe('cross-page project history mutation lease', () => {
  it('does not mutate without a lock or after its scope changes while queued', async () => {
    const work = vi.fn(async () => 'saved')
    await expect(withProjectHistoryRecoveryLock(ownerId, projectId, () => true, work, null)).rejects.toThrow('不支持')
    let current = true
    const lock: ProjectHistoryRecoveryLock = { async run(_key, callback) { current = false; return await callback() } }
    await expect(withProjectHistoryRecoveryLock(ownerId, projectId, () => current, work, lock)).rejects.toThrow('已变化')
    expect(work).not.toHaveBeenCalled()
  })
  it('uses the same owner and project lock for original submission and retry', async () => {
    const keys: string[] = [], lock: ProjectHistoryRecoveryLock = { async run(key, work) { keys.push(key); return await work() } }
    await withProjectHistoryRecoveryLock(ownerId, projectId, () => true, async () => 1, lock)
    await withProjectHistoryRecoveryLock(ownerId, projectId, () => true, async () => 2, lock)
    expect(keys).toEqual([projectHistoryRecoveryKey(ownerId, projectId), projectHistoryRecoveryKey(ownerId, projectId)])
  })
})
