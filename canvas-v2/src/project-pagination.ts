import type { CanvasProjectPage, CanvasProjectQuery } from './host'

export interface CanvasProjectListQuery extends CanvasProjectQuery {
  view: 'active' | 'archived'
  limit: number
  offset: number
  sort: 'updated-desc' | 'created-desc' | 'name-asc'
}

export const defaultCanvasProjectQuery: CanvasProjectListQuery = { view: 'active', limit: 24, offset: 0, sort: 'updated-desc' }

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function validateCanvasProjectPage(value: unknown): asserts value is CanvasProjectPage {
  if (!object(value) || !Array.isArray(value.items) || !count(value.total) || !count(value.offset) || !count(value.limit) || value.limit < 1 || value.limit > 100 || value.items.length !== Math.min(value.limit, Math.max(0, value.total - value.offset)) || !object(value.counts) || !count(value.counts.all) || !count(value.counts.active) || !count(value.counts.archived) || value.counts.active + value.counts.archived !== value.counts.all || value.total > value.counts.all) throw new Error('工程分页数据无法读取，请重新读取项目')
  const ids = new Set<string>()
  for (const item of value.items) {
    if (!object(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id) || typeof item.name !== 'string' || !count(item.version) || item.version < 1 || (item.nodeCount !== null && !count(item.nodeCount)) || (item.assetCount !== null && !count(item.assetCount)) || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string' || typeof item.lastOpenedAt !== 'string' || !['ready', 'missing', 'legacy'].includes(String(item.workspaceStatus))) throw new Error('工程摘要无法读取，请重新读取项目')
    ids.add(item.id)
  }
}

export function canvasProjectPageOffset(total: number, limit: number, offset: number): number {
  if (total === 0) return 0
  return Math.min(offset, Math.floor((total - 1) / limit) * limit)
}

export function canvasProjectPageRange(page: CanvasProjectPage): string {
  const start = page.items.length ? page.offset + 1 : 0
  const end = page.items.length ? page.offset + page.items.length : 0
  return `${start}–${end} / ${page.total} 个项目`
}

export async function loadCanvasProjectPage(
  load: (query: CanvasProjectQuery) => Promise<CanvasProjectPage>,
  query: CanvasProjectListQuery,
  isCurrent: () => boolean,
): Promise<{ page: CanvasProjectPage; query: CanvasProjectListQuery } | null> {
  let currentQuery = { ...query }
  try {
    for (let correction = 0; correction < 3; correction++) {
      const page = await load(currentQuery)
      if (!isCurrent()) return null
      validateCanvasProjectPage(page)
      if (page.limit !== currentQuery.limit || page.offset !== currentQuery.offset) throw new Error('工程分页位置未确认，请重新读取项目')
      const offset = canvasProjectPageOffset(page.total, page.limit, page.offset)
      if (offset === page.offset) {
        if (!page.items.length && page.total > page.offset) throw new Error('工程分页内容缺失，请重新读取项目')
        return { page, query: currentQuery }
      }
      // A mutation can remove the only item on the final page. Re-read its
      // valid predecessor instead of leaving an apparently empty library.
      currentQuery = { ...currentQuery, offset }
    }
    throw new Error('工程列表正在变化，请重新读取项目')
  } catch (error) {
    if (!isCurrent()) return null
    throw error
  }
}

export function canvasProjectStorageCopy(storageMode: 'local' | 'cloud') {
  return storageMode === 'cloud'
    ? { introduction: '项目节点与布局会自动云端保存，素材保存在您的账户中', create: '创建项目', duplicate: '创建副本', duplicateHint: '创建独立的云端工作流副本，已有素材仍属于您的账户。', archiveHint: '归档后保留工作流与账户素材，可随时恢复。' }
    : { introduction: '每个项目使用独立工作文件夹，节点、布局和生成素材会自动保存', create: '选择文件夹并创建', duplicate: '选择文件夹并复制', duplicateHint: '下一步选择一个新的空工作文件夹，项目节点、布局和素材会一并复制。', archiveHint: '归档后保留工作流与本地素材，可随时恢复。' }
}
