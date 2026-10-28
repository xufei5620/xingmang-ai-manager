import { createElement, type CSSProperties, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CanvasModelAvailabilityProvider, CanvasUpstreamReferencesProvider, composerReferenceChips, nodeTypes, type CanvasNode } from './WorkflowNodes'
import { defaultStoryboardTask } from '../storyboard/storyboard-task'
import type { WorkflowEdge } from '../model'
import { buildCanvasUpstreamReferences, type UpstreamMediaReference } from '../components/upstream-references'
import { orderImageReferenceInputs, parseImageReferenceOrder } from '../commerce/image-reference-order'
import { officialPromptSnapshot, parsePromptReferences } from '../library/prompt-references'

vi.mock('@xyflow/react', () => ({
  Handle: (props: { id?: string; style?: CSSProperties; className?: string; 'aria-label'?: string }) => createElement('span', { 'data-handle': props.id, style: props.style, className: props.className, 'aria-label': props['aria-label'] }),
  NodeResizer: () => null,
  NodeToolbar: (props: { children: ReactNode }) => createElement('aside', {}, props.children),
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  useNodeConnections: () => [],
  useConnection: () => ({ inProgress: false }),
  useStore: (select: (state: { width: number; height: number; transform: number[]; nodeLookup: Map<string, unknown> }) => unknown) => select({ width: 1200, height: 900, transform: [0, 0, 1], nodeLookup: new Map() }),
}))

function fixture() {
  const names = ['original-reference', 'original-source', 'xmp', 'qa']
  const sources: CanvasNode[] = names.map((name, index) => ({ id: name, type: 'image-input', definitionVersion: 1, position: { x: 0, y: index * 300 }, data: { prompt: '', model: '', status: 'succeeded', settings: { title: name }, result: { kind: 'image', assetId: String.fromCharCode(97 + index).repeat(43), localUrl: `xingmang-asset://image/${String.fromCharCode(97 + index).repeat(43)}` } } }))
  const order = ['xmp', 'original-source', 'original-reference', 'qa']
  const target: CanvasNode = { id: 'target', type: 'image-generate', definitionVersion: 1, position: { x: 400, y: 0 }, data: { prompt: '保留四张图片的身份', model: 'gpt-image-1', status: 'idle', settings: { storyboardTask: { ...defaultStoryboardTask(), automaticPlot: false }, imageReferenceOrder: { version: 1, slots: order.map((name, index) => ({ role: index === 0 ? 'source' : 'reference', edgeId: `edge-${name}`, outputIndex: 0 })) } } } }
  const edges: WorkflowEdge[] = names.map((name) => ({ id: `edge-${name}`, source: name, sourceHandle: 'out:image', target: target.id, targetHandle: 'in:images' }))
  return { sources, target, edges, order }
}

function renderComposer(input: ReturnType<typeof fixture>): string {
  return renderToStaticMarkup(createElement(CanvasModelAvailabilityProvider, {
    connected: true, imageModels: ['gpt-image-1'], videoModels: [], textModels: [],
    children: createElement(CanvasUpstreamReferencesProvider, {
      nodes: [...input.sources, input.target], edges: input.edges, assets: [], children: createElement(nodeTypes['image-generate'], {
        id: input.target.id, type: 'image-generate', data: input.target.data, selected: true, dragging: false,
        draggable: true, deletable: true, selectable: true, isConnectable: true,
        positionAbsoluteX: 400, positionAbsoluteY: 0, zIndex: 0,
      }),
    }),
  }))
}

