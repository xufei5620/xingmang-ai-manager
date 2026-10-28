import { describe, expect, it, vi } from 'vitest'
import { createPromptCatalog } from './prompt-catalog'
import type { CanvasPromptPreset } from './prompt-preset-contract'

function preset(name = 'Product'): CanvasPromptPreset { return { id: '11111111-1111-4111-8111-111111111111', name, prompt: 'Original content', tags: [], provenance: 'user-created', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z' } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }

describe('workspace prompt catalog', () => {
  it('shares one pending read and reuses the current snapshot between nodes', async () => {
    const pending = deferred<unknown>()
    const read = vi.fn(() => pending.promise)
    const catalog = createPromptCatalog(read, () => 100)
    catalog.activate()
    const first = catalog.load()
    expect(catalog.load()).toBe(first)
    await Promise.resolve()
    expect(read).toHaveBeenCalledOnce()
    pending.resolve([preset()]); await first
    await catalog.load()
    expect(read).toHaveBeenCalledOnce()
    expect(catalog.snapshot()).toMatchObject({ loaded: true, loading: false, items: [preset()] })
  })

  it('does not let a slow initial list erase a confirmed create or edit', async () => {
    const older = deferred<unknown>()
    const newer = deferred<unknown>()
    const read = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const catalog = createPromptCatalog(read)
    catalog.activate()
    const first = catalog.load(); await Promise.resolve()
    catalog.upsert(preset('Edited')); await Promise.resolve()
    older.resolve([preset('Stale')]); await first
    expect(catalog.snapshot().items[0].name).toBe('Edited')
    newer.resolve([preset('Edited')]); await catalog.load()
    expect(catalog.snapshot().items[0].name).toBe('Edited')
  })

  it('does not resurrect a deleted prompt from an older response', async () => {
    const older = deferred<unknown>()
    const newer = deferred<unknown>()
    const read = vi.fn().mockResolvedValueOnce([preset()]).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const catalog = createPromptCatalog(read)
    catalog.activate(); await catalog.load()
    const pending = catalog.load(true); await Promise.resolve()
    catalog.remove(preset().id); await Promise.resolve()
    older.resolve([preset()]); await pending
    expect(catalog.snapshot().items).toEqual([])
    newer.resolve([]); await catalog.load()
    expect(catalog.snapshot().items).toEqual([])
  })

  it('clears account data immediately and ignores late reads and mutations', async () => {
    const pending = deferred<unknown>()
    const read = vi.fn().mockResolvedValueOnce([preset()]).mockReturnValueOnce(pending.promise)
    const catalog = createPromptCatalog(read)
    catalog.activate(); await catalog.load()
    const request = catalog.load(true); await Promise.resolve()
    catalog.clear()
    expect(catalog.snapshot()).toEqual({ items: [], loaded: false, loading: false, error: null })
    catalog.upsert(preset('Wrong owner')); pending.resolve([preset('Old owner')]); await request
    await catalog.load()
    expect(catalog.snapshot().items).toEqual([])
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('rejects a late response even after the next lifecycle activates', async () => {
    const old = deferred<unknown>()
    const read = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce([])
    const catalog = createPromptCatalog(read)
    catalog.activate(); const before = catalog.load(); await Promise.resolve()
    catalog.clear(); catalog.activate(); await catalog.load()
    old.resolve([preset()]); await before
    expect(catalog.snapshot().items).toEqual([])
  })

  it('rejects an old mutation receipt after clear and reactivation', async () => {
    const catalog = createPromptCatalog(async () => [])
    catalog.activate()
    const scope = catalog.scope()
    expect(catalog.current(scope)).toBe(true)
    catalog.clear(); catalog.activate()
    expect(catalog.active()).toBe(true)
    expect(catalog.current(scope)).toBe(false)
    expect(catalog.snapshot().items).toEqual([])
  })

  it('retains the confirmed directory on read failure and exposes retry state', async () => {
    const read = vi.fn().mockResolvedValueOnce([preset()]).mockRejectedValueOnce(new Error('Temporary failure')).mockResolvedValueOnce([])
    const catalog = createPromptCatalog(read)
    catalog.activate(); await catalog.load(); await catalog.load(true)
    expect(catalog.snapshot()).toMatchObject({ items: [preset()], error: 'Temporary failure', loading: false })
    await catalog.load(true)
    expect(catalog.snapshot()).toMatchObject({ items: [], error: null })
  })

  it('rejects malformed or duplicate entries rather than exposing unchecked rows', async () => {
    const catalog = createPromptCatalog(async () => [preset(), preset()])
    catalog.activate(); await catalog.load()
    expect(catalog.snapshot().items).toEqual([])
    expect(catalog.snapshot().error).toContain('重复编号')
  })

  it('applies an order receipt before any older list and discards it after account clearing', async () => {
    const original = { ...preset(), version: 1, sortOrder: 5 }
    const old = deferred<unknown>(), fresh = deferred<unknown>()
    const read = vi.fn().mockResolvedValueOnce([original]).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const catalog = createPromptCatalog(read)
    catalog.activate(); await catalog.load()
    const loading = catalog.load(true); await Promise.resolve()
    catalog.reordered([{ id: original.id, version: 2, sortOrder: 0 }])
    old.resolve([original]); await loading
    expect(catalog.snapshot().items[0]).toMatchObject({ version: 2, sortOrder: 0, prompt: original.prompt })
    catalog.clear()
    catalog.reordered([{ id: original.id, version: 2, sortOrder: 0 }])
    fresh.resolve([{ ...original, version: 2, sortOrder: 0 }]); await Promise.resolve()
    expect(catalog.snapshot().items).toEqual([])
  })
})
