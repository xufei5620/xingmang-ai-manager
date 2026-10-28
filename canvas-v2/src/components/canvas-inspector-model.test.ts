import { describe, expect, it } from 'vitest'
import { canvasInspectorParameterRows } from './canvas-inspector-model'
import { defaultImageTransformRecipe, type ImageCollageRecipe, type ImageLayerRecipe } from '../image-tools/recipe'
import { imageCollageTemplates } from '../image-tools/collage-templates'

const node = { kind: 'image-edit', prompt: '', model: 'gpt-image-2', size: '1280x720', imageResolution: '4K', settings: {} } as const

describe('inspector router execution semantics', () => {
  it('distinguishes actual historical all behavior from explicitly saved first-per-media execution', () => {
    const legacy = canvasInspectorParameterRows({ ...node, kind: 'router', settings: { strategy: 'first-available' } })
    expect(legacy).toContainEqual({ label: '路由策略', value: '旧配置：保留全部输入' })
    expect(legacy.find((row) => row.label === '输入选择')?.value).toContain('明确选择')
    const first = canvasInspectorParameterRows({ ...node, kind: 'router', settings: { routerStrategy: { version: 1, strategy: 'first-available' } } })
    expect(first).toContainEqual({ label: '路由策略', value: '每种媒体保留首个输入' })
    expect(first.find((row) => row.label === '输入选择')?.value).toContain('按保存的连线顺序')
    expect(first.find((row) => row.label === '执行范围')?.value).toContain('可能产生费用')
    expect(first.find((row) => row.label === '执行范围')?.value).toContain('不提供失败容错')
  })
  it('keeps future strategy settings unresolved instead of describing a different supported strategy', () => {
    const settings = { routerStrategy: { version: 2, strategy: 'all' } }, before = structuredClone(settings)
    const rows = canvasInspectorParameterRows({ ...node, kind: 'router', settings })
    expect(rows).toContainEqual({ label: '路由策略', value: '策略无法核对，禁止运行' })
    expect(rows.find((row) => row.label === '输入选择')?.value).toContain('不会改用其他策略'); expect(settings).toEqual(before)
  })
})

describe('inspector image dimensions', () => {
  it('shows a saved fixed source identity rather than describing it as a project default', () => {
    expect(canvasInspectorParameterRows({ ...node, group: 'owned-image-source' })).toContainEqual({ label: '固定来源', value: 'owned-image-source' })
    expect(canvasInspectorParameterRows(node).some((row) => row.label === '固定来源')).toBe(false)
  })
  it('describes an empty node model as inherited without inventing a missing project configuration', () => {
    const input = { ...node, model: '' }, before = JSON.stringify(input)
    const rows = canvasInspectorParameterRows(input)
    expect(rows).toContainEqual({ label: '模型', value: '继承项目生成配置' })
    expect(rows).toContainEqual({ label: '清晰度', value: '由实际模型能力确定' })
    expect(rows.some((row) => row.label === '分辨率提示')).toBe(false)
    expect(JSON.stringify(input)).toBe(before)
  })
  it.each(imageCollageTemplates)('describes $title fixed composition and required input count', (template) => {
    const rows = canvasInspectorParameterRows({ ...node, kind: 'image-collage', settings: { imageTransform: { ...defaultImageTransformRecipe('collage'), layout: template.layout } } })
    expect(rows).toContainEqual({ label: '拼图布局', value: `${template.title} · ${template.inputCount} 张` })
    expect(rows.some((row) => row.label === '排列')).toBe(false)
    expect(rows).toContainEqual({ label: '输出尺寸', value: '1024 × 1024' })
  })
  it('does not present provider-sized defaults as a guaranteed 1K output', () => {
    const rows = canvasInspectorParameterRows({ ...node, model: 'grok-imagine-image', imageResolution: '1K' })
    expect(rows).toContainEqual({ label: '清晰度', value: '由服务决定' })
    expect(rows.some((row) => row.label === '请求尺寸')).toBe(false)
  })

  it('projects effective request dimensions without changing the saved base size', () => {
    expect(canvasInspectorParameterRows(node)).toContainEqual({ label: '请求尺寸', value: '3840 × 2160' })
    expect(node.size).toBe('1280x720')
  })

  it('uses actual result dimensions after generation', () => {
    const rows = canvasInspectorParameterRows({ ...node, previewAsset: { kind: 'image', assetId: 'existing-image', width: 2560, height: 1440 } })
    expect(rows).toContainEqual({ label: '产物尺寸', value: '2560 × 1440' })
    expect(rows.some((row) => row.label === '请求尺寸')).toBe(false)
  })

  it('shows an unsupported saved resolution instead of inventing smaller output dimensions', () => {
    const rows = canvasInspectorParameterRows({ ...node, model: 'gemini-3.1-flash-image' })
    expect(rows).toContainEqual({ label: '清晰度', value: '4K' })
    expect(rows).toContainEqual({ label: '请求尺寸', value: '当前组合不可用' })
    expect(rows.find((row) => row.label === '分辨率提示')?.value).toContain('保留的 4K 当前不可用')
  })
})

