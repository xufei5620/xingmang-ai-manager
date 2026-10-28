import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import { CollageInputSorter, finishCollageSort, type CollageSortableImage, type CollageSortGesture } from './CollageInputSorter'
import { collageInputIdentityKey } from './collage-input-order'
import { ImageToolControls } from './ImageToolControls'
import { defaultImageTransformRecipe } from './recipe'
import type { UpstreamMediaReference } from '../components/upstream-references'

const source = ts.createSourceFile('CollageInputSorter.tsx', readFileSync(new URL('./CollageInputSorter.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function actual<T>(name: string, environment: Record<string, unknown>, attribute = false): T {
  let found = ''
  function visit(node: ts.Node) {
    if (attribute && ts.isJsxAttribute(node) && node.name.getText(source) === name && node.initializer && ts.isJsxExpression(node.initializer)) found = node.initializer.expression!.getText(source)
    if (!attribute && ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(source)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (!found) throw new Error(`Missing actual handler ${name}`)
  return new Function(...Object.keys(environment), ts.transpileModule(`return (${found});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText)(...Object.values(environment)) as T
}
function items(): CollageSortableImage[] { return ['a', 'b', 'd'].map((edgeId) => ({ edgeId, outputIndex: 0, label: edgeId, pending: false, url: `xingmang-asset://image/${edgeId.repeat(43)}` })) }

describe('collage sorting controls', () => {
  it('commits the actual drop once and rejects a cancelled or stale source gesture', () => {
    const values = items(), gesture = { current: { key: collageInputIdentityKey(values[2]), scope: 'before' } as CollageSortGesture | null }
    const onReorder = vi.fn(), latest = { current: { items: values, scope: 'before', disabled: false } }
    const drop = actual<(event: object) => void>('onDrop', { targetIndex: () => 0, latest, blocked: false, gesture, finishCollageSort, clear: () => { gesture.current = null }, onReorder, setNotice: vi.fn() }, true)
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() }
    drop(event); drop(event)
    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(onReorder.mock.calls[0][0].slots.map((slot: { edgeId: string }) => slot.edgeId)).toEqual(['d', 'a', 'b'])
    gesture.current = { key: collageInputIdentityKey(values[2]), scope: 'before' }; latest.current.scope = 'after-new-batch'
    drop(event)
    expect(onReorder).toHaveBeenCalledTimes(1)
  })
  it('lets external file and asset drops reach the canvas when no sorting gesture exists', () => {
    const gesture = { current: null }, preventDefault = vi.fn(), stopPropagation = vi.fn(), targetIndex = vi.fn(), onReorder = vi.fn()
    const drop = actual<(event: object) => void>('onDrop', { gesture, targetIndex, latest: { current: { items: items(), scope: 'same', disabled: false } }, blocked: false, finishCollageSort, clear: vi.fn(), onReorder, setNotice: vi.fn() }, true)
    drop({ preventDefault, stopPropagation })
    expect(preventDefault).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
    expect(targetIndex).not.toHaveBeenCalled()
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('finds the entire styled cell under an overlay without requiring the tiny handle', () => {
    class ElementStub { closest() { return null } }
    const targetIndex = actual<(event: object) => number>('targetIndex', { Element: ElementStub })
    const cells = [0, 1].map((index) => ({ dataset: { collageSlotIndex: String(index) }, getBoundingClientRect: () => ({ left: index * 100, right: (index + 1) * 100, top: 0, bottom: 80, width: 100, height: 80 }) }))
    const base = { target: new ElementStub(), currentTarget: { contains: () => false, querySelectorAll: () => cells } }
    expect(targetIndex({ ...base, clientX: 150, clientY: 40 })).toBe(1)
    expect(targetIndex({ ...base, clientX: 250, clientY: 40 })).toBe(-1)
  })
  it('uses the actual keyboard commit function for a single reorder and keeps boundaries unchanged', () => {
    const values = items(), onReorder = vi.fn()
    const commit = actual<(from: number, target: number) => void>('commit', { blocked: false, items: values, finishCollageSort, collageInputIdentityKey, scope: 'same', onReorder, setNotice: vi.fn() })
    commit(1, 0); commit(0, -1); commit(2, 3)
    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(onReorder.mock.calls[0][0].slots.map((slot: { edgeId: string }) => slot.edgeId)).toEqual(['b', 'a', 'd'])
  })
  it('renders discoverable drag handles and bounded keyboard buttons without a mutation', () => {
    const onReorder = vi.fn(), html = renderToStaticMarkup(createElement(CollageInputSorter, { items: items(), scopeKey: 'same', onReorder }))
    expect(html.match(/title="拖拽调整顺序"/g)).toHaveLength(3)
    expect(html).toContain('方向键前后移动')
    expect(html).toMatch(/aria-label="将第 1 张图片前移" disabled=""/)
    expect(html).toMatch(/aria-label="将第 3 张图片后移" disabled=""/)
    expect(onReorder).not.toHaveBeenCalled()
  })
  it('stops a rapid second arrow click from opening the surrounding parameter editor', () => {
    const stopPropagation = vi.fn()
    const handler = actual<(event: object) => void>('onDoubleClick', {}, true)
    handler({ stopPropagation })
    expect(stopPropagation).toHaveBeenCalledOnce()
    const code = source.getFullText()
    expect(code).toContain('disabled={blocked || index === 0} onDoubleClick={(event) => event.stopPropagation()}')
    expect(code).toContain('disabled={blocked || index === items.length - 1} onDoubleClick={(event) => event.stopPropagation()}')
  })

  it('keeps card sorting controls reachable with a bounded list and overrides generic button padding', () => {
    const css = readFileSync(new URL('./collage-input-sorter.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.image-tool-node-preview\.has-collage-order\s*\{[^}]*max-height: none;[^}]*--image-tool-preview-height: 180px/)
    expect(css).toMatch(/\.collage-input-sorter\.is-compact ol\s*\{[^}]*max-height: 108px/)
    expect(css).toMatch(/\.image-tool-node \.collage-input-sorter button,[^{]*\{[^}]*min-height: 24px; padding: 0/)
    expect(css).toContain('width: 13px; height: 13px; flex: none')
  })

  it('keeps pending slots visible and blocks sorting instead of switching to another image', () => {
    const values = items(); values[0].pending = true
    const html = renderToStaticMarkup(createElement(CollageInputSorter, { items: values, scopeKey: 'waiting', onReorder() {} }))
    expect(html).toContain('等待原输入')
    expect(html).toContain('原连线未就绪的位置会保留')
    expect(html).not.toContain('draggable="true"')
  })
  it('projects saved collage ordering into the actual node preview and leaves pixel recipes unchanged', () => {
    const refs: UpstreamMediaReference[] = items().map((item) => ({ edgeId: item.edgeId, sourceNodeId: item.edgeId, kind: 'image', label: item.label, status: 'ready', mention: '@image', relationLabel: '图像输入', asset: { kind: 'image', assetId: item.edgeId.repeat(43), localUrl: item.url, width: 100, height: 100 } }))
    const recipe = defaultImageTransformRecipe('collage'), order = { version: 1, slots: ['d', 'a', 'b'].map((edgeId) => ({ edgeId, outputIndex: 0 })) }
    const onChange = vi.fn(), html = renderToStaticMarkup(createElement(ImageToolControls, { kind: 'image-collage', references: refs, disabled: false, onChange, data: { prompt: '', model: '', status: 'idle', settings: { imageTransform: recipe, imageCollageInputOrder: order } } }))
    expect(html.indexOf('alt="d"')).toBeLessThan(html.indexOf('alt="a"'))
    expect(html.indexOf('alt="a"')).toBeLessThan(html.indexOf('alt="b"'))
    expect(html.match(/title="拖拽调整顺序"/g)).toHaveLength(6)
    expect(html).toContain('image-tool-node-preview has-collage-order')
    expect(recipe).not.toHaveProperty('inputOrder')
    expect(onChange).not.toHaveBeenCalled()
  })
})
