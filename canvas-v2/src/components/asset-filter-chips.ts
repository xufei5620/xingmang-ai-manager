import type { CanvasAssetQuery } from '../host'

/**
 * The active filters, as chips that can each be taken off.
 *
 * The tray spent two rows of selects and a third of tags on filters that are
 * almost always at their defaults, and the only way to find out what was
 * narrowing the results was to read all four controls. The controls move into a
 * popover; what is actually on shows here, and each chip carries the patch that
 * removes it.
 */

export interface AssetFilterChip {
  id: 'search' | 'tag' | 'mediaType' | 'source' | 'sort' | 'prompt' | 'runId' | 'nodeId'
  label: string
  /** Applied over the current query to take this filter off. */
  patch: Partial<CanvasAssetQuery>
}

type FilterQuery = Pick<CanvasAssetQuery, 'search' | 'tag' | 'mediaType' | 'source' | 'sort' | 'view' | 'prompt' | 'runId' | 'nodeId'>

/** A prompt is a paragraph; a chip is a line. */
function shortPrompt(prompt: string): string {
  return prompt.length > 24 ? `${prompt.slice(0, 24)}…` : prompt
}

export const defaultAssetSort = 'created-desc'

const mediaTypeNames: Record<string, string> = { image: '图片', video: '视频', audio: '音频' }
const sourceNames: Record<string, string> = { generated: 'AI 生成', imported: '本地导入', legacy: '历史素材' }
const sortNames: Record<string, string> = {
  'created-desc': '最新创建',
  'created-asc': '最早创建',
  'used-desc': '最近使用',
  'name-asc': '名称',
}

export function activeAssetFilters(query: FilterQuery): AssetFilterChip[] {
  const chips: AssetFilterChip[] = []
  const search = (query.search ?? '').trim()
  if (search.length > 0) chips.push({ id: 'search', label: `搜索：${search}`, patch: { search: '' } })
  if (typeof query.tag === 'string' && query.tag.length > 0) {
    chips.push({ id: 'tag', label: `标签：${query.tag}`, patch: { tag: '' } })
  }
  // "Find similar" is a filter like any other, so it has to be visible and
  // removable; otherwise the library appears to have lost most of its contents.
  const prompt = (query.prompt ?? '').trim()
  if (prompt.length > 0) chips.push({ id: 'prompt', label: `同提示词：${shortPrompt(prompt)}`, patch: { prompt: undefined } })
  if (query.runId) chips.push({ id: 'runId', label: '同一次运行', patch: { runId: undefined } })
  if (query.nodeId) chips.push({ id: 'nodeId', label: `同来源节点：${query.nodeId}`, patch: { nodeId: undefined } })
  if (query.mediaType && query.mediaType !== 'all') {
    chips.push({ id: 'mediaType', label: mediaTypeNames[query.mediaType] ?? query.mediaType, patch: { mediaType: 'all' } })
  }
  if (query.source && query.source !== 'all') {
    chips.push({ id: 'source', label: sourceNames[query.source] ?? query.source, patch: { source: 'all' } })
  }
  // The recent view owns its sort, so offering to remove it would be offering
  // to break the view the user is looking at.
  if (query.sort && query.sort !== defaultAssetSort && query.view !== 'recent') {
    chips.push({ id: 'sort', label: `排序：${sortNames[query.sort] ?? query.sort}`, patch: { sort: defaultAssetSort } })
  }
  return chips
}

/** Shown on the collapsed filter button so a hidden filter is never a surprise. */
export function activeAssetFilterCount(query: FilterQuery): number {
  return activeAssetFilters(query).length
}
