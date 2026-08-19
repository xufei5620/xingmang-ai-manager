import type { CanvasAssetQuery } from '../host'

/**
 * What an empty asset grid should say.
 *
 * It used to say "没有符合条件的本地资产" in every case, which is true and
 * useless: a library with nothing in it, a search that matched nothing and a
 * favourites view nobody has favourited anything into need three different next
 * steps, and the one they share -- clear whatever you just did -- is the only
 * one the old line never offered.
 */

export type AssetEmptyAction = 'import' | 'clear-search' | 'clear-filters' | 'show-all'

export interface AssetEmptyState {
  /** Distinguishes the cases for tests; not shown. */
  reason: 'library' | 'search' | 'filters' | 'favorite' | 'recent'
  title: string
  description: string
  kind: AssetEmptyAction
  label: string
}

type EmptyStateQuery = Pick<CanvasAssetQuery, 'search' | 'tag' | 'mediaType' | 'source' | 'view'>

const mediaTypeNames: Record<string, string> = { image: '图片', video: '视频', audio: '音频' }
const sourceNames: Record<string, string> = { generated: 'AI 生成', imported: '本地导入', legacy: '历史素材' }

function activeFilterName(query: EmptyStateQuery): string | null {
  if (typeof query.tag === 'string' && query.tag.length > 0) return `标签「${query.tag}」`
  if (query.mediaType && query.mediaType !== 'all') return mediaTypeNames[query.mediaType] ?? null
  if (query.source && query.source !== 'all') return sourceNames[query.source] ?? null
  return null
}

/**
 * Resolved in the order of what the user did most recently and can most easily
 * undo: the search they just typed, then the filters they set, then the view
 * they switched to. Only when none of those explain the emptiness is the
 * library itself empty.
 */
export function assetEmptyState(query: EmptyStateQuery): AssetEmptyState {
  const search = (query.search ?? '').trim()
  if (search.length > 0) {
    return {
      reason: 'search',
      title: `没有匹配「${search}」的素材`,
      description: '搜索会匹配素材名称、原文件名与资产 ID。换个关键词，或清除搜索看看全部素材。',
      kind: 'clear-search',
      label: '清除搜索',
    }
  }
  const filterName = activeFilterName(query)
  if (filterName !== null) {
    return {
      reason: 'filters',
      title: '当前筛选下没有素材',
      description: `${filterName}没有匹配的素材。清除筛选可以看到这个视图下的全部素材。`,
      kind: 'clear-filters',
      label: '清除筛选',
    }
  }
  if (query.view === 'favorites') {
    return {
      reason: 'favorite',
      title: '还没有收藏素材',
      description: '在素材卡片上点星标，或选中后按句点键，收藏的素材会集中出现在这里。',
      kind: 'show-all',
      label: '查看全部素材',
    }
  }
  if (query.view === 'recent') {
    return {
      reason: 'recent',
      title: '最近没有用过素材',
      description: '把素材拖进画布或添加到节点后，它就会出现在这里，方便接着用。',
      kind: 'show-all',
      label: '查看全部素材',
    }
  }
  return {
    reason: 'library',
    title: '素材库还是空的',
    description: '导入本地图片、视频或音频，或者先运行一次生成节点，产出会自动进入素材库。',
    kind: 'import',
    label: '导入本地素材',
  }
}
