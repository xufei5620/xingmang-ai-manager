import { isCanvasPublicAccountId } from './canvas-account-contract'
import { parseWorkshopContentOperationIdentity } from './workshop-content-contract'
import type { WorkshopRecoveryStorage } from './workshop-import-recovery'

export interface WorkshopContentRecoveryRecord {
  version: 1
  operationId: string
  id: string
  kind: 'node' | 'group'
  expectedVersion: number
  contentDigest: string
  requestDigest: string
}

export interface WorkshopContentRecovery {
  read(): WorkshopContentRecoveryRecord | null
  save(record: WorkshopContentRecoveryRecord): void
  clear(operationId: string): void
}

export const workshopContentRecoveryEvent = 'xingmang:workshop-content-recovery'

function browserStorage(): WorkshopRecoveryStorage | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage } catch { return null }
}

function parseRecord(value: unknown): WorkshopContentRecoveryRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.version !== 1) return null
  try {
    const { operationId, id, kind, expectedVersion, contentDigest, requestDigest } = input
    return { version: 1, ...parseWorkshopContentOperationIdentity({ operationId, id, kind, expectedVersion, contentDigest, requestDigest }) }
  } catch { return null }
}

function notify(): void {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new Event(workshopContentRecoveryEvent))
}

/** Keep only a scoped operation identity. Configuration bodies stay in the
 * editor; a missing response is resolved by the durable server operation. */
export function createWorkshopContentRecovery(ownerPublicId: string, storage: () => WorkshopRecoveryStorage | null = browserStorage): WorkshopContentRecovery {
  if (!isCanvasPublicAccountId(ownerPublicId)) throw new Error('无法确认工坊配置更新所属账号。')
  const owner = ownerPublicId.toLowerCase()
  const key = `xingmang:workshop-content:v1:${owner}`
  function read(): WorkshopContentRecoveryRecord | null {
    try {
      const raw = storage()?.getItem(key)
      if (!raw || raw.length > 1536) return null
      const value = JSON.parse(raw)
      return value.owner === owner ? parseRecord(value) : null
    } catch { return null }
  }
  return {
    read,
    save(record) {
      const clean = parseRecord(record)
      if (!clean) throw new Error('配置更新恢复记录不完整，请重新核对。')
      const previous = read()
      if (previous && JSON.stringify(previous) !== JSON.stringify(clean)) throw new Error('还有一笔工坊配置更新待核对，请先核对或取消原操作。')
      try {
        const target = storage()
        if (!target) throw new Error('Storage unavailable')
        target.setItem(key, JSON.stringify({ ...clean, owner }))
        if (JSON.stringify(read()) !== JSON.stringify(clean)) throw new Error('Storage verification failed')
      } catch { throw new Error('浏览器暂不能保存配置更新恢复记录，本次尚未提交。请允许此站点使用会话存储后重试。') }
      notify()
    },
    clear(operationId) {
      if (read()?.operationId !== operationId.toLowerCase()) return
      try { storage()?.removeItem(key); notify() } catch { /* A confirmed operation can be inspected again without replaying the write. */ }
    },
  }
}
