import { describe, expect, it } from 'vitest'
import type { WorkflowFile } from '../model'
import { parseWorkflowFile, parseWorkflowFileDetailed, serializeWorkflow } from './workflow-serializer'
import { maximumWorkflowBytes } from './workflow-schema'

const stableAssetId = 'A'.repeat(43)

function v2Document(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    name: '测试工作流',
    nodes: [
      {
        id: 'text-1',
        kind: 'text',
        definitionVersion: 1,
        position: { x: 10, y: 20 },
        data: { prompt: '产品图', model: '' },
      },
      {
        id: 'image-1',
        kind: 'image',
        definitionVersion: 1,
        position: { x: 320, y: 20 },
        data: {
          prompt: '',
          model: 'gpt-image-1',
          result: {
            kind: 'image',
            assetId: stableAssetId,
            localUrl: `xingmang-asset://image/${stableAssetId}`,
            mimeType: 'image/png',
            width: 1024,
            height: 1024,
          },
        },
      },
    ],
    edges: [
      {
        id: 'edge-1',
        source: 'text-1',
        sourceHandle: 'out:text',
        target: 'image-1',
        targetHandle: 'in:text',
      },
    ],
    ...overrides,
  }
}

describe('workflow schema v2 parser', () => {
  it('migrates a v1 document and removes legacy remote-only assets', () => {
    const legacy = {
      schemaVersion: 1,
      name: '旧工作流',
      nodes: [
        {
          id: 'image-1',
          kind: 'image',
          position: { x: 1, y: 2 },
          data: {
            prompt: 'prompt',
            model: 'model',
            status: 'succeeded',
            errorMessage: 'must not survive',
            costQuota: 99,
            result: { kind: 'image', remoteUrl: 'data:image/png;base64,QUJD' },
          },
        },
      ],
      edges: [],
    }

    const result = parseWorkflowFile(JSON.stringify(legacy))

    expect(result).toEqual({
      schemaVersion: 2,
      name: '旧工作流',
      nodes: [
        {
          id: 'image-1',
          kind: 'image',
          definitionVersion: 1,
          position: { x: 1, y: 2 },
          data: { prompt: 'prompt', model: 'model', status: 'idle' },
        },
      ],
      edges: [],
    })
  })

  it('rejects oversized input before JSON parsing', () => {
    expect(parseWorkflowFile(' '.repeat(maximumWorkflowBytes + 1))).toBeNull()
  })

  it.each([
    ['duplicate node ids', { nodes: [v2Document().nodes[0], v2Document().nodes[0]] }],
    ['duplicate edge ids', { edges: [v2Document().edges[0], v2Document().edges[0]] }],
    [
      'non-finite coordinates',
      {
        nodes: [{
          ...v2Document().nodes[0],
          position: { x: Number.POSITIVE_INFINITY, y: 0 },
        }],
        edges: [],
      },
    ],
  ])('rejects %s', (_label, override) => {
    expect(parseWorkflowFile(JSON.stringify(v2Document(override)))).toBeNull()
  })

  it('retains an unknown node as a disabled placeholder and disconnects it', () => {
    const unknown = {
      id: 'future-1',
      kind: 'future-super-node',
      definitionVersion: 7,
      position: { x: 600, y: 40 },
      data: { prompt: 'opaque prompt', model: 'future-model' },
    }
    const input = v2Document({
      nodes: [...v2Document().nodes, unknown],
      edges: [
        ...v2Document().edges,
        {
          id: 'edge-future',
          source: 'text-1',
          sourceHandle: 'out:text',
          target: 'future-1',
          targetHandle: 'in:text',
        },
      ],
    })

    const result = parseWorkflowFileDetailed(JSON.stringify(input))

    expect(result?.workflow.nodes[2]).toMatchObject({
      kind: 'unknown',
      unknownKind: 'future-super-node',
      definitionVersion: 7,
      disabled: true,
      data: { status: 'failed' },
    })
    expect(result?.workflow.edges).toHaveLength(1)
    expect(result?.warnings.join('\n')).toContain('未知节点类型')
    expect(result?.warnings.join('\n')).toContain('不可执行的连线')
  })

  it('round-trips safe node settings and layout while stripping secrets and locations', () => {
    const workflow = parseWorkflowFile(JSON.stringify(v2Document({
      nodes: [{
        id: 'note-1', kind: 'note', definitionVersion: 1,
        position: { x: 10, y: 20 }, width: 300, height: 180, locked: true,
        data: {
          prompt: '', model: '',
          settings: {
            text: '交付前检查光影', durationSeconds: 5,
            apiKey: 'must-strip', sourcePath: 'C:\\private\\asset.png', remote: 'https://private.invalid/x',
          },
        },
      }],
      edges: [],
    })))
    expect(workflow?.nodes[0]).toMatchObject({
      kind: 'note', width: 300, height: 180, locked: true,
      data: { settings: { text: '交付前检查光影', durationSeconds: 5 } },
    })
    const serialized = serializeWorkflow(workflow as WorkflowFile)
    expect(serialized).not.toContain('must-strip')
    expect(serialized).not.toContain('private.invalid')
    expect(serialized).not.toContain('C:\\\\private')
  })

  it('drops dangling, incompatible, over-capacity, and cyclic edges deterministically', () => {
    const input = v2Document({
      nodes: [
        ...v2Document().nodes,
        {
          id: 'image-2',
          kind: 'image',
          definitionVersion: 1,
          position: { x: 640, y: 20 },
          data: { prompt: '', model: 'gpt-image-1' },
        },
        {
          id: 'video-1',
          kind: 'video',
          definitionVersion: 1,
          position: { x: 960, y: 20 },
          data: { prompt: '', model: 'video-model' },
        },
      ],
      edges: [
        v2Document().edges[0],
        { id: 'dangling', source: 'missing', sourceHandle: 'out:text', target: 'image-1', targetHandle: 'in:text' },
        { id: 'wrong-type', source: 'image-1', sourceHandle: 'out:image', target: 'image-2', targetHandle: 'in:text' },
        { id: 'image-input', source: 'image-1', sourceHandle: 'out:image', target: 'video-1', targetHandle: 'in:image' },
        { id: 'image-input-2', source: 'image-2', sourceHandle: 'out:image', target: 'video-1', targetHandle: 'in:image' },
        { id: 'cycle', source: 'video-1', sourceHandle: 'out:video', target: 'video-1', targetHandle: 'in:video' },
      ],
    })

    const result = parseWorkflowFileDetailed(JSON.stringify(input))

    expect(result?.workflow.edges.map((edge) => edge.id)).toEqual(['edge-1', 'image-input'])
    expect(result?.warnings).toHaveLength(4)
  })
})

