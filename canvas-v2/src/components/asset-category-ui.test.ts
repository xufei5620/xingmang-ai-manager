import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AssetCategoryFilter, AssetCategorySelect } from './AssetCategorySelect'
import { AssetCategoryManagerDialog } from './AssetCategoryManagerDialog'
import { AssetCategoryMoveDialog } from './AssetCategoryMoveDialog'
import type { AssetCategoryDirectory } from '../lib/asset-category-contract'

const directory: AssetCategoryDirectory = { version: 1, items: [{ id: '11111111-1111-4111-8111-111111111111', name: '产品', version: 1, counts: { active: 3, trash: 2 }, createdAt: '', updatedAt: '' }], uncategorized: { active: 1, trash: 0 } }
function callbacks() { return { scopeKey: 'owner-a', directory, onReadDirectory: vi.fn(async () => directory), onSubmit: vi.fn(), onInspect: vi.fn(), onChanged: vi.fn(), onClose: vi.fn() } }

describe('private asset category static UI', () => {
  it('offers all and uncategorized separately while a destination never means all', () => {
    const filter = renderToStaticMarkup(createElement(AssetCategoryFilter, { items: directory.items, value: null, onChange() {} }))
    expect(filter).toContain('全部分类'); expect(filter).toContain('value="uncategorized" selected=""'); expect(filter).toContain('产品')
    const destination = renderToStaticMarkup(createElement(AssetCategorySelect, { mode: 'destination', items: directory.items, value: undefined, onChange() {} }))
    expect(destination).not.toContain('全部分类'); expect(destination).toContain('选择目标分类')
  })
  it('has keyboard dialog semantics and accurate asset preservation wording without issuing requests', () => {
    const p = callbacks(), markup = renderToStaticMarkup(createElement(AssetCategoryManagerDialog, p))
    expect(markup).toContain('role="dialog"'); expect(markup).toContain('aria-modal="true"'); expect(markup).toContain('不会改动画布内容或原文件'); expect(p.onSubmit).not.toHaveBeenCalled()
  })
  it('does not call a newly selected category unavailable while its directory is still loading', () => {
    const reading = renderToStaticMarkup(createElement(AssetCategoryFilter, { items: [], value: directory.items[0].id, loading: true, onChange() {} }))
    expect(reading).toContain('正在核对所选分类'); expect(reading).not.toContain('原分类已不可用')
    const settled = renderToStaticMarkup(createElement(AssetCategoryFilter, { items: [], value: directory.items[0].id, onChange() {} }))
    expect(settled).toContain('原分类已不可用'); expect(settled).not.toContain('正在核对所选分类')
    const unconfirmed = renderToStaticMarkup(createElement(AssetCategoryFilter, { items: [], value: directory.items[0].id, directoryConfirmed: false, onChange() {} }))
    expect(unconfirmed).toContain('所选分类待核对'); expect(unconfirmed).not.toContain('原分类已不可用')
  })
  it('does not advertise movement without a real selected target and stable source versions', () => {
    const markup = renderToStaticMarkup(createElement(AssetCategoryMoveDialog, { ...callbacks(), assets: [{ assetId: 'a'.repeat(43), expectedOrganizationVersion: 0 }] }))
    expect(markup).toContain('所选 1 份素材'); expect(markup).toContain('disabled=""'); expect(markup).not.toContain('已移动')
  })
})
