import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, type WorkflowFile, type WorkflowNode } from '../model'
import { parseProjectImport } from '../lib/workflow-import'
import { maximumPromptLength, persistedSettings, toPersistedWorkflowV2 } from './workflow-schema'
import { sanitizeWorkflowV2 } from './workflow-sanitizer'
import { parseWorkflowFile, parseWorkflowFileDetailed, serializeWorkflow } from './workflow-serializer'

function noteWorkflow(text: unknown, kind: WorkflowNode['kind'] = 'note'): WorkflowFile {
  return {
    ...createEmptyWorkflow('原工程说明'),
    nodes: [{ id: 'note-original', kind, definitionVersion: 1, position: { x: 20, y: 40 }, data: { prompt: '', model: '', status: 'idle', settings: { text, color: 'warm-white' } } }],
  }
}

function textFrom(workflow: WorkflowFile | null): unknown {
  if (!workflow) throw new Error('测试工作流解析失败')
  return workflow.nodes[0].data.settings?.text
}

describe('note text persistence boundaries', () => {
  it.each([
    ['URL prose', 'https://example.invalid/original-source?notice=1'],
    ['Unix path prose', '/Users/example/Documents/原工程说明.txt'],
    ['Windows path prose', 'C:\\Users\\example\\Documents\\原工程说明.txt'],
    ['HTML prose', '<p>原始 HTML 仅为文字</p><script>notExecuted()</script>\n链接 https://example.invalid'],
    ['long prose over 10k', '来源说明\n'.repeat(3_000)],
  ])('retains %s through parse, serialization and project import', (_label, text) => {
    const original = noteWorkflow(text)
    const wire = JSON.stringify(toPersistedWorkflowV2(original))
    expect(textFrom(parseWorkflowFile(wire))).toBe(text)
    const serialized = serializeWorkflow(original)
    expect(textFrom(parseWorkflowFile(serialized))).toBe(text)
    const imported = parseProjectImport(serialized)
    expect(textFrom(imported.workflow)).toBe(text)
    expect(textFrom(parseWorkflowFile(imported.content))).toBe(text)
    expect(original.nodes[0].data.settings?.text).toBe(text)
  })

  it('preserves empty text and the exact UTF-16 boundary without truncating valid prose', () => {
    for (const text of ['', '星'.repeat(maximumPromptLength), '🌟'.repeat(maximumPromptLength / 2)]) {
      expect(textFrom(parseWorkflowFile(serializeWorkflow(noteWorkflow(text))))).toBe(text)
      expect(toPersistedWorkflowV2(noteWorkflow(text)).nodes[0].data.settings?.text).toBe(text)
    }
  })

  it.each([
    ['oversized BMP text', '星'.repeat(maximumPromptLength + 1)],
    ['oversized UTF-16 text', '🌟'.repeat(maximumPromptLength / 2 + 1)],
    ['NUL text', '原工程\0说明'],
    ['numeric text', 12],
    ['structured text', { url: 'https://example.invalid' }],
  ])('rejects %s without replacing the original note text with an empty successful save', (_label, text) => {
    const workflow = noteWorkflow(text)
    const raw = { schemaVersion: 2, name: workflow.name, nodes: workflow.nodes, edges: [] }
    expect(sanitizeWorkflowV2(raw)).toBeNull()
    expect(parseWorkflowFileDetailed(JSON.stringify(raw))).toBeNull()
    expect(parseWorkflowFile(JSON.stringify(raw))).toBeNull()
    expect(() => parseProjectImport(JSON.stringify(raw))).toThrow('无法识别工作流')
    expect(() => toPersistedWorkflowV2(workflow)).toThrow('便签正文')
    expect(() => serializeWorkflow(workflow)).toThrow('保存未完成')
    expect(workflow.nodes[0].data.settings?.text).toBe(text)
  })

  it('fails serialization before an autosave callback can overwrite the saved document and keeps the edited note unchanged', () => {
    const previous = serializeWorkflow(noteWorkflow('原已保存正文'))
    const workflow = noteWorkflow('星'.repeat(maximumPromptLength + 1))
    const edited = structuredClone(workflow)
    let saved = previous
    let writes = 0
    function saveDocument(content: string) { writes += 1; saved = content }
    expect(() => saveDocument(serializeWorkflow(workflow))).toThrow('保存未完成')
    expect(writes).toBe(0)
    expect(saved).toBe(previous)
    expect(workflow).toEqual(edited)
  })

  it('rejects the complete source document when a later note is invalid while allowing a missing text field', () => {
    const workflow = noteWorkflow('先前有效正文')
    workflow.nodes.push({ ...noteWorkflow('无效\0正文').nodes[0], id: 'later-invalid-note' })
    expect(parseWorkflowFileDetailed(JSON.stringify({ ...workflow, schemaVersion: 2 }))).toBeNull()
    const omitted = noteWorkflow('')
    delete omitted.nodes[0].data.settings?.text
    expect(parseWorkflowFile(serializeWorkflow(omitted))?.nodes[0].data.settings).toEqual({ color: 'warm-white' })
    const presentUndefined = noteWorkflow(undefined)
    expect(() => serializeWorkflow(presentUndefined)).toThrow('保存未完成')
  })

  it('keeps structured credentials and nested text filtered even in a note node', () => {
    const workflow = noteWorkflow('apiKey=仅为原作者写下的文字\nhttps://example.invalid/notice')
    workflow.nodes[0].data.settings = {
      ...workflow.nodes[0].data.settings,
      apiKey: 'must-not-survive', authorization: 'must-not-survive',
      url: 'https://example.invalid/structured', filePath: '/Users/example/private',
      nested: { text: 'https://example.invalid/nested', password: 'must-not-survive', useful: '保留普通设置', deep: { text: '星'.repeat(10_001), refreshToken: 'must-not-survive' } },
    }
    const expected = { text: workflow.nodes[0].data.settings.text, color: 'warm-white', nested: { useful: '保留普通设置', deep: {} } }
    expect(toPersistedWorkflowV2(workflow).nodes[0].data.settings).toEqual(expected)
    const sanitized = sanitizeWorkflowV2({ schemaVersion: 2, name: workflow.name, nodes: workflow.nodes, edges: [] })
    expect(sanitized?.workflow.nodes[0].data.settings).toEqual(expected)
    const serialized = serializeWorkflow(workflow)
    expect(parseProjectImport(serialized).workflow.nodes[0].data.settings).toEqual(expected)
    expect(serialized).not.toContain('must-not-survive')
    expect(serialized).not.toContain('/Users/example/private')
    expect(serialized).not.toContain('/structured')
    expect(serialized).not.toContain('/nested')
  })

  it.each(['prompt', 'image-input', 'unknown'] as const)('does not grant note prose privileges to %s settings', (kind) => {
    for (const text of ['https://example.invalid/source', '/Users/example/private', '星'.repeat(10_001)]) {
      const workflow = noteWorkflow(text, kind)
      expect(toPersistedWorkflowV2(workflow).nodes[0].data.settings).toEqual({ color: 'warm-white' })
      const sanitized = sanitizeWorkflowV2({ schemaVersion: 2, name: workflow.name, nodes: workflow.nodes, edges: [] })
      expect(sanitized?.workflow.nodes[0].data.settings).toEqual({ color: 'warm-white' })
    }
    expect(persistedSettings({ text: 'https://example.invalid/source' })).toBeUndefined()
  })

  it('does not extend display-only privileges to placeholder nodes or alternate wire kinds', () => {
    const placeholder = noteWorkflow('https://example.invalid/source', 'unknown')
    placeholder.nodes[0].unknownKind = 'note'
    expect(toPersistedWorkflowV2(placeholder).nodes[0].data.settings).toEqual({ color: 'warm-white' })
    const alternate = noteWorkflow('https://example.invalid/source')
    alternate.nodes[0].unknownKind = 'future-node'
    expect(toPersistedWorkflowV2(alternate).nodes[0].data.settings).toEqual({ color: 'warm-white' })
  })
})
