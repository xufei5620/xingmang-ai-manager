import { createElement, type CSSProperties, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CanvasModelAvailabilityProvider, CanvasNodeViewProvider, nodeTypes, type CanvasNode } from './WorkflowNodes'
import type { NodeKind, WorkflowNodeData } from '../model'

vi.mock('@xyflow/react', () => ({
  Handle: (props: { id?: string; style?: CSSProperties; className?: string; 'aria-label'?: string }) => createElement('span', { 'data-handle': props.id, style: props.style, className: props.className, 'aria-label': props['aria-label'] }),
  NodeResizer: () => null,
  NodeToolbar: (props: { children: ReactNode }) => createElement('aside', {}, props.children),
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  useNodeConnections: () => [],
  useConnection: () => ({ inProgress: false }),
  useStore: (select: (state: { width: number; height: number; transform: number[]; nodeLookup: Map<string, unknown> }) => unknown) => select({ width: 1200, height: 900, transform: [0, 0, 1], nodeLookup: new Map() }),
}))

function skippedData(patch: Partial<CanvasNode['data']> = {}): CanvasNode['data'] {
  return { prompt: '保留旧分析', model: 'gpt-4.1-mini', status: 'failed', dirty: true, errorMessage: '节点已禁用', attemptCount: 0, __canvasDisabled: true, ...patch }
}

function render(kind: NodeKind, data: CanvasNode['data'], summary = false): string {
  return renderToStaticMarkup(createElement(CanvasModelAvailabilityProvider, {
    connected: true, imageModels: ['gpt-image-1'], videoModels: [], textModels: ['gpt-4.1-mini'],
    children: createElement(CanvasNodeViewProvider, {
      lod: summary ? 'summary' : 'detail', children: createElement(nodeTypes[kind], {
        id: 'disabled-analysis', type: kind, data, selected: false, dragging: false,
        draggable: true, deletable: true, selectable: true, isConnectable: true,
        positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 0,
      }),
    }),
  }))
}

describe('disabled node skipped status presentation', () => {
  it.each([false, true])('shows a confirmed zero-attempt disabled skip without a failure label in summary=%s', (summary) => {
    const data = skippedData(), before = structuredClone(data), html = render('text-generate', data, summary)
    expect(html).toContain('已跳过')
    expect(html).toContain('节点已禁用')
    expect(html).toContain('已禁用')
    expect(html).not.toContain('>失败<')
    expect(html).not.toContain('wf-status-failed')
    expect(html).not.toContain('class="wf-error"')
    expect(data).toEqual(before)
    expect(data.status).toBe('failed')
  })
  it.each([
    { errorMessage: '模型额度不足', attemptCount: 1 },
    { errorMessage: '节点已禁用', attemptCount: 1 },
    { errorMessage: '节点已禁用', attemptCount: undefined },
    { errorMessage: '节点已禁用', __canvasDisabled: false },
  ])('preserves a genuine or unconfirmed failure rather than hiding it: %j', (patch) => {
    const html = render('text-generate', skippedData(patch))
    expect(html).toContain('>失败<')
    expect(html).toContain('wf-status-failed')
    expect(html).toContain('class="wf-error"')
    expect(html).not.toContain('已跳过')
    expect(html).toContain(patch.errorMessage)
  })
  it('retains the previous generated text while explaining that the disabled node did not execute', () => {
    const html = render('text-generate', skippedData({ outputText: '此前完整分析内容仍可复用' }), true)
    expect(html).toContain('此前完整分析内容仍可复用')
    expect(html).toContain('已跳过')
    expect(html).toContain('节点已禁用')
    expect(html).not.toContain('>失败<')
  })
  it.each([false, true])('does not replace a completed or idle disabled node with a skip: %s', (completed) => {
    const status: WorkflowNodeData['status'] = completed ? 'succeeded' : 'idle'
    const html = render('text-generate', skippedData({ status, errorMessage: undefined, attemptCount: undefined }))
    expect(html).toContain(completed ? '>完成<' : 'aria-label="待运行"')
    expect(html).not.toContain('已跳过')
  })
  it('distinguishes the disabled media placeholder from a real generation failure', () => {
    const skipped = render('image-generate', skippedData({ model: 'gpt-image-1' }))
    expect(skipped).toContain('已跳过')
    expect(skipped).toContain('节点已禁用')
    expect(skipped).not.toContain('生成未完成')
    expect(skipped).not.toContain('生成失败')
    const failed = render('image-generate', skippedData({ model: 'gpt-image-1', attemptCount: 1, errorMessage: '模型额度不足' }))
    expect(failed).toContain('生成失败')
    expect(failed).toContain('模型额度不足')
    expect(failed).not.toContain('已跳过')
  })
})
