import { describe, expect, it, vi } from 'vitest'
import type { BrowserLayerPsdDocument } from '../library/browser-layer-psd-import'
import { createLayerPsdImportController, initialLayerPsdImportState, layerPsdImportCapacityError, type LayerPsdImportState } from './layer-psd-import-state'

function document(): BrowserLayerPsdDocument { return { width: 320, height: 240, warnings: [], layers: [0, 1].map((index) => ({ name: `图层 ${index + 1}`, left: index * 10, top: 20, width: 40, height: 30, visible: index === 0, opacity: 0.5, blend: 'source-over', blob: new Blob(['png'], { type: 'image/png' }) })) } }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: Error) => void; const promise = new Promise<T>((success, failure) => { resolve = success; reject = failure }); return { promise, resolve, reject } }
function setup() {
  let state: LayerPsdImportState = { ...initialLayerPsdImportState }, active = true, sequence = 0
  const parsed = document(), parse = vi.fn(async () => parsed), onImport = vi.fn(async (_document: BrowserLayerPsdDocument, _options: { signal: AbortSignal }): Promise<void> => undefined)
  const createUrl = vi.fn(() => `blob:preview-${++sequence}`), revokeUrl = vi.fn(), onImported = vi.fn()
  const limits = { maximumAdditionalLayers: 20, maximumAdditionalSources: 20 }
  const controller = createLayerPsdImportController({ parse, onImport, createUrl, revokeUrl, onImported, active: () => active, limits: () => limits, onState: (value) => { state = value } })
  return { controller, parsed, parse, onImport, createUrl, revokeUrl, onImported, limits, state: () => state, deactivate: () => { active = false } }
}
const file = new File(['PSD'], '作品.psd')

