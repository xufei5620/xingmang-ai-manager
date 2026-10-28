import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssetMutationResult } from '../lib/asset-mutation-contract'
import type { CanvasAssetSummary, CanvasRunCandidate, CanvasRunRecord } from '../host'

// Exercise the actual component callbacks and effect ordering in the existing node environment.
const runtime = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as (() => void)[] }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useRef(initial: unknown) { const index = runtime.cursor++; runtime.slots[index] ??= { current: initial }; return runtime.slots[index] },
  useState(initial: unknown) { const index = runtime.cursor++; if (!(index in runtime.slots)) runtime.slots[index] = typeof initial === 'function' ? initial() : initial; return [runtime.slots[index], (value: unknown) => { runtime.slots[index] = typeof value === 'function' ? value(runtime.slots[index]) : value }] },
  useMemo(factory: () => unknown, dependencies: readonly unknown[]) {
    const index = runtime.cursor++, previous = runtime.slots[index] as { dependencies: readonly unknown[]; value: unknown } | undefined
    if (previous && dependencies.length === previous.dependencies.length && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return previous.value
    const value = factory(); runtime.slots[index] = { dependencies, value }; return value
  },
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) {
    const index = runtime.cursor++, previous = runtime.slots[index] as { dependencies: readonly unknown[]; cleanup?: () => void } | undefined
    if (previous && dependencies.length === previous.dependencies.length && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return
    runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); runtime.slots[index] = { dependencies, ...(typeof cleanup === 'function' ? { cleanup } : {}) } })
  },
}))
import { AssetTray } from './AssetTray'
import { RunInspector } from './RunInspector'
import { assetBatchDragMime } from './asset-batch-selection'

