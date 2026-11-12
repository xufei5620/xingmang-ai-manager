import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasAssetPage, CanvasListedAssetSummary } from '../host'
import { AccountAssetLibraryView, type AccountAssetLibraryViewProps } from './AccountAssetLibrary'
import {
  accountAssetDetail, accountAssetItems, accountAssetLastPageOffset, accountAssetLibraryInProjectNotice, accountAssetLibraryNote, accountAssetLibraryRequested, accountAssetQuery,
  accountAssetRangeLabel, validateAccountAssetPage, withoutAccountAssetLibraryRoute,
} from './account-asset-library-model'

function image(index: number, extra: Partial<CanvasListedAssetSummary> = {}): CanvasListedAssetSummary {
  const assetId = String.fromCharCode(97 + index).repeat(43)
  return {
    assetId, mediaType: 'image', mimeType: 'image/png', localUrl: `xingmang-asset://image/${assetId}`, thumbnailUrl: `xingmang-asset://thumb/v1/image/${assetId}`,
    fileName: `image-${index}.png`, displayName: `猫 ${index}`, createdAt: '2026-11-10T08:00:00.000Z', width: 1024, height: 768, ...extra,
  } as CanvasListedAssetSummary
}

function video(index: number): CanvasListedAssetSummary {
  const assetId = String.fromCharCode(97 + index).repeat(43)
  return {
    assetId, mediaType: 'video', mimeType: 'video/mp4', localUrl: `xingmang-asset://video/${assetId}`, thumbnailUrl: `xingmang-asset://thumb/v1/video/${assetId}`,
    fileName: `clip-${index}.mp4`, displayName: `片段 ${index}`, createdAt: '2026-11-09T08:00:00.000Z', width: 1280, height: 720, durationSeconds: 5,
  } as CanvasListedAssetSummary
}

function page(items: CanvasListedAssetSummary[], offset = 0, total = items.length): CanvasAssetPage {
  return { items, offset, limit: 24, total, hasMore: offset + items.length < total, facets: { tags: [] } } as CanvasAssetPage
}

function view(overrides: Partial<AccountAssetLibraryViewProps> = {}): string {
  const props: AccountAssetLibraryViewProps = {
    search: '', page: page([image(0), image(1)], 0, 30), loading: false, error: null, preview: null, saving: false, saveMessage: null,
    onSearchChange: vi.fn(), onRefresh: vi.fn(), onPage: vi.fn(), onPreview: vi.fn(), onSave: vi.fn(), onClose: vi.fn(),
    ...overrides,
  }
  return renderToStaticMarkup(createElement(AccountAssetLibraryView, props))
}

