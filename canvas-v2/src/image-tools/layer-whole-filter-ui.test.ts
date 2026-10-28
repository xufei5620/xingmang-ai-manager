import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginLayerEditorTransaction, createLayerEditorState, editorLayerEffectiveState, finishLayerEditorTransaction, patchEditorLayer, redoLayerEditor, undoLayerEditor, type LayerEditorState } from './layer-editor-state'
import { appendEditorLayerOperation } from './layer-paint-state'
import { defaultImageTransformRecipe, type ImageLayerRecipe } from './recipe'
import { defaultWholeLayerFilter, isNeutralWholeLayerFilter, layerWholeFilterSpace, parseImageLayerWholeFilterOperation, wholeLayerFilterDefinitions } from './layer-whole-filter'
import { buildLayerFilterOperation } from './layer-filter-editor-state'
import { LayerFilterEditor } from './LayerFilterEditor'
import { LayerRecipePreview } from './layerpreview'

vi.mock('react-dom', async (original) => ({ ...await original<typeof import('react-dom')>(), createPortal: (children: unknown) => children }))
function actual<T>(file: string, name: string, environment: Record<string, unknown>): T {
  environment = { closeLayerMerge: vi.fn(), ...environment }
  const source = ts.createSourceFile(file, readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let declaration = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node.getText(source); ts.forEachChild(node, visit) }
  visit(source); if (!declaration) throw new Error(`Missing ${file} function ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${declaration})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function fixture() {
  const recipe = defaultImageTransformRecipe('layer') as ImageLayerRecipe, stateRef = { current: createLayerEditorState(recipe, 1) }
  const wholeFilterSessionRef = { current: null as { id: string; index: number; layer: unknown; recipe: ImageLayerRecipe; sourcesKey: string } | null }, sourcesKeyRef = { current: 'source-a' }, importAlive = { current: true }
  const change = vi.fn((action: (value: LayerEditorState) => LayerEditorState) => { stateRef.current = action(stateRef.current) })
  const environment: Record<string, unknown> = { editorLayerEffectiveState, stateRef, wholeFilterSessionRef, sourcesKeyRef, importAlive, change, appendEditorLayerOperation, finishLayerEditorTransaction, layerWholeFilterSpace, parseImageLayerWholeFilterOperation, isNeutralWholeLayerFilter, setState: (action: (current: LayerEditorState) => LayerEditorState) => { stateRef.current = action(stateRef.current) }, cancelSampling: vi.fn(), cancelExport: vi.fn(), cancelGesture: vi.fn(), cancelVectorTools: vi.fn(), setToolMenu: vi.fn(), setError: vi.fn(), setStatus: vi.fn(), setWholeFilterSession: vi.fn() }
  environment.closeWholeFilter = actual('LayerEditor.tsx', 'closeWholeFilter', environment)
  function open() { actual<() => void>('LayerEditor.tsx', 'openWholeFilter', environment)(); return wholeFilterSessionRef.current! }
  function apply(session = wholeFilterSessionRef.current, value: unknown = buildLayerFilterOperation(stateRef.current.present.recipe, 0, defaultWholeLayerFilter('gaussian'))) { actual<(session: unknown, value: unknown) => void>('LayerEditor.tsx', 'applyWholeFilter', environment)(session, value) }
  return { stateRef, wholeFilterSessionRef, sourcesKeyRef, importAlive, change, environment, open, apply, close: environment.closeWholeFilter as (session?: unknown) => void }
}
afterEach(() => vi.unstubAllGlobals())
describe('actual whole layer filter handoff', () => {
  it('cancels without history and applies a complete filter as one undoable edit', () => {
    const f = fixture(), before = f.stateRef.current
    f.open(); f.close(); expect(f.stateRef.current).toBe(before); expect(f.change).not.toHaveBeenCalled()
    const session = f.open(); f.apply(session); const after = f.stateRef.current
    expect(after.past).toHaveLength(1); expect(after.present.recipe.layers[0].edits?.operations[0].mode).toBe('whole-filter')
    expect(() => f.apply(session)).toThrow('图层或素材已变化'); expect(f.stateRef.current).toBe(after)
    expect(undoLayerEditor(after).present.recipe).toEqual(before.present.recipe); expect(redoLayerEditor(undoLayerEditor(after)).present.recipe).toEqual(after.present.recipe)
  })
  it.each(['source', 'layer', 'locked', 'hidden', 'selection', 'output', 'closed', 'unmounted'] as const)('rejects a retained callback after %s changes', (condition) => {
    const f = fixture(), session = f.open(), operation = buildLayerFilterOperation(f.stateRef.current.present.recipe, 0, defaultWholeLayerFilter('mosaic')), present = f.stateRef.current.present
    if (condition === 'source') f.sourcesKeyRef.current = 'source-b'
    if (condition === 'layer') f.stateRef.current = { ...f.stateRef.current, present: { ...present, recipe: { ...present.recipe, layers: [] } } }
    if (condition === 'locked' || condition === 'hidden') f.stateRef.current = { ...f.stateRef.current, present: { ...present, recipe: { ...present.recipe, layers: [{ ...present.recipe.layers[0], ...(condition === 'locked' ? { locked: true } : { visible: false }) }] } } }
    if (condition === 'selection') f.stateRef.current = { ...f.stateRef.current, present: { ...present, selectedId: null } }
    if (condition === 'output') f.stateRef.current = { ...f.stateRef.current, present: { ...present, recipe: { ...present.recipe, outputWidth: 900 } } }
    if (condition === 'closed') f.close()
    if (condition === 'unmounted') f.importAlive.current = false
    const before = f.stateRef.current; expect(() => f.apply(session, operation)).toThrow(); expect(f.stateRef.current).toBe(before); expect(f.change).not.toHaveBeenCalled()
  })
  it('keeps no-op filters out of history and rejects changed pixel domains', () => {
    const f = fixture(), before = f.stateRef.current, neutral = defaultWholeLayerFilter('gaussian'); neutral.parameters.radius = 0
    f.apply(f.open(), buildLayerFilterOperation(before.present.recipe, 0, neutral)); expect(f.stateRef.current).toBe(before); expect(f.change).not.toHaveBeenCalled()
    const session = f.open(), operation = buildLayerFilterOperation(before.present.recipe, 0, defaultWholeLayerFilter('mosaic'))
    expect(() => f.apply(session, { ...operation, space: { width: 1, height: 1 } })).toThrow('像素范围'); expect(f.wholeFilterSessionRef.current).toBe(session)
  })
  it('settles prior gestures, preserves parent selection and ignores stale close handlers', () => {
    const f = fixture(), id = f.stateRef.current.present.ids[0]
    f.stateRef.current = patchEditorLayer(beginLayerEditorTransaction(f.stateRef.current), id, { opacity: .6 })
    const selection = { kind: 'rectangle' as const, x: 20, y: 30, width: 100, height: 120, inverted: false }
    f.stateRef.current = { ...f.stateRef.current, present: { ...f.stateRef.current.present, canvasSelection: selection } }
    const old = f.open(); f.close(old); const current = f.open(); f.close(old); expect(f.wholeFilterSessionRef.current).toBe(current); expect(f.stateRef.current.transaction).toBeNull()
    f.apply(); expect(f.stateRef.current.past).toHaveLength(2); expect(f.stateRef.current.present.canvasSelection).toEqual(selection); expect(undoLayerEditor(f.stateRef.current).present.recipe.layers[0].opacity).toBe(.6)
  })
  it('exposes all shared filter choices and renders saved filters through the original-domain world preview', () => {
    const f = fixture(); f.apply(f.open()); const recipe = f.stateRef.current.present.recipe
    recipe.layers[0] = { ...recipe.layers[0], content: { kind: 'shape', shape: 'rectangle', fill: '#ff0000', stroke: 'transparent', strokeWidth: 0 }, rotation: 45 }
    const preview = renderToStaticMarkup(createElement(LayerRecipePreview, { recipe, images: [] }))
    expect(preview).toContain('输出坐标描边与绘画预览'); expect(preview).toContain('<foreignObject x="0" y="0"')
    vi.stubGlobal('document', { body: {} })
    const html = renderToStaticMarkup(createElement(LayerFilterEditor, { recipe, layerIndex: 0, images: [], hasSelection: true, onApply: vi.fn(), onClose: vi.fn() }))
    expect((html.match(/<option/g) ?? [])).toHaveLength(17); for (const definition of wholeLayerFilterDefinitions) expect(html).toContain(definition.label)
    expect(html).toContain('图像调整与颜色效果在滤镜之后叠加'); expect(html).toContain('本次整层滤镜不受该选框限制'); expect(html).toContain('aria-label="半径滑杆"'); expect(html).toContain('aria-label="半径"'); expect(html).toContain('disabled=""')
  })
})

function dialogFixture() {
  const recipe = fixture().stateRef.current.present.recipe, filter = defaultWholeLayerFilter('gaussian'), operation = buildLayerFilterOperation(recipe, 0, filter)
  const draftRef = { current: { filter, operation, error: '' } }, shownRef = { current: operation }, readyOperation = { current: null as typeof operation | null }, beforeRef = { current: false }, inputPendingRef = { current: false }, pendingParameters = { current: new Set<string>() }, completed = { current: false }, alive = { current: true }
  const scope = 'source-a', initial = { current: { recipe, scope } }, current = { current: { recipe, scope } }, latestPreview = { current: { recipe, operation, revision: 0, before: false } }
  const env: Record<string, unknown> = { draftRef, shownRef, readyOperation, beforeRef, inputPendingRef, pendingParameters, completed, alive, initial, current, latestPreview, recipe, layerIndex: 0, defaultWholeLayerFilter, isNeutralWholeLayerFilter, buildLayerFilterOperation, setError: vi.fn(), setPreviewError: vi.fn(), setBusy: vi.fn(), setInputPending: vi.fn(), setParameterRevision: vi.fn(), setDraft: vi.fn(), setBefore: vi.fn(), onApply: vi.fn(), onClose: vi.fn(), setRevision: vi.fn() }
  env.prepareDraft = actual('LayerFilterEditor.tsx', 'prepareDraft', env); env.active = actual('LayerFilterEditor.tsx', 'active', env); env.change = actual('LayerFilterEditor.tsx', 'change', env); env.setParameterPending = actual('LayerFilterEditor.tsx', 'setParameterPending', env)
  return { env, recipe, operation, draftRef, shownRef, readyOperation, beforeRef, inputPendingRef, pendingParameters, completed, alive, initial, current, latestPreview, change: env.change as (nextFilter: typeof filter) => void, pending: env.setParameterPending as (key: string, value: boolean) => void, select: actual<(type: typeof filter.type) => void>('LayerFilterEditor.tsx', 'select', env), apply: actual<() => void>('LayerFilterEditor.tsx', 'apply', env), status: actual<(status: { busy: boolean; error: string }, token: typeof latestPreview.current) => void>('LayerFilterEditor.tsx', 'receiveStatus', env), compare: actual<(before: boolean) => void>('LayerFilterEditor.tsx', 'compare', env), close: actual<() => void>('LayerFilterEditor.tsx', 'close', env) }
}
describe('actual filter workbench preview and submit callbacks', () => {
  it('requires the current complete preview, keeps errors editable and submits only once', () => {
    const f = dialogFixture(); f.apply(); expect(f.env.onApply).not.toHaveBeenCalled(); expect(f.env.setError).toHaveBeenCalledWith(expect.stringContaining('预览成功'))
    f.status({ busy: false, error: '计算超时' }, f.latestPreview.current); f.apply(); expect(f.env.onApply).not.toHaveBeenCalled()
    f.status({ busy: true, error: '' }, f.latestPreview.current); expect(f.readyOperation.current).toBeNull()
    f.status({ busy: false, error: '' }, f.latestPreview.current); f.apply(); f.apply(); expect(f.env.onApply).toHaveBeenCalledExactlyOnceWith(f.operation); expect(f.env.onClose).toHaveBeenCalledOnce()
  })
  it('keeps a completed preview usable when its already-active comparison button is clicked again', () => {
    const f = dialogFixture(); f.status({ busy: false, error: '' }, f.latestPreview.current); f.compare(false); expect(f.readyOperation.current).toBe(f.operation); f.apply(); expect(f.env.onApply).toHaveBeenCalledOnce()
  })
  it('invalidates readiness synchronously when a parameter changes, before React commits the new preview', () => {
    const f = dialogFixture(), oldToken = f.latestPreview.current
    f.status({ busy: false, error: '' }, oldToken); f.change({ ...f.draftRef.current.filter, parameters: { radius: 9 } }); f.apply()
    expect(f.readyOperation.current).toBeNull(); expect(f.env.onApply).not.toHaveBeenCalled()
    f.status({ busy: false, error: '' }, oldToken); expect(f.readyOperation.current).toBeNull()
    f.shownRef.current = f.draftRef.current.operation; f.latestPreview.current = { ...oldToken, operation: f.draftRef.current.operation, revision: 1 }; f.status({ busy: false, error: '' }, f.latestPreview.current); f.apply(); expect(f.env.onApply).toHaveBeenCalledExactlyOnceWith(f.draftRef.current.operation)
  })
  it('rejects an old receipt immediately after retry, before the render advances its token', () => {
    const f = dialogFixture(), old = f.latestPreview.current; actual<() => void>('LayerFilterEditor.tsx', 'retry', f.env)(); f.status({ busy: false, error: '' }, old); expect(f.readyOperation.current).toBeNull(); expect(f.env.setRevision).toHaveBeenCalledOnce()
  })
  it('rejects late retry and comparison frames even when they share the same operation identity', () => {
    const f = dialogFixture(), oldToken = f.latestPreview.current
    f.latestPreview.current = { ...oldToken, revision: 1 }; f.status({ busy: false, error: '' }, oldToken); expect(f.readyOperation.current).toBeNull()
    f.compare(true); f.status({ busy: false, error: '' }, f.latestPreview.current); f.apply(); expect(f.env.onApply).not.toHaveBeenCalled()
    f.compare(false); f.latestPreview.current = { ...oldToken, revision: 2 }; f.status({ busy: false, error: '' }, oldToken); expect(f.readyOperation.current).toBeNull(); f.status({ busy: false, error: '' }, f.latestPreview.current); f.apply(); expect(f.env.onApply).toHaveBeenCalledOnce()
  })
  it.each(['scope', 'recipe', 'unmount', 'close'] as const)('ignores preview success and application after %s invalidation', (reason) => {
    const f = dialogFixture()
    if (reason === 'scope') f.current.current = { ...f.current.current, scope: 'other' }
    if (reason === 'recipe') f.current.current = { ...f.current.current, recipe: { ...f.recipe, outputWidth: 12 } }
    if (reason === 'unmount') f.alive.current = false
    if (reason === 'close') f.close()
    f.status({ busy: false, error: '' }, f.latestPreview.current); f.apply(); expect(f.readyOperation.current).toBeNull(); expect(f.env.onApply).not.toHaveBeenCalled()
  })
  it('blocks unfinished numeric input and allows neutral completion without a parent mutation', () => {
    const f = dialogFixture(); f.status({ busy: false, error: '' }, f.latestPreview.current); f.pending('radius', true); f.apply(); expect(f.env.onApply).not.toHaveBeenCalled(); expect(f.env.setError).toHaveBeenCalledWith(expect.stringContaining('参数输入'))
    f.pending('radius', false); f.change({ ...f.draftRef.current.filter, parameters: { radius: 0 } }); f.apply(); expect(f.env.onApply).not.toHaveBeenCalled(); expect(f.env.onClose).toHaveBeenCalledOnce()
  })
  it.each(['escape', 'correction'] as const)('keeps another field invalid through a slider update until explicit %s', (resolution) => {
    const f = dialogFixture(); f.select('usm')
    const parameter = wholeLayerFilterDefinitions.find((entry) => entry.type === 'usm')!.parameters.find((entry) => entry.key === 'amount')!
    const amount = { parameter, value: 100, text: '', setText: vi.fn(), setError: vi.fn(), onPending: (pending: boolean) => f.pending('amount', pending), onChange: (value: number) => actual<(key: string, value: number) => void>('LayerFilterEditor.tsx', 'patch', f.env)('amount', value) }
    actual<(text: string) => void>('LayerFilterEditor.tsx', 'editText', amount)('')
    actual<() => void>('LayerFilterEditor.tsx', 'commitText', { ...amount, commit: vi.fn() })()
    expect(amount.setError).toHaveBeenCalledWith('请输入有效数值'); expect(f.pendingParameters.current).toEqual(new Set(['amount']))
    const radius = wholeLayerFilterDefinitions.find((entry) => entry.type === 'usm')!.parameters.find((entry) => entry.key === 'radius')!
    actual<(value: number) => void>('LayerFilterEditor.tsx', 'commit', { parameter: radius, setText: vi.fn(), setError: vi.fn(), onPending: (pending: boolean) => f.pending('radius', pending), onChange: (value: number) => actual<(key: string, value: number) => void>('LayerFilterEditor.tsx', 'patch', f.env)('radius', value) })(3)
    f.shownRef.current = f.draftRef.current.operation; f.latestPreview.current = { ...f.latestPreview.current, operation: f.draftRef.current.operation }; f.status({ busy: false, error: '' }, f.latestPreview.current); f.apply()
    expect(f.env.onApply).not.toHaveBeenCalled(); expect(f.env.setError).toHaveBeenLastCalledWith('请先完成或修正参数输入'); expect(f.inputPendingRef.current).toBe(true); expect(f.draftRef.current.filter.parameters).toMatchObject({ amount: 100, radius: 3 })
    if (resolution === 'escape') actual<() => void>('LayerFilterEditor.tsx', 'discardText', amount)()
    else actual<(value: number) => void>('LayerFilterEditor.tsx', 'commit', amount)(140)
    expect(f.inputPendingRef.current).toBe(false); expect(f.pendingParameters.current.size).toBe(0)
    f.shownRef.current = f.draftRef.current.operation; f.latestPreview.current = { ...f.latestPreview.current, operation: f.draftRef.current.operation }; f.status({ busy: false, error: '' }, f.latestPreview.current); f.apply()
    expect(f.env.onApply).toHaveBeenCalledExactlyOnceWith(f.draftRef.current.operation); expect(f.draftRef.current.filter.parameters).toMatchObject({ amount: resolution === 'escape' ? 100 : 140, radius: 3 })
  })
  it('resets all field drafts only for an explicit reset or a different filter', () => {
    const f = dialogFixture(); f.select('usm'); f.pending('amount', true); f.pending('radius', true)
    f.select('usm'); expect(f.pendingParameters.current.size).toBe(0); expect(f.inputPendingRef.current).toBe(false); expect(f.draftRef.current.filter).toEqual(defaultWholeLayerFilter('usm'))
    f.pending('amount', true); f.select('gaussian'); expect(f.pendingParameters.current.size).toBe(0); expect(f.inputPendingRef.current).toBe(false); expect(f.draftRef.current.filter).toEqual(defaultWholeLayerFilter('gaussian'))
    expect(f.env.setParameterRevision).toHaveBeenCalledTimes(3)
  })
  it('retains draft and permits another explicit attempt when the parent rejects a late apply', () => {
    const f = dialogFixture(); f.status({ busy: false, error: '' }, f.latestPreview.current); vi.mocked(f.env.onApply as () => void).mockImplementationOnce(() => { throw new Error('图层已锁定') }); f.apply(); expect(f.completed.current).toBe(false); expect(f.env.onClose).not.toHaveBeenCalled(); expect(f.env.setError).toHaveBeenCalledWith('图层已锁定'); expect(f.draftRef.current.operation).toBe(f.operation)
  })
})

describe('actual filter preview unavailable-source feedback', () => {
  it('reports missing, rejected and failed sources without waiting forever for a raster receipt', () => {
    const source = ts.createSourceFile('layerpreview.tsx', readFileSync(new URL('./layerpreview.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    let expression = '', notification = '', reportFactory = ''
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'sourceUnavailable') expression = node.initializer!.getText(source)
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'reportRasterStatus' && node.initializer && ts.isCallExpression(node.initializer)) reportFactory = node.initializer.arguments[0].getText(source)
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes('if (sourceUnavailable)')) notification = node.arguments[0].getText(source)
      ts.forEachChild(node, visit)
    }
    visit(source); expect(expression).not.toBe(''); expect(notification).not.toBe(''); expect(reportFactory).not.toBe('')
    const code = ts.transpileModule(`const statusListener = { current: onRasterStatus }, lastStatus = { current: null }; const reportRasterStatus = (${reportFactory})(); const lut = { busy: false, error: '' }, rasterCount = 1; const sourceUnavailable = (${expression}); (${notification})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
    const run = new Function('layers', 'images', 'failed', 'sourceKey', 'resolveCanvasAssetDisplayUrl', 'onRasterStatus', code)
    const sourceKey = (image: { key: string }) => image.key, resolve = (url?: string) => url === 'allowed' ? url : undefined
    for (const [images, failed] of [[[], new Set()], [[{ key: 'a', asset: { localUrl: 'rejected' } }], new Set()], [[{ key: 'a', asset: { localUrl: 'allowed' } }], new Set(['a'])]]) {
      const onStatus = vi.fn(); run([{ sourceIndex: 0, visible: true }], images, failed, sourceKey, resolve, onStatus); expect(onStatus).toHaveBeenCalledExactlyOnceWith({ busy: false, error: '图层素材不可用，请重新选择素材后编辑' })
    }
    const onStatus = vi.fn(); run([{ sourceIndex: 0, visible: false }, { sourceIndex: 1, visible: true, content: { kind: 'paint' } }], [], new Set(), sourceKey, resolve, onStatus); expect(onStatus).not.toHaveBeenCalled()
  })
})

