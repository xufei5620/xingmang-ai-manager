import { describe, expect, it, vi } from 'vitest'
import { runProjectRenameTransaction } from './project-rename-transaction'

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done }); return { promise, resolve } }

describe('project header rename transaction', () => {
  it('waits for pending saves, captures latest edits, then saves before sending the new name', async () => {
    const pending = deferred(), saved = deferred()
    let content = 'before'
    const events: string[] = []
    const action = runProjectRenameTransaction({ pendingSaves: pending.promise, current: () => true,
      capture: () => { events.push('capture'); return content },
      save: async (snapshot) => { events.push(`save:${snapshot}`); await saved.promise },
      rename: async () => { events.push('rename'); return { version: 9, name: 'new' } },
      confirm: (receipt, snapshot) => { events.push(`confirm:${receipt.version}:${snapshot}`) },
    })
    content = 'latest'; expect(events).toEqual([])
    pending.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(events).toEqual(['capture', 'save:latest'])
    saved.resolve(); await action
    expect(events).toEqual(['capture', 'save:latest', 'rename', 'confirm:9:latest'])
  })
  it('does not mutate a new project after switching while saves are pending', async () => {
    const pending = deferred(), rename = vi.fn(), confirm = vi.fn()
    let active = true
    const action = runProjectRenameTransaction({ pendingSaves: pending.promise, current: () => active, capture: () => 'data', save: async () => {}, rename, confirm })
    active = false; pending.resolve()
    await expect(action).rejects.toThrow('已切换')
    expect(rename).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled()
  })
  it('does not rename after a failed content save', async () => {
    const rename = vi.fn()
    await expect(runProjectRenameTransaction({ pendingSaves: Promise.resolve(), current: () => true, capture: () => 'data', save: async () => { throw new Error('保存冲突') }, rename, confirm: vi.fn() })).rejects.toThrow('保存冲突')
    expect(rename).not.toHaveBeenCalled()
  })
  it('checks scope again after content save and ignores late rename receipts after unmount', async () => {
    const rename = vi.fn(), confirm = vi.fn(); let current = true
    await expect(runProjectRenameTransaction({ pendingSaves: Promise.resolve(), current: () => current, capture: () => 'data', save: async () => { current = false }, rename, confirm })).rejects.toThrow('已切换')
    expect(rename).not.toHaveBeenCalled()
    current = true
    await expect(runProjectRenameTransaction({ pendingSaves: Promise.resolve(), current: () => current, capture: () => 'data', save: async () => {}, rename: async () => { current = false; return 'receipt' }, confirm })).rejects.toThrow('请求已提交')
    expect(confirm).not.toHaveBeenCalled()
  })
  it('keeps the old title when a rename response is unknown instead of confirming optimistically', async () => {
    const confirm = vi.fn()
    await expect(runProjectRenameTransaction({ pendingSaves: Promise.resolve(), current: () => true, capture: () => 'data', save: async () => {}, rename: async () => { throw new Error('结果未确认') }, confirm })).rejects.toThrow('结果未确认')
    expect(confirm).not.toHaveBeenCalled()
  })
})
