import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { UpstreamMediaReference } from '../components/upstream-references'
import type { WorkflowNodeData } from '../model'
import { ImageToolControls } from './ImageToolControls'
import { defaultImageTransformRecipe } from './recipe'
import { buildCompareInputSlots } from './viewer-settings'

function inputs(count: number): UpstreamMediaReference[] {
  return Array.from({ length: count }, (_, index) => ({
    edgeId: `batch-${Math.floor(index / 16)}`, sourceNodeId: `source-${Math.floor(index / 16)}`,
    kind: 'image', label: `切片 ${index + 1}`, mention: `@切片-${index + 1}`, relationLabel: '图像输入', status: 'ready',
    asset: { kind: 'image', assetId: 'A'.repeat(43), localUrl: `xingmang-asset://image/${'A'.repeat(43)}`, width: 400, height: 300 },
  }))
}

function render(kind: string, references: UpstreamMediaReference[], settings?: WorkflowNodeData['settings']) {
  const onChange = vi.fn()
  const html = renderToStaticMarkup(createElement(ImageToolControls, { kind, references, disabled: false, onChange, data: { prompt: '', model: '', status: 'idle', ...(settings ? { settings } : {}) } }))
  expect(onChange).not.toHaveBeenCalled()
  return html
}

describe('image viewer input limit presentation', () => {
  it('shows an explicitly selected unproduced sixth batch image as waiting instead of disconnected', () => {
    const batch: UpstreamMediaReference = { edgeId: 'batch', sourceNodeId: 'grid', kind: 'image', label: '宫格裁剪 · 图片 1', mention: '@grid', relationLabel: '图像输入', status: 'waiting', batch: true, outputIndex: 0 }
    const photo: UpstreamMediaReference = { ...inputs(1)[0], edgeId: 'photo', batch: false, outputIndex: 0 }
    const html = render('image-compare', [batch, photo], { imageCompare: { mode: 'side-by-side', a: '0', b: '1', inputSlots: ['["batch",5]', '["photo",0]'] } })
    expect(html).toContain('等待此输入图片就绪')
    expect(html).toContain('宫格裁剪 · 第 6 张')
    expect(html).toContain('<option value="2" selected="">')
    expect(html).toContain('alt="B · 切片 1"')
    expect(html).not.toContain('原输入已断开')
    const disconnected = render('image-compare', [photo], { imageCompare: { mode: 'side-by-side', a: '0', b: '1', inputSlots: ['["batch",5]', '["photo",0]'] } })
    expect(disconnected).toContain('原输入已断开')
  })

  it('keeps an over-capacity collage editable while explaining that the preview cannot discard inputs', () => {
    const html = render('image-collage', inputs(208), { imageTransform: defaultImageTransformRecipe('collage') })
    expect(html).toContain('208 张输入需至少 208 格')
    expect(html).toContain('不会自动丢弃图片')
    expect(html).toContain('编辑处理参数')
    expect(html).not.toContain('图片对比最多支持')
    expect(html).toContain('role="alert"')
  })

  it('reports 201 comparison inputs without throwing or silently rendering only the first 200', () => {
    const html = render('image-compare', inputs(201))
    expect(html).toContain('role="alert"')
    expect(html).toContain('图片对比最多支持 200 个输入位置')
    expect(html).toMatch(/当前有 (?:<!-- -->)?201/)
    expect(html).toContain('不会自动截断输入')
    expect(html).not.toContain('<select')
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(6)
    expect(html).not.toContain('class="image-compare-stage')
  })

  it('allows all 200 positions including the last batch occurrence', () => {
    const references = inputs(200)
    const html = render('image-compare', references, { imageCompare: { mode: 'slider', position: 61, a: '199', b: '0', grid: ['199', '0', null, null], inputSlots: buildCompareInputSlots(references) } })
    expect(html).toContain('alt="A · 切片 200"')
    expect(html).toContain('<option value="199" selected="">')
    expect(html).toContain('value="61"')
    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('disabled=""')
  })

  it('preserves a missing selected slot and explicit empty slot after an earlier edge disconnects', () => {
    const before = inputs(33), references = before.filter((reference) => reference.edgeId !== 'batch-0')
    const html = render('image-compare', references, { imageCompare: { mode: 'grid', position: 31, a: '0', b: '32', grid: ['0', '32', null, '16'], inputSlots: buildCompareInputSlots(before) } })
    expect(html).toContain('原输入已断开')
    expect(html).toContain('<option value="missing" selected="">')
    expect(html).toContain('alt="格 2 · 切片 33"')
    expect(html).toContain('alt="格 4 · 切片 17"')
    expect(html).not.toContain('alt="格 3 ·')
  })

  it('projects saved three-image and overlay choices into the actual node controls', () => {
    const references = inputs(4), base = { a: '0', b: '1', c: '3', sideBySideCount: 3, position: 61, opacity: 0, overlayVisible: false, grid: ['0', '1', null, null], inputSlots: buildCompareInputSlots(references) }
    const parallel = render('image-compare', references, { imageCompare: { ...base, mode: 'side-by-side' } })
    expect(parallel).toContain('alt="C · 切片 4"')
    expect(parallel).toContain('aria-pressed="true">三图并排')
    expect(parallel).toContain('全屏预览')
    const opacity = render('image-compare', references, { imageCompare: { ...base, mode: 'opacity' } })
    expect(opacity).toContain('opacity:0;visibility:visible')
    expect(opacity).toContain('aria-pressed="true">透明')
    const toggle = render('image-compare', references, { imageCompare: { ...base, mode: 'toggle' } })
    expect(toggle).toContain('aria-pressed="true">点按')
    expect(toggle).toContain('显示上层 A')
  })
})
