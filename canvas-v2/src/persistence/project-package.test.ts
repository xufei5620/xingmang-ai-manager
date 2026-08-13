import { describe, expect, it } from 'vitest'
import type { WorkflowFile } from '../model'
import { parseXingCanvasProject, serializeXingCanvasProject } from './project-package'

const workflow: WorkflowFile = {
  schemaVersion: 2,
  name: '跨设备项目',
  nodes: [{
    id: 'image', kind: 'image-generate', definitionVersion: 1, position: { x: 10, y: 20 },
    data: {
      prompt: '产品图', model: 'gpt-image-2', status: 'succeeded',
      settings: { count: 4, apiKey: 'strip-me', source: 'C:\\private\\a.png' },
      result: { kind: 'image', assetId: 'A'.repeat(43), localUrl: 'C:\\private\\result.png', remoteUrl: 'https://private.invalid/x' },
    },
  }],
  edges: [],
}

describe('.xingcanvas project package', () => {
  it('round-trips a safe lightweight project without credentials or machine paths', () => {
    const content = serializeXingCanvasProject(workflow, { createdAt: '2026-08-13T00:00:00.000Z' })
    expect(content).not.toContain('strip-me')
    expect(content).not.toContain('private.invalid')
    expect(content).not.toContain('C:\\\\private')
    expect(parseXingCanvasProject(content)?.workflow.nodes[0]).toMatchObject({ kind: 'image-generate', data: { result: { assetId: 'A'.repeat(43) } } })
  })

  it('rejects damaged packages without returning a partial workflow', () => {
    expect(parseXingCanvasProject('{bad')).toBeNull()
    expect(parseXingCanvasProject(JSON.stringify({ packageVersion: 1, format: 'xingmang-canvas-project', createdAt: 'bad', workflow, licenses: [] }))).toBeNull()
  })

  it('retains bounded license notices', () => {
    const content = serializeXingCanvasProject(workflow, { licenses: [{ name: 'React Flow', license: 'MIT', notice: 'Copyright XYFlow' }] })
    expect(parseXingCanvasProject(content)?.licenses).toEqual([{ name: 'React Flow', license: 'MIT', notice: 'Copyright XYFlow' }])
  })
})
