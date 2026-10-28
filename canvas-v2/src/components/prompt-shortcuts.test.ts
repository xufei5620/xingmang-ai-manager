import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow } from '../model'
import { maximumPromptLength } from '../persistence/workflow-schema'
import { clipPromptEditorValue, promptEditorMaxLength } from './prompt-mentions'
import { filterPromptShortcuts, insertPromptShortcut, maximumVisiblePromptShortcuts, promptShortcutComposing, promptShortcutItems, promptShortcutMenuHandlesKeys, promptShortcutQueryAt } from './prompt-shortcuts'
import { PromptShortcutMenu } from './PromptShortcutMenu'
import { PromptEditor } from './PromptEditor'
import { PromptCatalogProvider } from './PromptCatalogContext'
import { PromptPresetMetadataFields } from './PromptPresetMetadataFields'

describe('prompt shortcuts', () => {
  it('detects a collapsed hash query at the beginning or after whitespace', () => {
    expect(promptShortcutQueryAt('#', 1)).toEqual({ start: 0, end: 1, query: '' })
    expect(promptShortcutQueryAt('前文\n#商品 后文', 6)).toEqual({ start: 3, end: 6, query: '商品' })
    expect(promptShortcutQueryAt('url#fragment', 12)).toBeNull()
    expect(promptShortcutQueryAt('#商品', 1, 3)).toBeNull()
    expect(promptShortcutQueryAt('#商品', -1)).toBeNull()
    expect(promptShortcutQueryAt('##', 2)).toBeNull()
  })

  it('inserts the full editable body exactly at the query without losing surrounding content', () => {
    const source = '保留开头\n#商品\n保留结尾🌟'
    const query = promptShortcutQueryAt(source, 8)!
    expect(insertPromptShortcut(source, '商品 🌟\n第二行 #FFFFFF', query)).toEqual({ ok: true, value: '保留开头\n商品 🌟\n第二行 #FFFFFF\n保留结尾🌟', caret: 22 })
    expect(source).toBe('保留开头\n#商品\n保留结尾🌟')
  })

  it('does not modify literal hashes merely by detecting a query', () => {
    const literal = '使用 #FFFFFF 背景'
    expect(promptShortcutQueryAt(literal, 10)?.query).toBe('FFFFFF')
    expect(literal).toBe('使用 #FFFFFF 背景')
  })

  it('refuses a stale insertion range and an oversized body without returning clipped content', () => {
    expect(insertPromptShortcut('changed', 'Template', { start: 0, end: 1, query: '' })).toMatchObject({ ok: false })
    const original = `${'x'.repeat(maximumPromptLength - 2)} #`
    const result = insertPromptShortcut(original, 'large', promptShortcutQueryAt(original, original.length)!)
    expect(result).toMatchObject({ ok: false })
    expect(result).not.toHaveProperty('value')
    expect(original).toHaveLength(maximumPromptLength)
  })

  it('preserves a 24000-character workshop preset through insertion, editor bounds and persistence', () => {
    const body = '🌟'.repeat(12_000)
    const inserted = insertPromptShortcut('#', body, { start: 0, end: 1, query: '' })
    expect(inserted).toEqual({ ok: true, value: body, caret: 24_000 })
    expect(clipPromptEditorValue(body).value).toBe(body)
    expect(promptEditorMaxLength).toBe(maximumPromptLength)
    const workflow = createEmptyWorkflow('Long prompt')
    workflow.nodes = [{ id: 'prompt-1', kind: 'prompt', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: body, model: '', status: 'idle' } }]
    expect(parseWorkflowFile(serializeWorkflow(workflow))?.nodes[0].data.prompt).toBe(body)
  })

  it('indexes names and tags once while keeping long bodies out of per-keystroke search', () => {
    const personal = Array.from({ length: 500 }, (_, index) => ({ id: String(index), name: `个人 ${index}`, tags: ['商品'], prompt: '正文'.repeat(12_000), provenance: 'user-created' as const, createdAt: '', updatedAt: '' }))
    const items = promptShortcutItems(personal)
    expect(filterPromptShortcuts(items, '商品', 'mine')).toHaveLength(500)
    expect(filterPromptShortcuts(items, '个人 499', 'mine')[0]?.name).toBe('个人 499')
    expect(filterPromptShortcuts(items, '正文', 'mine')).toHaveLength(0)
    expect(items[0].searchText.length).toBeLessThan(50)
    expect(items[0].description.length).toBe(160)
    expect(maximumVisiblePromptShortcuts).toBe(50)
    expect(filterPromptShortcuts(items, '', 'builtin').every((item) => item.source === 'builtin')).toBe(true)
  })

  it('recognizes both modern and legacy IME confirmation events', () => {
    expect(promptShortcutComposing({ isComposing: true })).toBe(true)
    expect(promptShortcutComposing({ keyCode: 229 })).toBe(true)
    expect(promptShortcutComposing({ isComposing: false, keyCode: 13 })).toBe(false)
  })

  it('leaves source filters and menu actions with their native keyboard behavior', () => {
    expect(promptShortcutMenuHandlesKeys({ search: true })).toBe(true)
    expect(promptShortcutMenuHandlesKeys({ role: 'option' })).toBe(true)
    expect(promptShortcutMenuHandlesKeys({ role: 'button' })).toBe(false)
    expect(promptShortcutMenuHandlesKeys({})).toBe(false)
  })

  it('renders explicit official-tag and editable-body contracts with accessible filtering', () => {
    const items = promptShortcutItems([]).slice(0, 2)
    const html = renderToStaticMarkup(createElement(PromptShortcutMenu, { id: 'menu', items, total: 2, query: '', source: 'all', activeIndex: 1, draft: '', error: null, onQuery: vi.fn(), onSource: vi.fn(), onActive: vi.fn(), onInsert: vi.fn(), onClose: vi.fn(), onKeyDown: vi.fn() }))
    expect(html).toContain('官方以整体标签插入；我的和已获取插入完整正文。保存后不依赖原模板')
    expect(html).toContain('搜索提示词预设')
    expect(html).toContain('aria-selected="true"')
    expect(html).toContain('id="menu-1"')
    expect(html).toContain('tabindex="-1"')
    expect(html).toContain('aria-busy="false"')
    expect(html).not.toContain('技能库')
  })

  it('renders the stored long body without shortening it on initial display', () => {
    const body = '长'.repeat(24_000)
    const html = renderToStaticMarkup(createElement(PromptEditor, { label: 'Prompt', value: body, placeholder: 'Write', references: [], onChange: vi.fn() }))
    expect(html).toContain(`>${body}</textarea>`)
    expect(html).toContain('maxLength="100000"')
  })

  it('searches group and description in the light index and retains explicit group filtering', () => {
    const preset = { id: '11111111-1111-4111-8111-111111111111', name: '产品', prompt: '正文不进入轻索引', group: '商业摄影', description: '逆光玻璃瓶的拍摄说明', tags: [], provenance: 'user-created' as const, createdAt: '', updatedAt: '', sortOrder: 0 }
    const items = promptShortcutItems([preset])
    expect(filterPromptShortcuts(items, '玻璃瓶', 'mine', '商业摄影')[0]?.id).toBe(`mine:${preset.id}`)
    expect(filterPromptShortcuts(items, '商业摄影', 'mine')[0]?.description).toBe(preset.description)
    expect(filterPromptShortcuts(items, '', 'all', '').some((item) => item.source === 'builtin')).toBe(false)
    expect(filterPromptShortcuts(items, '', 'mine', '别的分组')).toEqual([])
    expect(filterPromptShortcuts(items, '正文不进入', 'mine')).toEqual([])
  })

  it('renders metadata fields and separate management controls without repurposing insertion buttons', () => {
    const personal = { id: '11111111-1111-4111-8111-111111111111', name: '产品', prompt: '正文', group: '电商', description: '简介', tags: [], provenance: 'user-created' as const, createdAt: '', updatedAt: '', version: 1, sortOrder: 0 }
    const items = promptShortcutItems([personal]).filter((item) => item.source === 'mine')
    const menu = createElement(PromptShortcutMenu, { id: 'menu', items, total: 1, query: '', source: 'mine', group: '电商', activeIndex: 0, draft: '', error: null, onQuery: vi.fn(), onSource: vi.fn(), onGroup: vi.fn(), onActive: vi.fn(), onInsert: vi.fn(), onClose: vi.fn(), onKeyDown: vi.fn() })
    const html = renderToStaticMarkup(createElement(PromptCatalogProvider, { value: { items: [personal], loading: false, loaded: true, error: null, enabled: true, load: async () => {}, update: async () => {}, remove: async () => {}, reorder: async () => {} }, children: menu }))
    for (const name of ['上移提示词 产品', '下移提示词 产品', '编辑提示词 产品', '删除提示词 产品', '提示词分组筛选']) expect(html).toContain(`aria-label="${name}"`)
    expect(html).toContain('role="option"')
    expect(html).toContain('简介')
    const fields = renderToStaticMarkup(createElement(PromptPresetMetadataFields, { group: '电商', description: '<script>text</script>', groups: ['电商'], onGroup: vi.fn(), onDescription: vi.fn() }))
    expect(fields).toContain('maxLength="64"')
    expect(fields).toContain('maxLength="1000"')
    expect(fields).toContain('&lt;script&gt;text&lt;/script&gt;')
    expect(fields).not.toContain('<script>')
  })

  it('filters only acquired private prompts by community origin while preserving private editing and full insertion', () => {
    const acquired = { id: '11111111-1111-4111-8111-111111111111', name: '我改过的商品提示词', prompt: '获取后修改的正文', group: '电商', tags: [], provenance: 'user-created' as const, origin: { source: 'community' as const, publicationId: '22222222-2222-4222-8222-222222222222', publicationVersion: 1 as const, authorName: '产品作者' }, createdAt: '', updatedAt: '', version: 2 }
    const own = { ...acquired, id: '33333333-3333-4333-8333-333333333333', origin: undefined, provenance: 'user-created' as const }
    const items = promptShortcutItems([acquired, own])
    const found = filterPromptShortcuts(items, '产品作者', 'acquired', '电商')
    expect(found.map((item) => item.id)).toEqual([`mine:${acquired.id}`])
    expect(filterPromptShortcuts(items, '', 'mine').map((item) => item.id)).toEqual([`mine:${own.id}`])
    expect(insertPromptShortcut('片头 # 片尾', found[0].prompt, { start: 3, end: 4, query: '' })).toMatchObject({ value: '片头 获取后修改的正文 片尾' })
    const menu = createElement(PromptShortcutMenu, { id: 'menu', items: found, total: 1, query: '', source: 'acquired', group: '电商', activeIndex: 0, draft: '', error: null, onQuery: vi.fn(), onSource: vi.fn(), onGroup: vi.fn(), onActive: vi.fn(), onInsert: vi.fn(), onClose: vi.fn(), onKeyDown: vi.fn() })
    const html = renderToStaticMarkup(createElement(PromptCatalogProvider, { value: { items: [acquired, own], loading: false, loaded: true, error: null, enabled: true, load: async () => {}, update: async () => {}, remove: async () => {} }, children: menu }))
    expect(html).toContain('社区 · 产品作者')
    expect(html).toContain('aria-label="编辑提示词 我改过的商品提示词"')
    expect(html).toContain('aria-label="删除提示词 我改过的商品提示词"')
    expect(html).toContain('已获取')
  })
  it('distinguishes file and shared origins and disables protected catalog editing without disabling insertion', () => {
    const shared = { id: '11111111-1111-4111-8111-111111111111', name: '受限分享', prompt: '可插入的完整正文', tags: [], provenance: 'user-created' as const, transferOrigin: { source: 'share' as const, onlyUse: true, authorName: '示例作者' }, createdAt: '', updatedAt: '', version: 1 }
    const imported = { ...shared, id: '22222222-2222-4222-8222-222222222222', name: '导入配置', transferOrigin: { source: 'file' as const, onlyUse: false } }
    const items = filterPromptShortcuts(promptShortcutItems([shared, imported]), '', 'acquired')
    expect(items).toHaveLength(2)
    expect(items.find((item) => item.name === '受限分享')?.originLabel).toBe('分享获取 · 仅使用')
    expect(items.find((item) => item.name === '导入配置')?.originLabel).toBe('文件导入 · 来源未验证')
    expect(filterPromptShortcuts(items, '示例作者', 'acquired')).toHaveLength(1)
    expect(insertPromptShortcut('#', shared.prompt, { start: 0, end: 1, query: '' })).toMatchObject({ ok: true, value: shared.prompt })
    const menu = createElement(PromptShortcutMenu, { id: 'menu', items, total: 2, query: '', source: 'acquired', activeIndex: 0, draft: '', error: null, onQuery: vi.fn(), onSource: vi.fn(), onActive: vi.fn(), onInsert: vi.fn(), onClose: vi.fn(), onKeyDown: vi.fn() })
    const html = renderToStaticMarkup(createElement(PromptCatalogProvider, { value: { items: [shared, imported], loading: false, loaded: true, error: null, enabled: true, load: async () => {}, update: async () => {}, remove: async () => {} }, children: menu }))
    expect(html).toMatch(/aria-label="编辑提示词 受限分享"[^>]*disabled=""/)
    expect(html).not.toMatch(/aria-label="编辑提示词 导入配置"[^>]*disabled/)
    expect(html).not.toMatch(/role="option"[^>]*disabled/)
  })

})
