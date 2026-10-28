import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { LayerTextControls, LayerTextNumberField } from './LayerTextControls'
import { patchLayerTextTypography, parseLayerTextNumberDraft, setLayerTextGenericFont } from './layer-text-controls'
import { imageLayerTextWarpStyles } from './layer-text-layout'
import type { ImageLayerTextContent } from './recipe'
import { beginLayerEditorTransaction, createLayerEditorState, defaultEditorImageLayer, finishLayerEditorTransaction, patchEditorLayer, redoLayerEditor, undoLayerEditor } from './layer-editor-state'

const source = ts.createSourceFile('LayerTextControls.tsx', readFileSync(new URL('./LayerTextControls.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>): T {
  let expression = ''
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(source).replace(/^export /, ''); ts.forEachChild(node, visit) }
  visit(source)
  if (!expression) throw new Error(`Missing handler ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${expression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText)(...Object.values(environment)) as T
}
function text(): ImageLayerTextContent { return { kind: 'text', text: '星芒创作\nXINGMANG STUDIO', color: '#ffffff', fontSize: 40, fontFamily: 'sans-serif', fontWeight: 400, align: 'left' } }
function deferred() { let resolve!: () => void, reject!: (cause: unknown) => void; const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
function fonts() {
  const prepare = deferred(), onChange = vi.fn(), onFontReady = vi.fn()
  const environment = { current: { current: { content: text(), disabled: false, onChange } }, alive: { current: true }, request: { current: 0 }, families: ['Example Sans'], prepareLocalTextFont: vi.fn(() => prepare.promise), setLoading: vi.fn(), setFontError: vi.fn(), patchLayerTextTypography, setLayerTextGenericFont, onFontReady }
  return { ...environment, onChange, prepare, select: actual<(value: string) => Promise<void>>('selectFont', environment) }
}

describe('real layer text control actions', () => {
  it('renders all typography controls without enumerating fonts or mutating a legacy recipe', () => {
    const content = text(), onChange = vi.fn()
    const html = renderToStaticMarkup(createElement(LayerTextControls, { content, colorField: null, onChange, onBegin() {}, onFinish() {} }))
    for (const label of ['图层文字内容', '文字字号（像素）', '图层字重', '图层字体', '字距（像素）', '行高（倍）', '文字变形样式']) expect(html).toContain(`aria-label="${label}"`)
    for (const { label } of imageLayerTextWarpStyles) expect(html).toContain(`>${label}</option>`)
    for (const value of [100, 200, 300, 400, 500, 600, 700, 800, 900]) expect(html).toContain(`value="${value}"`)
    expect(html).toContain('加载本机字体')
    expect(html).not.toContain('弯曲度滑块')
    expect(html).toContain('不支持读取本机字体')
    expect(onChange).not.toHaveBeenCalled()
    expect(content.typography).toBeUndefined()
  })

  it('shows a missing saved local font by name and never disguises it as a generic font', () => {
    const content = patchLayerTextTypography(text(), { fontFamily: 'Missing Family', fontSource: 'local', warp: { style: 'wave', bend: 50 } })
    const html = renderToStaticMarkup(createElement(LayerTextControls, { content, disabled: true, colorField: null, onChange() {}, onBegin() {}, onFinish() {} }))
    expect(html).toContain('<fieldset class="layer-text-controls" disabled=""')
    expect(html).toContain('value="local:Missing Family" selected=""')
    expect(html).toContain('弯曲度滑块')
    expect(html).toContain('其他设备需安装相同字体')
  })

  it('commits a verified local font once and requests a preview repaint', async () => {
    const f = fonts(), pending = f.select('local:Example Sans')
    expect(f.prepareLocalTextFont).toHaveBeenCalledWith('Example Sans', 400)
    expect(f.onChange).not.toHaveBeenCalled()
    f.prepare.resolve(); await pending
    expect(f.onChange).toHaveBeenCalledOnce()
    expect(f.onChange.mock.calls[0][0].typography).toMatchObject({ fontFamily: 'Example Sans', fontSource: 'local', lineHeight: 1.2, letterSpacing: 0 })
    expect(f.onFontReady).toHaveBeenCalledOnce()
  })

  it.each(['content-changed', 'locked', 'unmounted', 'new-request'] as const)('rejects a late local font result after %s', async (boundary) => {
    const f = fonts(), pending = f.select('local:Example Sans')
    if (boundary === 'content-changed') f.current.current.content = { ...f.current.current.content, text: '新的文字' }
    if (boundary === 'locked') f.current.current.disabled = true
    if (boundary === 'unmounted') f.alive.current = false
    if (boundary === 'new-request') f.request.current++
    f.prepare.resolve(); await pending
    expect(f.onChange).not.toHaveBeenCalled()
    expect(f.onFontReady).not.toHaveBeenCalled()
  })

  it('retains the original recipe on a rejected font and supersedes loading with an explicit generic choice', async () => {
    const rejected = fonts(), pending = rejected.select('local:Example Sans')
    rejected.prepare.reject(new Error('本机字体不可用')); await pending
    expect(rejected.onChange).not.toHaveBeenCalled()
    expect(rejected.setFontError).toHaveBeenCalledWith('本机字体不可用')
    const switched = fonts(), slow = switched.select('local:Example Sans')
    await switched.select('serif'); switched.prepare.resolve(); await slow
    expect(switched.onChange).toHaveBeenCalledExactlyOnceWith({ ...text(), fontFamily: 'serif' })
  })

  it('does not accept a font name that the user has not explicitly loaded', async () => {
    const f = fonts(); await f.select('local:Hidden Font')
    expect(f.prepareLocalTextFont).not.toHaveBeenCalled()
    expect(f.onChange).not.toHaveBeenCalled()
    expect(f.setFontError).toHaveBeenCalledWith('请先加载并选择已授权的本机字体')
  })

  it.each(['present', 'removed', 'empty-or-denied'] as const)('rechecks the preview after an explicit font inventory refresh is %s without replacing the recipe', async (result) => {
    const content = patchLayerTextTypography(text(), { fontFamily: 'Saved Family', fontSource: 'local' })
    const onChange = vi.fn(), onFontReady = vi.fn(), prepareLocalTextFont = vi.fn(async () => {})
    const requestLocalTextFontFamilies = vi.fn(async () => { if (result === 'empty-or-denied') throw new Error('未找到可用的本机字体'); return result === 'present' ? ['Saved Family'] : ['Other Family'] })
    const environment = { current: { current: { content, disabled: false, onChange } }, alive: { current: true }, request: { current: 0 }, setLoading: vi.fn(), setFontError: vi.fn(), setFamilies: vi.fn(), requestLocalTextFontFamilies, prepareLocalTextFont, onFontReady }
    await actual<() => Promise<void>>('loadFonts', environment)()
    expect(onFontReady).toHaveBeenCalledOnce()
    expect(onChange).not.toHaveBeenCalled()
    expect(environment.current.current.content).toBe(content)
    expect(prepareLocalTextFont).toHaveBeenCalledTimes(result === 'present' ? 1 : 0)
  })

  it('does not refresh or commit an obsolete font inventory response after unmount', async () => {
    const pending = deferred(), onFontReady = vi.fn(), setFamilies = vi.fn()
    const environment = { current: { current: { content: text(), disabled: false, onChange: vi.fn() } }, alive: { current: true }, request: { current: 0 }, setLoading: vi.fn(), setFontError: vi.fn(), setFamilies, requestLocalTextFontFamilies: async () => { await pending.promise; return ['Other Family'] }, prepareLocalTextFont: vi.fn(async () => {}), onFontReady }
    const load = actual<() => Promise<void>>('loadFonts', environment)()
    environment.alive.current = false; pending.resolve(); await load
    expect(onFontReady).not.toHaveBeenCalled(); expect(setFamilies).not.toHaveBeenCalled()
  })

  it('keeps incomplete numeric text out of the recipe and commits the final draft only once', () => {
    const onChange = vi.fn(), setDraft = vi.fn(), setError = vi.fn(), skipBlur = { current: false }
    function commit(draft: string) { actual<() => void>('commit', { draft, min: -20, max: 100, step: .1, value: 0, onChange, setDraft, setError, skipBlur, parseLayerTextNumberDraft })() }
    commit(''); commit('-')
    expect(onChange).not.toHaveBeenCalled()
    commit('-15.2')
    expect(onChange).toHaveBeenCalledExactlyOnceWith(-15.2)
    skipBlur.current = true; commit('-15.2')
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('does not submit numeric drafts during IME and restores Escape without a stale blur commit', () => {
    let keyExpression = ''
    function visit(node: ts.Node) {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'LayerTextNumberField') {
        function find(child: ts.Node) { if (ts.isJsxAttribute(child) && child.name.getText(source) === 'onKeyDown' && child.initializer && ts.isJsxExpression(child.initializer)) keyExpression = child.initializer.expression!.getText(source); ts.forEachChild(child, find) }
        find(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    const commit = vi.fn(), setDraft = vi.fn(), setError = vi.fn(), skipBlur = { current: false }
    const env = { commit, setDraft, setError, skipBlur, value: 1.2 }
    const key = new Function(...Object.keys(env), ts.transpileModule(`return (${keyExpression})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(env)) as (event: unknown) => void
    const event = { key: 'Enter', keyCode: 229, nativeEvent: { isComposing: true }, preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: { blur: vi.fn() } }
    key(event); expect(commit).not.toHaveBeenCalled(); expect(event.currentTarget.blur).not.toHaveBeenCalled()
    key({ ...event, key: 'Escape', keyCode: 27, nativeEvent: { isComposing: false } })
    expect(skipBlur.current).toBe(true); expect(setDraft).toHaveBeenCalledWith('1.2'); expect(commit).not.toHaveBeenCalled()
    const html = renderToStaticMarkup(createElement(LayerTextNumberField, { label: '行高', value: 1.2, min: .5, max: 3, onChange() {} }))
    expect(html).toContain('value="1.2"')
  })

  it('groups the real bend gesture once and makes pointer cancel followed by lost capture harmless', () => {
    const content = patchLayerTextTypography(text(), { warp: { style: 'arc', bend: 50 } })
    let state = createLayerEditorState({ kind: 'layer', outputWidth: 640, outputHeight: 480, background: 'transparent', explicitLayers: true, layers: [{ ...defaultEditorImageLayer(0), content }] }, 0)
    const id = state.present.ids[0], before = state.present.recipe, dragging = { current: false }
    const onBegin = vi.fn(() => { state = beginLayerEditorTransaction(state) }), onFinish = vi.fn((cancel = false) => { state = finishLayerEditorTransaction(state, cancel) })
    const environment = { dragging, onBegin, onFinish }
    const begin = actual<() => void>('beginBend', environment), finish = actual<(cancel?: boolean) => void>('finishBend', environment)
    function move(bend: number) { state = patchEditorLayer(state, id, { content: patchLayerTextTypography(content, { warp: { style: 'arc', bend } }) }) }
    begin(); begin(); move(30); move(-20); finish(true); finish()
    expect(onBegin).toHaveBeenCalledOnce(); expect(onFinish).toHaveBeenCalledExactlyOnceWith(true)
    expect(state.present.recipe).toEqual(before); expect(state.past).toHaveLength(0)
    begin(); move(15); move(70); finish(); finish()
    expect(state.past).toHaveLength(1)
    expect(undoLayerEditor(state).present.recipe).toEqual(before)
    expect(redoLayerEditor(undoLayerEditor(state)).present.recipe).toEqual(state.present.recipe)
  })
})
