import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasAssetPage, CanvasImageAssetSummary } from '../host'
import { builtinCanvasTemplates } from '../templates/builtin-templates'
import { validateTemplateConfiguratorState } from './template-configurator-model'
import { TemplateAssetPicker } from './TemplateAssetPicker'
import { buildTemplateImageQuery, createTemplateAssetRequestGuard, createTemplateReferenceGuard, isTemplateImageAsset, loadTemplateImagePage, retainTemplateReference, templateImagePageOffset, templateReferenceIds, validateTemplateImagePage } from './template-asset-picker-model'

function image(id = 'a'.repeat(43)): CanvasImageAssetSummary {
  return { assetId: id, mediaType: 'image', localUrl: `xingmang-asset://image/${id}`, thumbnailUrl: `xingmang-asset://thumb/v2/image/${id}`, mimeType: 'image/png', fileName: 'reference.png', displayName: '较早的商品参考图', createdAt: '2025-01-01T00:00:00.000Z' }
}

function page(offset = 0, total = 30): CanvasAssetPage {
  return { items: Array.from({ length: Math.max(0, Math.min(24, total - offset)) }, (_value, index) => ({ ...image(String(offset + index).padStart(43, 'a')), displayName: `素材 ${offset + index + 1}` })), offset, limit: 24, total, hasMore: offset + 24 < total, facets: { tags: [] } }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('template image library selection', () => {
  it('queries the full image library independently of the editor page and search', () => {
    expect(buildTemplateImageQuery('  更早&view=trash  ', 24)).toEqual({ mediaType: 'image', view: 'all', source: 'all', sort: 'created-desc', search: '更早&view=trash', offset: 24, limit: 24 })
    expect(buildTemplateImageQuery('x'.repeat(200)).search).toHaveLength(160)
    expect(buildTemplateImageQuery('')).not.toHaveProperty('tag')
    expect(buildTemplateImageQuery('')).not.toHaveProperty('runId')
  })

  it('preserves server totals and validates the second page of an older library', () => {
    const result = validateTemplateImagePage(page(24), buildTemplateImageQuery('', 24))
    expect(result.total).toBe(30)
    expect(result.items).toHaveLength(6)
    expect(result.offset).toBe(24)
    expect(result.hasMore).toBe(false)
    expect(result.items[0].displayName).toBe('素材 25')
  })

  it('accepts a real empty library but rejects malformed successful replies', () => {
    expect(validateTemplateImagePage(page(0, 0), buildTemplateImageQuery('')).total).toBe(0)
    for (const invalid of [{ items: [], total: 0 }, { ...page(), total: -1 }, { ...page(), total: 1, hasMore: false }, { ...page(), items: [] }, { ...page(), hasMore: false }, { ...page(), items: [{ ...image(), mediaType: 'video' }] }, { ...page(), offset: 24 }]) {
      expect(() => validateTemplateImagePage(invalid, buildTemplateImageQuery(''))).toThrow('返回信息不完整')
    }
  })

  it('rejects foreign previews, forged asset ids, removed images and incompatible media', () => {
    for (const invalid of [{ ...image(), localUrl: 'https://foreign.test/image.png' }, { ...image(), thumbnailUrl: 'https://foreign.test/track' }, { ...image(), thumbnailUrl: `xingmang-asset://image/${'b'.repeat(43)}` }, { ...image(), assetId: '../private' }, { ...image(), mediaType: 'audio' }, { ...image(), mimeType: 'video/mp4' }, { ...image(), tags: {} }, { ...image(), favorite: 'yes' }, { ...image(), deletedAt: '2025-01-02' }]) expect(isTemplateImageAsset(invalid)).toBe(false)
    const own = image()
    const webAlias = { ...own, localUrl: `/api/assets/${own.assetId}/content`, thumbnailUrl: `/api/assets/${own.assetId}/content` }
    // Older web addresses are the host's to recognise; without such a host they are someone else's address.
    expect(isTemplateImageAsset(webAlias)).toBe(false)
    vi.stubGlobal('window', { xingmangCanvasHost: { resolveHostAssetUrl: (url: string) => url === `/api/assets/${own.assetId}/content` ? { assetId: own.assetId } : undefined } })
    expect(isTemplateImageAsset(webAlias)).toBe(true)
    expect(isTemplateImageAsset(own)).toBe(true)
    vi.stubGlobal('window', { xingmangCanvasHost: { resolveHostAssetUrl: () => ({ assetId: own.assetId, projectId: '11111111-1111-4111-8111-111111111111' }) } })
    expect(isTemplateImageAsset(webAlias)).toBe(false)
  })

  it('keeps the selected summary when the next library page does not contain it', () => {
    const first = page()
    const chosen = retainTemplateReference({}, 'reference', first.items[0])
    const second = page(24)
    expect(second.items.some((asset) => asset.assetId === chosen.reference.assetId)).toBe(false)
    expect(templateReferenceIds(chosen).has(first.items[0].assetId)).toBe(true)
    expect(chosen.reference.displayName).toBe('素材 1')
  })

  it('uses an uploaded owned image immediately without depending on the editor filtered page', () => {
    const template = builtinCanvasTemplates.find((entry) => entry.id === 'xingmang-reference-edit')
    expect(template).toBeDefined()
    if (!template) throw new Error('fixture template missing')
    const variable = template.variables.find((entry) => entry.type === 'asset')!
    const uploaded = image('u'.repeat(43))
    const retained = retainTemplateReference({}, variable.id, uploaded)
    const fields = Object.fromEntries(template.variables.map((entry) => [entry.id, entry.type === 'asset' ? uploaded.assetId : '测试图片编辑']))
    expect(validateTemplateConfiguratorState(template, fields, new Set(page(24).items.map((entry) => entry.assetId))).valid).toBe(false)
    expect(validateTemplateConfiguratorState(template, fields, templateReferenceIds(retained)).valid).toBe(true)
  })

  it('keeps each reference variable independent and refuses unowned source objects', () => {
    const first = retainTemplateReference({}, 'character', image())
    const both = retainTemplateReference(first, 'scene', image('b'.repeat(43)))
    expect(first).not.toHaveProperty('scene')
    expect(templateReferenceIds(both).size).toBe(2)
    expect(() => retainTemplateReference(both, 'scene', { ...image(), localUrl: 'https://foreign.test/a' })).toThrow('不可使用')
  })

  it('returns to the last valid page when library deletions leave an empty tail', () => {
    expect(templateImagePageOffset(page(48, 30))).toBe(24)
    expect(templateImagePageOffset(page(24, 24))).toBe(0)
    expect(templateImagePageOffset(page(24, 0))).toBe(0)
  })

  it('invalidates old page replies before a new search or a dialog close', () => {
    const guard = createTemplateAssetRequestGuard()
    const old = guard.begin()
    guard.invalidate()
    expect(guard.current(old)).toBe(false)
    const fresh = guard.begin()
    expect(guard.current(old)).toBe(false)
    expect(guard.current(fresh)).toBe(true)
    guard.invalidate()
    expect(guard.current(fresh)).toBe(false)
  })

  it('refuses late uploads after changing template, variable, or closing the dialog', () => {
    const guard = createTemplateReferenceGuard()
    const oldTemplate = guard.begin('template-a', 'product')
    const nextTemplate = guard.begin('template-b', 'product')
    expect(guard.current(oldTemplate)).toBe(false)
    const nextVariable = guard.begin('template-b', 'scene')
    expect(guard.current(nextTemplate)).toBe(false)
    expect(guard.current(nextVariable)).toBe(true)
    guard.invalidate()
    expect(guard.current(nextVariable)).toBe(false)
  })

  it('stops local waiting and ignores a late IPC reply when the picker closes', async () => {
    let resolve!: (result: CanvasAssetPage) => void
    const source = new Promise<CanvasAssetPage>((complete) => { resolve = complete })
    const controller = new AbortController()
    const waiting = loadTemplateImagePage(() => source, buildTemplateImageQuery(''), controller.signal)
    const rejection = expect(waiting).rejects.toThrow('等待已停止')
    controller.abort()
    await rejection
    resolve(page())
    await Promise.resolve()
  })

  it('times out stalled host reads without claiming an empty library', async () => {
    vi.useFakeTimers()
    const waiting = loadTemplateImagePage(() => new Promise(() => undefined), buildTemplateImageQuery(''), new AbortController().signal)
    const rejection = expect(waiting).rejects.toThrow('读取超时')
    await vi.advanceTimersByTimeAsync(25_000)
    await rejection
  })

  it('propagates a read failure so the UI can show retry instead of empty state', async () => {
    await expect(loadTemplateImagePage(async () => { throw new Error('列表读取失败') }, buildTemplateImageQuery(''), new AbortController().signal)).rejects.toThrow('列表读取失败')
  })

  it('labels the legacy loaded-only fallback accurately without pretending to offer pagination', () => {
    const html = renderToStaticMarkup(createElement(TemplateAssetPicker, { label: '商品图', fallbackPage: page(), onChoose: () => undefined, onCancel: () => undefined }))
    expect(html).toContain('仅提供已加载素材')
    expect(html).toContain('已加载 24 张匹配图片')
    expect(html).not.toContain('下一页图片')
    expect(html).toContain('取消选择')
  })
})
