import { describe, expect, it, vi } from 'vitest'
import { createEmptyWorkflow, serializeWorkflow } from '../model'
import { clearSavedTemplateProjectSubmission, createTemplateProjectSubmission, readSavedTemplateProjectSubmission, templateProjectOperationId, writeSavedTemplateProjectSubmission, type SavedTemplateProjectSubmission, type TemplateProjectSubmissionStorage } from './template-project-creation'

const operationId = '11111111-1111-4111-8111-111111111111'

function memoryStorage() {
  const values = new Map<string, string>()
  const storage = { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value) }), removeItem: vi.fn((key: string) => { values.delete(key) }) }
  return { values, storage }
}

function savedSubmission(overrides: Partial<SavedTemplateProjectSubmission> = {}): SavedTemplateProjectSubmission {
  const workflow = createEmptyWorkflow('用户已填写的原模板工程')
  workflow.nodes = [{ id: `${operationId}-1`, kind: 'note', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle', settings: { text: '原始长剧本与特殊字符：\n中文 "引号" 保留' } } }]
  return { version: 1, ownerId: 123, templateId: 'xingmang-drama-script-parse', operationId, signature: JSON.stringify({ templateId: 'xingmang-drama-script-parse', values: { script: '用户的原始内容' }, draft: false }), content: serializeWorkflow(workflow), ...overrides }
}

describe('template project confirmation and uncertain creation', () => {
  it('makes no workflow or project until confirmation, and blocks overlapping submissions', () => {
    const build = vi.fn(() => 'complete graph')
    const controller = createTemplateProjectSubmission()
    expect(build).not.toHaveBeenCalled()
    expect(controller.prepare(operationId, 'configuration', build).content).toBe('complete graph')
    expect(() => controller.prepare(operationId, 'configuration', build)).toThrow('仍在创建')
    expect(build).toHaveBeenCalledOnce()
  })

  it('reuses the exact graph and operation after an uncertain response, including its node identifiers', () => {
    const controller = createTemplateProjectSubmission()
    const first = controller.prepare(operationId, 'configuration', () => '{"nodes":[{"id":"first"}]}')
    controller.settled()
    const build = vi.fn(() => '{"nodes":[{"id":"second"}]}')
    expect(controller.prepare(operationId, 'configuration', build)).toBe(first)
    expect(build).not.toHaveBeenCalled()
    controller.settled()
    expect(() => controller.prepare(operationId, 'changed configuration', build)).toThrow('原配置')
    expect(() => controller.prepare('another operation', 'configuration', build)).toThrow('原配置')
    expect(build).not.toHaveBeenCalled()
  })

  it('permits a new creation only after its previous receipt was confirmed', () => {
    const controller = createTemplateProjectSubmission()
    controller.prepare(operationId, 'first', () => 'first graph')
    controller.confirmed()
    expect(controller.prepare(operationId, 'next', () => 'next graph').content).toBe('next graph')
  })

  it('retains a persisted valid operation through a page reload and rejects malformed route identifiers', () => {
    const createId = vi.fn(() => operationId)
    expect(templateProjectOperationId(new URLSearchParams(`templateOperation=${operationId}`), createId)).toBe(operationId)
    expect(createId).not.toHaveBeenCalled()
    for (const value of ['', 'foreign-path', '11111111-1111-1111-1111-111111111111', `${operationId}\n`]) expect(templateProjectOperationId(new URLSearchParams({ templateOperation: value }), createId)).toBe(operationId)
    expect(createId).toHaveBeenCalledTimes(4)
  })

  it('normalizes an uppercase route operation before it reaches the lowercase server identifier', () => {
    const uppercase = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    expect(templateProjectOperationId(new URLSearchParams(`templateOperation=${uppercase}`), () => operationId)).toBe(uppercase.toLowerCase())
  })
})

describe('account scoped exact template creation recovery', () => {
  it('restores the exact submitted signature and graph after a complete reload, without rebuilding defaults', () => {
    const { storage } = memoryStorage()
    const original = savedSubmission({ content: `${savedSubmission().content}\n  ` })
    writeSavedTemplateProjectSubmission(storage, original)
    const reloaded = readSavedTemplateProjectSubmission(storage, original.ownerId, operationId)
    expect(reloaded).toEqual(original)
    expect(reloaded?.content).toBe(original.content)
    expect(reloaded?.signature).toBe(original.signature)
    expect(storage.setItem).toHaveBeenCalledOnce()
    writeSavedTemplateProjectSubmission(storage, original)
    expect(storage.setItem).toHaveBeenCalledOnce()
  })

  it('isolates the recovery key by numeric owner and rejects a record forged under another owner key', () => {
    const { storage, values } = memoryStorage()
    const original = savedSubmission()
    writeSavedTemplateProjectSubmission(storage, original)
    expect(readSavedTemplateProjectSubmission(storage, 124, operationId)).toBeNull()
    const [key] = values.keys()
    values.set(key.replace(':123:', ':124:'), JSON.stringify(original))
    expect(() => readSavedTemplateProjectSubmission(storage, 124, operationId)).toThrow('恢复记录无法读取')
    expect(readSavedTemplateProjectSubmission(storage, 123, operationId)).toEqual(original)
  })

  it('refuses changed configuration, content or template while preserving the original record', () => {
    const { storage } = memoryStorage()
    const original = savedSubmission()
    writeSavedTemplateProjectSubmission(storage, original)
    for (const changed of [{ ...original, signature: 'changed' }, { ...original, content: serializeWorkflow(createEmptyWorkflow('新默认图')) }, { ...original, templateId: 'another-template' }]) {
      expect(() => writeSavedTemplateProjectSubmission(storage, changed)).toThrow('不会覆盖')
    }
    expect(storage.setItem).toHaveBeenCalledOnce()
    expect(readSavedTemplateProjectSubmission(storage, original.ownerId, operationId)).toEqual(original)
  })

  it('rejects malformed scopes, versions, workflow content and unexpected fields before writing', () => {
    const { storage } = memoryStorage()
    const original = savedSubmission()
    const invalid: unknown[] = [
      { ...original, version: 2 }, { ...original, ownerId: 0 }, { ...original, ownerId: 1.5 }, { ...original, ownerId: Number.MAX_SAFE_INTEGER + 1 },
      { ...original, operationId: '../outside' }, { ...original, operationId: '11111111-1111-1111-1111-111111111111' }, { ...original, operationId: `${operationId}\n` }, { ...original, templateId: '../outside' }, { ...original, templateId: 'valid-looking-id\n' },
      { ...original, content: '{}' }, { ...original, content: 'invalid-json' }, { ...original, signature: ' ' }, { ...original, accessToken: 'synthetic-untrusted-field' },
    ]
    for (const input of invalid) expect(() => writeSavedTemplateProjectSubmission(storage, input as SavedTemplateProjectSubmission)).toThrow()
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('uses UTF8 content budgets and accepts an exact 2MiB valid document without normalizing its digest input', () => {
    const { storage } = memoryStorage()
    const original = savedSubmission()
    const limit = 2 * 1024 * 1024
    const exact = { ...original, content: original.content + ' '.repeat(limit - new TextEncoder().encode(original.content).byteLength) }
    writeSavedTemplateProjectSubmission(storage, exact)
    expect(readSavedTemplateProjectSubmission(storage, original.ownerId, operationId)?.content).toBe(exact.content)
    const fresh = memoryStorage().storage
    expect(() => writeSavedTemplateProjectSubmission(fresh, { ...original, content: `${exact.content} ` })).toThrow('2 MB')
    expect(() => writeSavedTemplateProjectSubmission(fresh, { ...original, content: `${original.content}${'中'.repeat(700_000)}` })).toThrow('2 MB')
    expect(() => writeSavedTemplateProjectSubmission(fresh, { ...original, signature: '中'.repeat(700_000) })).toThrow('2 MB')
    expect(fresh.setItem).not.toHaveBeenCalled()
  })

  it('fails closed on quota errors and silent storage writes so no creation can follow', () => {
    const original = savedSubmission()
    for (const storage of [
      { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: () => undefined },
      { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    ] satisfies TemplateProjectSubmissionStorage[]) {
      const create = vi.fn()
      expect(() => { writeSavedTemplateProjectSubmission(storage, original); create() }).toThrow('本地模板配置保存失败')
      expect(create).not.toHaveBeenCalled()
    }
  })

  it('refuses corrupted or blocked storage without overwriting the unknown previous operation', () => {
    const { storage, values } = memoryStorage()
    const original = savedSubmission()
    writeSavedTemplateProjectSubmission(storage, original)
    const [key] = values.keys()
    values.set(key, '{broken')
    expect(() => readSavedTemplateProjectSubmission(storage, 123, operationId)).toThrow('恢复记录无法读取')
    expect(() => writeSavedTemplateProjectSubmission(storage, original)).toThrow('恢复记录无法读取')
    expect(values.get(key)).toBe('{broken')
    expect(storage.setItem).toHaveBeenCalledOnce()
    storage.getItem.mockImplementation(() => { throw new Error('denied') })
    expect(() => readSavedTemplateProjectSubmission(storage, 123, operationId)).toThrow('恢复记录无法读取')
  })

  it('checks readback content rather than trusting a successful setItem call', () => {
    const { storage, values } = memoryStorage()
    const original = savedSubmission()
    storage.setItem.mockImplementation((key) => { values.set(key, JSON.stringify({ ...original, signature: 'different readback' })) })
    expect(() => writeSavedTemplateProjectSubmission(storage, original)).toThrow('本地模板配置保存失败')
  })

  it('clears only the identical acknowledged record and retains changed or differently owned records', () => {
    const { storage } = memoryStorage()
    const original = savedSubmission()
    writeSavedTemplateProjectSubmission(storage, original)
    clearSavedTemplateProjectSubmission(storage, { ...original, signature: 'old acknowledgement' })
    clearSavedTemplateProjectSubmission(storage, { ...original, content: serializeWorkflow(createEmptyWorkflow('旧图')) })
    clearSavedTemplateProjectSubmission(storage, { ...original, ownerId: 124 })
    expect(storage.removeItem).not.toHaveBeenCalled()
    expect(readSavedTemplateProjectSubmission(storage, original.ownerId, operationId)).toEqual(original)
    clearSavedTemplateProjectSubmission(storage, original)
    expect(storage.removeItem).toHaveBeenCalledOnce()
    expect(readSavedTemplateProjectSubmission(storage, original.ownerId, operationId)).toBeNull()
  })

  it('reports a failed recovery cleanup without claiming the original record disappeared', () => {
    const { storage } = memoryStorage()
    const original = savedSubmission()
    writeSavedTemplateProjectSubmission(storage, original)
    storage.removeItem.mockImplementation(() => { throw new Error('denied') })
    expect(() => clearSavedTemplateProjectSubmission(storage, original)).toThrow('恢复记录暂未清除')
    expect(readSavedTemplateProjectSubmission(storage, original.ownerId, operationId)).toEqual(original)
  })

  it('detects a silent no-op remove instead of claiming the original recovery record was cleared', () => {
    const { storage } = memoryStorage()
    const original = savedSubmission()
    writeSavedTemplateProjectSubmission(storage, original)
    storage.removeItem.mockImplementation(() => undefined)
    expect(() => clearSavedTemplateProjectSubmission(storage, original)).toThrow('恢复记录暂未清除')
    expect(readSavedTemplateProjectSubmission(storage, original.ownerId, operationId)).toEqual(original)
  })
})
