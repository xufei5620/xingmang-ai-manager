import type { AiChatGroupSummary } from '../../../../electron/ipc-contract'
import type { ChatGroupPreparation } from '../chat/state'

// 「创作」页左边换着开几条视频时，每开一条工作台都重新挂上；以前每挂一次都把全部分组和每个分组的模型从账号站重读一遍
// （创作页复查第 3 条）。同一个账号里几条视频共用一份，过了这么久或者点「刷新模型」才重读。

/** Same lifetime as the price list: models change about as rarely as prices. */
export const videoStudioCatalogMaxAgeMs = 10 * 60_000

export interface VideoStudioCatalog {
  groups: AiChatGroupSummary[]
  preparations: Record<string, ChatGroupPreparation>
}

export interface VideoStudioCatalogCache {
  /** The catalog saved within maxAgeMs; null when there is none or it is older. */
  fresh(): VideoStudioCatalog | null
  /**
   * Keeps a catalog only when every group was read: one that failed would
   * stay missing from every film opened afterwards, so the next one reads again.
   */
  save(catalog: VideoStudioCatalog): void
}

export function isCompleteVideoStudioCatalog(catalog: VideoStudioCatalog): boolean {
  return catalog.groups.length > 0 && catalog.groups.every((group) => catalog.preparations[group.name]?.phase === 'ready')
}

export function createVideoStudioCatalogCache(now: () => number = Date.now, maxAgeMs = videoStudioCatalogMaxAgeMs): VideoStudioCatalogCache {
  let saved: { at: number, catalog: VideoStudioCatalog } | null = null
  return {
    fresh() {
      if (!saved) return null
      const age = now() - saved.at
      return age >= 0 && age < maxAgeMs ? saved.catalog : null
    },
    save(catalog) {
      saved = isCompleteVideoStudioCatalog(catalog) ? { at: now(), catalog } : null
    },
  }
}