interface ElementShape { type: unknown; props: Record<string, unknown> }
function elements(value: unknown, type: unknown): ElementShape[] {
  if (Array.isArray(value)) return value.flatMap((item) => elements(item, type))
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  const element = value as ElementShape
  return [...(element.type === type ? [element] : []), ...elements(element.props.children, type)]
}
function textOf(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(textOf).join('')
  return value && typeof value === 'object' && 'props' in value ? textOf((value as ElementShape).props.children) : ''
}
function button(tree: unknown, label: string) { const result = elements(tree, 'button').find((entry) => entry.props['aria-label'] === label || textOf(entry.props.children) === label); expect(result, label).toBeDefined(); return result! }
function click(tree: unknown, label: string) { const result = button(tree, label); expect(result.props.disabled, label).not.toBe(true); (result.props.onClick as () => void)() }
function check(tree: unknown, label: string) { const result = elements(tree, 'input').find((entry) => entry.props['aria-label'] === label); expect(result, label).toBeDefined(); expect(result!.props.disabled).not.toBe(true); (result!.props.onChange as () => void)() }
function harness<T>(render: () => T) {
  // Resolve the source-switching shell so existing assertions still exercise
  // the real personal tray callbacks rather than a shallow component element.
  function renderRoot(): T { let value: unknown = render(); while (value && typeof value === 'object' && 'type' in value && typeof value.type === 'function' && 'props' in value) value = value.type(value.props); return value as T }
  runtime.cursor = 0; runtime.slots = []; runtime.effects = []
  return {
    render() { runtime.cursor = 0; renderRoot(); runtime.effects.splice(0).forEach((effect) => effect()); runtime.cursor = 0; const result = renderRoot(); runtime.effects.splice(0).forEach((effect) => effect()); return result },
    close() { for (const slot of runtime.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as { cleanup(): void }).cleanup() },
  }
}
function id(index: number) { return String(index).padStart(43, '0') }
function asset(index: number): CanvasAssetSummary & { displayName: string } { return { assetId: id(index), mediaType: 'image', localUrl: `xingmang-asset://image/${id(index)}`, mimeType: 'image/png', thumbnailUrl: '', fileName: `${index}.png`, displayName: `素材${index}`, width: 320, height: 240, createdAt: '2026-10-15T12:00:00Z', metadataLevel: 'complete' } }
function trayProps(): Parameters<typeof AssetTray>[0] { return { page: { items: [asset(1), asset(2), asset(3)], total: 3, offset: 0, limit: 24, hasMore: false, facets: { tags: [] } }, query: { offset: 0, limit: 24, mediaType: 'all', view: 'all', source: 'all', sort: 'created-desc' }, loading: false, batchScope: 'owner-a:project-a', onQueryChange: vi.fn(), onRefresh: vi.fn(), onImport: vi.fn(), onAdd: vi.fn(), onAssetMenu: vi.fn(), onClose: vi.fn(), onAddMany: vi.fn(async () => {}), onDownloadMany: vi.fn(async () => {}) } }
function candidate(index: number): CanvasRunCandidate { return { candidateId: `candidate-${index}`, attemptId: 'attempt', createdAt: '', asset: { assetId: id(index), kind: 'image', localUrl: `xingmang-asset://image/${id(index)}` } } }
function record(runId = 'run-a'): CanvasRunRecord { const missing = candidate(4); missing.asset.localUrl = ''; return { version: 1, runId, userId: 1, ownerId: 1, graphRevision: 'g', scope: { kind: 'all' }, status: 'succeeded', createdAt: '2026-10-15T00:00:00Z', startedAt: '2026-10-15T00:00:00Z', nodes: [[candidate(3), candidate(1)], [candidate(1), candidate(2), missing]].map((candidates, index) => ({ nodeId: `node-${index}`, kind: 'image-generate', state: 'succeeded', attempts: [{ attemptId: 'attempt', fingerprint: 'f', state: 'succeeded', startedAt: '', completedAt: '', durationMs: 1, cached: false, candidates }] })), events: [] } }
function runProps(): Parameters<typeof RunInspector>[0] { return { open: true, records: [record()], selectedRunId: 'run-a', resultAssets: {}, selectedScope: 'all', dirtyCount: 0, selectionCount: 0, loading: false, batchScope: 'owner-a:project-a', onScopeChange: vi.fn(), onRefresh: vi.fn(), onSelectRun: vi.fn(), onUseCandidate: vi.fn(), onPreviewAsset: vi.fn(), onAssetMenu: vi.fn(), onLocateNode: vi.fn(), onClose: vi.fn(), onAddMany: vi.fn(async () => {}), onDownloadMany: vi.fn(async () => {}) } }
function drag(element: ElementShape) { const setData = vi.fn(), preventDefault = vi.fn(); (element.props.onDragStart as (value: unknown) => void)({ dataTransfer: { setData, effectAllowed: '' }, preventDefault }); return { setData, preventDefault } }
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
afterEach(() => vi.unstubAllGlobals())