describe('saved storyboard composer image order', () => {
  it('renders the real generic chips in saved slot order rather than old edge insertion order', () => {
    const input = fixture(), html = renderComposer(input)
    expect([...html.matchAll(/title="拖到提示词中插入([^"]+)"/g)].map((match) => match[1])).toEqual(input.order.map((name) => `${name} · 图片`))
    expect([...html.matchAll(/aria-label="输入顺序 (\d+)"/g)].map((match) => Number(match[1]))).toEqual([1, 2, 3, 4])
  })
  it('keeps all original reference objects and mentions while matching the unchanged request ordering helper', () => {
    const input = fixture(), official = officialPromptSnapshot('xingmang-product-studio')!
    input.target.data.prompt = `开场 ${official.prompt} 收尾`
    input.target.data.promptReferences = [{ ...official, start: 3, end: 3 + official.prompt.length }]
    const before = structuredClone(input)
    const references = buildCanvasUpstreamReferences([...input.sources, input.target], input.edges, []).get(input.target.id)!
    const referenceSnapshot = structuredClone(references)
    const displayed = composerReferenceChips(input.target.data.settings, references)
    expect(displayed.map((chip) => chip.reference?.sourceNodeId)).toEqual(input.order)
    for (const chip of displayed) expect(references).toContain(chip.reference)
    expect(displayed.map((chip) => chip.reference?.mention)).toEqual(input.order.map((id) => references.find((reference) => reference.sourceNodeId === id)!.mention))
    const requestInputs = references.map((reference) => ({ edgeId: reference.edgeId, outputIndex: reference.outputIndex ?? 0, assetId: reference.asset?.assetId }))
    const submitted = orderImageReferenceInputs(requestInputs, parseImageReferenceOrder(input.target.data.settings?.imageReferenceOrder), input.edges.map((edge) => edge.id))
    expect(displayed.map((chip) => chip.reference?.asset?.assetId)).toEqual(submitted.map((entry) => entry.assetId))
    expect(references).toEqual(referenceSnapshot)
    expect(parsePromptReferences(input.target.data.prompt, input.target.data.promptReferences)).toEqual(before.target.data.promptReferences)
    expect(renderComposer(input)).toContain('#商品棚拍 官方')
    expect(input).toEqual(before)
  })
  it('resolves repeated reference roles by exact edge and batch output index', () => {
    const input = fixture(), base = buildCanvasUpstreamReferences([...input.sources, input.target], input.edges, []).get(input.target.id)![0]
    const references: UpstreamMediaReference[] = [0, 1, 2, 3].map((outputIndex) => ({ ...base, edgeId: 'batch', referenceId: `batch-${outputIndex}`, outputIndex, mention: `@batch-${outputIndex}`, batch: true }))
    const settings = { storyboardTask: defaultStoryboardTask(), imageReferenceOrder: { version: 1, slots: [3, 1, 0, 2].map((outputIndex, index) => ({ role: index === 0 ? 'source' : 'reference', edgeId: 'batch', outputIndex })) } }
    const displayed = composerReferenceChips(settings, references)
    expect(displayed.map((chip) => chip.reference?.outputIndex)).toEqual([3, 1, 0, 2])
    expect(displayed.map((chip) => chip.inputIndex)).toEqual([0, 1, 2, 3])
    expect(displayed.map((chip) => chip.reference?.mention)).toEqual(['@batch-3', '@batch-1', '@batch-0', '@batch-2'])
  })
  it('keeps a missing slot in place and labels an extra edge as unassigned instead of promoting it', () => {
    const input = fixture(), references = buildCanvasUpstreamReferences([...input.sources, input.target], input.edges, []).get(input.target.id)!
    const settings = { storyboardTask: defaultStoryboardTask(), imageReferenceOrder: { version: 1, slots: [{ role: 'source', edgeId: 'edge-xmp', outputIndex: 0 }, { role: 'reference', missing: true }, { role: 'reference', edgeId: 'edge-qa', outputIndex: 0 }] } }
    const displayed = composerReferenceChips(settings, references)
    expect(displayed.slice(0, 3).map((chip) => [chip.inputIndex, chip.reference?.sourceNodeId])).toEqual([[0, 'xmp'], [1, undefined], [2, 'qa']])
    expect(displayed.slice(3).map((chip) => [chip.inputIndex, chip.reference?.sourceNodeId])).toEqual([[undefined, 'original-reference'], [undefined, 'original-source']])
    input.target.data.settings = settings
    const html = renderComposer(input)
    expect(html).toContain('aria-label="输入 2 图片未绑定"')
    expect(html.match(/aria-label="尚未分配输入顺序"/g)).toHaveLength(2)
    expect(html).toContain('未分配图片不会自动加入请求')
  })
  it('does not borrow another pending batch occurrence for a missing saved output index', () => {
    const input = fixture(), base = buildCanvasUpstreamReferences([...input.sources, input.target], input.edges, []).get(input.target.id)![0]
    const pending: UpstreamMediaReference = { ...base, edgeId: 'batch', outputIndex: 0, status: 'waiting', asset: undefined }
    const displayed = composerReferenceChips({ storyboardTask: defaultStoryboardTask(), imageReferenceOrder: { version: 1, slots: [{ role: 'source', edgeId: 'batch', outputIndex: 3 }] } }, [pending])
    expect(displayed[0]).toMatchObject({ inputIndex: 0, reference: undefined })
    expect(displayed[1].reference).toBe(pending)
    expect(displayed[1].inputIndex).toBeUndefined()
  })
  it.each([undefined, { exteriorTask: {} }, { commerceTask: {} }, { interiorTask: {} }])('leaves ordinary and other dedicated-task chip ordering unchanged: %j', (settings) => {
    const input = fixture(), references = buildCanvasUpstreamReferences([...input.sources, input.target], input.edges, []).get(input.target.id)!
    const displayed = composerReferenceChips(settings, references)
    expect(displayed.map((chip) => chip.reference)).toEqual(references)
    expect(displayed.map((chip) => chip.inputIndex)).toEqual([0, 1, 2, 3])
    for (const [index, chip] of displayed.entries()) expect(chip.reference).toBe(references[index])
  })
  it('does not invent input numbers from invalid or missing storyboard order metadata', () => {
    const input = fixture(), references = buildCanvasUpstreamReferences([...input.sources, input.target], input.edges, []).get(input.target.id)!
    for (const imageReferenceOrder of [undefined, null, { version: 2, slots: [] }]) {
      const displayed = composerReferenceChips({ storyboardTask: defaultStoryboardTask(), imageReferenceOrder }, references)
      expect(displayed.every((chip) => chip.inputIndex === undefined)).toBe(true)
      expect(displayed.map((chip) => chip.reference)).toEqual(references)
    }
  })
})
