import { readFileSync } from 'node:fs'
import { createElement, isValidElement, type ReactElement } from 'react'
import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as viewState from './panorama-view-state'

function elements(root: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(root)) return root.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(root)) return []
  return [root, ...elements(root.props.children)]
}
function component(environment: Record<string, unknown>) {
  const file = ts.createSourceFile('PanoramaPreview.tsx', readFileSync(new URL('./PanoramaPreview.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declaration = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'PanoramaPreview')!
  const source = declaration.getText(file).replace(/^export /, '')
  const code = ts.transpileModule(`return (${source})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS } }).outputText
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as (props: Record<string, unknown>) => unknown
}
function fixture() {
  const slots: unknown[] = [], effectSlots = new Map<number, { deps: unknown[]; cleanup?: () => void }>()
  let cursor = 0, queued: Array<() => void> = []
  function useRef(initial: unknown) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index] }
  function useState(initial: unknown) {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
  }
  function useEffect(run: () => void | (() => void), deps: unknown[]) {
    const index = cursor++, previous = effectSlots.get(index)
    if (previous && deps.length === previous.deps.length && deps.every((value, offset) => Object.is(value, previous.deps[offset]))) return
    queued.push(() => { previous?.cleanup?.(); const cleanup = run(); effectSlots.set(index, { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }) })
  }
  const gl = {
    MAX_TEXTURE_SIZE: 100, VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4, ARRAY_BUFFER: 5, STATIC_DRAW: 6, FLOAT: 7,
    TEXTURE_2D: 8, TEXTURE_WRAP_S: 9, TEXTURE_WRAP_T: 10, CLAMP_TO_EDGE: 11, TEXTURE_MIN_FILTER: 12, TEXTURE_MAG_FILTER: 13, LINEAR: 14, RGBA: 15, UNSIGNED_BYTE: 16, NO_ERROR: 0, TRIANGLE_STRIP: 17,
    getParameter: vi.fn(() => 4096), createShader: vi.fn(() => ({})), shaderSource: vi.fn(), compileShader: vi.fn(), getShaderParameter: vi.fn(() => true),
    createProgram: vi.fn(() => ({})), attachShader: vi.fn(), linkProgram: vi.fn(), getProgramParameter: vi.fn(() => true), useProgram: vi.fn(),
    createBuffer: vi.fn(() => ({})), bindBuffer: vi.fn(), bufferData: vi.fn(), getAttribLocation: vi.fn(() => 0), enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(),
    createTexture: vi.fn(() => ({})), bindTexture: vi.fn(), texParameteri: vi.fn(), texImage2D: vi.fn(), getError: vi.fn(() => 0), getUniformLocation: vi.fn(() => ({})),
    viewport: vi.fn(), uniform4f: vi.fn(), drawArrays: vi.fn(), deleteShader: vi.fn(), deleteBuffer: vi.fn(), deleteProgram: vi.fn(), deleteTexture: vi.fn(),
  }
  const listeners = new Map<string, (event: unknown) => void>()
  const target = { width: 0, height: 0, getContext: vi.fn(() => gl), getBoundingClientRect: () => ({ width: 640, height: 320 }), focus: vi.fn(), setPointerCapture: vi.fn(), addEventListener: vi.fn((name: string, fn: (event: unknown) => void) => listeners.set(name, fn)), removeEventListener: vi.fn((name: string) => listeners.delete(name)) }
  const observers: Array<{ run: () => void; disconnect: ReturnType<typeof vi.fn> }> = []
  vi.stubGlobal('window', { devicePixelRatio: 1 })
  vi.stubGlobal('ResizeObserver', class { disconnect = vi.fn(); constructor(run: () => void) { observers.push({ run, disconnect: this.disconnect }) }; observe() {} })
  const onChange = vi.fn((view: viewState.PanoramaView) => { props.view = view }), onCommit = vi.fn()
  const capturePanoramaPng = vi.fn(() => Promise.resolve(new Blob(['png'], { type: 'image/png' }))), downloadPanoramaPng = vi.fn()
  const props: Record<string, unknown> = { src: 'image-a', sourceKey: 'asset-a', view: { ...viewState.initialPanoramaView }, onChange, onCommit }
  const render = component({ React: { createElement }, useRef, useState, useEffect, SafeImage: 'SafeImage', ...viewState, capturePanoramaPng, downloadPanoramaPng })
  function view() {
    cursor = 0
    const tree = elements(render(props))
    const canvas = tree.find((entry) => entry.type === 'canvas')!
    ;(canvas.props.ref as { current: unknown }).current = target
    const pending = queued; queued = []; pending.forEach((run) => run())
    return tree
  }
  function canvas() { return view().find((entry) => entry.type === 'canvas')! }
  function load(width = 800, height = 400) {
    const img = view().find((entry) => entry.type === 'SafeImage')!
    ;(img.props.onLoad as (event: unknown) => void)({ currentTarget: { naturalWidth: width, naturalHeight: height } })
    view()
  }
  function event(extra: Record<string, unknown> = {}) { return { pointerId: 1, button: 0, isPrimary: true, clientX: 0, clientY: 0, preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: target, nativeEvent: {}, ...extra } }
  function call(name: string, extra: Record<string, unknown> = {}) { (canvas().props[name] as (event: unknown) => void)(event(extra)) }
  function click(label: string) { (view().find((entry) => entry.type === 'button' && entry.props.children === label)!.props.onClick as () => void)() }
  function unmount() { for (const entry of effectSlots.values()) entry.cleanup?.() }
  view()
  return { props, view, canvas, load, event, call, click, gl, target, listeners, observers, onChange, onCommit, capturePanoramaPng, downloadPanoramaPng, unmount }
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('actual panorama preview handlers', () => {
  it('keeps a stable loading canvas and commits exactly one pointer gesture', () => {
    const f = fixture()
    expect(f.canvas().props['aria-hidden']).toBe(true)
    f.load()
    f.call('onPointerDown')
    f.call('onPointerMove', { clientX: 80, clientY: 20 })
    f.call('onPointerMove', { pointerId: 2, clientX: 900 })
    f.call('onPointerUp', { pointerId: 2 })
    expect(f.onCommit).not.toHaveBeenCalled()
    f.call('onPointerUp')
    f.call('onLostPointerCapture')
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith({ yaw: 340, pitch: 5, fov: 75 })
  })
  it('cancels a pointer draft with Escape or capture loss and ignores modified keyboard shortcuts', () => {
    const f = fixture(); f.load()
    f.call('onPointerDown'); f.call('onPointerMove', { clientX: 100 })
    f.call('onKeyDown', { key: 'Escape' })
    f.call('onPointerUp')
    expect(f.props.view).toEqual(viewState.initialPanoramaView)
    f.call('onPointerDown'); f.call('onPointerMove', { clientX: 100 }); f.call('onLostPointerCapture')
    expect(f.props.view).toEqual(viewState.initialPanoramaView)
    f.call('onKeyDown', { key: 'ArrowRight', metaKey: true })
    expect(f.onCommit).not.toHaveBeenCalled()
    expect(f.props.view).toEqual(viewState.initialPanoramaView)
  })
  it('groups key repeat and wheel events, consumes scrolling, and cancels the pending wheel timer on source change', () => {
    vi.useFakeTimers()
    const f = fixture(); f.load()
    f.call('onKeyDown', { key: 'ArrowRight' }); f.call('onKeyDown', { key: 'ArrowRight' }); f.call('onKeyUp', { key: 'ArrowRight' })
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith({ yaw: 10, pitch: 0, fov: 75 })
    const wheel = f.event({ deltaY: -100, deltaMode: 0 })
    f.listeners.get('wheel')!(wheel)
    f.view()
    f.listeners.get('wheel')!(wheel)
    f.view()
    expect(wheel.preventDefault).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(180)
    expect(f.onCommit).toHaveBeenLastCalledWith({ yaw: 10, pitch: 0, fov: 67 })
    f.listeners.get('wheel')!(wheel)
    f.props.sourceKey = 'asset-b'; f.props.src = 'image-b'; f.props.view = { ...viewState.initialPanoramaView }; f.view()
    vi.advanceTimersByTime(200)
    expect(f.onCommit).toHaveBeenCalledTimes(2)
  })
  it('ignores old image callbacks even after switching back to the same source', () => {
    const f = fixture()
    const old = f.view().find((entry) => entry.type === 'SafeImage')!
    f.props.src = 'image-b'; f.props.sourceKey = 'asset-b'; f.view()
    f.props.src = 'image-a'; f.props.sourceKey = 'asset-a'; f.view()
    ;(old.props.onLoad as (event: unknown) => void)({ currentTarget: { naturalWidth: 800, naturalHeight: 400 } })
    ;(old.props.onError as () => void)()
    expect(f.gl.createTexture).not.toHaveBeenCalled()
    expect(f.canvas().props['aria-hidden']).toBe(true)
    f.load()
    expect(f.canvas().props['aria-hidden']).toBe(false)
  })
  it('cleans every WebGL resource on texture failure and can recover using the same mounted canvas', () => {
    const f = fixture()
    f.gl.getError.mockReturnValue(1285)
    f.load()
    expect(f.gl.deleteShader).toHaveBeenCalledTimes(2)
    expect(f.gl.deleteBuffer).toHaveBeenCalledOnce()
    expect(f.gl.deleteTexture).toHaveBeenCalledOnce()
    expect(f.gl.deleteProgram).toHaveBeenCalledOnce()
    expect(f.view().find((entry) => entry.type === 'SafeImage')!.props.className).toBe('image-tool-panorama-fallback')
    expect(f.canvas()).toBeDefined()
    f.gl.getError.mockReturnValue(0)
    f.click('重新加载'); f.load()
    expect(f.canvas().props['aria-hidden']).toBe(false)
    expect(f.onCommit).not.toHaveBeenCalled()
  })
  it('rejects textures beyond the device budget before allocation', () => {
    const f = fixture(); f.load(8192, 4096)
    expect(f.gl.createTexture).not.toHaveBeenCalled()
    expect(f.view().some((entry) => entry.props.role === 'status' && JSON.stringify(entry.props.children).includes('纹理上限'))).toBe(true)
    expect(f.canvas().props['aria-hidden']).toBe(true)
  })
  it('cancels an interrupted view, recovers a lost context, and disconnects observers on teardown', () => {
    const f = fixture(); f.load()
    f.call('onPointerDown'); f.call('onPointerMove', { clientX: 100 })
    f.listeners.get('webglcontextlost')!(f.event())
    f.view()
    expect(f.props.view).toEqual(viewState.initialPanoramaView)
    expect(f.canvas().props['aria-hidden']).toBe(true)
    f.listeners.get('webglcontextrestored')!({})
    expect(f.canvas().props['aria-hidden']).toBe(false)
    f.unmount()
    expect(f.observers.every((entry) => entry.disconnect.mock.calls.length === 1)).toBe(true)
    expect(f.listeners.size).toBe(0)
    expect(f.onCommit).not.toHaveBeenCalled()
  })
  it('retains externally saved views and reports a non-equirectangular source', () => {
    const f = fixture()
    f.props.view = { yaw: 90, pitch: -20, fov: 55 }; f.load(640, 480)
    expect(f.gl.uniform4f).toHaveBeenLastCalledWith(expect.anything(), Math.PI / 2, -20 * Math.PI / 180, 55 * Math.PI / 180, 2)
    expect(f.view().some((entry) => entry.type === 'p' && JSON.stringify(entry.props.children).includes('640 × 480'))).toBe(true)
    f.click('复位视角')
    expect(f.onCommit).toHaveBeenCalledExactlyOnceWith(viewState.initialPanoramaView)
  })
  it('draws before capturing and never downloads a late result after source replacement', async () => {
    const f = fixture(); f.load()
    let finish!: (blob: Blob) => void
    f.capturePanoramaPng.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    f.click('下载当前视角')
    expect(f.gl.drawArrays.mock.invocationCallOrder.at(-1)!).toBeLessThan(f.capturePanoramaPng.mock.invocationCallOrder[0])
    f.props.src = 'image-b'; f.props.sourceKey = 'asset-b'; f.view()
    f.props.src = 'image-a'; f.props.sourceKey = 'asset-a'; f.view()
    finish(new Blob(['png'], { type: 'image/png' }))
    await Promise.resolve(); await Promise.resolve()
    expect(f.downloadPanoramaPng).not.toHaveBeenCalled()
    expect(f.onCommit).not.toHaveBeenCalled()
  })
  it('shows capture errors without replacing the working projection and prevents concurrent exports', async () => {
    const f = fixture(); f.load()
    f.capturePanoramaPng.mockRejectedValue(new Error('导出失败，预览仍可用'))
    f.click('下载当前视角')
    const pending = f.view().find((entry) => entry.type === 'button' && entry.props.children === '正在导出视角…')!
    expect(pending.props.disabled).toBe(true)
    ;(pending.props.onClick as () => void)()
    await Promise.resolve(); await Promise.resolve()
    expect(f.capturePanoramaPng).toHaveBeenCalledOnce()
    expect(f.canvas().props['aria-hidden']).toBe(false)
    expect(f.view().find((entry) => entry.props.role === 'alert')!.props.children).toContain('预览仍可用')
    expect(f.downloadPanoramaPng).not.toHaveBeenCalled()
  })
  it('does not download an encoded image after unmounting the viewer', async () => {
    const f = fixture(); f.load()
    let finish!: (blob: Blob) => void
    f.capturePanoramaPng.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    f.click('下载当前视角')
    f.unmount()
    finish(new Blob(['png'], { type: 'image/png' }))
    await Promise.resolve(); await Promise.resolve()
    expect(f.downloadPanoramaPng).not.toHaveBeenCalled()
  })

  it('offers no view download when the host blocks page downloads', () => {
    const f = fixture(); f.props.allowDownload = false; f.load()
    function labelled(label: string) { return f.view().some((entry) => entry.type === 'button' && JSON.stringify(entry.props.children).includes(label)) }
    expect(labelled('下载当前视角')).toBe(false); expect(labelled('复位视角')).toBe(true)
  })
})
