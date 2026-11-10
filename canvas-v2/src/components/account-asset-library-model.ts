// 项目中心的素材库：画布地址带 ?view=assets 打开时（桌面主窗口「看全部作品」），不用先打开项目，
// 就能翻看当前账号素材库里的图片。这里只看和另存，不改名、不收藏、不回收，也不往画布里加。
// 只列图片：yoyo 选「素材库放开」时同意的是没开项目时读聊天里出的图和传的图，视频、音频不在里面。
// 列出哪些图片由宿主决定（桌面在没打开项目时给聊天用的那个库）；项目自己文件夹里的素材仍在项目
// 里右侧的「素材」页。
import type { CanvasAssetPage, CanvasAssetQuery, CanvasListedAssetSummary } from '../host'
import { canvasAssetIsPreviewable } from './MediaPreview'

export const accountAssetLibraryRoute = { key: 'view', value: 'assets' } as const
export const accountAssetPageSize = 24
export const accountAssetSearchMaxLength = 160

export const accountAssetLibraryNote = '这里列出当前账号素材库里的图片，只能查看和另存，不会改动素材。画布项目自己文件夹里的素材，打开项目后在右侧「素材」页查看。'
/** Shown when the host asks for the library while a project is open: the library lives on the project center. */
export const accountAssetLibraryInProjectNotice = '素材库在项目中心：先点左上角的文件夹图标回到项目中心，再看素材库里的图片'

/** True when the page was opened to show the library rather than a project, template or task. */
export function accountAssetLibraryRequested(search: string): boolean {
  return new URLSearchParams(search).get(accountAssetLibraryRoute.key) === accountAssetLibraryRoute.value
}

/** The address without the library request, so a reload after closing it opens the project center. Null when there is nothing to drop. */
export function withoutAccountAssetLibraryRoute(href: string): string | null {
  const url = new URL(href)
  if (url.searchParams.get(accountAssetLibraryRoute.key) !== accountAssetLibraryRoute.value) return null
  url.searchParams.delete(accountAssetLibraryRoute.key)
  return `${url.pathname}${url.search}${url.hash}`
}

export function accountAssetQuery(search: string, offset = 0): CanvasAssetQuery {
  return {
    mediaType: 'image',
    view: 'all',
    source: 'all',
    sort: 'created-desc',
    search: search.trim().slice(0, accountAssetSearchMaxLength),
    offset: Number.isSafeInteger(offset) && offset > 0 ? offset : 0,
    limit: accountAssetPageSize,
  }
}

/**
 * Checks the page against the query it answers before anything is shown. A
 * host that answers another page, or more than it was asked for, gets a retry
 * rather than a grid whose count and paging disagree.
 */
export function validateAccountAssetPage(value: CanvasAssetPage, query: CanvasAssetQuery): CanvasAssetPage {
  const counts = [value?.offset, value?.limit, value?.total].every((count) => Number.isSafeInteger(count) && count >= 0)
  if (!value || !Array.isArray(value.items) || !counts || value.offset !== query.offset || value.limit !== query.limit
    || value.items.length > value.limit || value.offset + value.items.length > value.total) {
    throw new Error('素材列表返回的信息不完整，请重新读取。')
  }
  return value
}

/** What the grid shows: pictures the page can display, never ones in the recycle bin, and nothing else a host sends along. */
export function accountAssetItems(page: CanvasAssetPage): CanvasListedAssetSummary[] {
  return page.items.filter((asset) => asset.mediaType === 'image' && !asset.deletedAt && canvasAssetIsPreviewable(asset))
}

/** The last page that still has items, for a library that shrank while the view was open. */
export function accountAssetLastPageOffset(page: CanvasAssetPage): number {
  return page.total > 0 ? Math.floor((page.total - 1) / accountAssetPageSize) * accountAssetPageSize : 0
}

export function accountAssetRangeLabel(page: CanvasAssetPage): string {
  if (!page.items.length) return `0 / ${page.total} 张图片`
  return `${page.offset + 1}–${page.offset + page.items.length} / ${page.total} 张图片`
}

export function accountAssetName(asset: CanvasListedAssetSummary): string {
  return asset.displayName || asset.fileName
}

export function accountAssetDetail(asset: CanvasListedAssetSummary): string {
  const size = asset.mediaType === 'image' && asset.width && asset.height ? `${asset.width}×${asset.height}` : ''
  const created = new Date(asset.createdAt)
  const date = Number.isNaN(created.getTime()) ? '' : created.toLocaleDateString('zh-CN')
  return [size, date].filter(Boolean).join(' · ')
}