describe('inspector image tool parameters', () => {
  it('summarizes crop geometry and transformations without changing the saved recipe', () => {
    const recipe = { ...defaultImageTransformRecipe('crop'), kind: 'crop' as const, x: .1, y: .25, width: .5, height: .75, outputWidth: 1200, outputHeight: 800, rotation: 90 as const, flipX: true, flipY: true }
    const input = { ...node, kind: 'image-crop', settings: { imageTransform: recipe } }
    expect(canvasInspectorParameterRows(input)).toEqual([
      { label: '图像工具', value: '裁剪图片' }, { label: '输出尺寸', value: '1200 × 800' },
      { label: '裁剪起点', value: 'X 10% · Y 25%' }, { label: '裁剪范围', value: '宽 50% · 高 75%' },
      { label: '旋转', value: '90°' }, { label: '翻转', value: '水平、垂直' },
    ])
    expect(input.settings.imageTransform).toBe(recipe)
    expect(recipe.x).toBe(.1)
  })

  it('distinguishes crop output dimensions from an existing result', () => {
    const rows = canvasInspectorParameterRows({ ...node, kind: 'image-crop', settings: {}, previewAsset: { kind: 'image', width: 512, height: 768 } })
    expect(rows).toContainEqual({ label: '输出尺寸', value: '1024 × 1024' })
    expect(rows).toContainEqual({ label: '产物尺寸', value: '512 × 768' })
  })

  it.each(['collage', 'tile'] as const)('shows the saved %s layout, fit and background', (kind) => {
    const recipe = { ...defaultImageTransformRecipe(kind), rows: 2, columns: 4, gap: 8, outputWidth: 1600, outputHeight: 900, fit: 'contain', background: '#abcdef', ...(kind === 'tile' ? { mirrorAlternate: true } : { padding: 12 }) }
    const rows = canvasInspectorParameterRows({ ...node, kind: `image-${kind}`, settings: { imageTransform: recipe } })
    expect(rows).toContainEqual({ label: '输出尺寸', value: '1600 × 900' })
    expect(rows).toContainEqual({ label: '排列', value: '2 行 × 4 列' })
    expect(rows).toContainEqual({ label: '间距', value: '8 像素' })
    expect(rows).toContainEqual({ label: '图片填充', value: '保留完整图片' })
    expect(rows).toContainEqual({ label: '背景', value: '#ABCDEF' })
    expect(rows).toContainEqual(kind === 'tile' ? { label: '交替镜像', value: '开启' } : { label: '边距', value: '12 像素' })
  })

  it('preserves the complete legacy collage summary without inventing style defaults', () => {
    expect(canvasInspectorParameterRows({ ...node, kind: 'image-collage', settings: { imageTransform: defaultImageTransformRecipe('collage') } })).toEqual([
      { label: '图像工具', value: '拼图' }, { label: '输出尺寸', value: '1024 × 1024' },
      { label: '排列', value: '2 行 × 2 列' }, { label: '间距', value: '16 像素' }, { label: '边距', value: '16 像素' },
      { label: '图片填充', value: '填满格子（居中裁切）' }, { label: '背景', value: '#FFFFFF' },
    ])
  })

  it.each([['grid', '网格'], ['horizontal', '横向拼接'], ['vertical', '纵向拼接'], ['hero-left', '主图在左'], ['hero-top', '主图在上']] as const)('describes %s without showing inactive grid dimensions', (layout, label) => {
    const recipe = { ...defaultImageTransformRecipe('collage'), layout }
    const rows = canvasInspectorParameterRows({ ...node, kind: 'image-collage', settings: { imageTransform: recipe } })
    expect(rows).toContainEqual({ label: '拼图布局', value: label })
    expect(rows.some((row) => row.label === '排列')).toBe(layout === 'grid')
    expect(rows).toContainEqual({ label: '输出尺寸', value: '1024 × 1024' })
  })

  it.each(['horizontal', 'vertical'] as const)('separates automatic %s output from the stored placeholder and actual result', (layout) => {
    const recipe = { ...defaultImageTransformRecipe('collage'), layout, autoSize: true, outputWidth: 800, outputHeight: 600 }
    const input = { ...node, kind: 'image-collage', settings: { imageTransform: recipe }, previewAsset: { kind: 'image' as const, width: 3253, height: 640 } }
    const before = JSON.stringify(input)
    const rows = canvasInspectorParameterRows(input)
    expect(rows).toContainEqual({ label: '输出尺寸', value: '自动 · 按输入图片比例计算（最长边不超过 4096 像素）' })
    expect(rows).toContainEqual({ label: '产物尺寸', value: '3253 × 640' })
    expect(rows.some((row) => row.value.includes('800 × 600'))).toBe(false)
    expect(JSON.stringify(input)).toBe(before)
    expect(canvasInspectorParameterRows({ ...input, settings: { imageTransform: { ...recipe, autoSize: false } } })).toContainEqual({ label: '输出尺寸', value: '800 × 600' })
  })

  it('summarizes saved collage styles and preserves explicit zero or disabled options', () => {
    const recipe: ImageCollageRecipe = { kind: 'collage', rows: 2, columns: 2, gap: 16, padding: 16, outputWidth: 1024, outputHeight: 1024, fit: 'cover', background: 'transparent', cornerRadius: 24, borderWidth: 4, borderColor: '#abcdef80', shadow: true, watermark: { text: '星芒品牌', color: '#123abc', opacity: .375, fontSize: 24 } }
    const input = { ...node, kind: 'image-collage', settings: { imageTransform: recipe } }
    const before = JSON.stringify(recipe)
    const rows = canvasInspectorParameterRows(input)
    expect(rows).toContainEqual({ label: '圆角', value: '24 像素' })
    expect(rows).toContainEqual({ label: '边框', value: '4 像素 · #ABCDEF80' })
    expect(rows).toContainEqual({ label: '图片阴影', value: '开启' })
    expect(rows).toContainEqual({ label: '文字水印', value: '“星芒品牌” · #123ABC · 不透明度 37.5% · 24 像素 · 斜向平铺' })
    expect(JSON.stringify(recipe)).toBe(before)
    const disabled = canvasInspectorParameterRows({ ...input, settings: { imageTransform: { ...recipe, cornerRadius: 0, borderWidth: 0, shadow: false, watermark: { ...recipe.watermark!, opacity: 0 } } } })
    expect(disabled).toContainEqual({ label: '圆角', value: '0 像素' })
    expect(disabled).toContainEqual({ label: '边框', value: '关闭' })
    expect(disabled).toContainEqual({ label: '图片阴影', value: '关闭' })
    expect(disabled.find((row) => row.label === '文字水印')?.value).toContain('不透明度 0%')
    expect(disabled.find((row) => row.label === '文字水印')?.value).toContain('（不绘制）')
    expect(canvasInspectorParameterRows({ ...input, settings: { imageTransform: { ...recipe, watermark: { ...recipe.watermark!, text: '' } } } })).toContainEqual({ label: '文字水印', value: '未填写文字（不绘制）' })
  })

  it('reports grid count without inventing dimensions before input pixels are known', () => {
    const input = { ...node, kind: 'image-grid-split', settings: { imageTransform: { kind: 'grid-split', rows: 3, columns: 3, gap: 0, padding: 0 } } }
    const rows = canvasInspectorParameterRows(input)
    expect(rows).toContainEqual({ label: '切片数量', value: '9 张' })
    expect(rows.some((row) => row.label.includes('尺寸'))).toBe(false)
    expect(canvasInspectorParameterRows({ ...input, previewAsset: { kind: 'image', width: 201, height: 134 } })).toContainEqual({ label: '选中切片尺寸', value: '201 × 134' })
  })

  it('distinguishes automatic, explicitly empty and mixed content layer stacks', () => {
    const recipe = defaultImageTransformRecipe('layer') as ImageLayerRecipe
    const input = { ...node, kind: 'image-layer', settings: { imageTransform: recipe } }
    expect(canvasInspectorParameterRows(input)).toContainEqual({ label: '图层', value: '按上游每张图片自动建立' })
    expect(canvasInspectorParameterRows({ ...input, settings: { imageTransform: { ...recipe, explicitLayers: true } } })).toContainEqual({ label: '画布内容', value: '空白画布' })
    const base = { sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over' as const, visible: true }
    const layers: ImageLayerRecipe['layers'] = [base, { ...base, visible: false, content: { kind: 'text', text: '产品', color: '#ffffff', fontSize: 16, fontFamily: 'sans-serif', fontWeight: 400, align: 'left' } }, { ...base, opacity: 0, content: { kind: 'shape', shape: 'rectangle', fill: '#ffffff', stroke: 'transparent', strokeWidth: 0 } }]
    const rows = canvasInspectorParameterRows({ ...input, settings: { imageTransform: { ...recipe, layers } } })
    expect(rows).toContainEqual({ label: '图层数量', value: '3 层' })
    expect(rows).toContainEqual({ label: '图层内容', value: '图片 1 · 文字 1 · 形状 1' })
    expect(rows).toContainEqual({ label: '可见图层', value: '1 层' })
  })

  it('keeps invalid tool settings reviewable instead of throwing or showing invented defaults', () => {
    const rows = canvasInspectorParameterRows({ ...node, kind: 'image-layer', settings: { imageTransform: defaultImageTransformRecipe('crop') } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ label: '参数状态', value: '图像工具参数与节点类型不匹配' })
  })

  it('reports persisted paint and eraser operations separately from removable masks', () => {
    const stroke = { points: [[2000, 3000], [4000, 5000]] as Array<[number, number]>, size: 30, hardness: 1, opacity: .5, color: '#ff8800', space: { width: 800, height: 600 } }
    const recipe: ImageLayerRecipe = { kind: 'layer', outputWidth: 800, outputHeight: 600, background: 'transparent', explicitLayers: true, layers: [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 45, opacity: 1, blend: 'source-over', visible: true, content: { kind: 'paint' }, edits: { version: 1, operations: [{ ...stroke, mode: 'paint' }, { ...stroke, mode: 'erase' }] }, mask: { kind: 'ellipse', transform: [.5, 0, 0, .5, .25, .25], inverted: true } }] }
    const before = JSON.stringify(recipe)
    const rows = canvasInspectorParameterRows({ ...node, kind: 'image-layer', settings: { imageTransform: recipe } })
    expect(rows).toContainEqual({ label: '图层内容', value: '图片 0 · 文字 0 · 形状 0 · 绘画 1' })
    expect(rows).toContainEqual({ label: '绘画编辑', value: '画笔 1 笔 · 擦除 1 笔' })
    expect(rows).toContainEqual({ label: '图层蒙版', value: '1 个 · 可在图层编辑器中移除' })
    expect(JSON.stringify(recipe)).toBe(before)
  })

  it.each([['slider', '滑动对比'], ['side-by-side', '并排对比'], ['grid', '四图对比'], ['opacity', '透明叠加'], ['toggle', '点按切换'], ['unknown', '滑动对比']])('reflects compare mode %s with the same fallback as the node', (mode, label) => {
    expect(canvasInspectorParameterRows({ ...node, kind: 'image-compare', settings: { imageCompare: { mode } } })).toContainEqual({ label: '对比模式', value: label })
  })

  it('identifies panorama viewing without claiming its transient camera state is persisted', () => {
    const rows = canvasInspectorParameterRows({ ...node, kind: 'image-panorama', settings: { imagePanorama: { fov: 999 } } })
    expect(rows).toContainEqual({ label: '图像工具', value: '360° 全景预览' })
    expect(rows).toContainEqual({ label: '图片格式', value: '等距柱状全景图' })
    expect(JSON.stringify(rows)).not.toContain('999')
  })
})