describe('actual asset tray batch interactions', () => {
  it('retains failed recycle items and offers undo for only confirmed successful items', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    const onRestore = vi.fn(async () => {}), props = { ...trayProps(), onRestore, onDelete: vi.fn(async () => ({ action: 'delete' as const, outcomes: [
      { assetId: id(1), state: 'succeeded' as const, message: '已移入回收站' },
      { assetId: id(2), state: 'unconfirmed' as const, message: '素材仍被共享项目使用' },
      { assetId: id(3), state: 'succeeded' as const, message: '已移入回收站' },
    ] })) }
    const ui = harness(() => AssetTray(props)); click(ui.render(), '全选本页'); click(ui.render(), '删除'); await settle()
    const tree = ui.render(); expect(textOf(tree)).toContain('已选 1 项'); expect(textOf(tree)).toContain('2 项成功'); expect(textOf(tree)).toContain('1 项未确认'); expect(textOf(tree)).toContain('素材仍被共享项目使用')
    click(tree, '撤销'); await settle(); expect(onRestore).toHaveBeenCalledExactlyOnceWith([id(1), id(3)]); ui.close()
  })
  it('starts a recycle operation once and disables the selection and download actions while pending', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    let resolve!: () => void
    const props = { ...trayProps(), onDelete: vi.fn(() => new Promise<void>((done) => { resolve = done })) }, ui = harness(() => AssetTray(props))
    click(ui.render(), '全选本页'); const remove = button(ui.render(), '删除'); (remove.props.onClick as () => void)(); (remove.props.onClick as () => void)()
    expect(props.onDelete).toHaveBeenCalledTimes(1)
    const pending = ui.render(); expect(button(pending, '删除').props.disabled).toBe(true); expect(button(pending, '打包下载').props.disabled).toBe(true)
    expect(button(pending, '回收站').props.disabled).toBe(true)
    resolve(); await settle(); ui.close()
  })
  it('suppresses old recycle results after scope changes even when returning to the original scope', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    let resolve!: () => void
    const props = { ...trayProps(), onDelete: vi.fn(() => new Promise<void>((done) => { resolve = done })) }, ui = harness(() => AssetTray(props))
    click(ui.render(), '全选本页'); click(ui.render(), '删除')
    props.batchScope = 'owner-b:project-b'; ui.render(); props.batchScope = 'owner-a:project-a'; ui.render()
    resolve(); await settle(); expect(textOf(ui.render())).not.toContain('已移入回收站 3 项'); expect(textOf(ui.render())).toContain('已选 0 项'); ui.close()
  })
  it('keeps failed restore items selected after confirmed successful items leave the recycle page', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    const props = { ...trayProps(), onRestore: vi.fn(async () => ({ action: 'restore' as const, outcomes: [
      { assetId: id(1), state: 'succeeded' as const, message: '已恢复' }, { assetId: id(2), state: 'unconfirmed' as const, message: '恢复结果需核对' }, { assetId: id(3), state: 'succeeded' as const, message: '已恢复' },
    ] })) }
    props.query.view = 'trash'; props.page.items = props.page.items.map((item) => ({ ...item, deletedAt: 'now' }))
    const ui = harness(() => AssetTray(props)); click(ui.render(), '全选本页'); click(ui.render(), '恢复'); await settle()
    props.page = { ...props.page, items: [props.page.items[1]], total: 1 }
    const tree = ui.render(); expect(textOf(tree)).toContain('已选 1 项'); expect(textOf(tree)).toContain('2 项成功'); expect(textOf(tree)).toContain('恢复结果需核对'); ui.close()
  })
  it('resaves all thirteen existing tags including a forty-character tag through the actual canvas editor', async () => {
    const tags = ['长'.repeat(40), ...Array.from({ length: 12 }, (_, index) => `标签${index}`)]
    const props = { ...trayProps(), onUpdateMetadata: vi.fn(async () => {}) }; props.page.items[0].tags = tags
    const ui = harness(() => AssetTray(props)); check(ui.render(), '选择素材：素材1'); click(ui.render(), '编辑素材标签：素材1')
    const tree = ui.render(), field = elements(tree, 'input').find((item) => item.props.value === tags.join(', '))!
    expect(field).toBeDefined(); expect(field.props.maxLength).toBe(1000)
    const form = elements(tree, 'form').find((item) => item.props['aria-label'] === '编辑素材标签')!
    ;(form.props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() }); await settle()
    expect(props.onUpdateMetadata).toHaveBeenCalledExactlyOnceWith(id(1), { tags }); expect(textOf(ui.render())).not.toContain('最多 12 个'); ui.close()
  })
  it('offers the real global-library rename limit without implying a canvas-only label', () => {
    const props = { ...trayProps(), onRename: vi.fn() }, ui = harness(() => AssetTray(props))
    check(ui.render(), '选择素材：素材1'); click(ui.render(), '重命名素材：素材1')
    const tree = ui.render(), form = elements(tree, 'form').find((item) => item.props['aria-label'] === '重命名素材')!
    expect(elements(form, 'input')[0].props.maxLength).toBe(160)
    expect(textOf(form)).toContain('更新素材库中的显示名称，不会修改原文件名。'); expect(textOf(form)).not.toContain('只修改画布'); ui.close()
  })
  it('clears selections between all and uncategorized and does not revive late batch feedback after category ABA', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    let resolve!: () => void
    const props = { ...trayProps(), onDelete: vi.fn(() => new Promise<void>((done) => { resolve = done })) }, ui = harness(() => AssetTray(props))
    click(ui.render(), '全选本页'); props.query.categoryId = null; expect(textOf(ui.render())).toContain('已选 0 项')
    click(ui.render(), '全选本页'); click(ui.render(), '删除'); props.query.categoryId = '11111111-1111-4111-8111-111111111111'; ui.render(); props.query.categoryId = null; ui.render()
    resolve(); await settle(); expect(textOf(ui.render())).not.toContain('已移入回收站 3 项'); expect(textOf(ui.render())).toContain('已选 0 项'); ui.close()
  })
  it('opens category movement in visible selection order and clears it only after a confirmed movement revision', () => {
    const props = { ...trayProps(), onDelete: vi.fn(async () => {}), onMoveCategory: vi.fn(), categorySelectionRevision: 0, categoryDirectory: { version: 1 as const, items: [], uncategorized: { active: 3, trash: 0 } } }, ui = harness(() => AssetTray(props))
    check(ui.render(), '选择素材：素材3'); check(ui.render(), '选择素材：素材1'); click(ui.render(), '移动分类')
    expect(props.onMoveCategory).toHaveBeenCalledExactlyOnceWith([id(1), id(3)]); expect(textOf(ui.render())).toContain('已选 2 项')
    props.categorySelectionRevision++; expect(textOf(ui.render())).toContain('已选 0 项'); ui.close()
  })
  it('adds touch-selected items once in display order without using single-asset actions', async () => {
    const props = trayProps(), ui = harness(() => AssetTray(props))
    check(ui.render(), '选择素材：素材3'); check(ui.render(), '选择素材：素材1')
    let tree = ui.render(); click(tree, '加入画布'); (button(tree, '加入画布').props.onClick as () => void)()
    expect(props.onAddMany).toHaveBeenCalledExactlyOnceWith([id(1), id(3)]); expect(props.onAdd).not.toHaveBeenCalled()
    expect(button(ui.render(), '正在加入…').props.disabled).toBe(true)
    await settle(); tree = ui.render(); expect(textOf(tree)).toContain('已将 2 项素材加入画布，可一次撤销'); ui.close()
  })
  it('encodes selected drag identities without a misleading single-item fallback and leaves unselected drag single', () => {
    const props = trayProps(), ui = harness(() => AssetTray(props))
    check(ui.render(), '选择素材：素材3'); check(ui.render(), '选择素材：素材1')
    const tiles = elements(ui.render(), 'article'), selected = drag(tiles[2]), unselected = drag(tiles[1])
    expect(selected.setData).toHaveBeenCalledExactlyOnceWith(assetBatchDragMime, JSON.stringify([id(1), id(3)]))
    expect(unselected.setData).toHaveBeenCalledWith(assetBatchDragMime, JSON.stringify([id(2)]))
    expect(unselected.setData).toHaveBeenCalledWith('application/x-xingmang-asset-id', id(2))
    expect(props.onAddMany).not.toHaveBeenCalled(); ui.close()
  })
  it('shows unavailable selected rows and refuses both actions and drag instead of skipping them', () => {
    const props = trayProps(); props.page.items[1].deletedAt = '2026-10-15'
    const ui = harness(() => AssetTray(props)); click(ui.render(), '全选本页')
    const tree = ui.render(); expect(textOf(tree)).toContain('素材2：素材在回收站中，请先恢复')
    expect(button(tree, '加入画布').props.disabled).toBe(true); expect(button(tree, '打包下载').props.disabled).toBe(true)
    expect(drag(elements(tree, 'article')[0]).preventDefault).toHaveBeenCalled(); expect(props.onAddMany).not.toHaveBeenCalled(); ui.close()
  })
  it('clears scope and query selections, suppresses late feedback, and never restores a previous scope selection', async () => {
    let fail: (cause: Error) => void = () => {}; const props = trayProps(); props.onDownloadMany = vi.fn(() => new Promise<void>((_, reject) => { fail = reject }))
    const ui = harness(() => AssetTray(props)); click(ui.render(), '全选本页'); click(ui.render(), '打包下载')
    props.batchScope = 'owner-b:project-b'; let tree = ui.render(); expect(textOf(tree)).toContain('已选 0 项')
    fail(new Error('旧账号下载失败')); await settle(); expect(textOf(ui.render())).not.toContain('旧账号下载失败')
    props.batchScope = 'owner-a:project-a'; expect(textOf(ui.render())).toContain('已选 0 项')
    click(ui.render(), '全选本页'); props.query = { ...props.query, search: '新筛选' }; tree = ui.render(); expect(textOf(tree)).toContain('已选 0 项'); ui.close()
  })
  it('keeps a download-only viewer from adding or dragging while preserving the export controls', () => {
    const props = trayProps(); props.onAddMany = undefined
    const ui = harness(() => AssetTray(props)), tree = ui.render()
    expect(textOf(tree)).toContain('当前仅可打包下载'); expect(textOf(tree)).not.toContain('可整体拖入画布')
    expect(elements(tree, 'article').every((entry) => entry.props.draggable === false)).toBe(true)
    expect(button(tree, '添加资产到画布：素材1').props.disabled).toBe(true)
    expect(drag(elements(tree, 'article')[0]).preventDefault).toHaveBeenCalled()
    click(tree, '全选本页'); expect(button(ui.render(), '打包下载').props.disabled).toBe(false); ui.close()
  })
  it('does not claim every file downloaded after a cancelled or partially successful host dialog resolves', async () => {
    const props = trayProps(), ui = harness(() => AssetTray(props)); click(ui.render(), '全选本页'); click(ui.render(), '打包下载'); await settle()
    expect(textOf(ui.render())).toContain('下载准备已结束，请查看打包结果'); expect(textOf(ui.render())).not.toContain('已完成 3 项'); ui.close()
  })
})

