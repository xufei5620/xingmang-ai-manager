import type { CanvasRunRecord, CanvasRunStatus } from './canvas-run-contract'

const assetIdPattern = /^[A-Za-z0-9_-]{43}$/

export interface CanvasRunAssetReference {
  runId: string
  projectId?: string
  createdAt: string
  status: CanvasRunStatus
  nodeIds: string[]
  inputReferenceCount: number
  candidateReferenceCount: number
}

export function findCanvasRunAssetReferences(runs: readonly CanvasRunRecord[], assetId: string): CanvasRunAssetReference[] {
  if (!assetIdPattern.test(assetId)) throw new Error('画布资产标识格式错误')
  return runs.flatMap((run) => {
    const nodeIds = new Set<string>()
    let inputReferenceCount = 0
    let candidateReferenceCount = 0
    for (const node of run.nodes) {
      let nodeReferenced = false
      for (const attempt of node.attempts) {
        const inputMatches = attempt.inputAssetIds?.filter((entry) => entry === assetId).length ?? 0
        const candidateMatches = attempt.candidates.filter((candidate) => candidate.asset.assetId === assetId).length
        inputReferenceCount += inputMatches
        candidateReferenceCount += candidateMatches
        nodeReferenced ||= inputMatches > 0 || candidateMatches > 0
      }
      if (nodeReferenced) nodeIds.add(node.nodeId)
    }
    if (nodeIds.size === 0) return []
    return [{
      runId: run.runId,
      ...(run.projectId ? { projectId: run.projectId } : {}),
      createdAt: run.createdAt,
      status: run.status,
      nodeIds: [...nodeIds],
      inputReferenceCount,
      candidateReferenceCount,
    }]
  })
}
