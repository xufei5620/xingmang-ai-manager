import { describe, expect, it, vi } from 'vitest'
import { savePromptPresetDraft } from './prompt-preset-edit'

describe('prompt preset editing', () => {
  it('waits for persisted confirmation before reporting success', async () => {
    let confirm: (() => void) | undefined
    const update = vi.fn(() => new Promise<void>((resolve) => { confirm = resolve }))
    let settled = false
    const saving = savePromptPresetDraft({ id: 'preset-1', name: ' 分镜 ', prompt: ' 保留内容 ' }, update).then((result) => { settled = true; return result })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(update).toHaveBeenCalledWith('preset-1', { name: '分镜', prompt: ' 保留内容 ' })
    confirm?.()
    await expect(saving).resolves.toEqual({ ok: true })
  })

  it('returns a failed receipt without discarding the original draft', async () => {
    const draft = { id: 'preset-1', name: '分镜', prompt: '编辑后尚未保存的内容' }
    const result = await savePromptPresetDraft(draft, () => Promise.reject(new Error('网络中断，请重试')))
    expect(result).toEqual({ ok: false, message: '网络中断，请重试' })
    expect(draft.prompt).toBe('编辑后尚未保存的内容')
  })

  it('does not persist an empty draft', async () => {
    const update = vi.fn()
    expect((await savePromptPresetDraft({ id: 'preset-1', name: ' ', prompt: '内容' }, update)).ok).toBe(false)
    expect((await savePromptPresetDraft({ id: 'preset-1', name: '名称', prompt: ' \r\n\t ' }, update)).ok).toBe(false)
    expect(update).not.toHaveBeenCalled()
  })

  it('includes the captured version and metadata without replacing them on a failed save', async () => {
    const draft = { id: 'preset-1', name: '标题', prompt: '正文', group: ' 电商 ', description: ' 场景说明 ', expectedVersion: 3 }
    const update = vi.fn().mockRejectedValue(new Error('其他页面已修改'))
    expect(await savePromptPresetDraft(draft, update)).toEqual({ ok: false, message: '其他页面已修改' })
    expect(update).toHaveBeenCalledWith('preset-1', { name: '标题', prompt: '正文', group: '电商', description: '场景说明', expectedVersion: 3 })
    expect(draft.expectedVersion).toBe(3)
    expect(draft.group).toBe(' 电商 ')
  })
})