describe('actual run candidate batch interactions', () => {
  it('selects each local asset once in node order, excludes missing files, and never adopts a candidate', async () => {
    const props = runProps(), ui = harness(() => RunInspector(props)); let tree = ui.render()
    expect(elements(tree, 'input').filter((entry) => entry.props.type === 'checkbox')).toHaveLength(4)
    expect(textOf(tree)).toContain('1 项未保存或不可用')
    click(tree, '全选可用素材'); tree = ui.render(); expect(textOf(tree)).toContain('已选 3 / 3 项')
    click(tree, '加入画布'); expect(props.onAddMany).toHaveBeenCalledExactlyOnceWith([id(3), id(1), id(2)])
    expect(props.onUseCandidate).not.toHaveBeenCalled(); await settle(); ui.close()
  })
  it('drags a selected historical set without adopting or rerunning any source node', () => {
    const props = runProps(), ui = harness(() => RunInspector(props)); click(ui.render(), '全选可用素材')
    const event = drag(elements(ui.render(), 'article')[1]); expect(event.setData).toHaveBeenCalledExactlyOnceWith(assetBatchDragMime, JSON.stringify([id(3), id(1), id(2)]))
    expect(props.onUseCandidate).not.toHaveBeenCalled(); expect(props.onAddMany).not.toHaveBeenCalled(); ui.close()
  })
  it('keeps download-only historical material selectable without advertising a canvas drop', () => {
    const props = runProps(); props.onAddMany = undefined
    const ui = harness(() => RunInspector(props)), tree = ui.render()
    expect(textOf(tree)).toContain('当前仅可打包下载'); expect(textOf(tree)).not.toContain('可整体拖入画布')
    expect(elements(tree, 'article').every((entry) => entry.props.draggable === false)).toBe(true)
    expect(drag(elements(tree, 'article')[0]).preventDefault).toHaveBeenCalled()
    click(tree, '全选可用素材'); expect(button(ui.render(), '打包下载').props.disabled).toBe(false); ui.close()
  })
  it('clears on run change and withholds late errors from an earlier run', async () => {
    let fail: (cause: Error) => void = () => {}; const props = runProps(); props.onAddMany = vi.fn(() => new Promise<void>((_, reject) => { fail = reject }))
    const ui = harness(() => RunInspector(props)); click(ui.render(), '全选可用素材'); click(ui.render(), '加入画布')
    props.records = [record('run-b')]; props.selectedRunId = 'run-b'; expect(textOf(ui.render())).toContain('已选 0 / 3 项')
    fail(new Error('旧运行已撤权')); await settle(); expect(textOf(ui.render())).not.toContain('旧运行已撤权')
    props.records = [record()]; props.selectedRunId = 'run-a'; expect(textOf(ui.render())).toContain('已选 0 / 3 项'); ui.close()
  })
  it('supports select all and Escape without leaking keys to the canvas, while ignoring IME confirmation', () => {
    vi.stubGlobal('HTMLElement', class {})
    const props = runProps(), ui = harness(() => RunInspector(props))
    function key(key: string, composing = false) { const element = elements(ui.render(), 'div').find((entry) => entry.props.className === 'run-inspector-scroll')!; const event = { key, metaKey: key === 'a', ctrlKey: false, nativeEvent: { isComposing: composing }, target: {}, preventDefault: vi.fn(), stopPropagation: vi.fn() }; (element.props.onKeyDown as (value: unknown) => void)(event); return event }
    const composing = key('a', true); expect(composing.preventDefault).not.toHaveBeenCalled(); expect(textOf(ui.render())).toContain('已选 0 / 3 项')
    expect(key('a').stopPropagation).toHaveBeenCalled(); expect(textOf(ui.render())).toContain('已选 3 / 3 项')
    expect(key('Escape').stopPropagation).toHaveBeenCalled(); expect(textOf(ui.render())).toContain('已选 0 / 3 项'); ui.close()
  })
})

