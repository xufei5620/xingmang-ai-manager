export interface LayerEditorScope {
  ownerId: number | null
  accountId: string | null
  projectId: string | null
  projectEpoch: number
  enabled: boolean
}

/** A node ID and identical recipe do not identify an editor session: reopening
 * the same project must invalidate an already uploaded, unapplied PSD draft. */
export function layerEditorScopeToken(scope: LayerEditorScope): string {
  return JSON.stringify([scope.ownerId, scope.accountId, scope.projectId, scope.projectEpoch, scope.enabled])
}

export function assertLayerEditorScope(captured: string, current: LayerEditorScope): void {
  if (!current.enabled || captured !== layerEditorScopeToken(current)) throw new Error('账号或工程已切换或重新打开，旧图层草稿未应用；已上传素材仍保留在素材库')
}
