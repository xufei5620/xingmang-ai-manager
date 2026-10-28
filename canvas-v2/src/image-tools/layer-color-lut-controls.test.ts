import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LayerColorLutControls, type LayerColorLutControlsProps } from './LayerColorLutControls'
import { layerColorLutPresets } from './layer-color-lut-presets'
import { buildColorLutSelection } from './layer-color-lut-selection'

function props(): LayerColorLutControlsProps {
  return { revision: 0, scope: {}, onChange() {}, async onImport() { throw new Error('不应在渲染时读取素材') } }
}

describe('layer color LUT controls markup', () => {
  it('shows every original preset, an explicit empty state and a native cube-only file picker', () => {
    const html = renderToStaticMarkup(createElement(LayerColorLutControls, props()))
    expect(html).toContain('aria-label="LUT 调色"')
    expect(html).toContain('尚未选择调色表')
    expect(html).toContain('accept=".cube"')
    expect(html).toContain('不会触发 AI 生成')
    expect(html).toContain('18 款星芒原创调色预设')
    expect(html).not.toContain('参考站')
    for (const preset of layerColorLutPresets) expect(html).toContain(`value="${preset.id}"`)
    expect(html).toContain('aria-label="启用 LUT" disabled=""')
    expect(html).toContain('aria-label="LUT 强度滑杆" min="0" max="100" step="1" disabled=""')
  })
  it('shows the retained custom name and disabled source at zero strength without discarding it', () => {
    const value = { version: 1 as const, enabled: false, strength: 0, source: { kind: 'asset' as const, lutAssetId: 'a'.repeat(43), digest: 'b'.repeat(64), name: '我自己的冷调.cube', domainMin: [0, 0, 0] as [number, number, number], domainMax: [1, 1, 1] as [number, number, number] } }
    const html = renderToStaticMarkup(createElement(LayerColorLutControls, { ...props(), value }))
    expect(html).toContain('我自己的冷调.cube')
    expect(html).toContain('33³ · 自定义调色表 · 已停用')
    expect(html).toContain('替换 .cube')
    expect(html).toContain('value="0"')
    expect(html).not.toContain('checked=""')
  })
  it('shows the selected original look and keeps its description separate from spatial editing claims', () => {
    const value = buildColorLutSelection({ kind: 'builtin', presetId: 'xm-lut-clear-texture-v1' })
    const html = renderToStaticMarkup(createElement(LayerColorLutControls, { ...props(), value }))
    expect(html).toContain('value="xm-lut-clear-texture-v1" selected=""')
    expect(html).toContain('不进行空间锐化或增加细节')
    expect(html).toContain('33³ · 原创内置预设')
    expect(html).toContain('checked=""')
  })
  it('disables source, strength, enabling, clearing and native input after editing is revoked', () => {
    const value = buildColorLutSelection({ kind: 'builtin', presetId: 'xm-lut-movie-tone-v1' })
    const html = renderToStaticMarkup(createElement(LayerColorLutControls, { ...props(), value, disabled: true }))
    expect((html.match(/<(?:input|select|button)\b[^>]*\bdisabled=""/g) ?? []).length).toBe(7)
    expect(html).toContain('aria-busy="false"')
  })
})
