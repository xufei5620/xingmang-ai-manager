import type { CanvasRunRecord } from '../host'
import { assetBatchUnavailableReason, type AssetBatchItem } from './asset-batch-selection'

export interface RunCandidateBatchItem extends AssetBatchItem { nodeId: string; candidateId: string; attemptId: string }

export function runCandidateBatchItems(record: CanvasRunRecord | undefined): RunCandidateBatchItem[] {
  const seen = new Set<string>()
  const items: RunCandidateBatchItem[] = []
  for (const node of record?.nodes ?? []) {
    let index = 0
    for (const attempt of node.attempts) for (const candidate of attempt.candidates) {
      index++
      if (seen.has(candidate.asset.assetId)) continue
      seen.add(candidate.asset.assetId)
      items.push({ assetId: candidate.asset.assetId, nodeId: node.nodeId, candidateId: candidate.candidateId, attemptId: attempt.attemptId, label: `节点 ${node.nodeId} 的候选 ${index}`, unavailableReason: assetBatchUnavailableReason(candidate.asset) })
    }
  }
  return items
}