function managementReceipt(ids: readonly string[], action: 'favorite' | 'unfavorite' = 'favorite'): AssetMutationResult {
  return { version: 1, action, operationId: '11111111-1111-4111-8111-111111111111', requestDigest: 'a'.repeat(64), createdAt: '2026-10-18T00:00:00.000Z', outcomes: ids.map((assetId) => ({ assetId, displayName: '素材', state: assetId === id(2) ? 'rejected' : 'succeeded', changed: assetId !== id(2), undoable: assetId !== id(2), message: assetId === id(2) ? '原操作拒绝此项' : '已收藏' })) }
}

describe('actual recoverable asset tray management', () => {
  it('sends the visible ordered selection once for favorite and keeps only rejected items', async () => {
    const props = { ...trayProps(), recoverableMutations: true, onFavoriteMany: vi.fn(async (ids: readonly string[], favorite: boolean) => managementReceipt(ids, favorite ? 'favorite' : 'unfavorite')), onDelete: vi.fn(async () => {}) }
    const ui = harness(() => AssetTray(props)); check(ui.render(), '选择素材：素材3'); check(ui.render(), '选择素材：素材2'); check(ui.render(), '选择素材：素材1')
    click(ui.render(), '收藏所选'); await settle()
    expect(props.onFavoriteMany).toHaveBeenCalledExactlyOnceWith([id(1), id(2), id(3)], true)
    expect(textOf(ui.render())).toContain('已选 1 项'); expect(textOf(ui.render())).toContain('原操作拒绝此项')
    click(ui.render(), '取消收藏所选'); await settle(); expect(props.onFavoriteMany).toHaveBeenLastCalledWith([id(2)], false); ui.close()
  })
  it('rejects duplicate selected writes and locks single favorite while the exact batch waits', async () => {
    let finish!: (result: AssetMutationResult) => void
    const props = { ...trayProps(), recoverableMutations: true, onUpdateMetadata: vi.fn(async () => {}), onFavoriteMany: vi.fn(() => new Promise<AssetMutationResult>((resolve) => { finish = resolve })) }
    const ui = harness(() => AssetTray(props)); click(ui.render(), '全选本页')
    const handler = button(ui.render(), '收藏所选').props.onClick as () => void; handler(); handler()
    expect(props.onFavoriteMany).toHaveBeenCalledOnce(); expect(button(ui.render(), '收藏：素材1').props.disabled).toBe(true)
    finish(managementReceipt([id(1), id(2), id(3)])); await settle(); ui.close()
  })
  it('leaves undo to the conditional original-operation panel for recoverable deletion', async () => {
    const props = { ...trayProps(), recoverableMutations: true, onRestore: vi.fn(async () => {}), onDelete: vi.fn(async () => ({ action: 'delete' as const, outcomes: [{ assetId: id(1), state: 'succeeded' as const, message: '已移入回收站' }] })) }
    const ui = harness(() => AssetTray(props)); check(ui.render(), '选择素材：素材1'); click(ui.render(), '删除'); await settle()
    expect(elements(ui.render(), 'button').some((item) => textOf(item.props.children) === '撤销')).toBe(false); expect(props.onRestore).not.toHaveBeenCalled(); ui.close()
  })
  it('refuses a legacy void as a recoverable receipt and retains the selected items', async () => {
    const props = { ...trayProps(), recoverableMutations: true, onDelete: vi.fn(async () => {}) }, ui = harness(() => AssetTray(props))
    click(ui.render(), '全选本页'); click(ui.render(), '删除'); await settle()
    expect(textOf(ui.render())).toContain('回执'); expect(textOf(ui.render())).toContain('已选 3 项'); ui.close()
  })
  it('blocks management under pending recovery while keeping local creation available', () => {
    const props = { ...trayProps(), mutationWritesBlocked: true, recoverableMutations: true, onUpdateMetadata: vi.fn(async () => {}), onDelete: vi.fn(async () => {}), onFavoriteMany: vi.fn(async (ids: readonly string[]) => managementReceipt(ids)) }, ui = harness(() => AssetTray(props))
    click(ui.render(), '全选本页')
    expect(button(ui.render(), '收藏所选').props.disabled).toBe(true); expect(button(ui.render(), '删除').props.disabled).toBe(true); expect(button(ui.render(), '收藏：素材1').props.disabled).toBe(true)
    expect(button(ui.render(), '加入画布').props.disabled).not.toBe(true); expect(props.onUpdateMetadata).not.toHaveBeenCalled(); ui.close()
  })
})

