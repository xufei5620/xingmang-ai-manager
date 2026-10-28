import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasGroupSummary, CanvasPreparedGroup } from '../host'

const hooks = vi.hoisted(() => ({ cursor: 0, slots: [] as unknown[], effects: [] as Array<() => void> }))
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(),
  useRef(initial: unknown) { const index = hooks.cursor++; if (!(index in hooks.slots)) hooks.slots[index] = { current: initial }; return hooks.slots[index] },
  useState(initial: unknown) { const index = hooks.cursor++; if (!(index in hooks.slots)) hooks.slots[index] = initial; return [hooks.slots[index], (value: unknown) => { hooks.slots[index] = typeof value === 'function' ? value(hooks.slots[index]) : value }] },
  useCallback(callback: unknown) { return callback },
  useEffect(effect: () => void | (() => void), dependencies: readonly unknown[]) {
    const index = hooks.cursor++, previous = hooks.slots[index] as { dependencies: readonly unknown[]; cleanup?: () => void } | undefined
    if (previous && dependencies.length === previous.dependencies.length && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return
    hooks.effects.push(() => { previous?.cleanup?.(); const cleanup = effect(); hooks.slots[index] = { dependencies, ...(typeof cleanup === 'function' ? { cleanup } : {}) } })
  },
}))
import { readAgentMediaCatalog, useCanvasAgentMediaCatalog } from './use-canvas-agent-media-catalog'

function source(name = 'source-a'): CanvasGroupSummary { return { name, description: `模型 ${name}`, ratio: '—', revision: 3, connectionStatus: 'ready', purposes: ['image', 'video'] } }
function prepared(group = 'source-a'): CanvasPreparedGroup { return { group, revision: 3, purposes: ['image', 'video'], models: ['custom-image-model', 'custom-video-model'], keyCreated: false } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((finish) => { resolve = finish }); return { promise, resolve } }
async function settle() { await new Promise<void>((resolve) => setImmediate(resolve)) }
function render(options: Parameters<typeof useCanvasAgentMediaCatalog>[0]) {
  hooks.cursor = 0
  const value = useCanvasAgentMediaCatalog(options)
  hooks.effects.splice(0).forEach((effect) => effect())
  return value
}
beforeEach(() => { hooks.cursor = 0; hooks.slots = []; hooks.effects = [] })
afterEach(() => {
  for (const slot of hooks.slots) if (slot && typeof slot === 'object' && 'cleanup' in slot) (slot as { cleanup(): void }).cleanup()
})

