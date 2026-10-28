import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LayerColorPresenceControls } from './LayerColorPresenceControls'
import { defaultImageLayerColorPresence } from './layer-color-presence'

describe('local texture clarity and dehaze controls', () => {
  it('renders three signed native sliders and number fields without creating a configuration on mount', () => {
    const onChange = vi.fn(), html = renderToStaticMarkup(createElement(LayerColorPresenceControls, { onChange }))
    expect(onChange).not.toHaveBeenCalled()
    expect((html.match(/type="range"/g) ?? []).length).toBe(3); expect((html.match(/type="number"/g) ?? []).length).toBe(3)
    for (const label of ['纹理', '清晰度', '去除薄雾']) expect(html).toContain(`aria-label="${label}滑杆" min="-100" max="100" step="1"`)
    expect(html).toContain('aria-label="启用质感与去雾" checked=""'); expect(html).toContain('本地像素处理'); expect(html).toContain('100%')
    expect(html).not.toContain('AI 增强')
  })
  it('keeps disabled effect values editable and explicit while the parent can disable all seven inputs', () => {
    const value = { ...defaultImageLayerColorPresence(), enabled: false, texture: 60, clarity: -40, dehaze: 30 }
    const html = renderToStaticMarkup(createElement(LayerColorPresenceControls, { value, onChange() {} }))
    expect(html).toContain('效果已停用，当前参数仍会保存'); expect(html).toContain('value="-40"'); expect(html).not.toContain('disabled=""')
    expect((renderToStaticMarkup(createElement(LayerColorPresenceControls, { value, disabled: true, onChange() {} })).match(/disabled=""/g) ?? []).length).toBe(7)
  })
})
