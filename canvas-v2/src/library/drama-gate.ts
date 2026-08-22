import type { DramaAssetData, DramaShotGate } from './drama-model'

export function dramaShotGate(assets: readonly DramaAssetData[]): DramaShotGate {
  if (assets.some((asset) => asset.locked !== true)) return 'blocked'
  return 'ready'
}

export function dramaShotBlockedReason(assets: readonly DramaAssetData[]): string | undefined {
  const unlocked = assets.filter((asset) => asset.locked !== true)
  if (unlocked.length === 0) return undefined
  const names = unlocked.map((asset) => asset.name || asset.elementId).join('、')
  const kindLabel = unlocked[0].assetKind === 'character' ? '角色' : unlocked[0].assetKind === 'scene' ? '场景' : '道具'
  return `请先封板${kindLabel}「${unlocked[0].name || unlocked[0].elementId}」的定妆图${unlocked.length > 1 ? `（还缺：${names}）` : ''}`
}

export function markDramaShotStale(current: DramaShotGate | undefined, compiled: boolean): DramaShotGate {
  if (!compiled) return current === 'blocked' ? 'blocked' : 'ready'
  return 'stale'
}
