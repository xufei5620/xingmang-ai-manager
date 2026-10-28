import { readFileSync } from 'node:fs'
import { createElement, isValidElement, type ReactElement } from 'react'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { isCanvasImagePreviewUrl } from '../components/MediaPreview'
import { imagePreviewSourceKey } from './preview-image-dimensions'
import { createTileViewportInteraction, tilePreviewDimensions } from './tile-preview-state'
import type { TileViewportImage } from './TileViewport'

function elements(value: unknown): ReactElement<Record<string, unknown>>[] { if (Array.isArray(value)) return value.flatMap(elements); return isValidElement<Record<string, unknown>>(value) ? [value, ...elements(value.props.children)] : [] }
function deferred() { let reject: (error: Error) => void = () => {}; let resolve: () => void = () => {}; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture() {
  const source = ts.createSourceFile('TileViewport.tsx', readFileSync(new URL('./TileViewport.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const component = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'TileViewport')!
  const slots: unknown[] = [], effects = new Map<number, { dependencies: unknown[]; cleanup?: () => void }>(), listeners = new Map<string, (event: unknown) => void>(), captures = new Set<number>()
  let cursor = 0, pending: Array<() => void> = []
  function useRef(initial: unknown) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index] }
  function useState(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }] }
  function useEffect(effect: () => void | (() => void), dependencies: unknown[]) { const index = cursor++, before = effects.get(index); if (!before || dependencies.some((value, at) => !Object.is(value, before.dependencies[at]))) pending.push(() => { before?.cleanup?.(); effects.set(index, { dependencies, cleanup: effect() || undefined }) }) }
  const surface = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 600, height: 400 }), addEventListener: vi.fn((name: string, listener: (event: unknown) => void) => listeners.set(name, listener)), removeEventListener: vi.fn((name: string) => listeners.delete(name)), focus: vi.fn(), setPointerCapture: (id: number) => captures.add(id), hasPointerCapture: (id: number) => captures.has(id), releasePointerCapture: (id: number) => captures.delete(id) }
  const env = { React: { createElement }, useRef, useState, useEffect, createTileViewportInteraction, tilePreviewDimensions, imagePreviewSourceKey, isCanvasImagePreviewUrl, resolveCanvasAssetDisplayUrl: (url: string) => url, SafeImage: 'SafeImage', Download: 'Download', Move: 'Move', RotateCcw: 'RotateCcw', ZoomIn: 'ZoomIn', ZoomOut: 'ZoomOut' }
  const render = new Function(...Object.keys(env), ts.transpileModule(`return (${component.getText(source).replace(/^export /, '')})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText)(...Object.values(env)) as (props: unknown) => unknown
  const props: { image?: TileViewportImage; onDownload: () => Promise<void> } = { image: { label: '竖版原图', asset: { kind: 'image', assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` } }, onDownload: vi.fn().mockResolvedValue(undefined) }
  function view() { cursor = 0; const tree = elements(render(props)), stage = tree.find((element) => String(element.props.className ?? '').startsWith('tile-viewport-stage'))!; (stage.props.ref as { current: unknown }).current = surface; const jobs = pending; pending = []; jobs.forEach((job) => job()); return tree }
  function stage() { return view().find((element) => String(element.props.className ?? '').startsWith('tile-viewport-stage'))! }
  function image() { return view().find((element) => element.type === 'SafeImage')! }
  function load() { (image().props.onLoad as (event: unknown) => void)({ currentTarget: { naturalWidth: 480, naturalHeight: 640 } }); view() }
  function event(extra: Record<string, unknown> = {}) { return { preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: surface, pointerId: 1, button: 0, isPrimary: true, clientX: 110, clientY: 120, ...extra } }
  function invoke(name: string, event: unknown) { (stage().props[name] as (value: unknown) => void)(event) }
  function click(label: string) { const button = view().find((element) => element.type === 'button' && (element.props['aria-label'] === label || Array.isArray(element.props.children) && element.props.children.includes(label)))!; (button.props.onClick as () => void)() }
  function unmount() { for (const effect of effects.values()) effect.cleanup?.() }
  return { props, view, stage, image, load, event, invoke, click, listeners, surface, captures, unmount }
}

