import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LayerColorCalibrationControls } from './LayerColorCalibrationControls'
import { defaultImageLayerColorCalibration } from './layer-color-calibration'

describe('local shadow and RGB primary calibration controls', () => {
  it('renders seven signed sliders and number inputs without persisting defaults on mount', () => {
    const onChange = vi.fn(), html = renderToStaticMarkup(createElement(LayerColorCalibrationControls, { onChange }))
    expect(onChange).not.toHaveBeenCalled()
    expect(html.match(/type="range"/g)).toHaveLength(7); expect(html.match(/type="number"/g)).toHaveLength(7)
    for (const label of ['阴影色调', '红原色色相', '红原色饱和度', '绿原色色相', '绿原色饱和度', '蓝原色色相', '蓝原色饱和度']) expect(html).toContain(`aria-label="${label}滑杆" min="-100" max="100" step="1"`)
    expect(html).toContain('aria-label="启用校准" checked=""'); expect(html).toContain('本地处理')
    expect(html).not.toContain('ProcessVersion'); expect(html).not.toContain('Adobe 算法')
  })
  it('keeps disabled calibration values editable while allowing the parent to disable all fifteen inputs', () => {
    const value = { ...defaultImageLayerColorCalibration(), enabled: false, shadowTint: 25, redHue: -40, blueSaturation: 70 }
    const html = renderToStaticMarkup(createElement(LayerColorCalibrationControls, { value, onChange() {} }))
    expect(html).toContain('校准已停用，当前参数仍会保存'); expect(html).toContain('value="-40"'); expect(html).not.toContain('disabled=""')
    expect(renderToStaticMarkup(createElement(LayerColorCalibrationControls, { value, disabled: true, onChange() {} })).match(/disabled=""/g)).toHaveLength(15)
  })
})
