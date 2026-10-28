import { describe, expect, it, vi } from 'vitest'
import type { CanvasGroupSummary } from '../host'
import { canvasNodeSourceSignature, fixedCanvasNodeSourceNames, prepareCanvasNodeSources, resolveCanvasNodeModelAvailability, type CanvasNodeModelAvailability, type CanvasNodeSourceCatalog } from './node-model-availability'

const defaults: CanvasNodeModelAvailability = { connected: true, imageModels: ['default-image'], videoModels: ['ark-model'], textModels: ['default-text'], imageModel: 'default-image', videoModel: 'ark-model', textModel: 'default-text', videoProtocol: 'ark-seedance' }
function source(name = 'fixed'): CanvasGroupSummary { return { name, description: `本人 ${name}`, ratio: 1, purposes: ['image', 'video'], connectionStatus: 'ready', revision: 2, videoProtocol: 'relay-videos' } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes }); return { promise, resolve } }

describe('node fixed-source model availability', () => {
  it('retains the exact old defaults object when the document has no source override', () => {
    expect(resolveCanvasNodeModelAvailability('image-generate', {}, defaults)).toBe(defaults)
    expect(resolveCanvasNodeModelAvailability('image-layer', { group: 'irrelevant' }, defaults)).toBe(defaults)
  })
  it.each([undefined, { state: 'pending', models: [] }, { state: 'error', models: [], error: '来源已删除' }] as const)('fails closed for an unresolved fixed source without inheriting defaults: %j', (entry) => {
    const resolved = resolveCanvasNodeModelAvailability('video-generate', { group: 'fixed' }, { ...defaults, sourceCatalog: entry ? { fixed: entry } : {} })
    expect(resolved.sourceError).toBeTruthy(); expect(resolved.videoModels).toEqual([]); expect(resolved.imageModels).toEqual([]); expect(resolved.videoModel).toBeUndefined(); expect(resolved.videoProtocol).not.toBe('ark-seedance')
  })
  it('preserves an explicit empty source as invalid instead of falling back', () => {
    const resolved = resolveCanvasNodeModelAvailability('image-generate', { group: '' }, defaults)
    expect(resolved.sourceError).toContain('为空'); expect(resolved.imageModels).toEqual([])
  })
  it('takes model choices and video protocol from the fixed source without selecting a replacement model', () => {
    const resolved = resolveCanvasNodeModelAvailability('video-generate', { group: 'fixed' }, { ...defaults, sourceCatalog: { fixed: { state: 'ready', models: ['grok-imagine-video'], purposes: ['video'], videoProtocol: 'relay-videos', label: '本人视频' } } })
    expect(resolved.videoModels).toEqual(['grok-imagine-video']); expect(resolved.videoProtocol).toBe('relay-videos'); expect(resolved.videoModel).toBeUndefined(); expect(resolved.sourceLabel).toBe('本人视频'); expect(resolved.imageModels).toEqual([])
  })
  it('rejects withdrawn purposes and keeps unknown relay aliases within their declared purpose', () => {
    const catalog: CanvasNodeSourceCatalog = { fixed: { state: 'ready', models: ['relay-image-alias'], purposes: ['image'] } }
    expect(resolveCanvasNodeModelAvailability('image-generate', { group: 'fixed' }, { ...defaults, sourceCatalog: catalog }).imageModels).toEqual(['relay-image-alias'])
    expect(resolveCanvasNodeModelAvailability('video-generate', { group: 'fixed' }, { ...defaults, sourceCatalog: catalog }).sourceError).toContain('不提供此用途')
  })
  it('deduplicates only referenced media source IDs and signatures ignore model edits and unrelated provider revisions', () => {
    const nodes = [{ type: 'image-generate', data: { group: 'fixed' } }, { type: 'video-generate', data: { group: 'fixed' } }, { type: 'image-layer', data: { group: 'local-group' } }, { type: 'image-generate', data: {} }]
    expect(fixedCanvasNodeSourceNames(nodes)).toEqual(['fixed'])
    const original = canvasNodeSourceSignature(['fixed'], [source(), source('unrelated')], 1)
    expect(canvasNodeSourceSignature(['fixed'], [source(), { ...source('unrelated'), revision: 20 }], 99)).toBe(original)
    expect(canvasNodeSourceSignature(['fixed'], [{ ...source(), revision: 3 }], 1)).not.toBe(original)
    expect(canvasNodeSourceSignature(['fixed'], [{ ...source(), videoProtocol: 'ark-seedance' }], 1)).not.toBe(original)
  })
  it('loads each saved catalog once, bounds concurrency at four and publishes independent source readiness', async () => {
    const names = Array.from({ length: 7 }, (_, i) => `s${i}`), gates = names.map(() => deferred<void>()), seen: CanvasNodeSourceCatalog[] = []
    let active = 0, peak = 0
    const prepare = vi.fn(async (name: string) => { active++; peak = Math.max(peak, active); await gates[names.indexOf(name)].promise; active--; return { group: name, models: ['grok-imagine-video'], revision: 2, videoProtocol: 'relay-videos' as const, keyCreated: false } })
    const job = prepareCanvasNodeSources({ names: [...names, names[0]], groups: names.map((name) => source(name)), prepare, isCurrent: () => true, onChange: (snapshot) => seen.push(snapshot) })
    expect(prepare).toHaveBeenCalledTimes(4); gates.forEach((gate) => gate.resolve()); await job
    expect(prepare).toHaveBeenCalledTimes(7); expect(peak).toBe(4); expect(Object.values(seen.at(-1)!).every((entry) => entry.state === 'ready')).toBe(true)
    expect(seen[0].s0.state).toBe('pending'); expect(seen[1].s0.videoProtocol).toBe('relay-videos')
  })
  it('never reads missing, failed or untested providers and exposes a source-specific error', async () => {
    const prepare = vi.fn(), seen: CanvasNodeSourceCatalog[] = []
    await prepareCanvasNodeSources({ names: ['missing', 'failed', 'untested'], groups: [{ ...source('failed'), connectionStatus: 'failed' }, { ...source('untested'), connectionStatus: 'untested' }], prepare, isCurrent: () => true, onChange: (value) => seen.push(value) })
    expect(prepare).not.toHaveBeenCalled(); expect(Object.values(seen.at(-1)!).every((entry) => entry.state === 'error')).toBe(true)
  })
  it.each(['id', 'revision', 'protocol'] as const)('rejects a saved catalog whose %s changed during its read', async (changed) => {
    let last: CanvasNodeSourceCatalog = {}
    await prepareCanvasNodeSources({ names: ['fixed'], groups: [source()], isCurrent: () => true, onChange: (value) => { last = value }, prepare: async () => ({ group: changed === 'id' ? 'foreign' : 'fixed', revision: changed === 'revision' ? 3 : 2, models: ['grok-imagine-video'], videoProtocol: changed === 'protocol' ? 'ark-seedance' : 'relay-videos', keyCreated: false }) })
    expect(last.fixed.state).toBe('error'); expect(last.fixed.models).toEqual([])
  })
  it('does not publish a late response after a monotonic owner/project epoch changes and returns', async () => {
    let epoch = 1
    const gate = deferred<void>(), change = vi.fn(), initial = epoch
    const job = prepareCanvasNodeSources({ names: ['fixed'], groups: [source()], isCurrent: () => epoch === initial, onChange: change, prepare: async () => { await gate.promise; return { group: 'fixed', models: ['grok-imagine-video'], revision: 2, keyCreated: false } } })
    expect(change).toHaveBeenCalledOnce(); epoch = 3; gate.resolve(); await job
    expect(change).toHaveBeenCalledOnce()
  })
})
