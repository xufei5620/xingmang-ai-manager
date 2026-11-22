import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, type WorkflowFile, type WorkflowNode } from '../model'
import { parseProjectImport } from '../lib/workflow-import'
import { persistedSettings, toPersistedWorkflowV2 } from './workflow-schema'
import { sanitizeWorkflowV2 } from './workflow-sanitizer'
import { parseWorkflowFile, serializeWorkflow } from './workflow-serializer'

function labelledWorkflow(kind: WorkflowNode['kind'], settings: Record<string, unknown>): WorkflowFile {
  return {
    ...createEmptyWorkflow('名字原样保存'),
    nodes: [{ id: 'labelled', kind, definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle', settings } }],
  }
}

function settingsAfterRoundTrip(workflow: WorkflowFile): Record<string, unknown> | undefined {
  const reopened = parseWorkflowFile(serializeWorkflow(workflow))
  if (!reopened) throw new Error('测试工作流解析失败')
  return reopened.nodes[0].data.settings
}

// What people type as a name or a style: a link, a slash command, a drive, a step label.
const labels = [
  'https://www.xiaohongshu.com/explore/1 的配色',
  '参考 https://example.invalid/brief',
  '/imagine 赛博朋克',
  'D:\\素材\\猫',
  '\\\\server\\share',
  'Step1: 出图',
  'data:先放这里',
  'file:草稿',
  '/Users/example/项目',
]

describe('label settings persistence (#1368 item 4)', () => {
  it.each(['image-generate', 'prompt', 'note', 'image-input'] as const)('keeps a %s node name exactly as typed through save, reopen and project import', (kind) => {
    for (const title of labels) {
      const workflow = labelledWorkflow(kind, { title })
      expect(toPersistedWorkflowV2(workflow).nodes[0].data.settings?.title, title).toBe(title)
      expect(settingsAfterRoundTrip(workflow)?.title, title).toBe(title)
      expect(parseProjectImport(serializeWorkflow(workflow)).workflow.nodes[0].data.settings?.title, title).toBe(title)
    }
  })

  it('keeps a group name and a drama bible style exactly as typed', () => {
    for (const label of labels) {
      expect(settingsAfterRoundTrip(labelledWorkflow('group', { title: label }))?.title, label).toBe(label)
      const bible = settingsAfterRoundTrip(labelledWorkflow('drama-bible', { stylePrompt: label, aspectRatio: '16:9' }))
      expect(bible?.stylePrompt, label).toBe(label)
      expect(bible?.aspectRatio).toBe('16:9')
    }
  })

  it('keeps the length and NUL rules on names', () => {
    expect(settingsAfterRoundTrip(labelledWorkflow('group', { title: '组'.repeat(10_000) }))?.title).toBe('组'.repeat(10_000))
    expect(toPersistedWorkflowV2(labelledWorkflow('group', { title: '组'.repeat(10_001), color: 'blue' })).nodes[0].data.settings).toEqual({ color: 'blue' })
    for (const title of ['组'.repeat(10_001), '分\0组']) {
      expect(settingsAfterRoundTrip(labelledWorkflow('group', { title, color: 'blue' }))).toEqual({ color: 'blue' })
      const sanitized = sanitizeWorkflowV2({ schemaVersion: 2, name: 'x', nodes: labelledWorkflow('group', { title, color: 'blue' }).nodes, edges: [] })
      expect(sanitized?.workflow.nodes[0].data.settings).toEqual({ color: 'blue' })
    }
  })

  it('keeps the location rule on every other key, on nested names and on other kinds\' style lines', () => {
    const workflow = labelledWorkflow('drama-bible', {
      title: 'https://example.invalid/kept',
      worldTone: 'https://example.invalid/world',
      source: 'D:\\素材\\猫.png',
      nested: { title: '/Users/example/private', useful: '保留' },
    })
    const expected = { title: 'https://example.invalid/kept', nested: { useful: '保留' } }
    expect(toPersistedWorkflowV2(workflow).nodes[0].data.settings).toEqual(expected)
    expect(settingsAfterRoundTrip(workflow)).toEqual(expected)
    const style = 'https://example.invalid/style'
    expect(settingsAfterRoundTrip(labelledWorkflow('drama-shot', { stylePrompt: style, action: '走' }))).toEqual({ action: '走' })
    expect(persistedSettings({ title: style })).toBeUndefined()
  })

  it('keeps credential keys out even when a name looks harmless', () => {
    const serialized = serializeWorkflow(labelledWorkflow('group', { title: '分组', apiKey: 'must-not-survive', password: 'must-not-survive' }))
    expect(serialized).not.toContain('must-not-survive')
    expect(parseWorkflowFile(serialized)?.nodes[0].data.settings).toEqual({ title: '分组' })
  })

  it('does not extend name privileges to placeholder nodes or wire kinds the kernel does not know', () => {
    const placeholder = labelledWorkflow('unknown', { title: 'https://example.invalid/source', color: 'blue' })
    placeholder.nodes[0].unknownKind = 'future-node'
    expect(toPersistedWorkflowV2(placeholder).nodes[0].data.settings).toEqual({ color: 'blue' })
    const unknownWire = { id: 'future', kind: 'future-node', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', settings: { title: 'https://example.invalid/source', color: 'blue' } } }
    const sanitized = sanitizeWorkflowV2({ schemaVersion: 2, name: 'x', nodes: [unknownWire], edges: [] })
    expect(sanitized?.workflow.nodes[0].data.settings).toEqual({ color: 'blue' })
  })
})