describe('PSD import dialog controller', () => {
  it('parses locally and previews every layer without importing before confirmation', async () => {
    const f = setup(); await f.controller.selectFile(file)
    expect(f.state()).toMatchObject({ phase: 'ready', fileName: '作品.psd', document: f.parsed, urls: ['blob:preview-1', 'blob:preview-2'] })
    expect(f.onImport).not.toHaveBeenCalled()
    expect(f.parse).toHaveBeenCalledWith(file, { signal: expect.any(AbortSignal) })
    await f.controller.importSelected()
    expect(f.onImport).toHaveBeenCalledExactlyOnceWith(f.parsed, { signal: expect.any(AbortSignal) })
    expect(f.onImported).toHaveBeenCalledOnce()
  })

  it('does not publish previews from a cancelled or superseded parse', async () => {
    const f = setup(), first = deferred<BrowserLayerPsdDocument>(), second = deferred<BrowserLayerPsdDocument>()
    f.parse.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const old = f.controller.selectFile(file)
    expect(f.state().phase).toBe('parsing')
    const oldSignal = (f.parse.mock.calls[0] as unknown as [Blob, { signal: AbortSignal }])[1].signal
    f.controller.cancel()
    expect(oldSignal.aborted).toBe(true)
    const newer = f.controller.selectFile(new File(['new'], '新的.psd'))
    first.resolve(document()); await old
    expect(f.createUrl).not.toHaveBeenCalled()
    expect(f.state().phase).toBe('parsing')
    second.resolve(f.parsed); await newer
    expect(f.state().fileName).toBe('新的.psd')
    expect(f.state().document).toBe(f.parsed)
  })

  it('retains the same parsed document after unknown import failure and prevents duplicate clicks', async () => {
    const f = setup(), pending = deferred<void>(); await f.controller.selectFile(file)
    f.onImport.mockReturnValueOnce(pending.promise)
    const running = f.controller.importSelected(); await f.controller.importSelected()
    expect(f.onImport).toHaveBeenCalledOnce()
    pending.reject(new Error('原素材上传结果待核对')); await running
    expect(f.state()).toMatchObject({ phase: 'ready', error: '原素材上传结果待核对' })
    expect(f.state().document).toBe(f.parsed)
    await f.controller.importSelected()
    expect(f.onImport.mock.calls[1][0]).toBe(f.onImport.mock.calls[0][0])
    expect(f.onImported).toHaveBeenCalledOnce()
  })

  it('ignores import completion after cancellation or owner scope loss', async () => {
    for (const cancel of [true, false]) {
      const f = setup(), pending = deferred<void>(); await f.controller.selectFile(file)
      f.onImport.mockReturnValueOnce(pending.promise)
      const running = f.controller.importSelected()
      if (cancel) f.controller.cancel(); else f.deactivate()
      pending.resolve(); await running
      expect(f.onImported).not.toHaveBeenCalled()
      f.controller.cancel()
      expect(f.state().phase).toBe('ready')
      expect(f.state().document).toBe(f.parsed)
    }
  })

  it.each(['maximumAdditionalLayers', 'maximumAdditionalSources'] as const)('preserves the complete preview but blocks insufficient %s before import', async (key) => {
    const f = setup(); f.limits[key] = 1; await f.controller.selectFile(file)
    expect(f.state().document?.layers).toHaveLength(2)
    expect(layerPsdImportCapacityError(f.parsed, f.limits)).toContain(key === 'maximumAdditionalLayers' ? '只能追加 1 层' : '只能追加 1 个')
    await f.controller.importSelected()
    expect(f.onImport).not.toHaveBeenCalled()
    expect(f.state().error).toContain('不会')
  })

  it('revokes every preview URL on replacement and disposal, and never creates URLs after disposal', async () => {
    const f = setup(); await f.controller.selectFile(file)
    await f.controller.selectFile(file)
    expect(f.revokeUrl.mock.calls.map(([url]) => url)).toEqual(['blob:preview-1', 'blob:preview-2'])
    f.controller.dispose()
    expect(f.revokeUrl.mock.calls.map(([url]) => url)).toEqual(['blob:preview-1', 'blob:preview-2', 'blob:preview-3', 'blob:preview-4'])
    await f.controller.selectFile(file)
    expect(f.parse).toHaveBeenCalledTimes(2)
    const late = setup(), pending = deferred<BrowserLayerPsdDocument>(); late.parse.mockReturnValueOnce(pending.promise)
    const running = late.controller.selectFile(file); late.controller.dispose(); pending.resolve(document()); await running
    expect(late.createUrl).not.toHaveBeenCalled()
  })

  it('cleans partially created previews and rejects empty input before parsing', async () => {
    const f = setup(); await f.controller.selectFile(new File([], 'empty.psd'))
    expect(f.parse).not.toHaveBeenCalled()
    expect(f.state().error).toContain('为空')
    f.createUrl.mockImplementationOnce(() => 'blob:partial').mockImplementationOnce(() => { throw new Error('预览内存不足') })
    await f.controller.selectFile(file)
    expect(f.revokeUrl).toHaveBeenCalledExactlyOnceWith('blob:partial')
    expect(f.state()).toMatchObject({ phase: 'idle', document: null, urls: [], error: '预览内存不足' })
  })
})


describe('PSD folder capacity', () => {
  it('blocks a new group before uploading any pixels when the editor group capacity changed', async () => {
    const f = setup()
    f.parsed.layerGroups = { version: 1, layerIds: ['a', 'b'], groups: [{ id: 'g', name: 'Folder', children: ['a', 'b'], visible: true, locked: false }] }
    const limits = f.limits as typeof f.limits & { maximumAdditionalGroups?: number }
    limits.maximumAdditionalGroups = 1
    await f.controller.selectFile(file)
    limits.maximumAdditionalGroups = 0
    await f.controller.importSelected()
    expect(f.onImport).not.toHaveBeenCalled()
    expect(f.state().error).toContain('组')
    expect(f.state().document).toBe(f.parsed)
  })
})
