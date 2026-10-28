import { describe, expect, it } from 'vitest'
import { beginLayerEditorTransaction, createLayerEditorState, defaultEditorImageLayer, finishLayerEditorTransaction, patchEditorLayer, redoLayerEditor, undoLayerEditor } from './layer-editor-state'
import { imageLayerTextWarpStyles } from './layer-text-layout'
import { parseImageTransformRecipe, type ImageLayerRecipe, type ImageLayerTextContent } from './recipe'
import { parseLayerTextNumberDraft, patchLayerTextTypography, resetLayerTextTypography, setLayerTextGenericFont, setLayerTextWarp, setLayerTextWeight } from './layer-text-controls'

function text(): ImageLayerTextContent { return { kind: 'text', text: '星芒创作\nXINGMANG STUDIO', color: '#ffffff', fontSize: 30, fontFamily: 'sans-serif', fontWeight: 400, align: 'left' } }
function recipe(content = text()): ImageLayerRecipe { return { kind: 'layer', outputWidth: 640, outputHeight: 480, background: 'transparent', explicitLayers: true, layers: [{ ...defaultEditorImageLayer(0), content }] } }

describe('layer typography control transformations', () => {
  it('keeps unused new controls absent and preserves legacy text settings', () => {
    const original = text()
    expect(patchLayerTextTypography(original, { lineHeight: 1.2 })).toBe(original)
    expect(patchLayerTextTypography(original, { letterSpacing: 0 })).toBe(original)
    expect(setLayerTextWarp(original, 'none')).toBe(original)
    expect(resetLayerTextTypography(original)).toBe(original)
    expect(setLayerTextWeight(original, 700)).toEqual({ ...original, fontWeight: 700 })
    expect(setLayerTextGenericFont(original, 'serif')).toEqual({ ...original, fontFamily: 'serif' })
    expect(JSON.stringify(original)).not.toContain('typography')
  })

  it('preserves exact text, color, geometry and old fallback while changing the real reference settings', () => {
    let content = patchLayerTextTypography(text(), { lineHeight: 1.9, letterSpacing: 15 })
    content = setLayerTextWeight(content, 700)
    content = setLayerTextWarp(content, 'wave')
    const expected = { ...text(), typography: { version: 1, lineHeight: 1.9, letterSpacing: 15, fontWeight: 700, warp: { style: 'wave', bend: 50 } } }
    expect(content).toEqual(expected)
    expect(parseImageTransformRecipe(recipe(content))).toEqual(recipe(content))
    expect(setLayerTextWarp(content, 'fisheye').typography?.warp).toEqual({ style: 'fisheye', bend: 50 })
    expect(resetLayerTextTypography(content)).toEqual(text())
  })

  it('uses all thirteen controlled styles and keeps negative bend when switching style', () => {
    expect(imageLayerTextWarpStyles).toHaveLength(13)
    const content = patchLayerTextTypography(text(), { warp: { style: 'arc', bend: -65 } })
    for (const style of imageLayerTextWarpStyles) expect(setLayerTextWarp(content, style.id).typography?.warp).toEqual({ style: style.id, bend: -65 })
    const reset = setLayerTextWarp(content, 'none')
    expect(reset.typography?.warp).toBeUndefined()
    expect(reset.typography).toMatchObject({ version: 1, lineHeight: 1.2, letterSpacing: 0 })
  })

  it('switches explicitly from an unavailable local font without discarding other typography', () => {
    const original = patchLayerTextTypography(text(), { fontFamily: 'Example Sans', fontSource: 'local', lineHeight: 1.9, warp: { style: 'wave', bend: 35 } })
    const next = setLayerTextGenericFont(original, 'serif')
    expect(next.fontFamily).toBe('serif')
    expect(next.typography).toEqual({ version: 1, lineHeight: 1.9, letterSpacing: 0, warp: { style: 'wave', bend: 35 } })
    expect(original.typography?.fontFamily).toBe('Example Sans')
  })

  it.each(['', ' ', '-', 'NaN', 'Infinity', '1.2.3', '-20.1', '100.1'])('does not commit invalid numeric draft %s', (draft) => {
    expect(parseLayerTextNumberDraft(draft, -20, 100, .1)).toBeNull()
  })

  it('accepts decimals and signed values without coercing empty drafts to zero', () => {
    expect(parseLayerTextNumberDraft('1.90', .5, 3, .05)).toBe(1.9)
    expect(parseLayerTextNumberDraft('-15.2', -20, 100, .1)).toBe(-15.2)
    expect(parseLayerTextNumberDraft('0', -20, 100, .1)).toBe(0)
  })

  it('keeps a continuous bend gesture in one undo step and cancels to the exact original recipe', () => {
    const initial = recipe(setLayerTextWarp(text(), 'arc'))
    let state = createLayerEditorState(initial, 0)
    const id = state.present.ids[0]
    state = beginLayerEditorTransaction(state)
    for (const bend of [45, 23, -16, -57]) state = patchEditorLayer(state, id, { content: patchLayerTextTypography(initial.layers[0].content as ImageLayerTextContent, { warp: { style: 'arc', bend } }) })
    expect(state.past).toHaveLength(0)
    const cancelled = finishLayerEditorTransaction(state, true)
    expect(cancelled.present.recipe).toEqual(initial)
    expect(cancelled.past).toHaveLength(0)
    state = finishLayerEditorTransaction(state)
    expect(state.past).toHaveLength(1)
    expect(undoLayerEditor(state).present.recipe).toEqual(initial)
    expect(redoLayerEditor(undoLayerEditor(state)).present.recipe).toEqual(state.present.recipe)
  })

  it('respects locked text layers for new typography patches', () => {
    const initial = recipe(); initial.layers[0].locked = true
    const state = createLayerEditorState(initial, 0)
    expect(patchEditorLayer(state, state.present.ids[0], { content: setLayerTextWarp(text(), 'arc') })).toBe(state)
  })
})
