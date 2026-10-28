import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createEmptyWorkflow, serializeWorkflow } from '../model'
import { BrowserDraftRecovery } from './BrowserDraftRecovery'
import { assertCanvasBrowserDraftStored, confirmRemoveCanvasBrowserDraft, createCanvasBrowserDraft, listCanvasBrowserDrafts, selectCanvasBrowserDraft, writeCanvasBrowserDraft, type CanvasBrowserDraft, type CanvasDraftStorage } from './browser-draft'
import { buildCanvasDraftConfirmation, canvasDraftConfirmationCurrent, confirmCanvasDraftActionRemoval, createCanvasDraftActionGuard, focusCanvasDraftReturnControl, reserveCanvasDraftRevision, resolveCanvasDraftProtectionAfterWriteFailure, type CanvasDraftActionScope } from './browser-draft-actions'

function storage(): CanvasDraftStorage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    key(index) { return [...values.keys()][index] ?? null },
    getItem(key) { return values.get(key) ?? null },
    setItem(key, value) { values.set(key, value) },
    removeItem(key) { values.delete(key) },
  }
}

function draft(overrides: Partial<CanvasBrowserDraft> = {}): CanvasBrowserDraft {
  return createCanvasBrowserDraft({ ownerId: 1, projectId: 'project-a', writerId: 'writer-a', revision: 'revision-1', cloudVersion: 4,
    updatedAt: '2026-10-10T12:00:00.000Z', content: serializeWorkflow(createEmptyWorkflow('原始本地编辑')), ...overrides })
}

function scope(overrides: Partial<CanvasDraftActionScope> = {}): CanvasDraftActionScope {
  return { ownerId: 1, projectId: 'project-a', projectEpoch: 3, dialogEpoch: 2, ...overrides }
}

function markup(drafts: CanvasBrowserDraft[], options: Partial<Parameters<typeof BrowserDraftRecovery>[0]> = {}): string {
  return renderToStaticMarkup(createElement(BrowserDraftRecovery, {
    drafts, cloudVersion: 4, selected: drafts[0] ? { writerId: drafts[0].writerId, revision: drafts[0].revision } : null,
    onSelect: () => {}, onRestore: () => {}, onUseCloud: () => {}, onExport: () => {}, onRequestRemove: () => {}, onConfirmRemove: () => {}, onCancelRemove: () => {}, onClose: () => {}, onRefresh: () => {}, ...options,
  }))
}

