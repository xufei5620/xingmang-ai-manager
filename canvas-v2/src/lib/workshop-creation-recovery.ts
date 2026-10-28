import { isCanvasPublicAccountId } from './canvas-account-contract'
import { parseWorkshopCreationIdentity, type WorkshopCreationIdentity } from './workshop-creation-identity'
import type { WorkshopSourcePolicy } from './workshop-contract'
import type { WorkshopRecoveryStorage } from './workshop-import-recovery'

export interface WorkshopCreationRecoveryRecord extends WorkshopCreationIdentity { version: 1; sourcePolicy: WorkshopSourcePolicy }
export interface WorkshopCreationRecovery { read(): WorkshopCreationRecoveryRecord | null; save(record: WorkshopCreationRecoveryRecord): void; clear(operationId: string): void }
export const workshopCreationRecoveryEvent = 'xingmang:workshop-creation-recovery'

function browserStorage(): WorkshopRecoveryStorage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage } catch { return null }
}
function parseRecord(value: unknown): WorkshopCreationRecoveryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('恢复记录格式错误')
  const v = value as Record<string, unknown>
  if (v.version !== 1 || !['portable', 'owner-private'].includes(String(v.sourcePolicy)) || Object.keys(v).some((key) => !['version', 'operationId', 'kind', 'requestDigest', 'sourcePolicy'].includes(key))) throw new Error('恢复记录格式错误')
  return { version: 1, ...parseWorkshopCreationIdentity({ operationId: v.operationId, kind: v.kind, requestDigest: v.requestDigest }), sourcePolicy: v.sourcePolicy as WorkshopSourcePolicy }
}
function notify(): void { if (typeof window !== 'undefined') window.dispatchEvent(new Event(workshopCreationRecoveryEvent)) }

/** Only a receipt identity and its source policy survive refresh. An unreadable
 * journal must never be mistaken for permission to overwrite an unknown save. */
export function createWorkshopCreationRecovery(ownerPublicId: string, storage: () => WorkshopRecoveryStorage | null = browserStorage): WorkshopCreationRecovery {
  if (!isCanvasPublicAccountId(ownerPublicId)) throw new Error('无法确认工坊保存所属账号。')
  const owner = ownerPublicId.toLowerCase(), key = `xingmang:workshop-creation:v1:${owner}`
  function read(): WorkshopCreationRecoveryRecord | null {
    try {
      const raw = storage()?.getItem(key)
      if (raw === null || raw === undefined) return null
      if (!raw || raw.length > 1536) throw new Error('恢复记录超限')
      const { owner: storedOwner, ...record } = JSON.parse(raw)
      if (storedOwner !== owner) throw new Error('恢复记录所属账号错误')
      return parseRecord(record)
    } catch { throw new Error('原保存恢复记录无法核对，已阻止覆盖。请保留当前页面并重新核对。') }
  }
  return {
    read,
    save(record) {
      const clean = parseRecord(record), previous = read()
      if (previous && JSON.stringify(previous) !== JSON.stringify(clean)) throw new Error('还有一笔工坊保存待核对，请先核对或取消原保存。')
      try {
        const target = storage()
        if (!target) throw new Error('Storage unavailable')
        target.setItem(key, JSON.stringify({ ...clean, owner }))
        if (JSON.stringify(read()) !== JSON.stringify(clean)) throw new Error('Storage verification failed')
      } catch { throw new Error('浏览器暂不能保存恢复记录，本次尚未提交。请允许此站点使用会话存储后重试。') }
      notify()
    },
    clear(operationId) {
      if (read()?.operationId !== operationId.toLowerCase()) return
      try { storage()?.removeItem(key); notify() } catch { /* A confirmed operation can be inspected again without replaying its write. */ }
    },
  }
}
