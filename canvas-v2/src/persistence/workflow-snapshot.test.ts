import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, type WorkflowFile } from '../model'
import { maximumPromptLength } from './workflow-schema'
import { parseWorkflowFile } from './workflow-serializer'
import { canvasWorkflowSnapshotNeedsSave, inspectCanvasWorkflowSnapshot } from './workflow-snapshot'

function documentWithNote(text: unknown): WorkflowFile {
  return { ...createEmptyWorkflow('编辑中的工程'), nodes: [{ id: 'note', kind: 'note', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle', settings: { text } } }] }
}

describe('editable workflow snapshot inspection', () => {
  it.each([
    ['oversized note', '文'.repeat(maximumPromptLength + 1)],
    ['NUL note', '正文\0仍在编辑'],
    ['non-string note', 12],
  ])('returns a failed editable snapshot instead of throwing during render for %s', (_label, text) => {
    const workflow = documentWithNote(text)
    const before = structuredClone(workflow)
    const snapshot = inspectCanvasWorkflowSnapshot(workflow)
    expect(snapshot.content).toBeNull()
    expect(snapshot.errorMessage).toContain('便签正文')
    expect(snapshot.errorMessage).toContain('保存未完成')
    expect(workflow).toEqual(before)
    expect(workflow.nodes[0].data.settings?.text).toBe(text)
    expect(canvasWorkflowSnapshotNeedsSave(snapshot, null)).toBe(true)
  })

  it('does not classify invalid edited text as saved after an earlier valid save completes', async () => {
    const original = inspectCanvasWorkflowSnapshot(documentWithNote('已保存的有效正文'))
    if (original.content === null) throw new Error('测试前置快照错误')
    const edited = documentWithNote('文'.repeat(maximumPromptLength + 1))
    const latest = inspectCanvasWorkflowSnapshot(edited)
    const confirmed = await Promise.resolve(original.content)
    expect(canvasWorkflowSnapshotNeedsSave(latest, confirmed)).toBe(true)
    expect(latest.content).toBeNull()
    expect(parseWorkflowFile(confirmed)?.nodes[0].data.settings?.text).toBe('已保存的有效正文')
    expect(edited.nodes[0].data.settings?.text).toBe('文'.repeat(maximumPromptLength + 1))
  })

  it('becomes saveable again when the existing editable note is corrected without truncating it', () => {
    const workflow = documentWithNote('文'.repeat(maximumPromptLength + 1))
    expect(inspectCanvasWorkflowSnapshot(workflow).content).toBeNull()
    const corrected = 'https://example.invalid/来源\n<p>纯文本</p>\n'.repeat(500)
    workflow.nodes[0].data.settings = { text: corrected }
    const snapshot = inspectCanvasWorkflowSnapshot(workflow)
    expect(snapshot.errorMessage).toBeNull()
    if (snapshot.content === null) throw new Error('修正后的快照应可保存')
    expect(parseWorkflowFile(snapshot.content)?.nodes[0].data.settings?.text).toBe(corrected)
    expect(canvasWorkflowSnapshotNeedsSave(snapshot, snapshot.content)).toBe(false)
    expect(canvasWorkflowSnapshotNeedsSave(snapshot, '另一份已保存内容')).toBe(true)
  })
})
