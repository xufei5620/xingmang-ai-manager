import { readFileSync } from 'node:fs'
import { createElement, isValidElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { UpstreamMediaReference } from '../components/upstream-references'
import type { WorkflowNodeData } from '../model'
import { ImageToolControls } from './ImageToolControls'
import { TileViewport } from './TileViewport'
import { defaultImageTransformRecipe, imageTransformKindForNode, imageTransformRecipeForNode } from './recipe'
import { parseTileInput, resolveTileInputSlots } from './tile-input'
import { tileEditorInputScope } from './tile-preview-state'
import { parseImageCompareSettings, resolveImageCompareView } from './viewer-settings'
import { initialPanoramaView, parsePanoramaView } from './panorama-view-state'

function elements(root: unknown): ReactElement<Record<string, unknown>>[] { if (Array.isArray(root)) return root.flatMap(elements); return isValidElement<Record<string, unknown>>(root) ? [root, ...elements(root.props.children)] : [] }
function reference(edgeId: string, id?: string, outputIndex = 0): UpstreamMediaReference { return { edgeId, outputIndex, sourceNodeId: edgeId, kind: 'image', relationLabel: '图像输入', mention: '', label: edgeId, status: id ? 'ready' : 'waiting', ...(id ? { asset: { kind: 'image', assetId: id, localUrl: `xingmang-asset://image/${id}` } } : {}) } }
function fixture() {
  const file = ts.createSourceFile('ImageToolControls.tsx', readFileSync(new URL('./ImageToolControls.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declaration = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'ImageToolControls')!
  const slots: unknown[] = [], dependencies = new Map<number, unknown[]>()
  let cursor = 0, pending: Array<() => void> = []
  function useRef(initial: unknown) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index] }
  function useState(initial: unknown) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }] }
  function useEffect(effect: () => void, deps: unknown[]) { const index = cursor++, before = dependencies.get(index); if (!before || deps.some((value, key) => !Object.is(value, before[key]))) { dependencies.set(index, deps); pending.push(effect) } }
  const props = { kind: 'image-tile', disabled: false, references: [reference('a'), reference('b', 'b'.repeat(43))], data: { prompt: '', model: '', status: 'idle', settings: { imageTransform: defaultImageTransformRecipe('tile') } } as WorkflowNodeData, onChange: vi.fn(), onTileChange: vi.fn((patch: Record<string, unknown>, _scope: string) => { props.data = { ...props.data, dirty: true, settings: { ...props.data.settings, ...patch } } }), onDownloadTileSource: vi.fn().mockResolvedValue(undefined) }
  const env = { React: { createElement }, useRef, useState, useEffect, parseTileInput, resolveTileInputSlots, tileEditorInputScope, parseImageCompareSettings, resolveImageCompareView, initialPanoramaView, parsePanoramaView, imageTransformKindForNode, imageTransformRecipeForNode, defaultImageTransformRecipe,
    useToolImages: (refs: UpstreamMediaReference[]) => refs.filter((ref) => ref.asset?.localUrl).map((ref) => ({ key: ref.edgeId, label: ref.label, asset: ref.asset, dimensions: { width: 480, height: 640 }, dimensionsReady: true, onLoad: vi.fn() })),
    toolNames: { 'image-tile': '平铺图片' }, ChevronLeft: 'ChevronLeft', ChevronRight: 'ChevronRight', SlidersHorizontal: 'SlidersHorizontal', Expand: 'Expand', ToolDialog: 'ToolDialog', TileViewport: 'TileViewport', RecipePreview: 'RecipePreview', RecipeEditor: 'RecipeEditor', SafeImage: 'SafeImage',
  }
  const code = ts.transpileModule(`return (${declaration.getText(file).replace(/^export /, '')})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText
  const render = new Function(...Object.keys(env), code)(...Object.values(env)) as (props: unknown) => unknown
  function view() { cursor = 0; const tree = elements(render(props)); const jobs = pending; pending = []; jobs.forEach((job) => job()); return tree }
  function click(label: string) { const button = view().find((entry) => entry.type === 'button' && (entry.props['aria-label'] === label || Array.isArray(entry.props.children) && entry.props.children.includes(label)))!; (button.props.onClick as () => void)() }
  function choose(index: number) { const selector = view().find((entry) => entry.type === 'select')!; (selector.props.onChange as (event: unknown) => void)({ currentTarget: { value: String(index) } }) }
  return { props, view, click, choose }
}

describe('actual tile node controls', () => {
  it('retains waiting slots and explicitly selects a ready second texture without running', () => {
    const f = fixture(), initial = f.view()
    expect(initial.find((entry) => entry.type === 'select')?.props.value).toBe(0)
    expect(initial.some((entry) => entry.props.children === '当前贴图尚未就绪，保留原选择；其他贴图仍可切换。')).toBe(true)
    f.choose(1); expect(f.props.onTileChange).toHaveBeenCalledExactlyOnceWith({ tileInput: { edgeId: 'b', outputIndex: 0 } }, expect.any(String))
    expect(f.view().find((entry) => entry.type === 'RecipePreview')?.props.images).toEqual([expect.objectContaining({ asset: expect.objectContaining({ assetId: 'b'.repeat(43) }) })])
    f.props.references[0] = reference('a', 'a'.repeat(43)); expect(f.view().find((entry) => entry.type === 'select')?.props.value).toBe(1)
    f.props.references = [f.props.references[0]]; const missing = f.view()
    expect(missing.some((entry) => entry.props.children === '已选贴图的连接已移除，请重新选择；不会自动换用其他图片。')).toBe(true)
    expect(f.props.onChange).not.toHaveBeenCalled()
  })
  it('keeps fullscreen viewing available while execution settings are locked', () => {
    const f = fixture(); f.choose(1); f.props.disabled = true
    f.choose(0); expect(f.props.onTileChange).toHaveBeenCalledTimes(1)
    f.click('全屏平铺预览'); const viewport = f.view().find((entry) => entry.type === 'TileViewport')!
    expect(viewport.props.image).toMatchObject({ asset: { assetId: 'b'.repeat(43) } })
    expect(f.view().find((entry) => entry.type === 'ToolDialog')?.props.fullScreen).toBe(true)
    expect(f.view().find((entry) => entry.type === 'select')?.props.disabled).toBe(true)
  })
  it('downloads the selected original slot and applies processing parameters through guarded tile change', async () => {
    const f = fixture(); f.choose(1); f.click('全屏平铺预览')
    const viewport = f.view().find((entry) => entry.type === 'TileViewport')!; await (viewport.props.onDownload as () => Promise<void>)()
    expect(f.props.onDownloadTileSource).toHaveBeenCalledExactlyOnceWith({ edgeId: 'b', outputIndex: 0 }, expect.any(String))
    ;(f.view().find((entry) => entry.type === 'ToolDialog')!.props.onClose as () => void)()
    f.click('编辑处理参数'); const recipe = f.view().find((entry) => entry.type === 'RecipeEditor')!
    expect(recipe.props.images).toEqual([expect.objectContaining({ asset: expect.objectContaining({ assetId: 'b'.repeat(43) }) })])
    const updated = { ...defaultImageTransformRecipe('tile'), rows: 2 }; (recipe.props.onApply as (value: unknown) => void)(updated)
    expect(f.props.onTileChange).toHaveBeenLastCalledWith({ imageTransform: updated }, expect.any(String))
    expect(f.props.onChange).not.toHaveBeenCalled()
  })
  it('discards an open recipe editor on source replacement without overwriting saved parameters', () => {
    const f = fixture(); f.choose(1); f.click('编辑处理参数'); expect(f.view().some((entry) => entry.type === 'RecipeEditor')).toBe(true)
    f.props.references[1] = reference('b', 'c'.repeat(43)); f.view()
    expect(f.view().some((entry) => entry.type === 'RecipeEditor')).toBe(false); expect(f.props.onTileChange).toHaveBeenCalledTimes(1)
  })
  it('renders the retained invalid choice honestly and never runs handlers during static rendering', () => {
    const onChange = vi.fn(), html = renderToStaticMarkup(createElement(ImageToolControls, { kind: 'image-tile', data: { prompt: '', model: '', status: 'idle', settings: { tileInput: { edgeId: 'removed' } } }, references: [reference('a', 'a'.repeat(43))], disabled: false, onChange }))
    expect(html).toContain('原贴图已断开'); expect(html).toContain('不会自动换用其他图片'); expect(html).toContain('全屏平铺预览'); expect(onChange).not.toHaveBeenCalled()
    const empty = renderToStaticMarkup(createElement(TileViewport, { message: '尚未连接图片' }))
    expect(empty).toContain('尚未连接图片'); expect(empty).toContain('平移缩放不会修改画布或提交运行'); expect(empty).not.toContain('background-image')
  })
})