describe('account asset library', () => {
  it('opens only for ?view=assets and drops just that part of the address when it closes', () => {
    expect(accountAssetLibraryRequested('?view=assets&theme=dark')).toBe(true)
    expect(accountAssetLibraryRequested('?theme=dark')).toBe(false)
    expect(accountAssetLibraryRequested('?view=runs')).toBe(false)
    expect(withoutAccountAssetLibraryRoute('xingmang-canvas://app/?theme=dark&view=assets&siteId=solov')).toBe('/?theme=dark&siteId=solov')
    expect(withoutAccountAssetLibraryRoute('xingmang-canvas://app/?theme=dark')).toBeNull()
  })

  it('asks only for pictures, one page of the newest at a time, with a bounded search', () => {
    expect(accountAssetQuery('  猫  ', 48)).toEqual({ mediaType: 'image', view: 'all', source: 'all', sort: 'created-desc', search: '猫', offset: 48, limit: 24 })
    expect(accountAssetQuery('x'.repeat(500), -3)).toMatchObject({ mediaType: 'image', search: 'x'.repeat(160), offset: 0 })
    expect(accountAssetQuery('', 1.5).offset).toBe(0)
    expect(accountAssetQuery('')).toMatchObject({ mediaType: 'image', view: 'all', offset: 0 })
  })

  it('refuses a page that does not answer the query it was sent for', () => {
    const query = accountAssetQuery('', 24)
    expect(validateAccountAssetPage(page([image(0)], 24, 25), query).items).toHaveLength(1)
    for (const wrong of [page([image(0)], 0, 25), { ...page([image(0)], 24, 25), limit: 48 }, page([image(0)], 24, 24), { ...page([], 24, 30), items: 'x' }]) {
      expect(() => validateAccountAssetPage(wrong as CanvasAssetPage, query)).toThrow('素材列表返回的信息不完整，请重新读取。')
    }
  })

  it('shows only pictures it can display, never ones in the recycle bin, and nothing else a host sends along', () => {
    const shown = accountAssetItems(page([image(0), image(1, { deletedAt: '2026-11-10T09:00:00.000Z' }), image(2, { localUrl: 'https://example.com/a.png', thumbnailUrl: '' }), video(3), image(4)]))
    expect(shown.map((asset) => asset.fileName)).toEqual(['image-0.png', 'image-4.png'])
    expect(accountAssetRangeLabel(page([image(0), image(1)], 24, 30))).toBe('25–26 / 30 张图片')
    expect(accountAssetRangeLabel(page([], 0, 0))).toBe('0 / 0 张图片')
    expect(accountAssetLastPageOffset(page([], 48, 30))).toBe(24)
    expect(accountAssetDetail(image(0))).toBe(`1024×768 · ${new Date('2026-11-10T08:00:00.000Z').toLocaleDateString('zh-CN')}`)
    expect(accountAssetDetail(image(0, { width: undefined, createdAt: 'later' }))).toBe('')
  })

  it('lists pictures to look at and save, with nothing that changes the library or the canvas', () => {
    const html = view({ page: page([image(0), video(1), image(2)], 0, 30) })
    expect(html).toContain('role="dialog"')
    expect(html).toContain('素材库')
    expect(html).toContain(accountAssetLibraryNote)
    expect(html).toContain('aria-label="查看图片：猫 0"')
    expect(html).toContain('aria-label="查看图片：猫 2"')
    expect(html).not.toContain('片段 1')
    expect(html).not.toContain('<video')
    expect(html).toContain('1–3 / 30 张图片')
    for (const word of ['视频', '音频', '添加', '导入', '重命名', '收藏', '回收', '删除', '编辑标签']) expect(html, word).not.toContain(word)
  })

  it('says when it is reading, when reading failed and when nothing matches', () => {
    expect(view({ loading: true })).toContain('正在读取素材…')
    const failed = view({ error: '请先登录' })
    expect(failed).toContain('素材没有读出来')
    expect(failed).toContain('请先登录')
    expect(failed).toContain('重新读取')
    expect(view({ page: page([]) })).toContain('素材库里还没有图片')
    expect(view({ page: page([video(0)]) })).toContain('素材库里还没有图片')
    const nothing = view({ page: page([]), search: '狗' })
    expect(nothing).toContain('没有匹配的图片')
    expect(nothing).toContain('清除搜索')
  })

  it('previews one asset with a way back and a save through the host', () => {
    const html = view({ preview: image(0), saveMessage: { kind: 'done', text: '已另存「猫 0」' } })
    expect(html).toContain('返回列表')
    expect(html).toContain('另存到电脑')
    expect(html).toContain('已另存「猫 0」')
    expect(html).toContain('src="xingmang-asset://image/')
    expect(html).not.toContain('查看图片：')
    expect(view({ preview: image(0), saveMessage: { kind: 'error', text: '另存没有完成，请重试。' } })).toContain('role="alert"')
  })

  it('is opened by the project center from the address and closed back to it', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('const accountAssets = accountAssetLibraryRequested(window.location.search)')
    expect(app).toContain('if (accountAssets && !template) { setAccountAssetsOpen(true); return }')
    expect(app).toContain('{projectImportRecoveryDialog}{accountAssetLibraryDialog}')
    expect(app).toContain('const accountAssetLibraryDialog = accountAssetsOpen && !activeProject ? <AccountAssetLibrary')
    expect(app).toContain('const saveAccountAsset = useCallback((assetId: string) => hostBridge().saveAsset(assetId), [])')
  })

  it('opens again when the host asks while the project center is showing, and only says where it is over an open or opening project', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('useEffect(() => window.xingmangCanvasHost?.onShowAccountAssets?.(() => {')
    expect(app).toContain('if (!activeProjectIdRef.current && !projectTransitionRef.current) setAccountAssetsOpen(true)')
    expect(app).toContain('else setBanner(accountAssetLibraryInProjectNotice)')
    expect(accountAssetLibraryInProjectNotice).toBe('素材库在项目中心：先点左上角的文件夹图标回到项目中心，再看素材库里的图片')
    const host = readFileSync(new URL('../host.ts', import.meta.url), 'utf8')
    expect(host).toContain('onShowAccountAssets?(listener: () => void): () => void')
  })
})
