import { describe, expect, it, vi } from 'vitest'
import { createWorkshopContentRecovery } from './workshop-content-recovery'
import type { WorkshopRecoveryStorage } from './workshop-import-recovery'

const owner = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const operationId = '33333333-3333-4333-8333-333333333333'
const record = { version: 1 as const, operationId, id: other, kind: 'group' as const, expectedVersion: 2, contentDigest: 'a'.repeat(64), requestDigest: 'b'.repeat(64) }

function storage() {
  const entries = new Map<string, string>()
  const target: WorkshopRecoveryStorage = { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value) }, removeItem: (key) => { entries.delete(key) } }
  return { entries, target }
}

describe('workshop configuration update receipt journal', () => {
  it('retains only bounded identity across new instances and strips payloads', () => {
    const f = storage()
    const extra = { ...record, workflow: { privatePrompt: 'secret-body' }, token: 'secret-token' }
    createWorkshopContentRecovery(owner, () => f.target).save(extra)
    expect(createWorkshopContentRecovery(owner, () => f.target).read()).toEqual(record)
    const raw = [...f.entries.values()][0]
    expect(raw).not.toContain('secret')
    expect(raw.length).toBeLessThan(600)
  })

  it('isolates owners and refuses to replace any unconfirmed identity field', () => {
    const f = storage(), a = createWorkshopContentRecovery(owner, () => f.target), b = createWorkshopContentRecovery(other, () => f.target)
    a.save(record)
    expect(b.read()).toBeNull()
    b.clear(operationId)
    expect(a.read()).toEqual(record)
    for (const patch of [{ operationId: owner }, { id: owner }, { kind: 'node' as const }, { expectedVersion: 3 }, { contentDigest: 'c'.repeat(64) }, { requestDigest: 'd'.repeat(64) }]) {
      expect(() => a.save({ ...record, ...patch })).toThrow('待核对')
      expect(a.read()).toEqual(record)
    }
    a.save(record)
    a.clear(other)
    expect(a.read()).toEqual(record)
    a.clear(operationId)
    expect(a.read()).toBeNull()
  })

  it('refuses preparation when storage cannot durably round-trip the operation', () => {
    for (const target of [null, { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: vi.fn() }, { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }]) {
      expect(() => createWorkshopContentRecovery(owner, () => target).save(record)).toThrow('本次尚未提交')
    }
  })

  it('rejects corrupt, foreign, oversized and unsupported records', () => {
    const f = storage(), journal = createWorkshopContentRecovery(owner, () => f.target)
    journal.save(record)
    const key = [...f.entries.keys()][0]
    for (const raw of ['{', 'x'.repeat(1537), JSON.stringify({ ...record, owner: other }), JSON.stringify({ ...record, owner, version: 2 }), JSON.stringify({ ...record, owner, expectedVersion: Number.MAX_SAFE_INTEGER }), JSON.stringify({ ...record, owner, contentDigest: 'unknown' }), JSON.stringify({ ...record, owner, operationId: '00000000-0000-0000-0000-000000000000' }), JSON.stringify({ ...record, owner, id: '00000000-0000-4000-0000-000000000000' })]) {
      f.entries.set(key, raw)
      expect(journal.read()).toBeNull()
    }
    expect(() => journal.save({ ...record, operationId: 'invalid' })).toThrow('不完整')
    expect(() => createWorkshopContentRecovery('invalid', () => f.target)).toThrow('所属账号')
  })

  it('normalizes identity casing and safely retains confirmation when clearing storage fails', () => {
    const f = storage(), journal = createWorkshopContentRecovery(owner.toUpperCase(), () => f.target)
    journal.save({ ...record, operationId: operationId.toUpperCase() })
    const retained = createWorkshopContentRecovery(owner, () => ({ ...f.target, removeItem: () => { throw new Error('blocked') } }))
    retained.clear(operationId)
    expect(retained.read()).toEqual(record)
  })
})