describe('local draft management action boundaries', () => {
  it('uses a fresh revision after a new disk copy is retained but the old copy cleanup throws', () => {
    const target = storage()
    let sequence = 0
    const initialReservation = reserveCanvasDraftRevision('writer-a', sequence)
    sequence = initialReservation.revisionSequence
    const previous = writeCanvasBrowserDraft(target, draft({ revision: initialReservation.revision }))
    const nextReservation = reserveCanvasDraftRevision('writer-a', sequence)
    sequence = nextReservation.revisionSequence
    const partiallyHeld = draft({ revision: nextReservation.revision, content: serializeWorkflow(createEmptyWorkflow('已持有但尚未确认的新编辑')) })
    const originalRemove = target.removeItem
    target.removeItem = () => { throw new Error('SecurityError') }
    expect(() => writeCanvasBrowserDraft(target, partiallyHeld)).toThrow('新草稿已持有')
    const heldKey = `xingmang:canvas-draft:v1:1:project-a:writer-a:${partiallyHeld.revision}`
    const heldBytes = target.getItem(heldKey)
    expect(heldBytes).toBe(JSON.stringify(partiallyHeld))
    const protectedDraft = resolveCanvasDraftProtectionAfterWriteFailure(partiallyHeld, previous, (value) => assertCanvasBrowserDraftStored(target, value))
    expect(protectedDraft).toBe(partiallyHeld)
    const protectedHtml = markup(listCanvasBrowserDrafts(target, 1, 'project-a'), { mode: 'manage', selected: { writerId: partiallyHeld.writerId, revision: partiallyHeld.revision }, protectedSelection: protectedDraft })
    expect(protectedHtml).toContain('正在保护当前编辑')
    expect(protectedHtml).toMatch(/disabled="">删除选中的草稿<\/button>/)
    const writes = vi.fn(target.setItem)
    target.setItem = writes
    target.removeItem = originalRemove
    const retryReservation = reserveCanvasDraftRevision('writer-a', sequence)
    sequence = retryReservation.revisionSequence
    expect(retryReservation.revision).not.toBe(partiallyHeld.revision)
    const retried = draft({ revision: retryReservation.revision, updatedAt: '2026-10-10T12:00:01.000Z', content: partiallyHeld.content })
    expect(writeCanvasBrowserDraft(target, retried)).toEqual(retried)
    expect(writes.mock.calls.some(([key]) => key === heldKey)).toBe(false)
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toEqual([retried])
    expect(sequence).toBe(3)
  })

  it('does not replace the old protection with an unconfirmed or unreadable new copy', () => {
    const target = storage()
    const previous = writeCanvasBrowserDraft(target, draft())
    const next = draft({ revision: 'next-revision' })
    expect(resolveCanvasDraftProtectionAfterWriteFailure(next, previous, (value) => assertCanvasBrowserDraftStored(target, value))).toBe(previous)
    writeCanvasBrowserDraft(target, next)
    target.getItem = () => { throw new Error('SecurityError') }
    expect(resolveCanvasDraftProtectionAfterWriteFailure(next, previous, (value) => assertCanvasBrowserDraftStored(target, value))).toBe(previous)
    expect(resolveCanvasDraftProtectionAfterWriteFailure(next, null, (value) => assertCanvasBrowserDraftStored(target, value))).toBeNull()
  })

  it('rejects exhausted or invalid revision counters before reserving an unsafe immutable key', () => {
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER, Number.NaN]) expect(() => reserveCanvasDraftRevision('writer-a', value)).toThrow('修订标识')
    expect(() => reserveCanvasDraftRevision('invalid/writer', 0)).toThrow('修订标识')
  })

  it('restores focus to the delete action after cancelling or completing a confirmation, with safe fallbacks', () => {
    const remove = { isConnected: true, disabled: false, getClientRects: () => ({ length: 1 }), focus: vi.fn() }
    const selected = { isConnected: true, disabled: false, getClientRects: () => ({ length: 1 }), focus: vi.fn() }
    const dialog = { isConnected: true, getClientRects: () => ({ length: 1 }), focus: vi.fn() }
    focusCanvasDraftReturnControl([remove, selected, dialog])
    expect(remove.focus).toHaveBeenCalledOnce()
    expect(selected.focus).not.toHaveBeenCalled()
    remove.disabled = true
    focusCanvasDraftReturnControl([remove, selected, dialog])
    expect(selected.focus).toHaveBeenCalledOnce()
    selected.isConnected = false
    focusCanvasDraftReturnControl([remove, selected, dialog])
    expect(dialog.focus).toHaveBeenCalledOnce()
  })

  it('frees exactly one selected writer and allows the previously blocked editor to retain its latest graph', () => {
    const target = storage()
    const retained = Array.from({ length: 4 }, (_, index) => writeCanvasBrowserDraft(target, draft({ writerId: `writer-${index}`, content: serializeWorkflow(createEmptyWorkflow(`草稿${index}`)) })))
    const latest = draft({ writerId: 'new-editor', content: serializeWorkflow(createEmptyWorkflow('仍在编辑的最新画布')) })
    expect(() => writeCanvasBrowserDraft(target, latest)).toThrow('4')
    const selection = { writerId: retained[2].writerId, revision: retained[2].revision }
    const chosen = selectCanvasBrowserDraft(listCanvasBrowserDrafts(target, 1, 'project-a'), selection)
    expect(chosen).toEqual(retained[2])
    if (!chosen) throw new Error('Fixture selection failed')
    const confirmation = buildCanvasDraftConfirmation(scope(), chosen)
    expect(confirmCanvasDraftActionRemoval(confirmation, scope(), true, (value) => confirmRemoveCanvasBrowserDraft(target, value, true))).toBe('removed')
    expect(writeCanvasBrowserDraft(target, latest)).toEqual(latest)
    const remaining = listCanvasBrowserDrafts(target, 1, 'project-a')
    expect(remaining).toHaveLength(4)
    expect(remaining).toContainEqual(latest)
    for (const preserved of [retained[0], retained[1], retained[3]]) expect(remaining).toContainEqual(preserved)
    expect(remaining).not.toContainEqual(chosen)
  })

  it('keeps a writer update instead of silently removing a newer revision from a stale confirmation', () => {
    const target = storage()
    const original = writeCanvasBrowserDraft(target, draft())
    const confirmation = buildCanvasDraftConfirmation(scope(), original)
    const newer = writeCanvasBrowserDraft(target, draft({ revision: 'revision-2', content: serializeWorkflow(createEmptyWorkflow('确认期间的新编辑')) }))
    expect(confirmCanvasDraftActionRemoval(confirmation, scope(), true, (value) => confirmRemoveCanvasBrowserDraft(target, value, true))).toBe('unconfirmed')
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toEqual([newer])
  })

  it('captures the entire confirmed snapshot without trusting later changes to a displayed list object', () => {
    const original = draft()
    const context = scope()
    const confirmation = buildCanvasDraftConfirmation(context, original)
    original.content = 'changed after confirmation'
    original.revision = 'later-revision'
    context.projectEpoch += 1
    expect(confirmation.draft.content).toContain('原始本地编辑')
    expect(confirmation.draft.revision).toBe('revision-1')
    expect(confirmation.scope.projectEpoch).toBe(3)
    expect(Object.isFrozen(confirmation.draft)).toBe(true)
  })

  it.each([
    ['other owner', scope({ ownerId: 2 }), true],
    ['other project', scope({ projectId: 'project-b' }), true],
    ['same project reopened', scope({ projectEpoch: 4 }), true],
    ['manager reopened', scope({ dialogEpoch: 3 }), true],
    ['account locked', scope(), false],
  ])('does not access storage from an obsolete confirmation after %s', (_reason, current, enabled) => {
    const confirmation = buildCanvasDraftConfirmation(scope(), draft())
    const remove = vi.fn(() => true)
    expect(canvasDraftConfirmationCurrent(confirmation, current, enabled)).toBe(false)
    expect(confirmCanvasDraftActionRemoval(confirmation, current, enabled, remove)).toBe('inactive')
    expect(remove).not.toHaveBeenCalled()
  })

  it('rejects confirmation objects outside the currently opened owner and project', () => {
    expect(() => buildCanvasDraftConfirmation(scope(), draft({ ownerId: 2 }))).toThrow('归属')
    expect(() => buildCanvasDraftConfirmation(scope(), draft({ projectId: 'project-b' }))).toThrow('归属')
    expect(() => buildCanvasDraftConfirmation(scope({ ownerId: null }), draft())).toThrow('归属')
  })

  it('does not treat a retained legacy writer key as freed capacity or remove it after export', () => {
    const target = storage()
    const legacy = draft()
    const key = `xingmang:canvas-draft:v1:${legacy.ownerId}:${legacy.projectId}:${legacy.writerId}`
    target.setItem(key, JSON.stringify(legacy))
    const confirmation = buildCanvasDraftConfirmation(scope(), listCanvasBrowserDrafts(target, 1, 'project-a')[0])
    expect(confirmCanvasDraftActionRemoval(confirmation, scope(), true, (value) => confirmRemoveCanvasBrowserDraft(target, value, true))).toBe('unconfirmed')
    expect(target.getItem(key)).toBe(JSON.stringify(legacy))
    const html = markup([legacy], { mode: 'manage', notice: '草稿可能已更新，或来自旧版存储、仍可能被其他页面写入，暂不能安全清理。原草稿仍保留，可先导出并重新读取核对。' })
    expect(html).toContain('旧版存储')
    expect(html).toContain('仍可能被其他页面写入')
    expect(html).toContain('原草稿仍保留')
    expect(target.getItem(key)).toBe(JSON.stringify(legacy))
  })

  it('keeps both drafts when a user cancels instead of applying a confirmation', () => {
    const target = storage()
    const original = writeCanvasBrowserDraft(target, draft())
    const another = writeCanvasBrowserDraft(target, draft({ writerId: 'writer-b' }))
    expect(confirmRemoveCanvasBrowserDraft(target, original, false)).toBe(false)
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toEqual([original, another])
  })

  it('reports storage failure while retaining the original revision and all other writers', () => {
    const target = storage()
    const original = writeCanvasBrowserDraft(target, draft())
    const another = writeCanvasBrowserDraft(target, draft({ writerId: 'writer-b' }))
    const confirmation = buildCanvasDraftConfirmation(scope(), original)
    target.removeItem = () => { throw new Error('SecurityError') }
    expect(() => confirmCanvasDraftActionRemoval(confirmation, scope(), true, (value) => confirmRemoveCanvasBrowserDraft(target, value, true))).toThrow('草稿')
    expect(listCanvasBrowserDrafts(target, 1, 'project-a')).toEqual([original, another])
  })

  it('suppresses a delayed export outcome after a dialog closes without unlocking its replacement action', async () => {
    const guard = createCanvasDraftActionGuard()
    const original = guard.begin(scope())
    if (!original) throw new Error('Fixture action failed')
    expect(guard.begin(scope())).toBeNull()
    guard.invalidate()
    const nextScope = scope({ dialogEpoch: 3 })
    const next = guard.begin(nextScope)
    if (!next) throw new Error('Fixture replacement failed')
    const lateDownload = await Promise.resolve('download-requested')
    expect(lateDownload).toBe('download-requested')
    expect(guard.current(original, nextScope)).toBe(false)
    guard.finish(original)
    expect(guard.busy()).toBe(true)
    expect(guard.current(next, nextScope)).toBe(true)
    guard.finish(next)
    expect(guard.busy()).toBe(false)
  })

  it('reactivates after effect cleanup while old action tokens remain permanently invalid', () => {
    const guard = createCanvasDraftActionGuard()
    const old = guard.begin(scope())
    if (!old) throw new Error('Fixture action failed')
    guard.dispose()
    expect(guard.begin(scope())).toBeNull()
    guard.activate()
    const next = guard.begin(scope())
    if (!next) throw new Error('Fixture restarted action failed')
    expect(guard.current(old, scope())).toBe(false)
    expect(guard.current(next, scope(), false)).toBe(false)
    guard.finish(old)
    expect(guard.current(next, scope())).toBe(true)
  })
})