describe('workflow schema v2 serializer', () => {
  it('persists stable asset references and strips runtime and unsafe locations', () => {
    const workflow: WorkflowFile = {
      schemaVersion: 1,
      name: '安全保存',
      nodes: [
        {
          id: 'image-1',
          kind: 'image',
          position: { x: 1, y: 2 },
          data: {
            prompt: 'prompt',
            model: 'model',
            status: 'failed',
            errorMessage: 'secret server detail',
            costQuota: 123,
            result: {
              kind: 'image',
              assetId: stableAssetId,
              localUrl: 'C:\\Users\\person\\secret.png',
              remoteUrl: 'data:image/png;base64,SECRET',
              mimeType: 'image/png',
              width: 512,
              height: 512,
            },
          },
        },
      ],
      edges: [],
    }

    const serialized = serializeWorkflow(workflow)
    const wire = JSON.parse(serialized)

    expect(wire.schemaVersion).toBe(2)
    expect(serialized).not.toContain('secret server detail')
    expect(serialized).not.toContain('costQuota')
    expect(serialized).not.toContain('remoteUrl')
    expect(serialized).not.toContain('base64')
    expect(serialized).not.toContain('C:\\\\Users')
    expect(wire.nodes[0].data.result).toEqual({
      kind: 'image',
      assetId: stableAssetId,
      localUrl: `xingmang-asset://image/${stableAssetId}`,
      mimeType: 'image/png',
      width: 512,
      height: 512,
    })
  })

  it('keeps a bounded task id for resumable video jobs without persisting its remote URL', () => {
    const workflow: WorkflowFile = {
      schemaVersion: 2,
      name: '视频续查',
      nodes: [{
        id: 'video-1',
        kind: 'video',
        position: { x: 0, y: 0 },
        data: {
          prompt: '',
          model: 'video-model',
          status: 'running',
          result: { kind: 'video', taskId: 'task-123', remoteUrl: 'https://private.invalid/video.mp4' },
        },
      }],
      edges: [],
    }

    const serialized = serializeWorkflow(workflow)

    expect(serialized).toContain('task-123')
    expect(serialized).not.toContain('private.invalid')
    expect(parseWorkflowFile(serialized)?.nodes[0].data).toMatchObject({
      status: 'idle',
      result: { kind: 'video', taskId: 'task-123' },
    })
  })
})
