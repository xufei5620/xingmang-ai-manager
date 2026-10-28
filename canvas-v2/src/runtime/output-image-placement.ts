import type { CanvasImageAssetSummary, CanvasRunGraph, CanvasRunRecord } from '../host'
import { stableAssetId } from '../persistence/workflow-schema'
import { matchingCanvasRunNodeIds } from './run-input-matching'
import type { OutputImageSelection } from '../editor/output-image-nodes'

export interface OutputImagePlacementToken {
  nodeId: string
  selection: OutputImageSelection
  scope: string
  graph: CanvasRunGraph
  assetIds?: string[]
  run?: { runId: string; graphRevision: string }
  controller: AbortController
  resolving: boolean
}

/** Owns one explicit placement, independent of repeated terminal projections.
 * Tokens are consumed before reading media; undo never resubmits a run. */
export function createOutputImagePlacementCoordinator(adapter: {
  scope(): string | null
  graph(): CanvasRunGraph
  outputIds(nodeId: string, selection: OutputImageSelection): string[]
  read(assetId: string, signal: AbortSignal): Promise<CanvasImageAssetSummary>
  commit(nodeId: string, assets: readonly CanvasImageAssetSummary[]): void
  busy(nodeIds: ReadonlySet<string>): void
  notice(message: string): void
}) {
  const operations = new Map<string, OutputImagePlacementToken>()
  function publish() { adapter.busy(new Set(operations.keys())) }
  function finish(token: OutputImagePlacementToken) {
    if (operations.get(token.nodeId) !== token) return
    operations.delete(token.nodeId)
    token.controller.abort()
    publish()
  }
  function current(token: OutputImagePlacementToken, run?: CanvasRunRecord): boolean {
    if (operations.get(token.nodeId) !== token || token.scope !== adapter.scope() || token.controller.signal.aborted) return false
    if (!matchingCanvasRunNodeIds(token.graph, adapter.graph(), run).has(token.nodeId)) return false
    if (token.assetIds) {
      try { return JSON.stringify(token.assetIds) === JSON.stringify(adapter.outputIds(token.nodeId, token.selection)) } catch { return false }
    }
    return true
  }
  function begin(nodeId: string, selection: OutputImageSelection, graph: CanvasRunGraph, assetIds?: string[]): OutputImagePlacementToken | null {
    const scope = adapter.scope()
    if (!scope || operations.has(nodeId)) return null
    const token = { nodeId, selection, scope, graph: structuredClone(graph), ...(assetIds ? { assetIds: [...assetIds] } : {}), controller: new AbortController(), resolving: false }
    operations.set(nodeId, token)
    publish()
    return token
  }
  async function resolve(token: OutputImagePlacementToken, assetIds: string[], run?: CanvasRunRecord): Promise<void> {
    if (token.resolving || operations.get(token.nodeId) !== token) return
    token.resolving = true
    try {
      if (!current(token, run)) throw new Error('工程或输入已变化，成品仍保留在素材库中；本次没有添加图片')
      if (!assetIds.length || assetIds.length > 16 || assetIds.some((id) => !stableAssetId(id))) throw new Error('本次处理没有完整的图片产物，请在运行记录中核对')
      const assets = await Promise.all(assetIds.map((id) => adapter.read(id, token.controller.signal)))
      if (!current(token, run)) throw new Error('工程或输入已变化，成品仍保留在素材库中；本次没有添加图片')
      if (assets.some((asset, index) => asset.assetId !== assetIds[index] || asset.mediaType !== 'image' || asset.deletedAt)) throw new Error('图片成品已变化或不可读取，本次没有添加图片')
      adapter.commit(token.nodeId, assets)
      adapter.notice(assets.length === 1 ? '成品已放到画布，原工具保留；后续修改不会改变这张图片' : `已将 ${assets.length} 张切片放到画布，可一次撤销`)
    } catch (error) {
      if (token.scope === adapter.scope() && !token.controller.signal.aborted) adapter.notice(error instanceof Error ? error.message : '成品放置未完成，请重试')
    } finally { finish(token) }
  }
  function attach(token: OutputImagePlacementToken, run: { runId: string; graphRevision: string }): void {
    if (operations.get(token.nodeId) !== token) return
    token.run = run
  }
  function accept(record: CanvasRunRecord): void {
    if (record.status === 'running') return
    for (const token of operations.values()) {
      if (token.resolving || token.run?.runId !== record.runId || token.run.graphRevision !== record.graphRevision) continue
      const node = record.nodes.find((entry) => entry.nodeId === token.nodeId)
      if (record.cancelRequested || !node || !['succeeded', 'cached'].includes(node.state)) {
        if (token.scope === adapter.scope()) adapter.notice('本次图像处理未完成，没有添加成品；请查看运行记录后重试')
        finish(token)
        continue
      }
      const attempt = node.attempts.at(-1)
      const candidates = attempt && ['succeeded', 'cached'].includes(attempt.state) ? attempt.candidates.filter((candidate) => candidate.asset.kind === 'image') : []
      const ordered = [...candidates].sort((a, b) => (a.outputIndex ?? 0) - (b.outputIndex ?? 0))
      void resolve(token, (token.selection === 'all' ? ordered : ordered.slice(0, 1)).map((candidate) => candidate.asset.assetId), record)
    }
  }
  function invalidate(): void { for (const token of [...operations.values()]) finish(token) }
  return { begin, resolve, attach, accept, cancel: finish, invalidate, pending: (nodeId: string) => operations.has(nodeId) }
}