describe('draft recovery and management presentation', () => {
  it('selects only the chosen writer when two valid drafts share a revision', () => {
    const drafts = [draft(), draft({ writerId: 'writer-b' })]
    const html = markup(drafts, { selected: { writerId: 'writer-b', revision: 'revision-1' } })
    expect(html.match(/checked=""/g)).toHaveLength(1)
    expect(html).toMatch(/aria-label="选择本地草稿 2"[^>]*checked=""/)
    expect(markup(drafts, { selected: { writerId: 'missing-writer', revision: 'revision-1' } })).not.toContain('checked=""')
  })

  it('offers management without restore or cloud replacement controls', () => {
    const html = markup([draft()], { mode: 'manage' })
    expect(html).toContain('管理本地草稿')
    expect(html).toContain('删除选中的草稿')
    expect(html).toContain('刷新草稿列表')
    expect(html).toContain('关闭管理')
    expect(html).toContain('不会替换当前画布或更改云端工程')
    expect(html).not.toContain('>恢复本地草稿</button>')
    expect(html).not.toContain('>使用云端</button>')
    expect(markup([draft()])).toContain('>恢复本地草稿</button>')
  })

  it('requires an explicit destructive confirmation and states that export never discards a draft', () => {
    const html = markup([draft()], { mode: 'manage', confirmation: draft() })
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain('aria-describedby="canvas-draft-remove-description"')
    expect(html).toContain('确认删除这份草稿')
    expect(html).toContain('保留草稿')
    expect(html).toContain('无法撤销')
    expect(html).toContain('导出不会自动删除草稿')
    expect(html).not.toContain('>删除选中的草稿</button>')
  })

  it('protects the current unsaved snapshot and distinguishes unavailable storage from an actual empty list', () => {
    const selected = { writerId: 'writer-a', revision: 'revision-1' }
    const protectedHtml = markup([draft()], { mode: 'manage', protectedSelection: selected })
    expect(protectedHtml).toMatch(/disabled="">删除选中的草稿<\/button>/)
    expect(protectedHtml).toContain('正在保护当前编辑')
    expect(markup([], { mode: 'manage' })).toContain('本工程没有可读取的本地草稿')
    const failed = markup([], { mode: 'manage', listAvailable: false, storageError: '读取失败' })
    expect(failed).toContain('草稿列表尚未读取成功，请刷新核对')
    expect(failed).not.toContain('本工程没有可读取的本地草稿')
    expect(failed).toContain('role="alert"')
    expect(failed).toContain('>刷新草稿列表</button>')
  })

  it('keeps empty management separate from recovery and leaves no restore action enabled without an exact selection', () => {
    const html = markup([], { mode: 'manage' })
    expect(html).toContain('关闭管理')
    expect(html).not.toContain('恢复后自动保存会暂停')
    expect(html).toMatch(/disabled="">删除选中的草稿<\/button>/)
    expect(markup([draft()], { selected: null })).toMatch(/disabled="">恢复本地草稿<\/button>/)
  })
})
