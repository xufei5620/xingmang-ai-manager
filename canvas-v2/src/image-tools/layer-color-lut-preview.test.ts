import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasHostBridge } from '../host'
import { defaultImageLayerColorGrade } from './layer-color-grade'
import { parseColorLutCube } from './layer-color-lut'
import { colorLutSourceKey, type AssetColorLutSource, type ColorLutSelection } from './layer-color-lut-selection'
import { createLayerColorLutPreviewSession, layerColorLutPreviewSignature, useLayerColorLutPreview } from './layer-color-lut-preview'
import type { ImageLayerRecipe } from './recipe'

type Access = ReturnType<NonNullable<CanvasHostBridge['getProjectAccess']>>
type Read = Awaited<ReturnType<NonNullable<CanvasHostBridge['readColorLut']>>>
function selection(index = 0): ColorLutSelection { return { version: 1, enabled: true, strength: 100, source: { kind: 'asset', lutAssetId: String.fromCharCode(65 + index).repeat(43), digest: index.toString(16).padStart(64, '0'), name: 'Owned inverse', domainMin: [0, 0, 0], domainMax: [1, 1, 1] } } }
function recipe(lut = selection()): ImageLayerRecipe { return { kind: 'layer', outputWidth: 2, outputHeight: 2, background: 'transparent', explicitLayers: true, layers: [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, opacity: 1, rotation: 0, blend: 'source-over', visible: true, content: { kind: 'paint' }, colorGrade: { ...defaultImageLayerColorGrade(), lut } }] } }
function resource(source: AssetColorLutSource): Read { return { descriptor: { version: 1, size: 33, assetId: source.lutAssetId, digest: source.digest, name: source.name, domainMin: [...source.domainMin], domainMax: [...source.domainMax], byteSize: 600000, mimeType: 'application/vnd.xingmang.color-lut+json' }, table: parseColorLutCube('TITLE "Owned inverse"\nLUT_1D_SIZE 2\n1 1 1\n0 0 0') } }
function access(projectId = 'project-a', accessVersion = 1, denied = false): Access { return { projectId, denied, access: { projectId, projectVersion: 1, accessVersion, mode: 'owner', canEdit: true, canRun: true, canExport: true, canManageShare: true, canRestore: true } } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function fixture() {
  let current = access()
  const listeners = new Set<(state: Access) => void>(), read = vi.fn(async (source: AssetColorLutSource, _signal?: AbortSignal) => resource(source)), changed = vi.fn()
  const bridge = { readColorLut: read, getProjectAccess: () => current, onProjectAccessChange(listener: (state: Access) => void) { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const session = createLayerColorLutPreviewSession(() => bridge, changed); session.start()
  return { session, read, changed, listeners, event(state: Access) { current = state; for (const listener of listeners) listener(state) } }
}

describe('mounted-preview LUT preparation event session', () => {
  it('keys only active immutable sources and caches one map across exposure, position, strength and layer ordering edits', async () => {
    const f = fixture(), value = recipe(); f.session.update(value)
    await vi.waitFor(() => expect(f.session.snapshot(value).busy).toBe(false))
    const ready = f.session.snapshot(value).tables!, changed = { ...value, layers: [{ ...value.layers[0], x: .2, colorGrade: { ...value.layers[0].colorGrade!, exposure: 1, lut: { ...selection(), strength: 50 } } }] }
    for (let index = 0; index < 20; index++) f.session.update({ ...changed, layers: [...changed.layers] })
    expect(f.session.snapshot(changed).tables).toBe(ready); expect(f.read).toHaveBeenCalledOnce()
    expect(layerColorLutPreviewSignature(value)).toBe(layerColorLutPreviewSignature(changed))
    const two = { ...value, layers: [...value.layers, ...recipe(selection(1)).layers] }
    expect(layerColorLutPreviewSignature(two)).toBe(layerColorLutPreviewSignature({ ...two, layers: [...two.layers].reverse() }))
    f.session.dispose()
  })

  it('does no network work for no LUT, builtin, disabled or zero-strength selections', () => {
    const f = fixture()
    for (const value of [recipe({ ...selection(), enabled: false }), recipe({ ...selection(), strength: 0 }), recipe({ version: 1, enabled: true, strength: 100, source: { kind: 'builtin', presetId: 'xm-lut-movie-tone-v1' } }), { ...recipe(), layers: [] }]) { f.session.update(value); expect(f.session.snapshot(value)).toMatchObject({ busy: false, error: '' }) }
    expect(f.read).not.toHaveBeenCalled(); f.session.dispose()
  })

  it('uses supplied resources or explicit parent preparation without starting a second read', () => {
    const f = fixture(), lut = selection(), source = lut.source
    if (source.kind !== 'asset') throw new Error('fixture source')
    const tables = new Map([[colorLutSourceKey(source), resource(source).table]])
    f.session.update(recipe(), tables)
    expect(f.session.snapshot(recipe(), tables).tables).toBe(tables)
    f.session.update(recipe(), undefined, true)
    expect(f.session.snapshot(recipe(), undefined, true)).toEqual({ busy: true, error: '' })
    expect(f.read).not.toHaveBeenCalled(); f.session.dispose()
  })

  it('hides an old map synchronously when a new source is rendered and drops its late predecessor response', async () => {
    const f = fixture(), first = deferred<Read>(), second = deferred<Read>(), a = recipe(), b = recipe(selection(1))
    f.read.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    f.session.update(a); const oldSignal = f.read.mock.calls[0][1]!
    expect(f.session.snapshot(b)).toEqual({ busy: true, error: '' })
    f.session.update(b); expect(oldSignal.aborted).toBe(true)
    const sourceA = selection().source, sourceB = selection(1).source
    if (sourceA.kind !== 'asset' || sourceB.kind !== 'asset') throw new Error('fixture source')
    first.resolve(resource(sourceA)); await Promise.resolve()
    expect(f.session.snapshot(b).tables).toBeUndefined()
    second.resolve(resource(sourceB)); await vi.waitFor(() => expect(f.session.snapshot(b).busy).toBe(false))
    expect(f.session.snapshot(b).tables?.has(colorLutSourceKey(sourceA))).toBe(false)
    expect(f.session.snapshot(b).tables?.has(colorLutSourceKey(sourceB))).toBe(true)
    f.session.dispose()
  })

  it('ignores identical permission polls and project-version-only updates, but invalidates real scope/access changes', async () => {
    const f = fixture(), value = recipe(); f.session.update(value)
    await vi.waitFor(() => expect(f.session.snapshot(value).busy).toBe(false))
    for (let index = 0; index < 10; index++) { const next = access(); if (next?.access) next.access.projectVersion = 10 + index; f.event(next) }
    expect(f.read).toHaveBeenCalledOnce()
    f.event(access('project-a', 2)); expect(f.session.snapshot(value).busy).toBe(true)
    await vi.waitFor(() => expect(f.session.snapshot(value).busy).toBe(false)); expect(f.read).toHaveBeenCalledTimes(2)
    f.event(access('project-b', 1)); expect(f.session.snapshot(value).busy).toBe(true)
    await vi.waitFor(() => expect(f.session.snapshot(value).busy).toBe(false)); expect(f.read).toHaveBeenCalledTimes(3)
    f.session.dispose()
  })

  it('drops cached pixels immediately on denied access and never starts a replacement private read', async () => {
    const f = fixture(), value = recipe(); f.session.update(value)
    await vi.waitFor(() => expect(f.session.snapshot(value).busy).toBe(false))
    f.event(access('project-a', 2, true))
    expect(f.session.snapshot(value)).toEqual({ busy: false, error: '当前项目访问权限已失效，LUT 预览不可用' })
    expect(f.read).toHaveBeenCalledOnce(); f.session.dispose()
  })

  it('provides a real retry event after loading failure and rejects resource metadata mismatch', async () => {
    const f = fixture(), value = recipe(); f.read.mockRejectedValueOnce(new Error('本项目无权读取此 LUT'))
    f.session.update(value); await vi.waitFor(() => expect(f.session.snapshot(value).error).toContain('无权'))
    expect(f.session.snapshot(value).tables).toBeUndefined()
    f.session.retry(); await vi.waitFor(() => expect(f.session.snapshot(value).tables).toBeDefined()); expect(f.read).toHaveBeenCalledTimes(2)
    const another = fixture(), source = selection().source
    if (source.kind !== 'asset') throw new Error('fixture source')
    const wrong = resource(source); wrong.table.domainMax[0] = 2; another.read.mockResolvedValueOnce(wrong)
    another.session.update(value); await vi.waitFor(() => expect(another.session.snapshot(value).error).toContain('不匹配'))
    f.session.dispose(); another.session.dispose()
  })

  it('aborts and unsubscribes on unmount and never notifies success from an ignoring late loader', async () => {
    const f = fixture(), pending = deferred<Read>(), value = recipe(); f.read.mockReturnValueOnce(pending.promise); f.session.update(value)
    const signal = f.read.mock.calls[0][1]!, calls = f.changed.mock.calls.length
    f.session.dispose(); expect(signal.aborted).toBe(true); expect(f.listeners.size).toBe(0)
    const source = selection().source; if (source.kind !== 'asset') throw new Error('fixture source')
    pending.resolve(resource(source)); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(f.changed).toHaveBeenCalledTimes(calls)
  })

  it('runs the actual hook during SSR without accessing window or claiming an active custom table is ready', () => {
    let active: ReturnType<typeof useLayerColorLutPreview> | undefined
    function Capture() { active = useLayerColorLutPreview(recipe()); return null }
    renderToStaticMarkup(createElement(Capture))
    expect(active).toMatchObject({ busy: true, error: '', retry: expect.any(Function) })
    expect(active?.tables).toBeUndefined()
  })
})
