import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssetCategoryDirectory, AssetCategoryInput, AssetCategoryOperationInspection, AssetCategoryResult } from '../lib/asset-category-contract'
import { AssetCategoryClientError } from '../lib/asset-category-client-error'
import { AssetCategoryRecoveryNotSubmittedError } from '../lib/asset-category-recovery'

const runtime = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as Array<() => void> }))
vi.mock('react', async () => ({
  ...await vi.importActual<object>('react'),
  useRef(value: unknown) { const index = runtime.cursor++; if (!(index in runtime.slots)) runtime.slots[index] = { current: value }; return runtime.slots[index] },
  useState(initial: unknown) { const index = runtime.cursor++; if (!(index in runtime.slots)) runtime.slots[index] = typeof initial === 'function' ? initial() : initial; return [runtime.slots[index], (value: unknown) => { runtime.slots[index] = typeof value === 'function' ? value(runtime.slots[index]) : value }] },
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) {
    const index = runtime.cursor++, previous = runtime.slots[index] as { dependencies: readonly unknown[]; cleanup?: () => void } | undefined
    if (previous && dependencies.length === previous.dependencies.length && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return
    runtime.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); runtime.slots[index] = { dependencies, ...(typeof cleanup === 'function' ? { cleanup } : {}) } })
  },
}))
import { AssetCategoryManagerDialog, type AssetCategoryManagerDialogProps } from './AssetCategoryManagerDialog'
import { AssetCategoryMoveDialog, type AssetCategoryMoveDialogProps } from './AssetCategoryMoveDialog'
import { AssetCategorySelect } from './AssetCategorySelect'
import { AssetCategoryRecoveryNotice } from './AssetCategoryRecoveryNotice'

interface ElementShape { type: unknown; props: Record<string, unknown> }
function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand)
  if (!value || typeof value !== 'object' || !('props' in value) || !('type' in value)) return value
  const element = value as ElementShape
  if (typeof element.type === 'function') return expand(element.type(element.props))
  return { ...element, props: { ...element.props, children: expand(element.props.children) } }
}
function elements(value: unknown, type: unknown): ElementShape[] {
  if (Array.isArray(value)) return value.flatMap((item) => elements(item, type))
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  const element = value as ElementShape
  return [...(element.type === type ? [element] : []), ...elements(element.props.children, type)]
}
function textOf(value: unknown): string { if (typeof value === 'string' || typeof value === 'number') return String(value); if (Array.isArray(value)) return value.map(textOf).join(''); return value && typeof value === 'object' && 'props' in value ? textOf((value as ElementShape).props.children) : '' }
function button(tree: unknown, label: string) { const value = elements(tree, 'button').find((item) => item.props['aria-label'] === label || textOf(item.props.children) === label); expect(value, label).toBeDefined(); return value! }
function click(tree: unknown, label: string) { const value = button(tree, label); expect(value.props.disabled, label).not.toBe(true); (value.props.onClick as () => void)() }
function change(tree: unknown, type: 'input' | 'select', value: string) { const field = elements(tree, type)[0]; expect(field).toBeDefined(); expect(field.props.disabled).not.toBe(true); (field.props.onChange as (event: unknown) => void)({ target: { value } }) }
function submit(tree: unknown) { const form = elements(tree, 'form')[0]; expect(form).toBeDefined(); (form.props.onSubmit as (event: unknown) => void)({ preventDefault: vi.fn() }) }
function harness(render: () => unknown) {
  runtime.cursor = 0; runtime.slots = []; runtime.effects = []
  return { render() { runtime.cursor = 0; expand(render()); runtime.effects.splice(0).forEach((effect) => effect()); runtime.cursor = 0; const value = expand(render()); runtime.effects.splice(0).forEach((effect) => effect()); return value }, close() { for (const slot of runtime.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as { cleanup(): void }).cleanup() } }
}
const categoryId = '11111111-1111-4111-8111-111111111111'
function directory(version = 1): AssetCategoryDirectory { return { version: 1, items: [{ id: categoryId, name: version === 1 ? '产品素材' : '服务器新名称', version, createdAt: '', updatedAt: '', counts: { active: 2, trash: 1 } }], uncategorized: { active: 1, trash: 0 } } }
function result(input: AssetCategoryInput): AssetCategoryResult {
  const common = { operationId: input.operationId, requestDigest: 'd'.repeat(64) }
  if (input.action === 'move') return { ...common, action: 'move', assignments: input.assets.map((asset) => ({ assetId: asset.assetId, categoryId: input.categoryId, organizationVersion: asset.expectedOrganizationVersion + 1 })) }
  if (input.action === 'delete-category') return { ...common, action: 'delete-category', categoryId: input.id, movedAssetCount: 3 }
  return { ...common, action: input.action, category: { ...directory().items[0], name: input.name, version: input.action === 'rename-category' ? input.expectedVersion + 1 : 1 } }
}
function props(): AssetCategoryManagerDialogProps {
  return { scopeKey: 'owner-a', directory: directory(), onSubmit: vi.fn(async (input) => result(input)), onInspect: vi.fn(async (input): Promise<AssetCategoryOperationInspection> => ({ status: 'applied', operationId: input.operationId, requestDigest: 'd'.repeat(64), result: result(input) })), onReadDirectory: vi.fn(async () => directory(2)), onChanged: vi.fn(), onClose: vi.fn(), onRecoveryChange: vi.fn() }
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve() }
afterEach(() => vi.unstubAllGlobals())

