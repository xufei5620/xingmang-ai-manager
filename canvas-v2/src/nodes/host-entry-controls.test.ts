import { createElement, type ComponentProps, type CSSProperties, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { NodeProps } from '@xyflow/react'
import { CanvasModelAvailabilityProvider, CanvasNodeViewProvider, nodeTypes, registerNodeChangeHandlers, type CanvasNode } from './WorkflowNodes'
import type { NodeKind, WorkflowNodeData } from '../model'
import { v2EquivalentCapabilities } from '../host-capabilities'
import { fullCanvasCapabilityProfile } from '../host-capabilities.test-fixture'

vi.mock('@xyflow/react', () => ({
  Handle: (props: { id?: string; style?: CSSProperties; className?: string }) => createElement('span', { 'data-handle': props.id, style: props.style, className: props.className }),
  NodeResizer: () => null,
  NodeToolbar: (props: { children: ReactNode }) => createElement('aside', null, props.children),
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  useNodeConnections: vi.fn(() => []),
  useConnection: () => ({ inProgress: false }),
  useStore: (select: (state: { width: number; height: number; transform: number[]; nodeLookup: Map<string, unknown> }) => unknown) => select({ width: 1200, height: 900, transform: [0, 0, 1], nodeLookup: new Map() }),
}))

type Handlers = Parameters<typeof registerNodeChangeHandlers>[0]
type AvailabilityProps = ComponentProps<typeof CanvasModelAvailabilityProvider>
type NodeViewProps = ComponentProps<typeof CanvasNodeViewProvider>

// Every handler a node calls is a no-op unless listed; a listed undefined is
// how the editor says it has no such entry.
function registerHandlers(listed: Partial<Record<keyof Handlers, unknown>>) {
  registerNodeChangeHandlers(new Proxy(listed, {
    get: (target, key) => key in target ? target[key as keyof Handlers] : key === 'isPortCompatible' ? () => true : () => undefined,
  }) as unknown as Handlers)
}

function renderNode(kind: NodeKind, data: Partial<WorkflowNodeData>, view: { capabilities?: typeof v2EquivalentCapabilities } = {}): string {
  const props: NodeProps<CanvasNode> = {
    id: 'node', type: kind, data: { prompt: '', model: '', status: 'idle', ...data }, selected: true,
    dragging: false, draggable: true, deletable: true, selectable: true, isConnectable: true,
    positionAbsoluteX: 0, positionAbsoluteY: 0, zIndex: 0,
  }
  const availability: Omit<AvailabilityProps, 'children'> = { connected: true, imageModels: [], videoModels: [], textModels: [] }
  const nodeView: Omit<NodeViewProps, 'children'> = { lod: 'detail', ...view }
  // The providers type children as a prop; createElement fills it from its third argument.
  return renderToStaticMarkup(createElement(CanvasModelAvailabilityProvider, availability as AvailabilityProps,
    createElement(CanvasNodeViewProvider, nodeView as NodeViewProps, createElement(nodeTypes[kind], props))))
}

const image = { kind: 'image' as const, assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` }

describe('node entries that depend on the host', () => {
  it('offers the TXT download only when the host takes page downloads', () => {
    registerHandlers({})
    const result = { outputText: '生成结果' }
    expect(renderNode('text-generate', result, { capabilities: fullCanvasCapabilityProfile })).toContain('下载生成结果 TXT')
    expect(renderNode('text-generate', result, { capabilities: v2EquivalentCapabilities })).not.toContain('下载生成结果 TXT')
    expect(renderNode('text-generate', result, { capabilities: v2EquivalentCapabilities })).toContain('复制生成结果')
  })

  it('offers annotation and frame selection only when the editor has them', () => {
    registerHandlers({ onAnnotateImage: undefined, onSelectVideoFrame: undefined })
    expect(renderNode('image-input', { result: image })).not.toContain('aria-label="标注图片"')
    expect(renderNode('frame-extract', {})).not.toContain('选择视频帧')
    registerHandlers({ onAnnotateImage: vi.fn(), onSelectVideoFrame: vi.fn() })
    expect(renderNode('image-input', { result: image })).toContain('aria-label="标注图片"')
    expect(renderNode('frame-extract', {})).toContain('选择视频帧')
  })
})
