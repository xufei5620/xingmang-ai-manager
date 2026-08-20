import { describe, expect, it } from 'vitest'
import type { Edge } from '@xyflow/react'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { canvasInspectorParameterRows, projectCanvasInspectorNodes } from './canvas-inspector-model'

function node(overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: 'image-edit', type: 'image-edit', definitionVersion: 1, position: { x: 0, y: 0 }, selected: true,
    data: { prompt: 'edit', model: 'gpt-image-2', imageResolution: '4K', status: 'succeeded' },
    ...overrides,
  }
}

describe('projectCanvasInspectorNodes', () => {
  it('projects port cardinality and connection counts in one view model', () => {
    const edges: Edge[] = [
      { id: 'text', source: 'prompt', sourceHandle: 'out:text', target: 'image-edit', targetHandle: 'in:text' },
      { id: 'image-a', source: 'a', sourceHandle: 'out:image', target: 'image-edit', targetHandle: 'in:images' },
      { id: 'image-b', source: 'b', sourceHandle: 'out:image', target: 'image-edit', targetHandle: 'in:images' },
    ]
    const projected = projectCanvasInspectorNodes([node()], edges)[0]

    expect(projected.imageResolution).toBe('4K')
    expect(projected.ports.find((port) => port.id === 'in:text')).toMatchObject({ cardinality: 'many', connectionCount: 1 })
    expect(projected.ports.find((port) => port.id === 'in:images')).toMatchObject({ cardinality: 'many', connectionCount: 2 })
    expect(projected.ports.find((port) => port.id === 'out:image')).toMatchObject({ direction: 'output', connectionCount: 0 })
  })

  it('uses the preview-only selected candidate before adopted and result assets', () => {
    const selectedAsset = { kind: 'image' as const, assetId: 's'.repeat(43) }
    const projected = projectCanvasInspectorNodes([node({
      draggable: false,
      disabled: true,
      data: {
        prompt: 'edit', model: 'gpt-image-2', status: 'failed', dirty: true,
        selectedCandidateId: 'selected', adoptedCandidateId: 'adopted',
        result: { kind: 'image', assetId: 'r'.repeat(43) },
        candidates: [
          { candidateId: 'adopted', attemptId: 'a', createdAt: '2026-08-17T00:00:00Z', asset: { kind: 'image', assetId: 'a'.repeat(43) } },
          { candidateId: 'selected', attemptId: 'b', createdAt: '2026-08-17T00:00:01Z', asset: selectedAsset },
        ],
        attemptCount: 2, latestAttemptDurationMs: 1_500, costQuota: 12, errorMessage: '请求失败',
      },
    })], [])[0]

    expect(projected).toMatchObject({ previewAsset: selectedAsset, candidateCount: 2, attemptCount: 2, locked: true, disabled: true, dirty: true })
    expect(projected.latestAttemptDurationMs).toBe(1_500)
    expect(projected.costQuota).toBe(12)
  })

  it('returns only selected nodes', () => {
    expect(projectCanvasInspectorNodes([node({ selected: false })], [])).toEqual([])
  })
})

describe('canvasInspectorParameterRows', () => {
  function summary(kind: string, overrides: Record<string, unknown> = {}) {
    return canvasInspectorParameterRows({
      kind, prompt: '', model: '', settings: {}, ...overrides,
    } as Parameters<typeof canvasInspectorParameterRows>[0])
  }

  it('reads image parameters back as human labels rather than raw values', () => {
    const rows = summary('image-generate', { prompt: '一只猫', model: 'gpt-image-2', quality: 'low', imageResolution: '2K', size: '1280x720' })
    expect(rows).toEqual([
      { label: '提示词', value: '一只猫' },
      { label: '模型', value: 'GPT Image 2(推荐)' },
      { label: '画质', value: '低' },
      { label: '清晰度', value: '2K' },
      { label: '尺寸', value: '16:9 · 1280x720' },
    ])
  })

  it('omits parameters the model does not support', () => {
    const labels = summary('image-generate', { model: 'gpt-image-1' }).map((row) => row.label)
    expect(labels).toContain('清晰度')
    // Every image preset today supports both, so the guard is asserted by the
    // shape of the row list rather than by a model that drops them.
    expect(labels.filter((label) => label === '模型')).toHaveLength(1)
  })

  it('marks an empty prompt instead of rendering a blank row', () => {
    expect(summary('prompt', { prompt: '   ' })).toEqual([{ label: '提示词', value: '未填写' }])
  })

  it('covers settings-driven nodes', () => {
    expect(summary('frame-extract', { settings: { timestampSeconds: 2.5 } })).toEqual([{ label: '时间点', value: '2.5 秒' }])
    expect(summary('router', { settings: { strategy: 'all' } })).toEqual([{ label: '路由策略', value: '保留全部输入' }])
    expect(summary('router')).toEqual([{ label: '路由策略', value: '优先首个可用输入' }])
    expect(summary('group')).toEqual([{ label: '分组名称', value: '新建分组' }])
  })

  it('returns nothing for nodes without editable parameters', () => {
    expect(summary('output')).toEqual([])
    expect(summary('image-input')).toEqual([])
  })
})
