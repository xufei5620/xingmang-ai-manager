import { parseAssetOriginAssetId, parseCanvasAssetOrigin, type CanvasAssetOriginResult } from '../lib/asset-origin-contract'

export type AssetOriginLookupState = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; result: CanvasAssetOriginResult }

export function assetOriginProjectHref(result: CanvasAssetOriginResult): string | null {
  if (result.state !== 'available') return null
  return `/asset-origin/${parseAssetOriginAssetId(result.assetId)}`
}

/** A lookup owns no storage, run recovery or navigation side effects. */
export function createAssetOriginLookup(input: {
  assetId: string
  read(assetId: string, signal: AbortSignal): Promise<CanvasAssetOriginResult>
  active(): boolean
  changed(state: AssetOriginLookupState): void
}) {
  let generation = 0, disposed = false, pending: AbortController | null = null
  function current(ticket: number, signal: AbortSignal): boolean { return !disposed && ticket === generation && !signal.aborted && input.active() }
  return {
    async load(): Promise<void> {
      if (disposed || !input.active()) return
      const ticket = ++generation
      pending?.abort()
      const controller = new AbortController()
      pending = controller
      input.changed({ state: 'loading' })
      try {
        const response = await input.read(input.assetId, controller.signal)
        if (!current(ticket, controller.signal)) return
        const result = parseCanvasAssetOrigin(response, input.assetId)
        input.changed({ state: 'ready', result })
      } catch (error) {
        if (current(ticket, controller.signal)) input.changed({ state: 'error', message: error instanceof Error ? error.message : '素材来源暂时无法核对，请重试。' })
      } finally { if (pending === controller) pending = null }
    },
    dispose(): void { disposed = true; generation++; pending?.abort(); pending = null },
  }
}
