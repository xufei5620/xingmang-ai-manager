import { describe, expect, it } from 'vitest'
import { createWorkshopCreationRecovery, type WorkshopCreationRecoveryRecord } from './workshop-creation-recovery'

const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222'
function record(): WorkshopCreationRecoveryRecord { return { version: 1, operationId: '33333333-3333-4333-8333-333333333333', kind: 'group', requestDigest: 'a'.repeat(64), sourcePolicy: 'owner-private' } }
function store() { const values = new Map<string, string>(); return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } } }

describe('owner-scoped workshop creation receipt journal', () => {
  it('persists only operation identity and policy and restores it within the same account', () => {
    const storage = store(), journal = createWorkshopCreationRecovery(owner, () => storage)
    journal.save(record())
    expect(createWorkshopCreationRecovery(owner.toUpperCase(), () => storage).read()).toEqual(record())
    expect(createWorkshopCreationRecovery(other, () => storage).read()).toBeNull()
    expect(JSON.parse([...storage.values.values()][0])).toEqual({ ...record(), owner })
    expect([...storage.values.values()][0]).not.toMatch(/workflow|provider|apiKey|https?:|prompt|name/)
    journal.clear(other); expect(journal.read()).toEqual(record()); journal.clear(record().operationId); expect(journal.read()).toBeNull()
  })
  it('rejects another unresolved operation and refuses to overwrite corrupted or foreign journals', () => {
    const storage = store(), journal = createWorkshopCreationRecovery(owner, () => storage)
    journal.save(record()); const key = [...storage.values.keys()][0], original = storage.values.get(key)
    expect(() => journal.save({ ...record(), operationId: other })).toThrow('还有一笔')
    expect(storage.values.get(key)).toBe(original)
    for (const invalid of ['{', '{}', JSON.stringify({ ...record(), owner: other }), JSON.stringify({ ...record(), owner, workflow: {} }), 'x'.repeat(1537)]) {
      storage.values.set(key, invalid)
      expect(() => journal.read()).toThrow('阻止覆盖')
      expect(() => journal.save(record())).toThrow('阻止覆盖'); expect(storage.values.get(key)).toBe(invalid)
    }
  })
  it('fails before submission when storage is unavailable or verification cannot read its write', () => {
    expect(() => createWorkshopCreationRecovery('invalid')).toThrow('所属账号')
    expect(() => createWorkshopCreationRecovery(owner, () => null).save(record())).toThrow('尚未提交')
    const broken = { getItem: () => null, setItem() {}, removeItem() {} }
    expect(() => createWorkshopCreationRecovery(owner, () => broken).save(record())).toThrow('尚未提交')
    expect(() => createWorkshopCreationRecovery(owner, () => store()).save({ ...record(), sourcePolicy: 'invalid' as 'portable' })).toThrow('格式')
  })
})
