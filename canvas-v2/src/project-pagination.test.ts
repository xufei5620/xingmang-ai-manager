import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasProjectPage, CanvasProjectQuery } from './host'
import { ProjectCenter } from './components/ProjectCenter'
import { canvasProjectPageOffset, canvasProjectPageRange, canvasProjectStorageCopy, defaultCanvasProjectQuery, loadCanvasProjectPage, validateCanvasProjectPage } from './project-pagination'

function project(id: string) {
  return { id, name: id, version: 7, createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z', lastOpenedAt: '2026-10-10T00:00:00.000Z', nodeCount: 0, assetCount: 0, workspaceConfigured: true, workspaceStatus: 'ready' as const }
}

function page(total = 535, offset = 0, limit = 24): CanvasProjectPage {
  return { items: Array.from({ length: Math.min(limit, Math.max(0, total - offset)) }, (_, index) => project(`project-${offset + index}`)), total, offset, limit, counts: { all: total + 11, active: total, archived: 11 } }
}

describe('canvas project pagination', () => {
  it('validates complete pages and rejects missing totals, partial pages and duplicate IDs', () => {
    expect(() => validateCanvasProjectPage(page())).not.toThrow()
    const duplicate = page(2)
    duplicate.items[1].id = duplicate.items[0].id
    for (const value of [{ ...page(), total: undefined }, { ...page(), items: [] }, { ...page(), counts: { all: 1, active: 1, archived: 1 } }, { ...page(), limit: 101 }, duplicate, { ...page(1), items: [{ ...project('one'), version: 0 }] }]) expect(() => validateCanvasProjectPage(value)).toThrow('无法读取')
  })

  it('uses real ranges and corrects an empty final page after archive or restore', async () => {
    expect(canvasProjectPageRange(page())).toBe('1–24 / 535 个项目')
    expect(canvasProjectPageRange(page(0))).toBe('0–0 / 0 个项目')
    expect(canvasProjectPageOffset(48, 24, 48)).toBe(24)
    const load = vi.fn(async (query: CanvasProjectQuery) => page(48, query.offset))
    const result = await loadCanvasProjectPage(load, { ...defaultCanvasProjectQuery, offset: 48 }, () => true)
    expect(load).toHaveBeenCalledTimes(2)
    expect(load.mock.calls.map(([query]) => query.offset)).toEqual([48, 24])
    expect(result?.query.offset).toBe(24)
    expect(result?.page.items).toHaveLength(24)
    const empty = await loadCanvasProjectPage(async (query) => page(0, query.offset), { ...defaultCanvasProjectQuery, view: 'archived', offset: 24 }, () => true)
    expect(empty?.query).toMatchObject({ view: 'archived', offset: 0 })
    expect(empty?.page.total).toBe(0)
  })

  it('discards an old response before correcting its offset when a new query has begun', async () => {
    let resolve: (value: CanvasProjectPage) => void = () => undefined
    let current = true
    const held = new Promise<CanvasProjectPage>((done) => { resolve = done })
    const load = vi.fn(() => held)
    const pending = loadCanvasProjectPage(load, { ...defaultCanvasProjectQuery, offset: 48 }, () => current)
    current = false
    resolve(page(24, 48))
    expect(await pending).toBeNull()
    expect(load).toHaveBeenCalledOnce()
  })

  it('ignores a superseded failure and keeps current failures actionable', async () => {
    let reject: (error: Error) => void = () => undefined
    let current = true
    const held = new Promise<CanvasProjectPage>((_done, fail) => { reject = fail })
    const pending = loadCanvasProjectPage(() => held, { ...defaultCanvasProjectQuery }, () => current)
    current = false
    reject(new Error('Old list failure'))
    expect(await pending).toBeNull()
    await expect(loadCanvasProjectPage(async () => { throw new Error('请重新读取项目') }, { ...defaultCanvasProjectQuery }, () => true)).rejects.toThrow('请重新读取')
  })

  it('bounds correction attempts and rejects a mismatched server query position', async () => {
    const load = vi.fn(async (query: CanvasProjectQuery) => page(query.offset ?? 0, query.offset))
    await expect(loadCanvasProjectPage(load, { ...defaultCanvasProjectQuery, offset: 96 }, () => true)).rejects.toThrow('正在变化')
    expect(load).toHaveBeenCalledTimes(3)
    await expect(loadCanvasProjectPage(async () => page(10, 0, 10), { ...defaultCanvasProjectQuery }, () => true)).rejects.toThrow('位置未确认')
  })

  it('renders whole-library counts, server sorting and pagination in cloud mode', () => {
    const initial = page()
    const html = renderToStaticMarkup(createElement(ProjectCenter, { projects: initial.items, page: initial, query: { ...defaultCanvasProjectQuery }, storageMode: 'cloud', loading: false, error: null, onQueryChange: () => undefined, onCreate: async () => true, onOpen: () => undefined, onRename: async () => true, onDuplicate: async () => true, onSetArchived: async () => true }))
    expect(html).toContain('535')
    expect(html).toContain('1–24 / 535 个项目')
    expect(html).toContain('搜索项目')
    expect(html).toContain('最近创建')
    expect(html).toContain('下一页')
    expect(html).toContain('云端保存')
    expect(html).not.toContain('独立工作文件夹')
    expect(html).not.toContain('选择文件夹')
  })

  it('preserves local folder copy and omits paging controls for a legacy host', () => {
    const html = renderToStaticMarkup(createElement(ProjectCenter, { projects: [project('local')], loading: false, error: null, onCreate: async () => true, onOpen: () => undefined, onRename: async () => true, onDuplicate: async () => true, onSetArchived: async () => true }))
    expect(html).toContain('独立工作文件夹')
    expect(html).not.toContain('工程分页')
    expect(html).not.toContain('搜索项目')
    expect(canvasProjectStorageCopy('local')).toMatchObject({ create: '选择文件夹并创建', duplicate: '选择文件夹并复制' })
    expect(canvasProjectStorageCopy('cloud')).toMatchObject({ create: '创建项目', duplicate: '创建副本' })
  })
})
