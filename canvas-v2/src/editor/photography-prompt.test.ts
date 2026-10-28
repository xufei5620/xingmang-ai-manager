import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow } from '../model'
import { applyPhotographyPrompt, emptyPhotographyDraft, photographyPresets, readPhotographyDraft } from './photography-prompt'

describe('photography prompt controls', () => {
  it('round trips editable photography choices without duplicating the block', () => {
    const draft = { ...emptyPhotographyDraft(), ...photographyPresets[0].values }
    const original = '保留商品轮廓与商标。\n参考图 @image1\n'
    const applied = applyPhotographyPrompt(original, draft)
    expect(readPhotographyDraft(applied)).toEqual(draft)
    expect(applyPhotographyPrompt(applied, draft)).toBe(applied)
    const changed = applyPhotographyPrompt(applied, { ...draft, angle: '正上方俯拍' })
    expect(changed.match(/【摄影设定】/g)).toHaveLength(1)
    expect(changed).toContain('拍摄角度：正上方俯拍')
    expect(applyPhotographyPrompt(changed, emptyPhotographyDraft())).toBe(original)
  })

  it('preserves unrelated text when removing an owned block', () => {
    const applied = applyPhotographyPrompt('产品正面', { ...emptyPhotographyDraft(), lighting: '影棚柔光箱' })
    expect(applyPhotographyPrompt(`${applied}\n保留原包装`, emptyPhotographyDraft())).toBe('产品正面\n保留原包装')
  })

  it('does not overwrite manually edited or ambiguous blocks', () => {
    const draft = { ...emptyPhotographyDraft(), lighting: '柔和自然光' }
    expect(() => applyPhotographyPrompt('【摄影设定】\n用户自写内容\n【摄影设定结束】', draft)).toThrow('手动修改')
    const applied = applyPhotographyPrompt('主体', draft)
    expect(() => applyPhotographyPrompt(`${applied}\n${applied}`, draft)).toThrow('手动修改')
  })

  it('rejects unsupported options and overflow without truncating the original prompt', () => {
    expect(() => applyPhotographyPrompt('主体', { ...emptyPhotographyDraft(), iso: 'arbitrary' })).toThrow('感光表现')
    const original = '文'.repeat(9998)
    expect(() => applyPhotographyPrompt(original, { ...emptyPhotographyDraft(), angle: '平视' })).toThrow('超过')
    expect(applyPhotographyPrompt(original, emptyPhotographyDraft())).toBe(original)
  })

  it('keeps applied choices through workflow persistence for execution and reuse', () => {
    const workflow = createEmptyWorkflow('摄影设定验收')
    const prompt = applyPhotographyPrompt('咖啡杯', { ...emptyPhotographyDraft(), ...photographyPresets[1].values })
    workflow.nodes.push({ id: 'image-node', kind: 'image-generate', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt, model: '', status: 'idle' } })
    const restored = parseWorkflowFile(serializeWorkflow(workflow))
    expect(restored?.nodes[0].data.prompt).toBe(prompt)
    expect(readPhotographyDraft(restored!.nodes[0].data.prompt)?.lens).toBe('35mm 环境视角')
  })
})
