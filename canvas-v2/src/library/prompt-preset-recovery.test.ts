import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PromptPresetRecovery, type PromptPresetRecoveryProps } from '../components/PromptPresetRecovery'
import type { CanvasPromptPreset } from './prompt-preset-contract'
import { promptPresetSaveFailure, resumePromptPresetDraft } from './prompt-preset-recovery'

const latest: CanvasPromptPreset = { id: '12345678-1234-4123-8123-123456789abc', name: '服务器名称', prompt: '服务器正文', group: '最新分组', description: '最新简介', tags: [], version: 4, provenance: 'user-created', createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T01:00:00Z' }
function props(overrides: Partial<PromptPresetRecoveryProps> = {}): PromptPresetRecoveryProps { return { conflict: true, editing: true, latest, matched: false, readComplete: false, loading: false, onRead: vi.fn(), onKeep: vi.fn(), onReload: vi.fn(), ...overrides } }

describe('prompt preset save recovery', () => {
  it('distinguishes a definite version conflict from a rejected create and uncertain receipt', () => {
    const conflict = Object.assign(new Error('版本已变化'), { status: 409 })
    expect(promptPresetSaveFailure(conflict, true)).toMatchObject({ kind: 'conflict', message: expect.stringContaining('本次修改未保存') })
    expect(promptPresetSaveFailure(conflict, false).kind).toBe('rejected')
    expect(promptPresetSaveFailure(Object.assign(new Error('bad'), { status: 400 }), true).kind).toBe('rejected')
    expect(promptPresetSaveFailure(Object.assign(new Error('lost receipt'), { status: 503 }), true).kind).toBe('uncertain')
    expect(promptPresetSaveFailure(new Error('409 mentioned by unknown transport'), true).kind).toBe('uncertain')
  })

  it('requires an observed latest version before offering either explicit recovery action', () => {
    const input = props()
    const pending = renderToStaticMarkup(createElement(PromptPresetRecovery, input))
    expect(pending).toContain('版本冲突')
    expect(pending).toContain('本次修改未保存')
    expect(pending).not.toContain('保存结果待核对')
    expect(pending).toContain('读取最新版本')
    expect(pending).not.toContain('基于最新版本继续编辑')
    expect(pending).not.toContain(latest.prompt)
    const confirmed = renderToStaticMarkup(createElement(PromptPresetRecovery, { ...input, readComplete: true }))
    expect(confirmed).toContain('保留我的输入，基于最新版本继续编辑')
    expect(confirmed).toContain('放弃我的输入，加载服务器版本')
    expect(confirmed).toContain(latest.prompt)
    expect(confirmed).toContain('max-height:160px;overflow:auto')
    expect(input.onKeep).not.toHaveBeenCalled()
    expect(input.onReload).not.toHaveBeenCalled()
  })

  it('advances only the explicit keep action version while preserving every draft field', () => {
    const draft = { id: latest.id, expectedVersion: 2, name: '我的名称', prompt: '未丢失正文'.repeat(4000), group: '我的分组', description: '我的简介', tags: '自选标签' }
    const resumed = resumePromptPresetDraft(draft, latest)
    expect(resumed).toEqual({ ...draft, expectedVersion: 4 })
    expect(draft.expectedVersion).toBe(2)
    expect(() => resumePromptPresetDraft({ ...draft, id: 'other' }, latest)).toThrow('编号')
    expect(() => resumePromptPresetDraft({ ...draft, expectedVersion: 5 }, latest)).toThrow('较旧版本')
  })

  it('retains the uncertainty distinction for unknown writes and removed templates', () => {
    const uncertain = renderToStaticMarkup(createElement(PromptPresetRecovery, props({ conflict: false, latest: null, readComplete: true })))
    expect(uncertain).toContain('保存结果待核对')
    expect(uncertain).toContain('可能已被删除')
    expect(uncertain).not.toContain('基于最新版本继续编辑')
    const matched = renderToStaticMarkup(createElement(PromptPresetRecovery, props({ conflict: false, readComplete: true, matched: true })))
    expect(matched).toContain('已核对，编辑已保存条目')
    expect(matched).not.toContain('保留我的输入')
  })
})
