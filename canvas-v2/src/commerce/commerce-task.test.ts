import { describe, expect, it } from 'vitest'
import { assertCommerceOutputSize, buildCommerceTaskPrompt, commerceStylePresets, defaultCommerceTask, parseCommerceTask, parseNodeCommerceTask, resolveCommerceImageRequest, resolveCommerceTargetSize, type CommerceTaskKind } from './commerce-task'

describe('commerce task contract and exact native dimensions', () => {
  it.each<CommerceTaskKind>(['material-a', 'material-b', 'style-preset', 'style-reference', 'product-view'])('round trips %s while keeping supplements separate', (kind) => {
    const task = defaultCommerceTask(kind)
    expect(parseCommerceTask(JSON.parse(JSON.stringify(task)))).toEqual(task)
    const prompt = buildCommerceTaskPrompt(task, '自由补充')
    expect(prompt).toContain('自由补充')
    expect(task).not.toHaveProperty('prompt')
    expect(task).not.toHaveProperty('assetId')
    expect(() => parseNodeCommerceTask('text-generate', task)).toThrow('不支持')
  })
  it.each([null, {}, { ...defaultCommerceTask('material-a'), version: 2 }, { ...defaultCommerceTask('material-a'), strength: NaN }, { ...defaultCommerceTask('material-a'), strength: -0.1 }, { ...defaultCommerceTask('material-b'), upscale: 2.1 }, { ...defaultCommerceTask('style-preset'), preset: 'unverified' }, { ...defaultCommerceTask('product-view'), view: 'orbit-3d' }, { ...defaultCommerceTask('material-a'), preserve: ['shape', 'shape'] }, { ...defaultCommerceTask('material-a'), preserve: ['identity'] }, { ...defaultCommerceTask('material-a'), hidden: true }])('rejects malformed or future controls %#', (value) => {
    expect(() => parseCommerceTask(value)).toThrow()
  })
  it('allows an explicitly empty preserve list and does not preserve composition by default for views', () => {
    expect(parseCommerceTask({ ...defaultCommerceTask('material-a'), preserve: [] }).preserve).toEqual([])
    expect(defaultCommerceTask('product-view').preserve).not.toContain('composition')
    expect(new Set(commerceStylePresets.map((preset) => preset.value)).size).toBe(11)
  })
  it('derives exactly 1024 square from an owned 512 square and a two-times intent', () => {
    const task = { ...defaultCommerceTask('material-b'), kind: 'material-b' as const, strength: .35, upscale: 2 }
    expect(resolveCommerceTargetSize(task, { width: 512, height: 512 })).toEqual({ width: 1024, height: 1024, size: '1024x1024' })
    expect(resolveCommerceImageRequest(task, { model: 'gpt-image-1', prompt: '', size: 'auto', imageResolution: '1K' }, { width: 512, height: 512 })).toMatchObject({ size: '1024x1024', imageResolution: '1K' })
    expect(() => assertCommerceOutputSize(task, { width: 512, height: 512 }, { width: 1024, height: 1024 })).not.toThrow()
    expect(() => assertCommerceOutputSize(task, { width: 512, height: 512 }, { width: 1024, height: 1023 })).toThrow('不能标记')
    expect(() => resolveCommerceImageRequest(task, { model: 'gpt-image-1', prompt: '', size: 'auto' }, { width: 192, height: 128 })).toThrow('当前模型无法精确输出派生尺寸 384x256；请更换原图、请求倍率或模型')
  })
  it.each([
    [{ model: 'gpt-image-1', size: 'auto' }, { width: 192, height: 128 }],
    [{ model: 'grok-imagine-image', size: 'auto' }, { width: 512, height: 512 }],
    [{ model: 'gpt-image-1', size: '1024x1024' }, { width: 512, height: 512 }],
    [{ model: 'gpt-image-2', size: 'auto', imageResolution: '2K' as const }, { width: 512, height: 512 }],
    [{ model: 'gpt-image-1', size: 'auto' }, undefined],
  ])('rejects impossible or conflicting upscale requests %#', (input, dimensions) => {
    expect(() => resolveCommerceImageRequest({ version: 1, kind: 'material-b', preserve: [], strength: .35, upscale: 2 }, { ...input, prompt: '' }, dimensions)).toThrow()
  })
  it('keeps strength in reviewable prose and never emits a native denoise control', () => {
    const result = resolveCommerceImageRequest(defaultCommerceTask('material-a'), { model: 'gpt-image-1', prompt: '保留原文', size: '1024x1024' })
    expect(result.prompt).toContain('35%')
    expect(result.prompt).toContain('保留原文')
    expect(result).not.toHaveProperty('strength')
    expect(result).not.toHaveProperty('denoise')
  })
})
