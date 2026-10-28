import { describe, expect, it } from 'vitest'
import { clearProjectImportRecovery, listProjectImportRecoveries, parseProjectImportRecoveryRecord, writeProjectImportRecovery, type ProjectImportRecoveryRecord, type ProjectImportRecoveryStorage } from './project-import-recovery'

const owner = 'b6772b98-170d-4c36-b84b-af0f6e059ef7'
const other = 'b6772b98-170d-4c36-b84b-af0f6e059ef8'
function storage() {
  const values = new Map<string, string>()
  const api: ProjectImportRecoveryStorage = { get length() { return values.size }, key(index) { return [...values.keys()][index] ?? null }, getItem(key) { return values.get(key) ?? null }, setItem(key, value) { values.set(key, value) }, removeItem(key) { values.delete(key) } }
  return { values, api }
}
function record(operationId = crypto.randomUUID(), ownerId = owner): ProjectImportRecoveryRecord { return { version: 1, ownerId, operationId, fileName: '原始工程.xingmang.json', fileSha256: 'a'.repeat(64), fileBytes: 500, createdAt: '2026-10-15T12:00:00.000Z', policy: 'reject', phase: 'assets', assets: [{ sourceAssetId: 'i'.repeat(43), mediaType: 'image', mimeType: 'image/png', sha256: 'b'.repeat(64), byteSize: 68, width: 1, height: 1 }] } }

describe('account-scoped import recovery metadata', () => {
  it('stores only bounded identities and isolates accounts without reading another account malformed records', () => {
    const s = storage(), first = record(), second = record(crypto.randomUUID(), other)
    writeProjectImportRecovery(s.api, first)
    writeProjectImportRecovery(s.api, second)
    expect(listProjectImportRecoveries(s.api, owner)).toEqual([first])
    expect(listProjectImportRecoveries(s.api, other)).toEqual([second])
    s.values.set(`xingmang:project-import:v1:${other}:${second.operationId}`, '{broken')
    expect(listProjectImportRecoveries(s.api, owner)).toEqual([first])
    expect(() => listProjectImportRecoveries(s.api, other)).toThrow('恢复记录')
    const encoded = [...s.values.values()][0]
    expect(encoded).not.toMatch(/bytesBase64|blob|prompt|workflow|authorization|token/i)
  })

  it('rejects corrupt records, extra bytes or secrets and unknown versions instead of treating them as missing', () => {
    const s = storage(), first = record()
    for (const invalid of [{ ...first, version: 2 }, { ...first, content: 'private prompt' }, { ...first, apiKey: 'private' }, { ...first, assets: [{ ...first.assets[0], bytesBase64: 'AA==' }] }, { ...first, ownerId: other }, { ...first, phase: 'commit' }]) expect(() => parseProjectImportRecoveryRecord(invalid, owner)).toThrow()
    s.values.set(`xingmang:project-import:v1:${owner}:${first.operationId}`, 'null')
    expect(() => listProjectImportRecoveries(s.api, owner)).toThrow('恢复记录')
    expect(() => writeProjectImportRecovery(s.api, record())).toThrow('恢复记录')
  })

  it('does not downgrade a final proof or let a late tab erase another operation or updated record', () => {
    const s = storage(), first = record(), second = { ...record(), fileSha256: 'c'.repeat(64) }
    writeProjectImportRecovery(s.api, first)
    const committed: ProjectImportRecoveryRecord = { ...first, phase: 'commit', creationDigest: 'd'.repeat(64) }
    writeProjectImportRecovery(s.api, committed)
    writeProjectImportRecovery(s.api, second)
    expect(() => writeProjectImportRecovery(s.api, first)).toThrow('摘要')
    expect(() => clearProjectImportRecovery(s.api, first)).toThrow('另一页面')
    clearProjectImportRecovery(s.api, committed)
    expect(listProjectImportRecoveries(s.api, owner)).toEqual([second])
    expect(() => writeProjectImportRecovery(s.api, { ...record(), fileSha256: second.fileSha256 })).toThrow('原导入操作')
  })

  it('verifies writes before they authorize any request and bounds the number of pending operations', () => {
    const s = storage()
    expect(() => writeProjectImportRecovery({ ...s.api, setItem() {} }, record())).toThrow('无法保存')
    for (let index = 0; index < 12; index += 1) writeProjectImportRecovery(s.api, { ...record(), fileSha256: index.toString(16).repeat(64) })
    expect(() => writeProjectImportRecovery(s.api, { ...record(), fileSha256: 'f'.repeat(64) })).toThrow('上限')
  })
})
