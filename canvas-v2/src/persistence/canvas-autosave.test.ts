import { describe, expect, it } from 'vitest'
import type { WorkflowFile } from '../model'
import { canvasAutosaveErrorMessage, canvasAutosaveGraphSignature, canvasAutosaveSignature } from './canvas-autosave'

function workflow(overrides: Partial<WorkflowFile> = {}): WorkflowFile {
  return {
    schemaVersion: 2,
    name: '测试',
    nodes: [],
    edges: [],
    ...overrides,
  }
}

describe('canvasAutosaveErrorMessage', () => {
  it('turns a locked-file IPC error into a stay-in-the-window warning', () => {
    expect(canvasAutosaveErrorMessage(
      new Error("Error invoking remote method 'canvas-host:save-project': Error: EPERM: operation not permitted, rename"),
    )).toContain('项目文件正被占用')
  })

  it('keeps an already localized occupancy error readable', () => {
    expect(canvasAutosaveErrorMessage(new Error('画布项目写入被系统占用，请稍后重试'))).toContain('请稍后再试')
  })

  it('passes other failures through without the invoke prefix', () => {
    expect(canvasAutosaveErrorMessage(
      new Error("Error invoking remote method 'canvas-host:save-project': Error: 画布项目已归档，无法保存"),
    )).toBe('自动保存失败：画布项目已归档，无法保存')
  })
})

describe('canvasAutosaveSignature', () => {
  it('ignores viewport-only movement so opening a project does not look dirty', () => {
    const empty = workflow({ mediaGroups: { image: '个四分组', video: 'grok' } })
    expect(canvasAutosaveSignature(workflow({ ...empty, viewport: { x: 0, y: 0, zoom: 1 } })))
      .toBe(canvasAutosaveSignature(workflow({ ...empty, viewport: { x: 80, y: -40, zoom: 0.85 } })))
    expect(canvasAutosaveGraphSignature(empty)).toBe(canvasAutosaveGraphSignature(
      workflow({ ...empty, viewport: { x: 120, y: 40, zoom: 1.2 } }),
    ))
  })

  it('treats a node or edge edit as a real save, but not a later media-group fill-in', () => {
    const opened = workflow()
    const withGroups = workflow({ mediaGroups: { image: '个四分组', video: 'grok' } })
    const withNode = workflow({
      nodes: [{
        id: 'n1',
        kind: 'image-generate',
        definitionVersion: 1,
        position: { x: 120, y: 120 },
        data: { prompt: '一只猫', model: '', status: 'idle' },
      }],
    })
    expect(canvasAutosaveSignature(opened)).not.toBe(canvasAutosaveSignature(withGroups))
    expect(canvasAutosaveGraphSignature(opened)).toBe(canvasAutosaveGraphSignature(withGroups))
    expect(canvasAutosaveGraphSignature(opened)).not.toBe(canvasAutosaveGraphSignature(withNode))
  })
})
