import { readFileSync } from 'node:fs'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { inspectSelectedNodeRun, nodeSupportsRunActions, type NodeRunModelAvailability, type SelectedRunNode } from '../components/node-run-actions'
import { selectionToolbarActions } from '../components/selection-toolbar-model'

const models: NodeRunModelAvailability = { connected: true, imageModels: ['gpt-image-1'], videoModels: ['sora-2'], textModels: ['text-model'], textModel: 'text-model' }
function node(type: string, patch: Partial<SelectedRunNode> = {}): SelectedRunNode { return { id: 'selected-node', type, data: { status: 'idle', model: '' }, ...patch } }
function appRunCallback(name: 'onRunTo' | 'onRunFrom', environment: Record<string, unknown>): (() => void) | undefined {
  const file = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), source = ts.createSourceFile('App.tsx', file, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let expression = ''
  function visit(current: ts.Node) {
    if (ts.isJsxSelfClosingElement(current) && current.tagName.getText(source) === 'SelectionToolbar') {
      const attribute = current.attributes.properties.find((entry) => ts.isJsxAttribute(entry) && entry.name.getText(source) === name)
      if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer)) expression = attribute.initializer.expression?.getText(source) ?? ''
    }
    ts.forEachChild(current, visit)
  }
  visit(source)
  if (!expression) throw new Error(`Missing ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as (() => void) | undefined
}

describe('unified selection run actions', () => {
  it('retains executable kinds without adding run controls to passive inputs or groups', () => {
    for (const kind of ['text-generate', 'image-generate', 'image-edit', 'video-generate', 'image', 'video', 'frame-extract', 'image-crop', 'image-collage', 'image-grid-split', 'image-tile', 'image-layer', 'image-compare', 'image-panorama', 'drama-parse']) expect(nodeSupportsRunActions(kind)).toBe(true)
    for (const kind of ['text', 'prompt', 'image-input', 'video-input', 'audio-input', 'gallery', 'group', 'unknown', 'note']) expect(inspectSelectedNodeRun(node(kind), models)).toBeNull()
    expect(inspectSelectedNodeRun(undefined, models)).toBeNull()
  })
  it('preserves running, disabled and unavailable-model reasons while using inherited models', () => {
    expect(inspectSelectedNodeRun(node('text-generate'), models)).toEqual({})
    expect(inspectSelectedNodeRun(node('text-generate', { data: { status: 'idle', model: 'missing' } }), models)?.disabledReason).toContain('文字来源与模型')
    for (const status of ['queued', 'running']) expect(inspectSelectedNodeRun(node('text-generate', { data: { status, model: 'text-model' } }), models)?.disabledReason).toContain('正在运行')
    expect(inspectSelectedNodeRun(node('image-collage', { disabled: true }), models)?.disabledReason).toContain('跳过运行')
    expect(inspectSelectedNodeRun(node('image-collage'), { ...models, imageModels: [] })).toEqual({})
    expect(inspectSelectedNodeRun(node('image-generate'), { ...models, imageModel: 'missing' })?.disabledReason).toContain('图像来源与模型')
    expect(inspectSelectedNodeRun(node('video-generate'), { ...models, videoModel: 'missing' })?.disabledReason).toContain('视频来源与模型')
    expect(inspectSelectedNodeRun(node('text-generate'), { ...models, connected: false, textModels: [] })).toEqual({})
  })
  it('only exposes scope actions for exactly one eligible node', () => {
    const state = { count: 1, hasRunActions: true, canGroup: false, canUngroup: false, allLocked: false, canToggleDisabled: true, allDisabled: false, canSaveWorkshop: false }
    expect(selectionToolbarActions(state, 'run').map((entry) => entry.id)).toEqual(['run-to', 'run-from'])
    expect(selectionToolbarActions({ ...state, count: 2 }, 'run')).toEqual([])
    expect(selectionToolbarActions({ ...state, hasRunActions: false }, 'run')).toEqual([])
    expect(selectionToolbarActions({ ...state, runDisabledReason: '正在运行' }, 'run').every((entry) => entry.disabledReason === '正在运行')).toBe(true)
  })
  it('routes real App toolbar callbacks to existing handlers with the selected node ID', () => {
    const rerunNode = vi.fn(), runFromNode = vi.fn(), environment = { projectCanRun: true, runNode: node('text-generate'), runActions: {}, rerunNode, runFromNode }
    appRunCallback('onRunTo', environment)?.(); appRunCallback('onRunFrom', environment)?.()
    expect(rerunNode).toHaveBeenCalledExactlyOnceWith('selected-node'); expect(runFromNode).toHaveBeenCalledExactlyOnceWith('selected-node')
    for (const name of ['onRunTo', 'onRunFrom'] as const) {
      expect(appRunCallback(name, { ...environment, runNode: undefined })).toBeUndefined()
      expect(appRunCallback(name, { ...environment, runActions: null })).toBeUndefined()
    }
  })
  it('exposes no App toolbar execution callbacks when a shared project cannot run', () => {
    const rerunNode = vi.fn(), runFromNode = vi.fn()
    const environment = { projectCanRun: false, runNode: node('text-generate'), runActions: {}, rerunNode, runFromNode }
    for (const name of ['onRunTo', 'onRunFrom'] as const) {
      const callback = appRunCallback(name, environment)
      expect(callback).toBeUndefined()
      callback?.()
    }
    expect(rerunNode).not.toHaveBeenCalled()
    expect(runFromNode).not.toHaveBeenCalled()
  })
})
