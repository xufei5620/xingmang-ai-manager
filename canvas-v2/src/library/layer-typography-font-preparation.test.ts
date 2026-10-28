import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageLayerRecipe } from '../image-tools/recipe'

function recipe(): ImageLayerRecipe {
  return { kind: 'layer', outputWidth: 100, outputHeight: 80, background: 'transparent', explicitLayers: true, layers: [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true,
    content: { kind: 'text', text: '中文 office 👩🏽‍💻', color: '#ffffff', fontSize: 20, fontFamily: 'sans-serif', fontWeight: 400, align: 'left', typography: { version: 1, fontFamily: 'Saved Local Family', fontSource: 'local', fontWeight: 600, lineHeight: 1.2, letterSpacing: 0 } },
  }] }
}

function nativeFixture() {
  const canvases: Array<{ width: number; height: number }> = [], draws = vi.fn(), texts = vi.fn(), reads = vi.fn(() => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) })), encode = vi.fn()
  vi.stubGlobal('document', { createElement() {
    const canvas = { width: 0, height: 0, toBlob: encode, getContext() { return context } }
    const context = { canvas, font: '', letterSpacing: '0px', filter: 'none', save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, translate() {}, rotate() {}, scale() {},
      fillText(value: string) { texts(value, context.font) }, drawImage: draws, getImageData: reads,
    }
    canvases.push(canvas)
    return canvas
  } })
  let complete!: () => void, fail!: (cause: Error) => void, notifyStarted!: () => void
  const started = new Promise<void>((resolve) => { notifyStarted = resolve })
  const load = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject })
  const source = vi.fn()
  vi.stubGlobal('FontFace', class {
    constructor(...args: unknown[]) { source(...args) }
    load() { notifyStarted(); return load }
  })
  return { canvases, draws, texts, reads, encode, source, started, complete, fail }
}

beforeEach(() => vi.resetModules())
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('native typography font preparation', () => {
  it.each(['export', 'sample'] as const)('aborts a pending font immediately during %s and never paints after late readiness', async (operation) => {
    const f = nativeFixture(), controller = new AbortController(), browser = await import('./browser-image-transform')
    const pending = operation === 'export'
      ? browser.processBrowserImageTransform({ recipe: recipe(), sources: [], signal: controller.signal })
      : browser.sampleBrowserImageLayerPixels({ recipe: recipe(), sources: [], source: 'composite', signal: controller.signal })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await f.started
    expect(f.canvases).toHaveLength(1)
    expect(f.texts).not.toHaveBeenCalled()
    controller.abort()
    // This must settle before releasing FontFace.load(), rather than waiting
    // for its eight-second independent timeout to notice the cancelled job.
    await rejected
    expect(f.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
    f.complete()
    await (await import('../image-tools/local-text-fonts')).prepareLocalTextFont('Saved Local Family', 600)
    expect(f.canvases).toHaveLength(1)
    expect(f.draws).not.toHaveBeenCalled()
    expect(f.texts).not.toHaveBeenCalled()
    expect(f.reads).not.toHaveBeenCalled()
    expect(f.encode).not.toHaveBeenCalled()
  })

  it('waits for the exact saved local family and weight before shaping or reading pixels', async () => {
    const f = nativeFixture(), browser = await import('./browser-image-transform')
    const pending = browser.sampleBrowserImageLayerPixels({ recipe: recipe(), sources: [], source: 'composite', region: { x: 0, y: 0, width: 1, height: 1 } })
    await f.started
    expect(f.source).toHaveBeenCalledWith('xingmang-local-font-check', 'local("Saved Local Family")', { weight: '600' })
    expect(f.texts).not.toHaveBeenCalled()
    expect(f.draws).not.toHaveBeenCalled()
    f.complete()
    expect(await pending).toEqual({ width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255]) })
    expect(f.texts).toHaveBeenCalledExactlyOnceWith('中文 office 👩🏽‍💻', '600 20px "Saved Local Family"')
    expect(f.draws).toHaveBeenCalledOnce()
    expect(f.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })

  it('refuses unavailable local fonts without painting a fallback or encoding output', async () => {
    const f = nativeFixture(), browser = await import('./browser-image-transform')
    const pending = browser.processBrowserImageTransform({ recipe: recipe(), sources: [] })
    const rejected = expect(pending).rejects.toThrow('当前设备不可用')
    await f.started
    f.fail(new Error('not installed'))
    await rejected
    expect(f.texts).not.toHaveBeenCalled()
    expect(f.draws).not.toHaveBeenCalled()
    expect(f.encode).not.toHaveBeenCalled()
    expect(f.canvases.every((canvas) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  })
})
