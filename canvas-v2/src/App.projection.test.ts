import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import type { WorkflowNode } from './model'
import {
  canvasMediaConfigurationErrors,
  isCanvasGraphNode,
  isCanvasRunnableTarget,
  selectCanvasRunNodeIds,
  toCanvasNode,
  toCanvasRunGraph,
  toWorkflowNode,
  workflowNodeData,
} from './App'
import { builtinCanvasTemplates } from './templates/builtin-templates'
import { instantiateTemplate } from './templates/instantiate-template'

function workflowNode(overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id: 'node-1',
    kind: 'prompt',
    definitionVersion: 3,
    position: { x: 10, y: 20 },
    data: { prompt: '测试', model: '', status: 'idle', settings: { note: '保留' } },
    ...overrides,
  }
}

describe('canvas workflow projection', () => {
  it('projects the product-video template with seconds and ignores durationSeconds', () => {
    const template = builtinCanvasTemplates.find((item) => item.id === 'xingmang-product-video')!
    const instance = instantiateTemplate(template, {
      values: { product: 'p'.repeat(43), prompt: '轻微推近' },
      availableNodeTypes: new Set(['prompt', 'image-input', 'video-generate', 'gallery', 'output']),
      createId: (() => { let id = 0; return () => `template-${++id}` })(),
    })
    const videoTemplateNode = instance.nodes.find((node) => node.type === 'video-generate')!
    const video = toCanvasNode(workflowNode({
      id: videoTemplateNode.id,
      kind: 'video-generate',
      data: workflowNodeData('video-generate', videoTemplateNode.config),
    }))
    const graph = toCanvasRunGraph([video], [], { image: '生图分组', video: 'grok' })
    expect(graph.nodes[0].data.seconds).toBe('5')
    expect(graph.nodes[0].data.settings?.durationSeconds).toBeUndefined()

    const legacy = workflowNodeData('video-generate', { durationSeconds: 8 })
    expect(legacy.seconds).toBeUndefined()
    expect(legacy.settings?.durationSeconds).toBe(8)
  })
  it('restores registry dimensions for legacy asset nodes without saved geometry', () => {
    const canvas = toCanvasNode(workflowNode({ id: 'legacy-asset', kind: 'image-input', data: workflowNodeData('image-input') }))

    expect(canvas.width).toBe(280)
    expect(canvas.height).toBe(340)
    expect(canvas.style).toMatchObject({ width: 280, height: 340 })
  })

  it('uses real portrait video metadata instead of stale saved node dimensions', () => {
    const assetId = 'v'.repeat(43)
    const canvas = toCanvasNode(workflowNode({
      id: 'portrait-video',
      kind: 'video-input',
      width: 320,
      height: 180,
      data: {
        prompt: '', model: '', status: 'succeeded',
        result: {
          kind: 'video', assetId, localUrl: `xingmang-asset://video/${assetId}`,
          width: 448, height: 672,
        },
      },
    }))

    expect(canvas.width).toBe(320)
    expect(canvas.height).toBe(480)
    expect(canvas.style).toMatchObject({ width: 320, height: 480 })
    expect(toWorkflowNode(canvas).data.result).toMatchObject({ width: 448, height: 672 })
  })

  it('expands a generated portrait video node so the result preview is not clipped', () => {
    const assetId = 'g'.repeat(43)
    const canvas = toCanvasNode(workflowNode({
      id: 'portrait-video-result',
      kind: 'video-generate',
      width: 304,
      height: 360,
      data: {
        prompt: '竖屏镜头', model: 'grok-imagine-video', status: 'succeeded',
        result: {
          kind: 'video', assetId, localUrl: `xingmang-asset://video/${assetId}`,
          width: 448, height: 672,
        },
      },
    }))

    expect(canvas.width).toBe(304)
    expect(canvas.height).toBe(672)
    expect(canvas.style).toMatchObject({ width: 304, height: 672 })
  })

  it('uses the requested video size while metadata is still unavailable', () => {
    const assetId = 'p'.repeat(43)
    const canvas = toCanvasNode(workflowNode({
      id: 'pending-portrait-video',
      kind: 'video-generate',
      width: 304,
      height: 360,
      data: {
        prompt: '竖屏镜头', model: 'grok-imagine-video', status: 'succeeded', size: '720x1280',
        result: { kind: 'video', assetId, localUrl: `xingmang-asset://video/${assetId}` },
      },
    }))

    expect(canvas.style).toMatchObject({ width: 304, height: 751 })
  })

  it('round-trips definition metadata without leaking it into user settings', () => {
    const source = workflowNode({
      kind: 'unknown',
      definitionVersion: 7,
      disabled: true,
      unknownKind: 'future-super-node',
    })

    const canvas = toCanvasNode(source)
    expect(canvas).toMatchObject({ type: 'unknown', definitionVersion: 7, disabled: true, unknownKind: 'future-super-node' })
    expect(canvas.data.settings).toEqual({ note: '保留' })
    expect(toWorkflowNode(canvas)).toMatchObject({
      kind: 'unknown', definitionVersion: 7, disabled: true, unknownKind: 'future-super-node',
      data: { settings: { note: '保留' } },
    })
  })

  it('preserves disabled known nodes and excludes unknown placeholders from execution', () => {
    const disabled = toCanvasNode(workflowNode({ id: 'disabled', disabled: true, definitionVersion: 4 }))
    const unknown = toCanvasNode(workflowNode({
      id: 'unknown', kind: 'unknown', disabled: true, unknownKind: 'future-node', definitionVersion: 9,
    }))
    const edges: Edge[] = [{ id: 'edge-1', source: 'disabled', target: 'unknown' }]

    const graph = toCanvasRunGraph([disabled, unknown], edges, { image: '生图分组', video: 'grok' })

    expect(graph.nodes).toEqual([expect.objectContaining({ id: 'disabled', definitionVersion: 4, disabled: true })])
    expect(graph.edges).toEqual([])
  })

  it('separates graph members from runnable targets and structural nodes', () => {
    const active = toCanvasNode(workflowNode({ id: 'active', kind: 'image-generate', data: workflowNodeData('image-generate') }))
    const disabled = toCanvasNode(workflowNode({ id: 'disabled', kind: 'image-generate', disabled: true, data: workflowNodeData('image-generate') }))
    const group = toCanvasNode(workflowNode({ id: 'group', kind: 'group', data: workflowNodeData('group') }))
    const note = toCanvasNode(workflowNode({ id: 'note', kind: 'note', data: workflowNodeData('note') }))

    expect(isCanvasGraphNode(active)).toBe(true)
    expect(isCanvasRunnableTarget(active)).toBe(true)
    expect(isCanvasGraphNode(disabled)).toBe(true)
    expect(isCanvasRunnableTarget(disabled)).toBe(false)
    expect(isCanvasGraphNode(group)).toBe(false)
    expect(isCanvasGraphNode(note)).toBe(false)
    expect(toCanvasRunGraph([active, disabled, group, note], [], { image: '', video: '' }).nodes.map((node) => node.id)).toEqual(['active', 'disabled'])
  })

  it('projects a template-bound local asset into an owned image-input run', () => {
    const assetId = 'a'.repeat(43)
    const data = workflowNodeData('image-input', { assetId })
    expect(data).toMatchObject({
      status: 'succeeded',
      result: { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}` },
    })
    expect(data.settings).toBeUndefined()

    const canvas = toCanvasNode(workflowNode({ id: 'asset', kind: 'image-input', data }))
    expect(toCanvasRunGraph([canvas], [], { image: '生图分组', video: 'grok' }).nodes[0].data.adoptedAssetId).toBe(assetId)
  })

  it('projects image and video nodes with their independently configured groups', () => {
    const image = toCanvasNode(workflowNode({
      id: 'image', kind: 'image-generate', data: workflowNodeData('image-generate', { model: 'gpt-image-2' }),
    }))
    const video = toCanvasNode(workflowNode({
      id: 'video', kind: 'video-generate', data: workflowNodeData('video-generate', { model: 'grok-imagine-video' }),
    }))

    const graph = toCanvasRunGraph([image, video], [], { image: '生图分组', video: 'grok' })

    expect(graph.nodes.find((node) => node.id === 'image')?.data.group).toBe('生图分组')
    expect(graph.nodes.find((node) => node.id === 'video')?.data.group).toBe('grok')
  })

  it('validates media groups only for the selected run scope and its upstream dependencies', () => {
    const prompt = toCanvasNode(workflowNode({ id: 'prompt' }))
    const image = toCanvasNode(workflowNode({
      id: 'image', kind: 'image-generate', data: workflowNodeData('image-generate', { model: 'gpt-image-2' }),
    }))
    const unrelatedVideo = toCanvasNode(workflowNode({
      id: 'video', kind: 'video-generate', data: workflowNodeData('video-generate', { model: 'grok-imagine-video' }),
    }))
    const graph = toCanvasRunGraph([prompt, image, unrelatedVideo], [
      { id: 'prompt-image', source: 'prompt', target: 'image' },
    ], { image: '生图分组', video: '' })
    const scope = { kind: 'to-node' as const, nodeId: 'image' }

    expect([...selectCanvasRunNodeIds(graph, scope)]).toEqual(expect.arrayContaining(['prompt', 'image']))
    expect(selectCanvasRunNodeIds(graph, scope).has('video')).toBe(false)
    expect(canvasMediaConfigurationErrors(graph, scope, {
      imageGroup: '生图分组', imageModels: ['gpt-image-2'], videoModels: [],
    })).toEqual([])
  })

  it('reports unavailable models in the active run closure but ignores disabled media nodes', () => {
    const activeImage = toCanvasNode(workflowNode({
      id: 'active-image', kind: 'image-generate', data: workflowNodeData('image-generate', { model: 'gpt-image-2' }),
    }))
    const disabledVideo = toCanvasNode(workflowNode({
      id: 'disabled-video', kind: 'video-generate', disabled: true,
      data: workflowNodeData('video-generate', { model: 'grok-imagine-video' }),
    }))
    const graph = toCanvasRunGraph([activeImage, disabledVideo], [], { image: '生图分组', video: '' })

    expect(canvasMediaConfigurationErrors(graph, { kind: 'all' }, {
      imageGroup: '生图分组', imageModels: [], videoModels: [],
    })).toEqual(['生图分组「生图分组」不提供模型：gpt-image-2'])
  })
})
