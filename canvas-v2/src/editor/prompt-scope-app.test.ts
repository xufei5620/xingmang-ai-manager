import { parseImageCandidateCount } from '../runtime/image-candidate-count'
import { parseVideoCandidateCount } from '../runtime/video-candidate-count'
import { readFileSync } from 'node:fs'
import { parseTextWebSearch } from '../runtime/text-web-search'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { layerEditorScopeToken } from '../image-tools/layer-editor-scope'
import { officialPromptSnapshot, parsePromptReferences, type PromptReference } from '../library/prompt-references'
import { builtinPromptPresetsV1 } from '../library/prompt-presets'

const source = ts.createSourceFile('App.tsx', readFileSync(new URL('../App.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) expression = node.initializer.arguments[0].getText(source)
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source).replace(/^export /, '')
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!expression) throw new Error(`Missing ${name}`)
  const compiled = ts.transpileModule(`(${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  return new Function(...Object.keys(environment), `return ${compiled}`)(...Object.values(environment)) as T
}
function fixture() {
  const owner = { ownerId: 7, accountId: 'account-a' }
  const environment = { draftActionsEnabledRef: { current: true }, projectTransitionRef: { current: false }, layerEditorOwnerRef: { current: owner }, activeProjectIdRef: { current: 'project-a' }, projectEpochRef: { current: 1 }, layerEditorScopeToken,
    applyCanvasPromptDraft: vi.fn(() => ({ nodes: [], edges: [] })), getGraphSnapshot: vi.fn(), execute: vi.fn(), setNodes: vi.fn(), graphRef: { current: {} }, setDirtyNodeIds: vi.fn(), dirtyCanvasNodeIds: () => new Set() }
  const callback = actual<(id: string, prompt: string, discrete: boolean, references: PromptReference[], scope: string) => void>('applyPromptDraft', environment)
  const scope = layerEditorScopeToken({ ...owner, projectId: 'project-a', projectEpoch: 1, enabled: true })
  return { environment, callback, scope }
}

describe('real App prompt callback scope and metadata', () => {
  it('changes only the composer preference and preserves identity for repeated collapse events', () => {
    let preferences = { version: 1, composerCollapsed: false, composerFollowNode: true, libraryCollapsed: true }
    const initial = preferences
    const callback = actual<(collapsed: boolean) => void>('setComposerCollapsed', { setUiPreferences: (update: (current: typeof preferences) => typeof preferences) => { preferences = update(preferences) } })
    callback(false)
    expect(preferences).toBe(initial)
    callback(true)
    expect(preferences).toEqual({ ...initial, composerCollapsed: true })
    const changed = preferences
    callback(true)
    expect(preferences).toBe(changed)
  })
  it('forwards an official snapshot and explicit removal through the existing undo transaction', () => {
    const target = fixture(), snapshot = officialPromptSnapshot(builtinPromptPresetsV1[0].id)!
    const references = [{ ...snapshot, start: 0, end: snapshot.prompt.length }]
    target.callback('node-a', snapshot.prompt, true, references, target.scope)
    expect(target.environment.applyCanvasPromptDraft).toHaveBeenLastCalledWith(expect.any(Object), 'node-a', snapshot.prompt, { discrete: true, promptReferences: references })
    target.callback('node-a', snapshot.prompt, false, [], target.scope)
    expect(target.environment.applyCanvasPromptDraft).toHaveBeenLastCalledWith(expect.any(Object), 'node-a', snapshot.prompt, { discrete: false, promptReferences: [] })
  })
  it.each(['project', 'epoch', 'account', 'disabled', 'transition'])('ignores a late draft after %s changes', (change) => {
    const target = fixture(), env = target.environment
    if (change === 'project') env.activeProjectIdRef.current = 'project-b'
    if (change === 'epoch') env.projectEpochRef.current++
    if (change === 'account') env.layerEditorOwnerRef.current = { ownerId: 8, accountId: 'account-b' }
    if (change === 'disabled') env.draftActionsEnabledRef.current = false
    if (change === 'transition') env.projectTransitionRef.current = true
    target.callback('node-a', '迟到的草稿', false, [], target.scope)
    expect(env.applyCanvasPromptDraft).not.toHaveBeenCalled()
    expect(env.setDirtyNodeIds).not.toHaveBeenCalled()
  })
  it('hydrates validated metadata with the prompt while ignoring forged snapshots', () => {
    const snapshot = officialPromptSnapshot(builtinPromptPresetsV1[0].id)!
    const refs = [{ ...snapshot, start: 0, end: snapshot.prompt.length }]
    const hydrate = actual<(node: unknown) => { data: { prompt: string; promptReferences?: PromptReference[] } }>('editorNodeToCanvasNode', { parseImageCandidateCount, parseVideoCandidateCount, parseTextWebSearch, clipPromptEditorValue: (value: string) => ({ value }), parsePromptReferences, toCanvasNode: (node: unknown) => node, maximumOutputTextLength: 32000 })
    const node = { id: 'node-a', type: 'prompt', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: snapshot.prompt, promptReferences: refs } }
    expect(hydrate(node).data.promptReferences).toEqual(refs)
    expect(hydrate({ ...node, data: { ...node.data, promptReferences: [{ ...refs[0], prompt: '伪造正文' }] } }).data.promptReferences).toBeUndefined()
  })
})
