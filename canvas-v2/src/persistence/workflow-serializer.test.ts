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

  it('round-trips a bounded image clarity tier and rejects unknown tiers', () => {
    const document = v2Document()
    ;(document.nodes[1].data as Record<string, unknown>).imageResolution = '4K'
    const parsed = parseWorkflowFile(JSON.stringify(document))
    expect(parsed?.nodes[1].data.imageResolution).toBe('4K')
    expect(JSON.parse(serializeWorkflow(parsed!)).nodes[1].data.imageResolution).toBe('4K')

    ;(document.nodes[1].data as Record<string, unknown>).imageResolution = '8K'
    expect(parseWorkflowFile(JSON.stringify(document))).toBeNull()
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

  it('preserves known disabled node connections and lock state', () => {
    const input = v2Document({
      nodes: [
        v2Document().nodes[0],
        { ...v2Document().nodes[1], disabled: true, locked: true },
      ],
    })
    const parsed = parseWorkflowFileDetailed(JSON.stringify(input))

    expect(parsed?.workflow.nodes[1]).toMatchObject({ kind: 'image', disabled: true, locked: true })
    expect(parsed?.workflow.edges.map((edge) => edge.id)).toEqual(['edge-1'])
    expect(parsed?.warnings).not.toContain('已移除不可执行的连线：edge-1')
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

  it('round-trips drama settings without adding new node data keys', () => {
    const workflow = parseWorkflowFile(JSON.stringify(v2Document({
      nodes: [{
        id: 'char-1', kind: 'drama-character', definitionVersion: 1,
        position: { x: 40, y: 80 },
        data: {
          prompt: '定妆', model: '',
          settings: {
            assetKind: 'character', name: '虞晚', elementId: 'yuwan',
            appearance: '红衣金饰', locked: true, sheetPrompt: '一张角色设定图',
          },
        },
      }],
      edges: [],
    })))
    expect(workflow?.nodes[0]).toMatchObject({
      kind: 'drama-character',
      data: { settings: { name: '虞晚', elementId: 'yuwan', locked: true } },
    })
    expect(serializeWorkflow(workflow as WorkflowFile)).toContain('虞晚')
  })

  it('migrates legacy single-image handles to the multi-image ports', () => {
    const source = {
      id: 'asset', kind: 'image-input', definitionVersion: 1,
      position: { x: 0, y: 0 }, data: { prompt: '', model: '' },
    }
    const edit = {
      id: 'edit', kind: 'image-edit', definitionVersion: 1,
      position: { x: 320, y: 0 }, data: { prompt: '编辑', model: 'gpt-image-2' },
    }
    const video = {
      id: 'video', kind: 'video-generate', definitionVersion: 1,
      position: { x: 640, y: 0 }, data: { prompt: '生成视频', model: 'grok-imagine-video' },
    }
    const workflow = parseWorkflowFile(JSON.stringify(v2Document({
      nodes: [source, edit, video],
      edges: [
        { id: 'legacy-edit', source: 'asset', sourceHandle: 'out:image', target: 'edit', targetHandle: 'in:image' },
        { id: 'legacy-video', source: 'asset', sourceHandle: 'out:image', target: 'video', targetHandle: 'in:image' },
      ],
    })))

    expect(workflow?.edges).toEqual([
      { id: 'legacy-edit', source: 'asset', sourceHandle: 'out:image', target: 'edit', targetHandle: 'in:images' },
      { id: 'legacy-video', source: 'asset', sourceHandle: 'out:image', target: 'video', targetHandle: 'in:images' },
    ])
  })

  it('preserves image, video, and audio fan-in for MiniMax-compatible video generation', () => {
    const workflow = parseWorkflowFileDetailed(JSON.stringify(v2Document({
      nodes: [
        {
          id: 'image-source', kind: 'image-input', definitionVersion: 1,
          position: { x: 0, y: 0 }, data: { prompt: '', model: '' },
        },
        {
          id: 'video-source', kind: 'video-input', definitionVersion: 1,
          position: { x: 0, y: 220 }, data: { prompt: '', model: '' },
        },
        {
          id: 'audio-source', kind: 'audio-input', definitionVersion: 1,
          position: { x: 0, y: 440 }, data: { prompt: '', model: '' },
        },
        {
          id: 'target', kind: 'video-generate', definitionVersion: 1,
          position: { x: 420, y: 0 }, data: { prompt: '生成视频', model: 'grok-imagine-video' },
        },
      ],
      edges: [
        { id: 'image', source: 'image-source', sourceHandle: 'out:image', target: 'target', targetHandle: 'in:images' },
        { id: 'video', source: 'video-source', sourceHandle: 'out:video', target: 'target', targetHandle: 'in:videos' },
        { id: 'audio', source: 'audio-source', sourceHandle: 'out:audio', target: 'target', targetHandle: 'in:audios' },
      ],
    })))

    expect(workflow?.workflow.edges.map((edge) => edge.id)).toEqual(['image', 'video', 'audio'])
    expect(workflow?.warnings).toEqual([])
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

    expect(result?.workflow.edges.map((edge) => edge.id)).toEqual(['edge-1', 'image-input', 'image-input-2'])
    expect(result?.warnings).toHaveLength(3)
  })
})

describe('workflow schema v2 serializer', () => {
  it('round-trips the saved canvas viewport', () => {
    const workflow = parseWorkflowFile(JSON.stringify(v2Document({
      viewport: { x: 420, y: -160, zoom: 0.8 },
    })))

    expect(workflow?.viewport).toEqual({ x: 420, y: -160, zoom: 0.8 })
    expect(parseWorkflowFile(serializeWorkflow(workflow as WorkflowFile))?.viewport).toEqual({
      x: 420,
      y: -160,
      zoom: 0.8,
    })
  })

  it('round-trips project media groups without storing any API Key', () => {
    const workflow = parseWorkflowFile(JSON.stringify(v2Document({
      mediaGroups: { image: '生图分组', video: 'grok' },
    })))

    const serialized = serializeWorkflow(workflow as WorkflowFile)

    expect(serialized).not.toMatch(/api[_-]?key/i)
    expect(parseWorkflowFile(serialized)?.mediaGroups).toEqual({ image: '生图分组', video: 'grok' })
  })

  it('round-trips default models and the text generation group', () => {
    const workflow = parseWorkflowFile(JSON.stringify(v2Document({
      mediaGroups: {
        image: '生图分组',
        video: 'grok',
        text: '对话分组',
        imageModel: 'gpt-image-2',
        videoModel: 'grok-imagine-video',
        textModel: 'gpt-5.4',
      },
    })))

    expect(parseWorkflowFile(serializeWorkflow(workflow as WorkflowFile))?.mediaGroups).toEqual({
      image: '生图分组',
      video: 'grok',
      text: '对话分组',
      imageModel: 'gpt-image-2',
      videoModel: 'grok-imagine-video',
      textModel: 'gpt-5.4',
    })
  })

  it('round-trips a bounded node-level group override', () => {
    const document = v2Document()
    ;(document.nodes[0].data as Record<string, unknown>).group = '节点专用分组'
    const workflow = parseWorkflowFile(JSON.stringify(document))
    const serialized = serializeWorkflow(workflow as WorkflowFile)

    expect(parseWorkflowFile(serialized)?.nodes[0].data.group).toBe('节点专用分组')
  })

  it('ignores malformed media group configuration without rejecting the project', () => {
    const result = parseWorkflowFileDetailed(JSON.stringify(v2Document({
      mediaGroups: { image: 'x'.repeat(129), video: 'grok' },
    })))

    expect(result?.workflow.mediaGroups).toBeUndefined()
    expect(result?.warnings).toContain('已忽略无效的生成分组配置')
  })

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

  it('round-trips a video asset duration separately from generation elapsed time', () => {
    const workflow: WorkflowFile = {
      schemaVersion: 2,
      name: '视频时长',
      nodes: [{
        id: 'video-1',
        kind: 'video-input',
        position: { x: 0, y: 0 },
        data: {
          prompt: '',
          model: '',
          status: 'succeeded',
          result: {
            kind: 'video',
            assetId: 'a'.repeat(43),
            localUrl: `xingmang-asset://video/${'a'.repeat(43)}`,
            mimeType: 'video/mp4',
            width: 1280,
            height: 720,
            durationSeconds: 5.2,
          },
        },
      }],
      edges: [],
    }
    expect(parseWorkflowFile(serializeWorkflow(workflow))?.nodes[0].data.result).toMatchObject({
      durationSeconds: 5.2,
      width: 1280,
      height: 720,
    })
  })

  it('drops generation elapsed time so a reopen does not keep the chip', () => {
    const workflow: WorkflowFile = {
      schemaVersion: 2,
      name: '生成耗时',
      nodes: [{
        id: 'image-1',
        kind: 'image-generate',
        position: { x: 0, y: 0 },
        data: {
          prompt: '角色',
          model: 'gpt-image-2',
          status: 'succeeded',
          latestAttemptDurationMs: 8_123,
          result: {
            kind: 'image',
            assetId: 'a'.repeat(43),
            localUrl: `xingmang-asset://image/${'a'.repeat(43)}`,
          },
        },
      }],
      edges: [],
    }
    expect(JSON.parse(serializeWorkflow(workflow)).nodes[0].data.latestAttemptDurationMs).toBeUndefined()
    expect(parseWorkflowFile(serializeWorkflow(workflow))?.nodes[0].data.latestAttemptDurationMs).toBeUndefined()
    expect(parseWorkflowFile(JSON.stringify({
      schemaVersion: 2,
      name: '旧耗时',
      nodes: [{
        id: 'image-1',
        kind: 'image-generate',
        position: { x: 0, y: 0 },
        data: {
          prompt: '角色',
          model: 'gpt-image-2',
          latestAttemptDurationMs: 8_123,
        },
      }],
      edges: [],
    }))?.nodes[0].data.latestAttemptDurationMs).toBeUndefined()
  })
})
