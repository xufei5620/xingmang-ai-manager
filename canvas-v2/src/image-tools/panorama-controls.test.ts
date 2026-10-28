import { parseTileInput, resolveTileInputSlots } from './tile-input'
import { tileEditorInputScope } from './tile-preview-state'
import { readFileSync } from 'node:fs'
import { createElement, isValidElement, type ReactElement } from 'react'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { initialPanoramaView, parsePanoramaView, type PanoramaView } from './panorama-view-state'
import { parseImageCompareSettings, resolveImageCompareView } from './viewer-settings'
import { imageTransformKindForNode, imageTransformRecipeForNode } from './recipe'
import type { WorkflowNodeData } from '../model'
import type { UpstreamMediaReference } from '../components/upstream-references'

function elements(root: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(root)) return root.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(root)) return []
  return [root, ...elements(root.props.children)]
}
function component(environment: Record<string, unknown>) {
  const file = ts.createSourceFile('ImageToolControls.tsx', readFileSync(new URL('./ImageToolControls.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const declaration = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'ImageToolControls')!
  const code = ts.transpileModule(`return (${declaration.getText(file).replace(/^export /, '')})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS } }).outputText
  return new Function(...Object.keys(environment), code)(...Object.values(environment)) as (props: Record<string, unknown>) => unknown
}
function fixture(saved: PanoramaView = { yaw: 45, pitch: 10, fov: 75 }) {
  const slots: unknown[] = [], effects = new Map<number, unknown[]>()
  let cursor = 0, pending: Array<() => void> = []
  function useRef(initial: unknown) { const slot = cursor++; slots[slot] ??= { current: initial }; return slots[slot] }
  function useState(initial: unknown) { const slot = cursor++; if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial; return [slots[slot], (next: unknown) => { slots[slot] = typeof next === 'function' ? next(slots[slot]) : next }] }
  function useEffect(effect: () => void, deps: unknown[]) { const slot = cursor++, prior = effects.get(slot); if (!prior || deps.some((value, index) => !Object.is(value, prior[index]))) { effects.set(slot, deps); pending.push(effect) } }
  const props: { kind: string; data: WorkflowNodeData; references: UpstreamMediaReference[]; disabled: boolean; onChange: (settings: Record<string, unknown>) => void } = { kind: 'image-panorama', data: { prompt: '', model: '', status: 'idle', settings: { imagePanorama: saved } }, references: [], disabled: false, onChange: () => {} }
  const onChange = vi.fn((settings: Record<string, unknown>) => { props.data = { ...props.data, settings: { ...props.data.settings, ...settings } } })
  props.onChange = onChange
  const render = component({ parseTileInput, resolveTileInputSlots, tileEditorInputScope, React: { createElement }, useRef, useState, useEffect, initialPanoramaView, parsePanoramaView, parseImageCompareSettings, resolveImageCompareView, imageTransformKindForNode, imageTransformRecipeForNode, toolNames: { 'image-panorama': '全景预览' }, Expand: 'Expand', PanoramaPreview: 'PanoramaPreview',
    useToolImages: (references: UpstreamMediaReference[]) => references.filter((reference) => reference.asset?.localUrl).map((reference) => ({ asset: reference.asset, dimensions: { width: 960, height: 480 }, dimensionsReady: true, onLoad: () => {} })) })
  function source(assetId?: string) { props.references = [{ edgeId: 'same-edge', kind: 'image', label: '同一上游图层', sourceNodeId: 'same-layer', mention: '@图1', relationLabel: '图像输入', status: assetId ? 'ready' : 'waiting', ...(assetId ? { asset: { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}` } } : {}) }] }
  function view() { cursor = 0; const tree = elements(render(props)); const run = pending; pending = []; run.forEach((effect) => effect()); return tree }
  function preview() { return view().find((element) => element.type === 'PanoramaPreview')! }
  source('a'.repeat(43)); view()
  return { props, source, view, preview, onChange }
}

describe('actual panorama controls preserve saved view settings', () => {
  it('does not rewrite persisted angles when an upstream run replaces its image result', () => {
    const f = fixture()
    expect(f.preview().props.view).toEqual({ yaw: 45, pitch: 10, fov: 75 })
    f.source('b'.repeat(43)); f.view()
    expect(f.preview().props.view).toEqual({ yaw: 45, pitch: 10, fov: 75 })
    expect(f.onChange).not.toHaveBeenCalled()
    expect(f.props.data.settings!.imagePanorama).toEqual({ yaw: 45, pitch: 10, fov: 75 })
  })
  it('clears only transient gestures across waiting and restored input states', () => {
    const f = fixture()
    ;(f.preview().props.onChange as (view: PanoramaView) => void)({ yaw: 135, pitch: -30, fov: 80 })
    expect(f.preview().props.view).toEqual({ yaw: 135, pitch: -30, fov: 80 })
    f.source(); f.view(); expect(f.preview()).toBeUndefined()
    f.source('b'.repeat(43)); f.view()
    expect(f.preview().props.view).toEqual({ yaw: 45, pitch: 10, fov: 75 })
    f.props.disabled = true; f.source('c'.repeat(43)); f.view()
    expect(f.preview().props.view).toEqual({ yaw: 45, pitch: 10, fov: 75 })
    expect(f.onChange).not.toHaveBeenCalled()
  })
  it('persists one explicit reset and restores a separately saved view on remount', () => {
    const f = fixture({ yaw: 270, pitch: -25, fov: 60 })
    ;(f.preview().props.onCommit as (view: PanoramaView) => void)({ ...initialPanoramaView })
    expect(f.onChange).toHaveBeenCalledExactlyOnceWith({ imagePanorama: initialPanoramaView })
    f.source('b'.repeat(43)); f.view()
    expect(f.onChange).toHaveBeenCalledTimes(1)
    const reopened = fixture({ yaw: 270, pitch: -25, fov: 60 })
    expect(reopened.preview().props.view).toEqual({ yaw: 270, pitch: -25, fov: 60 })
    expect(reopened.onChange).not.toHaveBeenCalled()
  })
})