describe('actual asset metadata recovery scope guards', () => {
  it('does not submit a saved rename handler after scope ABA or a new recovery write block', async () => {
    for (const change of ['scope', 'blocked'] as const) {
      const props = { ...trayProps(), recoverableMutations: true, mutationWritesBlocked: false, onRename: vi.fn(async () => {}) }, ui = harness(() => AssetTray(props))
      check(ui.render(), '选择素材：素材1'); click(ui.render(), '重命名素材：素材1')
      const form = elements(ui.render(), 'form').find((item) => item.props['aria-label'] === '重命名素材')!, submit = form.props.onSubmit as (event: unknown) => void
      if (change === 'scope') { props.batchScope = 'owner-b:project-b'; ui.render(); props.batchScope = 'owner-a:project-a'; ui.render() } else { props.mutationWritesBlocked = true; ui.render() }
      submit({ preventDefault: vi.fn() }); await settle(); expect(props.onRename).not.toHaveBeenCalled(); ui.close()
    }
  })
  it('keeps the newly opened editor when an earlier rename completes after scope ABA', async () => {
    let finish!: () => void
    const props = { ...trayProps(), onRename: vi.fn(() => new Promise<void>((resolve) => { finish = resolve })) }, ui = harness(() => AssetTray(props))
    check(ui.render(), '选择素材：素材1'); click(ui.render(), '重命名素材：素材1')
    const form = elements(ui.render(), 'form').find((item) => item.props['aria-label'] === '重命名素材')!; (form.props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() })
    expect(props.onRename).toHaveBeenCalledOnce()
    props.batchScope = 'owner-b:project-b'; ui.render(); props.batchScope = 'owner-a:project-a'; ui.render()
    check(ui.render(), '选择素材：素材3'); click(ui.render(), '重命名素材：素材3'); finish(); await settle()
    const current = elements(ui.render(), 'form').find((item) => item.props['aria-label'] === '重命名素材')!
    expect(current).toBeDefined(); expect(elements(current, 'input')[0].props.value).toBe('素材3'); ui.close()
  })
})

