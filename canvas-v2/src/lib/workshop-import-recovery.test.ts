import { describe, expect, it, vi } from 'vitest'
import { createWorkshopImportRecovery, type WorkshopRecoveryStorage } from './workshop-import-recovery'

const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222'
const operation = '33333333-3333-4333-8333-333333333333'
const record = { version: 1 as const, operationId: operation, kind: 'group' as const, previewDigest: 'a'.repeat(64) }
function storage() {
  const entries = new Map<string, string>()
  const target: WorkshopRecoveryStorage = { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value) }, removeItem: (key) => { entries.delete(key) } }
  return { target, entries }
}
describe('workshop import receipt recovery journal', () => {
  it('restores only bounded receipt identity across fresh client instances', () => {
    const f = storage()
    createWorkshopImportRecovery(owner, () => f.target).save({ ...record, content: 'private prompt', token: 'private token' } as typeof record)
    expect(createWorkshopImportRecovery(owner, () => f.target).read()).toEqual(record)
    const raw = [...f.entries.values()][0]
    expect(raw).not.toContain('private')
    expect(raw.length).toBeLessThan(400)
  })
  it('isolates owners and never replaces an unresolved operation or changes its digest', () => {
    const f = storage(), own = createWorkshopImportRecovery(owner, () => f.target), foreign = createWorkshopImportRecovery(other, () => f.target)
    own.save(record)
    expect(foreign.read()).toBeNull()
    foreign.clear(operation)
    expect(own.read()).toEqual(record)
    for (const changed of [{ operationId: other }, { previewDigest: 'b'.repeat(64) }, { kind: 'prompt' as const }]) expect(() => own.save({ ...record, ...changed })).toThrow('待核对')
    expect(own.read()).toEqual(record)
    own.clear(other)
    expect(own.read()).toEqual(record)
    own.clear(operation)
    expect(own.read()).toBeNull()
  })
  it('refuses dispatch preparation if storage is unavailable, throws or silently drops writes', () => {
    for (const target of [null, { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: vi.fn() }, { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }]) {
      expect(() => createWorkshopImportRecovery(owner, () => target).save(record)).toThrow('本次尚未提交')
    }
  })
  it('does not revive corrupt, oversized or foreign records', () => {
    const f = storage(), own = createWorkshopImportRecovery(owner, () => f.target)
    own.save(record)
    const key = [...f.entries.keys()][0]
    for (const value of ['{', 'x'.repeat(1025), JSON.stringify({ ...record, owner: other }), JSON.stringify({ ...record, owner, kind: 'bad' }), JSON.stringify({ ...record, owner, version: 2 })]) {
      f.entries.set(key, value); expect(own.read()).toBeNull()
    }
  })
})
