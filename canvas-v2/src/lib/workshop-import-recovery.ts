import { isCanvasPublicAccountId } from './canvas-account-contract'

export interface WorkshopImportRecoveryRecord {
  version: 1
  operationId: string
  previewDigest: string
  kind: 'prompt' | 'node' | 'group'
}
export interface WorkshopImportRecovery {
  read(): WorkshopImportRecoveryRecord | null
  save(record: WorkshopImportRecoveryRecord): void
  clear(operationId: string): void
}
export interface WorkshopRecoveryStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export const workshopImportRecoveryEvent = 'xingmang:workshop-import-recovery'

function browserStorage(): WorkshopRecoveryStorage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage } catch { return null }
}
function parseRecord(value: unknown): WorkshopImportRecoveryRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (v.version !== 1 || !isCanvasPublicAccountId(v.operationId) || typeof v.previewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.previewDigest) || !['prompt', 'node', 'group'].includes(String(v.kind))) return null
  return { version: 1, operationId: v.operationId, previewDigest: v.previewDigest, kind: v.kind as WorkshopImportRecoveryRecord['kind'] }
}
function notify(): void { if (typeof window !== 'undefined') window.dispatchEvent(new Event(workshopImportRecoveryEvent)) }

/** Retain only receipt identity. File bodies, share tokens and account credentials never enter this journal. */
export function createWorkshopImportRecovery(ownerPublicId: string, storage: () => WorkshopRecoveryStorage | null = browserStorage): WorkshopImportRecovery {
  if (!isCanvasPublicAccountId(ownerPublicId)) throw new Error('无法确认工坊导入所属账号。')
  const key = `xingmang:workshop-import:v1:${ownerPublicId.toLowerCase()}`
  function read(): WorkshopImportRecoveryRecord | null {
    try {
      const raw = storage()?.getItem(key)
      if (!raw || raw.length > 1024) return null
      const value = JSON.parse(raw)
      if (value.owner !== ownerPublicId.toLowerCase()) return null
      return parseRecord(value)
    } catch { return null }
  }
  return {
    read,
    save(record) {
      const clean = parseRecord(record)
      if (!clean) throw new Error('导入恢复记录不完整，请重新核对文件。')
      const previous = read()
      if (previous && (previous.operationId !== clean.operationId || previous.previewDigest !== clean.previewDigest || previous.kind !== clean.kind)) throw new Error('还有一笔工坊导入待核对，请先继续原操作。')
      try {
        const target = storage()
        if (!target) throw new Error('Storage unavailable')
        target.setItem(key, JSON.stringify({ ...clean, owner: ownerPublicId.toLowerCase() }))
        if (JSON.stringify(read()) !== JSON.stringify(clean)) throw new Error('Storage verification failed')
      } catch { throw new Error('浏览器暂不能保存导入恢复记录，本次尚未提交。请允许此站点使用会话存储后重试。') }
      notify()
    },
    clear(operationId) {
      if (read()?.operationId !== operationId) return
      try { storage()?.removeItem(key); notify() } catch { /* The same receipt can safely be inspected again. */ }
    },
  }
}
