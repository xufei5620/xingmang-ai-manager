import { describe, expect, it } from 'vitest'
import { parseWorkshopShareDetail, parseWorkshopSharePage, parseWorkshopShareInput, parseWorkshopTransferReceipt, parseWorkshopTransferOrigin, workshopItemPermissions, workshopOriginLabel } from './workshop-transfer-contract'
const id = '01234567-1234-4123-8123-123456789abc'
const snapshot = { kind: 'prompt', name: '合成', description: '', category: 'general', tags: [], nodeCount: 0, edgeCount: 0, nodeKinds: [], prompt: '正文' }
const share = { id, name: '合成', kind: 'prompt', authorName: '作者', onlyUse: true, limitAcquisitions: 1, acquisitionCount: 0, version: 1, createdAt: '2026-10-14T12:00:00.000Z', state: 'active' }
describe('workshop transfer response boundary', () => {
  it('checks recipient kind against its share and requires a visible snapshot', () => {
    expect(() => parseWorkshopShareDetail({ ...share, isOwner: false })).toThrow()
    expect(() => parseWorkshopShareDetail({ ...share, isOwner: false, snapshot, owned: { kind: 'node', id, state: 'active' } })).toThrow()
    expect(parseWorkshopShareDetail({ ...share, isOwner: false, snapshot, owned: { kind: 'prompt', id, state: 'active' } }).owned?.kind).toBe('prompt')
    expect(parseWorkshopShareDetail({ ...share, state: 'revoked', isOwner: false }).snapshot).toBeUndefined()
  })
  it('refuses internally inconsistent pages and duplicate entries', () => {
    const item = { ...share, token: 'x'.repeat(43) }, valid = { items: [item], total: 1, offset: 0, limit: 20 }
    expect(parseWorkshopSharePage(valid).total).toBe(1)
    for (const page of [{ ...valid, total: 0 }, { ...valid, offset: 1 }, { ...valid, items: [] }, { ...valid, total: 3 }, { ...valid, limit: 0 }, { ...valid, items: [item, item], total: 2 }]) expect(() => parseWorkshopSharePage(page)).toThrow()
  })
  it('bounds explicit share policy and refuses incorrect operation receipts', () => {
    const input = { source: { kind: 'prompt', id, expectedVersion: 1 }, authorName: '作者', onlyUse: false, limitAcquisitions: null }
    expect(parseWorkshopShareInput(input)).toEqual(input)
    for (const invalid of [{ ...input, onlyUse: 'false' }, { ...input, limitAcquisitions: 0 }, { ...input, limitAcquisitions: 10001 }, { ...input, authorName: 'x\ny' }, { ...input, source: { ...input.source, expectedVersion: 0 } }]) expect(() => parseWorkshopShareInput(invalid)).toThrow()
    expect(() => parseWorkshopTransferReceipt({ action: 'import', operationId: id })).toThrow()
    expect(() => parseWorkshopTransferReceipt({ action: 'acquire', operationId: id, owned: { id, kind: 'prompt', state: 'active' } })).toThrow()
  })
  it('keeps external provenance distinct from verified community origin and restricts only-use copies', () => {
    const transferOrigin = parseWorkshopTransferOrigin({ source: 'file', onlyUse: false })
    expect(workshopOriginLabel({ transferOrigin })).toContain('未验证')
    expect(workshopItemPermissions({ transferOrigin })).toEqual({ canEdit: true, canShare: true, canExport: true, canPublish: false })
    expect(workshopItemPermissions({ transferOrigin: { source: 'share', onlyUse: true } })).toEqual({ canEdit: false, canShare: false, canExport: false, canPublish: false })
    expect(workshopItemPermissions({ origin: { source: 'community' } }).canShare).toBe(false)
  })
})