describe('actual infinite tile viewport events', () => {
  it('pans at the initial scale and uses captured drag, keyboard, wheel and reset without document changes', () => {
    const f = fixture(); f.load()
    expect(f.stage().props.style).toMatchObject({ backgroundSize: '240px 320px', backgroundPosition: '0px 0px' })
    const down = f.event(); f.invoke('onPointerDown', down); expect(f.captures.has(1)).toBe(true); expect(down.preventDefault).toHaveBeenCalled()
    f.invoke('onPointerMove', f.event({ clientX: 160, clientY: 150 })); expect(f.stage().props.style).toMatchObject({ backgroundPosition: '50px 30px' })
    f.invoke('onPointerUp', f.event()); expect(f.captures.size).toBe(0)
    f.invoke('onKeyDown', f.event({ key: 'ArrowRight' })); expect(f.stage().props.style).toMatchObject({ backgroundPosition: '18px 30px' })
    const wheel = f.event({ deltaY: -100, deltaMode: 0 }); f.listeners.get('wheel')!(wheel); expect(wheel.preventDefault).toHaveBeenCalled(); expect(wheel.stopPropagation).toHaveBeenCalled()
    expect(f.stage().props.style).not.toMatchObject({ backgroundSize: '240px 320px' })
    expect(f.surface.addEventListener).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: false })
    f.click('重置视图'); expect(f.stage().props.style).toMatchObject({ backgroundSize: '240px 320px', backgroundPosition: '0px 0px' })
    expect(f.props.onDownload).not.toHaveBeenCalled()
  })
  it('resets only viewer state and rejects stale image completion after the selected source changes', () => {
    const f = fixture(); const oldImage = f.image(); f.load(); f.click('放大平铺预览')
    f.props.image = { label: '第二张', asset: { kind: 'image', assetId: 'b'.repeat(43), localUrl: `xingmang-asset://image/${'b'.repeat(43)}` } }
    expect(f.stage().props.style).toBeUndefined()
    ;(oldImage.props.onLoad as (event: unknown) => void)({ currentTarget: { naturalWidth: 100, naturalHeight: 100 } }); expect(f.stage().props.style).toBeUndefined()
    f.load(); expect(f.stage().props.style).toMatchObject({ backgroundSize: '240px 320px', backgroundPosition: '0px 0px' })
    f.invoke('onPointerDown', f.event()); f.invoke('onPointerMove', f.event({ clientX: 300 })); f.invoke('onPointerCancel', f.event()); expect(f.stage().props.style).toMatchObject({ backgroundPosition: '0px 0px' })
  })
  it('downloads once for repeated clicks and discards a late error from the old source', async () => {
    const f = fixture(), pending = deferred(); f.props.onDownload = vi.fn().mockReturnValue(pending.promise); f.load()
    f.click('下载当前原图'); f.click('下载中…'); expect(f.props.onDownload).toHaveBeenCalledOnce()
    f.props.image = { label: '第二张', asset: { kind: 'image', assetId: 'b'.repeat(43), localUrl: `xingmang-asset://image/${'b'.repeat(43)}` } }; f.view(); pending.reject(new Error('旧贴图失败')); await Promise.resolve(); await Promise.resolve()
    expect(f.view().some((element) => element.props.role === 'alert')).toBe(false)
    f.load(); f.unmount(); expect(f.listeners.size).toBe(0)
  })
  it('shows invalid or unreadable original images as unavailable and keeps preview actions disabled', () => {
    const f = fixture(); f.props.image!.asset.localUrl = 'https://untrusted.invalid/texture.png'
    expect(f.view().some((element) => element.props.children === '当前贴图无法读取，请核对素材或切换其他贴图')).toBe(true)
    expect(f.stage().props.style).toBeUndefined()
    const buttons = f.view().filter((element) => element.type === 'button'); expect(buttons.every((button) => button.props.disabled)).toBe(true)
    expect(f.props.onDownload).not.toHaveBeenCalled()
  })
})