function dialogEffect(marker: string, environment: Record<string, unknown>): () => (() => void) {
  const source = ts.createSourceFile('LayerFilterEditor.tsx', readFileSync(new URL('./LayerFilterEditor.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let expression = ''
  function visit(node: ts.Node) { if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' && node.arguments[0]?.getText(source).includes(marker)) expression = node.arguments[0].getText(source); ts.forEachChild(node, visit) }
  visit(source); if (!expression) throw new Error('Missing actual dialog effect')
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as () => (() => void)
}
describe('actual filter dialog lifecycle', () => {
  it('supports strict effect replay while preventing unmounted callbacks and restoring focus', () => {
    class Element { isConnected = true; focus = vi.fn() }
    const previous = new Element(), panel = { current: new Element() }, f = dialogFixture()
    vi.stubGlobal('document', { activeElement: previous }); vi.stubGlobal('HTMLElement', Element)
    const setup = dialogEffect('alive.current = true', { ...f.env, panel }), cleanup = setup()
    expect((f.env.active as () => boolean)()).toBe(true); cleanup(); expect((f.env.active as () => boolean)()).toBe(false); expect(previous.focus).toHaveBeenCalledOnce()
    const secondCleanup = setup(); expect((f.env.active as () => boolean)()).toBe(true); expect(f.completed.current).toBe(false); secondCleanup()
  })
  it('debounces previews and cancels a queued change when the dialog closes', () => {
    vi.useFakeTimers()
    try {
      const f = dialogFixture(), setShownOperation = vi.fn(), setup = dialogEffect('setTimeout', { active: f.env.active, setShownOperation, draft: f.draftRef.current }), cleanup = setup()
      vi.advanceTimersByTime(119); expect(setShownOperation).not.toHaveBeenCalled(); cleanup(); vi.advanceTimersByTime(500); expect(setShownOperation).not.toHaveBeenCalled()
      setup(); f.close(); vi.advanceTimersByTime(120); expect(setShownOperation).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
})
