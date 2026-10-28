import { maximumAssetBatchCount } from './asset-batch-selection'

export type CanvasAssetMutationAction = 'delete' | 'restore' | 'purge'
export interface CanvasAssetMutationOutcome {
  assetId: string
  state: 'succeeded' | 'rejected' | 'unconfirmed' | 'not-started'
  message: string
}
export interface CanvasAssetMutationResult {
  action: CanvasAssetMutationAction
  outcomes: CanvasAssetMutationOutcome[]
  refreshError?: string
}

export const canvasAssetMutationLabels: Record<CanvasAssetMutationAction, string> = { delete: '移入回收站', restore: '恢复', purge: '彻底删除' }

function assertIds(ids: readonly string[]): void {
  if (!ids.length || ids.length > maximumAssetBatchCount || new Set(ids).size !== ids.length || ids.some((id) => !/^[A-Za-z0-9_-]{43}$/.test(id))) throw new Error(`请选择 1–${maximumAssetBatchCount} 项不同的有效素材`)
}

/** A failed item never turns previous accepted writes into an all-or-nothing claim. */
export async function runCanvasAssetMutationBatch(input: {
  action: CanvasAssetMutationAction
  ids: readonly string[]
  current(): boolean
  perform(assetId: string): Promise<{ assetId: string; deletedAt?: string }>
}): Promise<CanvasAssetMutationResult> {
  assertIds(input.ids)
  const ids = [...input.ids], outcomes: CanvasAssetMutationOutcome[] = []
  for (const assetId of ids) {
    if (!input.current()) { outcomes.push({ assetId, state: 'not-started', message: '尚未发送操作' }); continue }
    try {
      const result = await input.perform(assetId)
      if (result.assetId !== assetId || input.action === 'delete' && !result.deletedAt || input.action === 'restore' && result.deletedAt) throw new Error('素材操作回执未能确认，请重新读取核对')
      outcomes.push({ assetId, state: 'succeeded', message: `已${canvasAssetMutationLabels[input.action]}` })
    } catch (error) {
      outcomes.push({ assetId, state: 'unconfirmed', message: error instanceof Error ? error.message.slice(0, 500) : '操作未确认，请刷新核对' })
    }
  }
  return { action: input.action, outcomes }
}

/** Native hosts with the original void callback retain their all-success contract. */
export function resolveCanvasAssetMutationResult(action: CanvasAssetMutationAction, ids: readonly string[], value: CanvasAssetMutationResult | void): CanvasAssetMutationResult {
  assertIds(ids)
  if (value === undefined) return { action, outcomes: ids.map((assetId) => ({ assetId, state: 'succeeded', message: `已${canvasAssetMutationLabels[action]}` })) }
  if (value.action !== action || value.outcomes.length !== ids.length || new Set(value.outcomes.map((item) => item.assetId)).size !== ids.length || value.outcomes.some((item) => !ids.includes(item.assetId) || !['succeeded', 'rejected', 'unconfirmed', 'not-started'].includes(item.state) || typeof item.message !== 'string')) throw new Error('批量操作回执与所选素材不一致，请刷新核对；当前选择仍保留')
  return value
}