describe('actual private asset category controls', () => {
  it('keeps all, uncategorized and an owned category distinct and ignores forged choices', () => {
    const onChange = vi.fn(), ui = harness(() => createElement(AssetCategorySelect, { items: directory().items, value: undefined, onChange }))
    expect(elements(ui.render(), 'select')[0].props.value).toBe('all')
    change(ui.render(), 'select', 'uncategorized'); change(ui.render(), 'select', categoryId); change(ui.render(), 'select', 'all'); change(ui.render(), 'select', 'foreign')
    expect(onChange.mock.calls).toEqual([[null], [categoryId], [undefined]]); ui.close()
  })
  it('starts create once and reconciles an unknown response without submitting a new request', async () => {
    const p = props(), gate = deferred<AssetCategoryResult>(); p.onSubmit = vi.fn(() => gate.promise)
    const ui = harness(() => createElement(AssetCategoryManagerDialog, p))
    click(ui.render(), '新建素材分类'); change(ui.render(), 'input', '电商产品'); const tree = ui.render(); submit(tree); submit(tree)
    expect(p.onSubmit).toHaveBeenCalledTimes(1); gate.reject(new AssetCategoryClientError('连接中断')); await settle()
    expect(textOf(ui.render())).toContain('上次分类操作尚未确认'); expect(p.onRecoveryChange).toHaveBeenCalledWith(expect.objectContaining({ name: '电商产品' }))
    click(ui.render(), '核对原分类操作'); await settle(); expect(p.onSubmit).toHaveBeenCalledTimes(1); expect(p.onInspect).toHaveBeenCalledTimes(1); expect(p.onChanged).toHaveBeenCalledTimes(1); ui.close()
  })
  it('retries only the same operation after a missing inspection and keeps it across close', async () => {
    const p = props(); p.onSubmit = vi.fn(async (input) => { if (vi.mocked(p.onSubmit).mock.calls.length === 1) throw new AssetCategoryClientError('未确认'); return result(input) })
    p.onInspect = vi.fn(async (input): Promise<AssetCategoryOperationInspection> => ({ status: 'missing', operationId: input.operationId, requestDigest: 'd'.repeat(64) }))
    const ui = harness(() => createElement(AssetCategoryManagerDialog, p)); click(ui.render(), '新建素材分类'); change(ui.render(), 'input', '纹理'); submit(ui.render()); await settle()
    click(ui.render(), '关闭，保留待核对操作'); expect(p.onClose).toHaveBeenCalledOnce(); expect(p.onSubmit).toHaveBeenCalledTimes(1)
    click(ui.render(), '核对原分类操作'); await settle(); click(ui.render(), '沿用原操作重试'); await settle()
    const calls = vi.mocked(p.onSubmit).mock.calls; expect(calls).toHaveLength(2); expect(calls[1][0]).toBe(calls[0][0]); expect(p.onChanged).toHaveBeenCalledOnce(); ui.close()
  })
  it('retains rename draft after conflict and requires read and adoption before a fresh explicit save', async () => {
    const p = props(); p.onSubmit = vi.fn(async (input) => { if (vi.mocked(p.onSubmit).mock.calls.length === 1) throw new AssetCategoryClientError('分类版本已变化', 409, true); return result(input) })
    const ui = harness(() => createElement(AssetCategoryManagerDialog, p)); click(ui.render(), '重命名分类：产品素材'); change(ui.render(), 'input', '我的新名称'); submit(ui.render()); await settle()
    expect(elements(ui.render(), 'input')[0].props.value).toBe('我的新名称'); expect(button(ui.render(), '保存分类名称').props.disabled).toBe(true)
    click(ui.render(), '重新读取分类'); await settle(); expect(textOf(ui.render())).toContain('服务器新名称'); click(ui.render(), '采用最新版本，保留名称草稿')
    expect(p.onSubmit).toHaveBeenCalledTimes(1); submit(ui.render()); await settle()
    expect(vi.mocked(p.onSubmit).mock.calls[1][0]).toMatchObject({ action: 'rename-category', expectedVersion: 2, name: '我的新名称' }); ui.close()
  })
  it('cancels delete without a request and explicitly confirms keeping every active and trashed asset', async () => {
    const p = props(), ui = harness(() => createElement(AssetCategoryManagerDialog, p)); click(ui.render(), '删除分类：产品素材'); expect(textOf(ui.render())).toContain('3 份素材将回到“未分类”')
    click(ui.render(), '取消删除分类'); expect(p.onSubmit).not.toHaveBeenCalled(); click(ui.render(), '删除分类：产品素材'); click(ui.render(), '删除分类并保留素材'); await settle()
    expect(vi.mocked(p.onSubmit).mock.calls[0][0]).toMatchObject({ action: 'delete-category', id: categoryId, expectedVersion: 1 }); ui.close()
  })
  it('suppresses late submit results after permission is withdrawn', async () => {
    const p = props(), gate = deferred<AssetCategoryResult>(); p.onSubmit = vi.fn(() => gate.promise)
    const ui = harness(() => createElement(AssetCategoryManagerDialog, p)); click(ui.render(), '新建素材分类'); change(ui.render(), 'input', '未确认'); submit(ui.render())
    const input = vi.mocked(p.onSubmit).mock.calls[0][0]; p.disabled = true; ui.render(); gate.resolve(result(input)); await settle()
    expect(p.onChanged).not.toHaveBeenCalled(); expect(p.onRecoveryChange).not.toHaveBeenLastCalledWith(undefined); ui.close()
  })
  it('opens a move only from recovery and inspects its original ordered identities', async () => {
    const input: AssetCategoryInput = { action: 'move', operationId: '22222222-2222-4222-8222-222222222222', assets: [{ assetId: 'a'.repeat(43), expectedOrganizationVersion: 0 }], categoryId: null }
    const p: AssetCategoryMoveDialogProps = { ...props(), recovery: input }, ui = harness(() => createElement(AssetCategoryMoveDialog, p))
    expect(textOf(ui.render())).toContain('a'.repeat(43)); expect(button(ui.render(), '确认移动分类').props.disabled).toBe(true)
    click(ui.render(), '核对原分类操作'); await settle(); expect(p.onInspect).toHaveBeenCalledWith(input, expect.any(AbortSignal)); expect(p.onSubmit).not.toHaveBeenCalled(); expect(p.onChanged).toHaveBeenCalledOnce(); ui.close()
  })
  it('reviews new assignment versions after a move conflict without silently changing or resubmitting the selection', async () => {
    const p: AssetCategoryMoveDialogProps = { ...props(), assets: [{ assetId: 'a'.repeat(43), expectedOrganizationVersion: 0, displayName: '原图' }], onReadAssets: vi.fn(async () => [{ assetId: 'a'.repeat(43), expectedOrganizationVersion: 3, displayName: '服务器新名称', categoryId: null }]) }
    p.onSubmit = vi.fn(async (input) => { if (vi.mocked(p.onSubmit).mock.calls.length === 1) throw new AssetCategoryClientError('素材归属已变化', 409, true); return result(input) })
    const ui = harness(() => createElement(AssetCategoryMoveDialog, p)); change(ui.render(), 'select', categoryId); click(ui.render(), '确认移动分类'); await settle()
    click(ui.render(), '读取最新分类与素材资料'); await settle(); expect(textOf(ui.render())).toContain('服务器新名称：未分类'); expect(p.onSubmit).toHaveBeenCalledTimes(1)
    click(ui.render(), '采用最新资料，保留目标分类'); expect(p.onSubmit).toHaveBeenCalledTimes(1); click(ui.render(), '确认移动分类'); await settle()
    expect(vi.mocked(p.onSubmit).mock.calls[1][0]).toMatchObject({ action: 'move', assets: [{ expectedOrganizationVersion: 3 }], categoryId, expectedCategoryVersion: 2 }); ui.close()
  })

  it('uses the dedicated durable retry callback only after an explicit missing inspection', async () => {
    const original: AssetCategoryInput = { action: 'create-category', operationId: '22222222-2222-4222-8222-222222222222', name: '刷新原请求' }
    const p = { ...props(), recovery: original, durableRecoveryReady: true, onRetry: vi.fn(async (value: AssetCategoryInput) => result(value)) }
    p.onInspect = vi.fn(async (value): Promise<AssetCategoryOperationInspection> => ({ status: 'missing', operationId: value.operationId, requestDigest: 'd'.repeat(64) }))
    const ui = harness(() => createElement(AssetCategoryManagerDialog, p)); expect(textOf(ui.render())).not.toContain('沿用原操作重试')
    click(ui.render(), '核对原分类操作'); await settle(); click(ui.render(), '沿用原操作重试'); await settle()
    expect(p.onRetry).toHaveBeenCalledExactlyOnceWith(original, expect.any(AbortSignal)); expect(p.onSubmit).not.toHaveBeenCalled(); ui.close()
  })

  it('clears idle pending when another tab clears the authoritative loaded journal', async () => {
    const p = props(); p.recovery = { action: 'create-category', operationId: '22222222-2222-4222-8222-222222222222', name: '另一页面核对' }; p.durableRecoveryReady = true
    const ui = harness(() => createElement(AssetCategoryManagerDialog, p)); expect(textOf(ui.render())).toContain('上次分类操作尚未确认')
    p.recovery = undefined; expect(textOf(ui.render())).not.toContain('上次分类操作尚未确认')
    expect(p.onChanged).not.toHaveBeenCalled(); expect(p.onSubmit).not.toHaveBeenCalled(); expect(p.onInspect).not.toHaveBeenCalled(); ui.close()
  })

  it('does not retain another owner pending while the new owner journal is still loading', () => {
    const p = props(); p.recovery = { action: 'create-category', operationId: '22222222-2222-4222-8222-222222222222', name: '旧账号私有名称' }; p.durableRecoveryReady = true
    const ui = harness(() => createElement(AssetCategoryManagerDialog, p)); expect(textOf(ui.render())).toContain('旧账号私有名称')
    p.scopeKey = 'owner-b'; p.recovery = undefined; p.durableRecoveryReady = false
    expect(textOf(ui.render())).not.toContain('旧账号私有名称'); expect(p.onInspect).not.toHaveBeenCalled(); ui.close()
  })

  it('does not clear local pending before the durable submit has saved its journal', async () => {
    const p = props(), gate = deferred<AssetCategoryResult>(); p.durableRecoveryReady = true; p.onSubmit = vi.fn(() => gate.promise)
    const ui = harness(() => createElement(AssetCategoryManagerDialog, p)); click(ui.render(), '新建素材分类'); change(ui.render(), 'input', '写入前等待'); submit(ui.render())
    expect(textOf(ui.render())).toContain('上次分类操作尚未确认'); expect(button(ui.render(), '关闭，保留待核对操作').props.disabled).toBe(true)
    p.recovery = vi.mocked(p.onSubmit).mock.calls[0][0]; gate.reject(new AssetCategoryClientError('unknown')); await settle()
    expect(textOf(ui.render())).toContain('写入前等待'); expect(p.onChanged).not.toHaveBeenCalled(); ui.close()
  })

  it('keeps the original retry pending and demands another GET when its missing permission becomes stale', async () => {
    const original: AssetCategoryInput = { action: 'create-category', operationId: '22222222-2222-4222-8222-222222222222', name: '同一原请求' }
    const p = { ...props(), recovery: original, durableRecoveryReady: true, onRetry: vi.fn(async () => { throw new AssetCategoryRecoveryNotSubmittedError('另一页面已更新，请重新核对') }) }
    p.onInspect = vi.fn(async (value): Promise<AssetCategoryOperationInspection> => ({ status: 'missing', operationId: value.operationId, requestDigest: 'd'.repeat(64) }))
    const ui = harness(() => createElement(AssetCategoryManagerDialog, p)); click(ui.render(), '核对原分类操作'); await settle(); click(ui.render(), '沿用原操作重试'); await settle()
    expect(textOf(ui.render())).toContain('同一原请求'); expect(textOf(ui.render())).not.toContain('沿用原操作重试'); expect(p.onRecoveryChange).not.toHaveBeenLastCalledWith(undefined)
    expect(p.onSubmit).not.toHaveBeenCalled(); expect(p.onRetry).toHaveBeenCalledOnce(); ui.close()
  })

  it('allows editing again after a storage preflight refusal without inventing a pending server request', async () => {
    const p = props(); p.durableRecoveryReady = true; p.onSubmit = vi.fn(async () => { throw new AssetCategoryRecoveryNotSubmittedError('存储容量不足，本次尚未提交') })
    const ui = harness(() => createElement(AssetCategoryManagerDialog, p)); click(ui.render(), '新建素材分类'); change(ui.render(), 'input', '保留草稿'); submit(ui.render()); await settle()
    expect(textOf(ui.render())).not.toContain('上次分类操作尚未确认'); expect(textOf(ui.render())).toContain('存储容量不足'); expect(elements(ui.render(), 'input')[0].props.value).toBe('保留草稿')
    change(ui.render(), 'input', '修复后可提交'); expect(button(ui.render(), '保存分类名称').props.disabled).not.toBe(true); expect(p.onChanged).not.toHaveBeenCalled(); ui.close()
  })

  it.each(['manager', 'move'] as const)('keeps the recovery read error and reload action visible inside the disabled %s modal', async (kind) => {
    const onReload = vi.fn(async () => undefined), p = { ...props(), disabled: true, recoveryNotice: createElement(AssetCategoryRecoveryNotice, { state: { ready: false, loading: false, error: '本机恢复记录损坏，尚未提交', writeError: '' }, onReload }) }
    const ui = harness(() => kind === 'manager' ? createElement(AssetCategoryManagerDialog, p) : createElement(AssetCategoryMoveDialog, p))
    const tree = ui.render(); expect(textOf(tree)).toContain('本机恢复记录损坏，尚未提交')
    click(tree, '重读分类操作记录'); await settle()
    expect(onReload).toHaveBeenCalledOnce(); expect(p.onSubmit).not.toHaveBeenCalled(); expect(p.onInspect).not.toHaveBeenCalled(); ui.close()
  })
})
