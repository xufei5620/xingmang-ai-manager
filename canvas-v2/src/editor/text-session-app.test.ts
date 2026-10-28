import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EditorNodeRecord } from '../domain/node-definition'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { createCanvasDocument } from '../store/canvas-state'
import { canvasNodeDocumentRecord, useCanvasDocument, type CanvasDocumentController } from '../store/use-canvas-document'
import { promptPresetSaveFailure } from '../library/prompt-preset-recovery'
import { assertLayerEditorScope, layerEditorScopeToken } from '../image-tools/layer-editor-scope'
import { applyCanvasPromptDraft } from './prompt-draft'
import { assertTextDraft, assertTextSessionNode, textDownloadName, type CanvasTextSession } from './text-session'
import { buildOutputTextNode, inspectNodeTextOutput, textOutputPresetInput, type TextOutputSelection } from './output-text-nodes'
import { canvasCapabilities } from '../host-capabilities'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0].getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error(`Missing actual App callback ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function fixture(kind: 'text-generate' | 'output' = 'text-generate') {
  let controller: CanvasDocumentController | undefined
  function project(record: EditorNodeRecord): CanvasNode { if (record.type !== 'prompt' && record.type !== 'text-generate' && record.type !== 'output') throw new Error('Unexpected test node'); return { ...record, type: record.type, data: { prompt: '', model: '', status: 'idle', ...record.data } } }
  function Capture() { controller = useCanvasDocument(project); return null }
  renderToStaticMarkup(createElement(Capture))
  if (!controller) throw new Error('Missing document')
  const target = controller
  target.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument(), nodes: [
    { id: 'source', type: kind, definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '保留原指令', model: 'local-model', outputText: '# 成品\n\n完整正文 ☕\n', dirty: false } },
    { id: 'child', type: 'text-generate', definitionVersion: 1, position: { x: 800, y: 0 }, data: { prompt: '下游指令', model: 'local-model', outputText: '下游旧结果', dirty: false } },
  ], edges: [{ id: 'edge', source: 'source', sourceHandle: 'out:text', target: 'child', targetHandle: 'in:text' }] } })
  const layerEditorOwnerRef = { current: { ownerId: 7, accountId: 'account-a' } }, activeProjectIdRef = { current: 'project-a' }, projectEpochRef = { current: 1 }, draftActionsEnabledRef = { current: true }, projectTransitionRef = { current: false }
  const mediaPreparationMountedRef = { current: true }
  const activeRunsRef = { current: new Set<string>() }, startingRunsRef = { current: 0 }, pendingRunProjectionIdsRef = { current: new Set<string>() }, textActionPendingRef = { current: new Set<string>() }
  const textActionUncertainRef = { current: new Map() }, catalogSnapshot = { items: [] as { name: string; prompt: string }[], loading: false, loaded: true, error: null as string | null }
  const promptCatalog = { load: vi.fn().mockResolvedValue(undefined), snapshot: () => catalogSnapshot }
  const execute = vi.fn(target.execute), setBanner = vi.fn(), createPromptPreset = vi.fn().mockResolvedValue({ id: 'preset' }), downloadCanvasText = vi.fn(), writeText = vi.fn().mockResolvedValue(undefined)
  const frames: (() => void)[] = [], reactFlow = { fitView: vi.fn().mockResolvedValue(true) }
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  vi.stubGlobal('window', { requestAnimationFrame: (run: () => void) => { frames.push(run); return frames.length } })
  const applyPromptDraft = vi.fn((nodeId: string, text: string, discrete: boolean) => applyCanvasPromptDraft({ ...target, execute }, nodeId, text, { discrete, promptReferences: [] }))
  let sequence = 0
  const environment = { projectCanEditRef: { current: true }, mediaPreparationMountedRef, layerEditorOwnerRef, activeProjectIdRef, projectEpochRef, draftActionsEnabledRef, projectTransitionRef, activeRunsRef, startingRunsRef, pendingRunProjectionIdsRef, textActionPendingRef,
    textActionUncertainRef, promptCatalog, catalogSnapshot, promptPresetSaveFailure, getGraphSnapshot: target.getGraphSnapshot, setNodes: target.setNodes, execute, graphRef: { current: target.getGraphSnapshot() }, setBanner, createPromptPreset, downloadCanvasText, applyPromptDraft, reactFlow,
    assertLayerEditorScope, layerEditorScopeToken, assertTextSessionNode, assertTextDraft, inspectNodeTextOutput, buildOutputTextNode, textOutputPresetInput, canvasNodeDocumentRecord, nextNodeId: () => `text-${++sequence}`,
    // The preset name limit comes from the host; the stubbed window has no host, so this is the v2-equivalent set.
    canvasCapabilities,
  }
  const capture = actual<(nodeId: string, selection: TextOutputSelection) => CanvasTextSession>('captureTextSession', environment)
  const perform = actual<(session: CanvasTextSession, action: 'copy' | 'download' | 'place' | 'preset' | 'save', text: string, signal: AbortSignal) => Promise<void>>('performTextAction', environment)
  function run(action: Parameters<typeof perform>[1], selection: TextOutputSelection = 'result', text?: string) { const session = capture('source', selection); return perform(session, action, text ?? session.value, new AbortController().signal) }
  return { ...environment, target, capture, perform, run, writeText, frames, current: target.getGraphSnapshot }
}
afterEach(() => vi.unstubAllGlobals())

describe('actual App text actions', () => {
  it('rejects a blocked collaboration save without dropping the full editor draft or reporting success', async () => {
    const f = fixture(), before = structuredClone(f.current())
    f.projectCanEditRef.current = false
    await expect(f.run('save', 'input', 'Unsaved editor draft')).rejects.toThrow('文字仍保留在编辑窗口')
    expect(f.applyPromptDraft).not.toHaveBeenCalled()
    expect(f.setBanner).not.toHaveBeenCalledWith('文字已保存，可一步撤销')
    expect(f.current()).toEqual(before)
    await f.run('download')
  })
  it('opens output-node text read-only and copies, downloads and saves the exact result without replacing its input', async () => {
    const f = fixture('output'), before = structuredClone(f.current()), text = before.nodes[0].data.outputText
    const session = f.capture('source', 'result')
    expect(session).toMatchObject({ kind: 'output', selection: 'result', title: '输出 · 文字结果', value: text })
    expect(() => f.capture('source', 'input')).toThrow('输出节点的文字结果')
    await f.run('copy'); await f.run('download'); await f.run('preset')
    expect(f.writeText).toHaveBeenCalledWith(text); expect(f.downloadCanvasText).toHaveBeenCalledWith(text, '输出 · 文字结果')
    expect(f.createPromptPreset).toHaveBeenCalledWith(expect.objectContaining({ prompt: text }))
    expect(f.current()).toEqual(before); expect(f.execute).not.toHaveBeenCalled()
  })
  it('places output-node text with one undo and blocks result replacement or active-run mutations', async () => {
    const f = fixture('output'), before = structuredClone(f.current())
    await f.run('place')
    expect(f.current().nodes[2]).toMatchObject({ type: 'prompt', data: { prompt: before.nodes[0].data.outputText } })
    expect(f.current().nodes[0].data).toEqual(before.nodes[0].data)
    f.target.undo(); expect(f.current().nodes).toHaveLength(2)
    f.target.redo(); expect(f.current().nodes).toHaveLength(3)
    await expect(f.run('save')).rejects.toThrow('另存为文本')
    f.activeRunsRef.current.add('run')
    await expect(f.run('place')).rejects.toThrow('等待当前运行')
    await f.run('download')
  })
  it('copies and downloads exact Unicode and whitespace without altering the graph or submitting a model', async () => {
    const f = fixture(), before = structuredClone(f.current()), text = before.nodes[0].data.outputText
    await f.run('copy'); await f.run('download')
    expect(f.writeText).toHaveBeenCalledWith(text); expect(f.downloadCanvasText).toHaveBeenCalledWith(text, '文字生成 · 生成结果')
    expect(f.execute).not.toHaveBeenCalled(); expect(f.createPromptPreset).not.toHaveBeenCalled(); expect(f.current()).toEqual(before)
  })
  it('places complete output in an independent editable node with one undo and no artificial edges', async () => {
    const f = fixture(), before = structuredClone(f.current())
    await f.run('place')
    expect(f.current().nodes).toHaveLength(3); expect(f.current().edges).toEqual(before.edges)
    expect(f.current().nodes[2]).toMatchObject({ type: 'prompt', data: { prompt: before.nodes[0].data.outputText, model: '' }, selected: true })
    expect(f.current().nodes[0].data).toEqual(before.nodes[0].data)
    expect(f.execute).toHaveBeenCalledOnce()
    f.target.undo(); expect(f.current().nodes).toHaveLength(2)
    f.target.redo(); expect(f.current().nodes[2].data.prompt).toBe(before.nodes[0].data.outputText)
  })
  it('focuses only the newly placed text node after the next frame without adding history', async () => {
    const f = fixture()
    await f.run('place')
    const added = f.current().nodes[2]
    expect(f.reactFlow.fitView).not.toHaveBeenCalled(); expect(f.frames).toHaveLength(1)
    f.frames.shift()!()
    expect(f.reactFlow.fitView).toHaveBeenCalledExactlyOnceWith({ nodes: [{ id: added.id }], padding: 0.3, duration: 180, maxZoom: 1 })
    expect(f.execute).toHaveBeenCalledOnce()
    f.target.undo(); expect(f.current().nodes).toHaveLength(2)
  })
  it.each(['owner', 'account', 'project', 'epoch', 'disabled', 'unmounted', 'transition', 'undo', 'deleted'] as const)('ignores a delayed text placement focus after %s', async (change) => {
    const f = fixture()
    await f.run('place')
    const addedId = f.current().nodes[2].id
    if (change === 'owner') f.layerEditorOwnerRef.current.ownerId = 8
    if (change === 'account') f.layerEditorOwnerRef.current.accountId = 'account-b'
    if (change === 'project') f.activeProjectIdRef.current = 'project-b'
    if (change === 'epoch') f.projectEpochRef.current++
    if (change === 'disabled') f.draftActionsEnabledRef.current = false
    if (change === 'unmounted') f.mediaPreparationMountedRef.current = false
    if (change === 'transition') f.projectTransitionRef.current = true
    if (change === 'undo') f.target.undo()
    if (change === 'deleted') f.target.setNodes((nodes) => nodes.filter((node) => node.id !== addedId))
    f.frames.shift()!()
    expect(f.reactFlow.fitView).not.toHaveBeenCalled()
  })
  it('saves an input edit as one history command and preserves generated results', async () => {
    const f = fixture(), before = structuredClone(f.current())
    await f.run('save', 'input', '## 新指令\n\n正文')
    expect(f.current().nodes[0].data).toMatchObject({ prompt: '## 新指令\n\n正文', outputText: before.nodes[0].data.outputText, dirty: true })
    expect(f.current().nodes[1].data).toMatchObject({ dirty: true, outputText: '下游旧结果' })
    expect(f.execute).toHaveBeenCalledOnce()
    f.target.undo(); expect(f.current().nodes[0].data.prompt).toBe('保留原指令'); expect(f.current().nodes[1].data.dirty).toBe(false)
  })
  it('does not add history when saving an unchanged input', async () => { const f = fixture(); await f.run('save', 'input'); expect(f.execute).not.toHaveBeenCalled() })
  it('can save a filled draft from a formerly empty input without mutating the canvas', async () => {
    const f = fixture(); f.target.setNodes((nodes) => nodes.map((node) => node.id === 'source' ? { ...node, data: { ...node.data, prompt: '' } } : node))
    await f.run('preset', 'input', '  完整草稿\n')
    expect(f.createPromptPreset).toHaveBeenCalledWith(expect.objectContaining({ prompt: '  完整草稿\n' })); expect(f.current().nodes[0].data.prompt).toBe('')
  })
  it('saves output rather than the generation instruction to the workshop', async () => {
    const f = fixture(); await f.run('preset')
    expect(f.createPromptPreset).toHaveBeenCalledWith(expect.objectContaining({ prompt: '# 成品\n\n完整正文 ☕\n' })); expect(f.execute).not.toHaveBeenCalled()
  })
  it('rejects over-limit presets without silently truncating while retaining download and placement', async () => {
    const f = fixture(), text = '字'.repeat(32_000)
    f.target.setNodes((nodes) => nodes.map((node) => node.id === 'source' ? { ...node, data: { ...node.data, outputText: text } } : node))
    await expect(f.run('preset')).rejects.toThrow('24,000'); expect(f.createPromptPreset).not.toHaveBeenCalled()
    await f.run('download'); await f.run('place'); expect(f.current().nodes[2].data.prompt).toBe(text)
  })
  it.each(['save', 'place', 'preset'] as const)('blocks %s during an active run and still permits copying the previous output', async (action) => {
    const f = fixture(); f.activeRunsRef.current.add('run')
    await expect(f.run(action, action === 'save' ? 'input' : 'result')).rejects.toThrow('等待当前运行')
    await f.run('copy'); expect(f.writeText).toHaveBeenCalledOnce(); expect(f.execute).not.toHaveBeenCalled(); expect(f.createPromptPreset).not.toHaveBeenCalled()
  })
  it.each(['account', 'project', 'epoch', 'disabled', 'unmounted', 'transition'] as const)('rejects stale %s sessions before side effects', async (change) => {
    const f = fixture(), session = f.capture('source', 'result')
    if (change === 'account') f.layerEditorOwnerRef.current.accountId = 'account-b'
    if (change === 'project') f.activeProjectIdRef.current = 'project-b'
    if (change === 'epoch') f.projectEpochRef.current++
    if (change === 'unmounted') f.mediaPreparationMountedRef.current = false
    if (change === 'disabled') f.draftActionsEnabledRef.current = false
    if (change === 'transition') f.projectTransitionRef.current = true
    await expect(f.perform(session, 'download', session.value, new AbortController().signal)).rejects.toThrow()
    expect(f.downloadCanvasText).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
  })
  it.each(['changed', 'deleted'] as const)('exports the displayed snapshot when its original node is %s but rejects mutations', async (change) => {
    const f = fixture(), session = f.capture('source', 'result')
    f.target.setNodes((nodes) => change === 'deleted' ? nodes.filter((node) => node.id !== 'source') : nodes.map((node) => ({ ...node, data: { ...node.data, outputText: 'new result' } })))
    await f.perform(session, 'copy', session.value, new AbortController().signal)
    await f.perform(session, 'download', session.value, new AbortController().signal)
    expect(f.writeText).toHaveBeenCalledWith(session.value); expect(f.downloadCanvasText).toHaveBeenCalledWith(session.value, session.title)
    for (const action of ['place', 'preset'] as const) await expect(f.perform(session, action, session.value, new AbortController().signal)).rejects.toThrow()
    expect(f.createPromptPreset).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
  })
  it('retains confirmed preset success when a new output arrives during its request', async () => {
    const f = fixture(); let resolve!: () => void
    f.createPromptPreset.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done }))
    const pending = f.run('preset')
    f.target.setNodes((nodes) => nodes.map((node) => ({ ...node, data: { ...node.data, outputText: 'new result' } })))
    resolve(); await expect(pending).resolves.toBeUndefined(); expect(f.setBanner).toHaveBeenCalledWith(expect.stringContaining('已将正文保存'))
  })
  it('does not show a confirmed write in a different project', async () => {
    const f = fixture(); let resolve!: () => void
    f.createPromptPreset.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done }))
    const pending = f.run('preset'); f.activeProjectIdRef.current = 'other'; resolve()
    await expect(pending).resolves.toBeUndefined(); expect(f.setBanner).not.toHaveBeenCalled()
  })
  it('reconciles uncertain writes without silently resubmitting them', async () => {
    const f = fixture(); f.createPromptPreset.mockRejectedValueOnce(new Error('network receipt lost'))
    await expect(f.run('preset')).rejects.toThrow('待核对')
    await expect(f.run('preset')).rejects.toThrow('不会自动重复提交')
    expect(f.createPromptPreset).toHaveBeenCalledOnce(); expect(f.promptCatalog.load).toHaveBeenCalledWith(true)
    f.catalogSnapshot.items.push({ name: '文字生成 · 生成结果', prompt: '# 成品\n\n完整正文 ☕\n' })
    await f.run('preset'); expect(f.createPromptPreset).toHaveBeenCalledOnce(); expect(f.textActionUncertainRef.current.size).toBe(0)
    expect(f.setBanner).toHaveBeenCalledWith(expect.stringContaining('没有重复创建'))
  })
  it('rejects forged edited result content and aborted operations', async () => {
    const f = fixture(), session = f.capture('source', 'result'), controller = new AbortController()
    await expect(f.perform(session, 'preset', 'different', controller.signal)).rejects.toThrow('不可直接覆盖')
    controller.abort(); await expect(f.perform(session, 'place', session.value, controller.signal)).rejects.toThrow()
    expect(f.execute).not.toHaveBeenCalled(); expect(f.createPromptPreset).not.toHaveBeenCalled()
  })
  it('guards double clicks while a preset request is pending', async () => {
    const f = fixture(); let resolve!: () => void
    f.createPromptPreset.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done }))
    const first = f.run('preset'); await expect(f.run('preset')).rejects.toThrow('勿重复提交')
    resolve(); await first; expect(f.createPromptPreset).toHaveBeenCalledOnce()
  })
  it('does not report a changed draft as saved when reconciling an earlier unknown write', async () => {
    const f = fixture(); f.createPromptPreset.mockRejectedValueOnce(new Error('receipt lost'))
    await expect(f.run('preset', 'input', '草稿 A')).rejects.toThrow('待核对')
    f.catalogSnapshot.items.push({ name: '文字生成 · 正文', prompt: '草稿 A' })
    await expect(f.run('preset', 'input', '草稿 B')).rejects.toThrow('当前修改尚未保存')
    expect(f.createPromptPreset).toHaveBeenCalledOnce(); expect(f.setBanner).not.toHaveBeenCalled(); expect(f.textActionUncertainRef.current.size).toBe(0)
    await f.run('preset', 'input', '草稿 B'); expect(f.createPromptPreset).toHaveBeenCalledTimes(2)
    expect(f.createPromptPreset).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: '草稿 B' }))
  })
  it('reports clipboard failure without claiming success', async () => {
    const f = fixture(); f.writeText.mockRejectedValueOnce(new Error('clipboard unavailable'))
    await expect(f.run('copy')).rejects.toThrow('clipboard unavailable'); expect(f.setBanner).not.toHaveBeenCalled()
  })
})

describe('text draft boundaries', () => {
  it('retains a maximum-length draft and rejects NUL or oversize content', () => {
    expect(() => assertTextDraft('x'.repeat(100_000))).not.toThrow()
    expect(() => assertTextDraft('x'.repeat(100_001))).toThrow('截断')
    expect(() => assertTextDraft('x\0y')).toThrow('空字符')
  })
  it('uses a local filename rather than a path', () => { expect(textDownloadName('../a\\b:c?')).toBe('.. a b c.txt'); expect(textDownloadName('...')).toBe('星芒文字.txt') })
})