describe('captured asset management entry callbacks', () => {
  it('refuses batch single and recycle entries before writing after scope ABA or unmount', async () => {
    for (const kind of ['batch', 'single', 'delete'] as const) for (const change of ['scope', 'unmount'] as const) {
      const props = { ...trayProps(), recoverableMutations: true, onUpdateMetadata: vi.fn(async () => {}), onDelete: vi.fn(async () => {}), onFavoriteMany: vi.fn(async (ids: readonly string[]) => managementReceipt(ids)) }, ui = harness(() => AssetTray(props))
      click(ui.render(), '全选本页')
      const handler = button(ui.render(), kind === 'batch' ? '收藏所选' : kind === 'single' ? '收藏：素材1' : '删除').props.onClick as () => void
      if (change === 'scope') { props.batchScope = 'owner-b:project-b'; ui.render(); props.batchScope = 'owner-a:project-a'; ui.render() } else ui.close()
      handler(); await settle()
      expect(props.onFavoriteMany).not.toHaveBeenCalled(); expect(props.onUpdateMetadata).not.toHaveBeenCalled(); expect(props.onDelete).not.toHaveBeenCalled(); if (change === 'scope') ui.close()
    }
  })
  it('refuses a former editor submit even when a new editor has matching current generation', async () => {
    for (const kind of ['rename', 'tags'] as const) {
      const props = { ...trayProps(), onRename: vi.fn(async () => {}), onUpdateMetadata: vi.fn(async () => {}) }, ui = harness(() => AssetTray(props))
      check(ui.render(), '选择素材：素材1'); click(ui.render(), kind === 'rename' ? '重命名素材：素材1' : '编辑素材标签：素材1')
      const label = kind === 'rename' ? '重命名素材' : '编辑素材标签'
      const stale = elements(ui.render(), 'form').find((item) => item.props['aria-label'] === label)!.props.onSubmit as (event: unknown) => void
      props.batchScope = 'owner-b:project-b'; ui.render(); props.batchScope = 'owner-a:project-a'; ui.render()
      check(ui.render(), '选择素材：素材3'); click(ui.render(), kind === 'rename' ? '重命名素材：素材3' : '编辑素材标签：素材3')
      stale({ preventDefault: vi.fn() }); await settle()
      expect(props.onRename).not.toHaveBeenCalled(); expect(props.onUpdateMetadata).not.toHaveBeenCalled(); ui.close()
    }
  })
})