describe('owner-scoped Agent media catalog', () => {
  it('reads each source once and projects both declared purposes without changing defaults', async () => {
    const prepare = vi.fn(async (name: string) => prepared(name))
    const result = await readAgentMediaCatalog([source()], prepare, () => true)
    expect(prepare).toHaveBeenCalledExactlyOnceWith('source-a')
    expect(result?.items).toEqual(['image', 'video'].map((purpose) => ({ purpose, providerId: 'source-a', providerName: '模型 source-a', models: prepared().models })))
    expect(result?.error).toBe('')
  })
  it('reads text-only sources independently and does not prepare an untested source', async () => {
    const prepare = vi.fn(async (name: string) => prepared(name))
    const result = await readAgentMediaCatalog([{ ...source('text'), purposes: ['text'] }, { ...source('new'), connectionStatus: 'untested' }], prepare, () => true)
    expect(prepare).toHaveBeenCalledExactlyOnceWith('text')
    expect(result?.items).toHaveLength(3)
    expect(result?.items.every((item) => item.models.length === 0)).toBe(true)
    expect(result?.error).toContain('模型 new')
  })
  it.each(['group', 'revision'])('rejects an inconsistent %s while retaining other independently available sources', async (field) => {
    const prepare = vi.fn(async (name: string) => name === 'bad' ? { ...prepared(name), [field]: field === 'group' ? 'other-owner-source' : 4 } : prepared(name))
    const result = await readAgentMediaCatalog([source('bad'), source('good')], prepare, () => true)
    expect(result?.items.filter((item) => item.providerId === 'bad').every((item) => !item.models.length)).toBe(true)
    expect(result?.items.filter((item) => item.providerId === 'good').every((item) => item.models.length === 2)).toBe(true)
    expect(result?.error).toContain('模型 bad')
  })
  it('ignores all late replies after the account or project has changed', async () => {
    const response = deferred<CanvasPreparedGroup>(); let active = true
    const result = readAgentMediaCatalog([source()], () => response.promise, () => active)
    active = false; response.resolve(prepared())
    expect(await result).toBeNull()
  })
  it('filters known incompatible families from a mixed catalog while retaining custom aliases', async () => {
    const result = await readAgentMediaCatalog([source()], async () => ({ ...prepared(), models: ['gpt-4.1', 'gpt-image-1', 'custom-relay-model'] }), () => true)
    expect(result?.items.find((item) => item.purpose === 'image')?.models).toEqual(['gpt-image-1', 'custom-relay-model'])
    expect(result?.items.find((item) => item.purpose === 'video')?.models).toEqual(['custom-relay-model'])
  })
  it('keeps Sora video entries out of the image pool in a source serving several purposes', async () => {
    const result = await readAgentMediaCatalog([source()], async () => ({ ...prepared(), models: ['gpt-4.1-mini', 'gpt-image-1', 'sora-2'] }), () => true)
    expect(result?.items.find((item) => item.purpose === 'image')?.models).toEqual(['gpt-image-1'])
    expect(result?.items.find((item) => item.purpose === 'video')?.models).toEqual(['sora-2'])
  })
  it('uses existing media-family filters for a legacy host without declared purposes', async () => {
    const result = await readAgentMediaCatalog([{ ...source(), purposes: undefined }], async () => ({ ...prepared(), purposes: undefined, models: ['gpt-image-1', 'gpt-4.1'] }), () => true)
    expect(result?.items.find((item) => item.purpose === 'image')?.models).toContain('gpt-image-1')
    expect(result?.items.find((item) => item.purpose === 'text')?.models).toEqual(['gpt-4.1'])
  })

  it('does not read while closed and reuses the same successful catalog when reopened', async () => {
    const prepare = vi.fn(async (name: string) => prepared(name))
    const options = { scopeKey: 'owner:project:1', enabled: false, groups: [source()], active: () => true, prepare }
    render(options); await settle(); expect(prepare).not.toHaveBeenCalled()
    options.enabled = true; render(options); await settle()
    expect(render(options).items).toHaveLength(2)
    options.enabled = false; render(options)
    options.enabled = true; render(options); await settle()
    expect(render(options).items).toHaveLength(2)
    expect(prepare).toHaveBeenCalledTimes(1)
  })
  it('hides the old owner catalog immediately and ignores its pending completion', async () => {
    const old = deferred<CanvasPreparedGroup>()
    const oldOptions = { scopeKey: 'owner-a:project:1', enabled: true, groups: [source('old')], active: () => true, prepare: () => old.promise }
    render(oldOptions)
    const next = { ...oldOptions, scopeKey: 'owner-b:project:2', groups: [source('new')], prepare: async () => prepared('new') }
    expect(render(next).items).toEqual([])
    await settle(); old.resolve(prepared('old')); await settle()
    expect(render(next).items.map((item) => item.providerId)).toEqual(['new', 'new'])
  })
  it('reloads explicitly and invalidates a changed source revision without an identity request', async () => {
    const prepare = vi.fn(async (name: string) => prepared(name))
    const options = { scopeKey: 'owner:project:1', enabled: true, groups: [source()], active: () => true, prepare }
    render(options); await settle()
    render(options).reload(); render(options); await settle()
    expect(prepare).toHaveBeenCalledTimes(2)
    const updated = { ...options, groups: [{ ...source(), revision: 4 }] }
    expect(render(updated).items).toEqual([])
    await settle()
    expect(render(updated).error).toContain('来源资料已更新')
    expect(prepare).toHaveBeenCalledTimes(3)
  })
})
