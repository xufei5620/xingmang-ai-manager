import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LayerColorDetailControls } from './LayerColorDetailControls'
import { defaultImageLayerColorDetail } from './layer-color-detail'

describe('local color detail controls markup', () => {
  it('renders ten native controls with actual defaults and three collapsed advanced groups without writing a value', () => {
    const onChange = vi.fn(), html = renderToStaticMarkup(createElement(LayerColorDetailControls, { onChange }))
    expect(onChange).not.toHaveBeenCalled()
    expect((html.match(/type="range"/g) ?? []).length).toBe(10)
    expect((html.match(/type="number"/g) ?? []).length).toBe(10)
    expect((html.match(/<details>/g) ?? []).length).toBe(3)
    expect(html).toContain('aria-label="启用细节与降噪" checked=""')
    expect(html).toContain('aria-label="锐化数量滑杆" min="0" max="150" step="1"')
    expect(html).toContain('aria-label="锐化半径滑杆" min="0.5" max="3" step="0.1"')
    expect(html).toContain('100%'); expect(html).toContain('本地像素处理'); expect(html).not.toContain('AI 降噪')
  })
  it('keeps dormant controls editable and explicit instead of removing a disabled configuration', () => {
    const value = { ...defaultImageLayerColorDetail(), enabled: false }; value.sharpening.amount = 80
    const html = renderToStaticMarkup(createElement(LayerColorDetailControls, { value, onChange() {} }))
    expect(html).toContain('效果已停用，当前参数仍会保存')
    expect(html).toContain('value="80"'); expect(html).not.toContain('disabled=""')
    expect(html).not.toContain('checked=""')
  })
  it('disables every editable input when the parent is reading or editing is no longer allowed', () => {
    const html = renderToStaticMarkup(createElement(LayerColorDetailControls, { value: defaultImageLayerColorDetail(), disabled: true, onChange() {} }))
    expect((html.match(/disabled=""/g) ?? []).length).toBe(21)
  })
})