describe('inspector persisted video parameters', () => {
  it('uses saved native choices instead of obsolete fixed dimensions and preserves explicit silent audio', () => {
    const input = { kind: 'video-generate', prompt: '镜头', model: 'doubao-seedance-2-0-mini-260615', size: '1280x720', seconds: '15', settings: { videoMode: 'ref2va', videoAspectRatio: '9:16', videoResolution: '480p', generateAudio: false } }
    const before = structuredClone(input), rows = canvasInspectorParameterRows(input)
    expect(rows).toContainEqual({ label: '生成模式', value: 'Ref2VA · 多模态参考' })
    expect(rows).toContainEqual({ label: '比例', value: '9:16' })
    expect(rows).toContainEqual({ label: '清晰度', value: '480p' })
    expect(rows).toContainEqual({ label: '时长', value: '15 秒' })
    expect(rows).toContainEqual({ label: '生成音频', value: '关闭（已保存）' })
    expect(rows.some((row) => row.value.includes('16:9'))).toBe(false)
    expect(input).toEqual(before)
  })
  it('shows shared Seedance defaults without letting an inactive old size replace adaptive ratio', () => {
    const rows = canvasInspectorParameterRows({ kind: 'video', prompt: '', model: 'doubao-seedance-2-0-mini-260615', size: '1280x720', settings: {} })
    expect(rows).toContainEqual({ label: '比例', value: '自适应' })
    expect(rows).toContainEqual({ label: '清晰度', value: '720p' })
    expect(rows).toContainEqual({ label: '时长', value: '5 秒' })
    expect(rows).toContainEqual({ label: '生成音频', value: '使用服务默认设置' })
  })
  it('retains unsupported saved options for review and does not invent inherited model defaults', () => {
    const input = { kind: 'video', prompt: '', model: '', settings: { videoMode: 'future-mode', videoResolution: '1080p', videoAspectRatio: '7:9', generateAudio: true } }
    const rows = canvasInspectorParameterRows(input)
    expect(rows).toContainEqual({ label: '模型', value: '继承项目生成配置' })
    expect(rows).toContainEqual({ label: '生成模式', value: 'future-mode' })
    expect(rows).toContainEqual({ label: '清晰度', value: '1080p' })
    expect(rows).toContainEqual({ label: '比例', value: '7:9' })
    expect(rows).toContainEqual({ label: '生成音频', value: '开启（已保存）' })
    expect(canvasInspectorParameterRows({ ...input, settings: {}, size: '1280x720' })).toContainEqual({ label: '比例', value: '由实际模型与输入确定' })
  })
})
