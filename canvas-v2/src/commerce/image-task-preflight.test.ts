import { describe, expect, it } from 'vitest'
import type { CanvasRunGraph } from '../host'
import type { WorkflowFile } from '../model'
import { buildCanvasRunPreflight } from '../runtime/run-preflight'
import { matchingCanvasRunNodeIds } from '../runtime/run-input-matching'
import { buildWorkshopSetup } from '../editor/workshop-setup'
import { buildCanvasClipboardPayload, pasteCanvasClipboard } from '../editor/clipboard'
import { duplicateCanvasNodesForAltDrag } from '../editor/alt-drag'
import { imageTaskWorkflowFixture } from '../lib/image-task.test-fixture'
import { parseNodeCommerceTask } from './commerce-task'
import { parseNodeImageReferenceOrder, parseImageReferenceOrder } from './image-reference-order'

function runGraph(workflow: WorkflowFile): CanvasRunGraph {
  return { nodes: workflow.nodes.map((node) => ({ id: node.id, kind: node.kind, definitionVersion: 1, data: { prompt: node.data.prompt, model: node.data.model, group: ['image-edit', 'image-generate', 'text-generate'].includes(node.kind) ? 'provider' : undefined, size: node.data.size, quality: node.data.quality, imageResolution: node.data.imageResolution, imageCandidateCount: node.data.imageCandidateCount, adoptedAssetId: node.data.result?.assetId, ...(node.data.settings?.commerceTask ? { commerceTask: parseNodeCommerceTask(node.kind, node.data.settings.commerceTask) } : {}), ...(node.data.settings?.imageReferenceOrder ? { imageReferenceOrder: parseNodeImageReferenceOrder(node.kind, node.data.settings.imageReferenceOrder) } : {}) } })), edges: workflow.edges.map((edge) => ({ ...edge, sourceHandle: edge.sourceHandle!, targetHandle: edge.targetHandle! })) }
}
const models = { imageModels: ['gpt-image-1'], videoModels: [], textModels: ['gpt-4.1-mini'] }
describe('commerce preparation and late-result scopes', () => {
  it('requires actual base dimensions and allows an exact two-times B request without inventing a prompt requirement', () => {
    const workflow = imageTaskWorkflowFixture('material-b'), graph = runGraph(workflow)
    const task = graph.nodes.find((node) => node.data.commerceTask)!
    Object.assign(task.data.commerceTask!, { upscale: 2 })
    task.data.prompt = ''
    expect(buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, ...models }).canStart).toBe(false)
    const configuration = { ...models, imageAssetDimensions: { ['a'.repeat(43)]: { width: 512, height: 512 } } }
    expect(buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, ...configuration })).toMatchObject({ canStart: true, imageRequestCount: 1 })
    const setup = buildWorkshopSetup({ nodes: workflow.nodes.map((node) => ({ ...node, type: node.kind })), graph, scope: { kind: 'all' }, configuration })
    expect(setup.items.filter((item) => item.category === 'prompt')).toHaveLength(0)
    expect(setup.canReviewRun).toBe(true)
    expect(buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, ...models, imageAssetDimensions: { ['a'.repeat(43)]: { width: 192, height: 128 } } }).canStart).toBe(false)
  })
  it('counts visible visual analysis separately and blocks a missing role before confirmation', () => {
    const graph = runGraph(imageTaskWorkflowFixture('style-reference', true))
    expect(buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, ...models })).toMatchObject({ canStart: true, imageRequestCount: 1, textRequestCount: 1, paidRequestCount: 2 })
    graph.nodes.find((node) => node.data.commerceTask)!.data.imageReferenceOrder!.slots[1] = { role: 'reference', missing: true }
    expect(buildCanvasRunPreflight({ graph, scope: { kind: 'all' }, ...models }).canStart).toBe(false)
  })
  it('does not project late results into a changed task or reference role chain', () => {
    const graph = runGraph(imageTaskWorkflowFixture('material-a'))
    const task = graph.nodes.find((node) => node.data.commerceTask)!
    for (const change of ['strength', 'preserve', 'reference'] as const) {
      const current = structuredClone(graph), target = current.nodes.find((node) => node.id === task.id)!
      if (change === 'strength') Object.assign(target.data.commerceTask!, { strength: .9 })
      if (change === 'preserve') target.data.commerceTask!.preserve = []
      if (change === 'reference') target.data.imageReferenceOrder!.slots[0] = { role: 'source', missing: true }
      expect(matchingCanvasRunNodeIds(graph, current).has(task.id)).toBe(false)
    }
    expect(matchingCanvasRunNodeIds(graph, structuredClone(graph)).has(task.id)).toBe(true)
  })
  it('copies complete role bindings and preserves missing external sources through clipboard and alt duplication', () => {
    const workflow = imageTaskWorkflowFixture('style-reference')
    const nodes = workflow.nodes.map((node) => ({ ...node, type: node.kind, definitionVersion: 1, data: { ...node.data } }))
    const image = nodes.find((node) => node.data.settings?.commerceTask)!
    const all = buildCanvasClipboardPayload(nodes, workflow.edges, new Set(nodes.map((node) => node.id)))
    const copy = pasteCanvasClipboard(all, { offset: { x: 10, y: 20 }, createNodeId: (id) => `copy-${id}`, createEdgeId: (id) => `copy-${id}` })
    const order = parseImageReferenceOrder((copy.nodes.find((node) => node.id === `copy-${image.id}`)!.data.settings as Record<string, unknown>).imageReferenceOrder)
    expect(order.slots.every((slot) => 'edgeId' in slot && copy.edges.some((edge) => edge.id === slot.edgeId))).toBe(true)
    const isolated = buildCanvasClipboardPayload(nodes, workflow.edges, new Set([image.id]))
    expect(parseImageReferenceOrder((isolated.nodes[0].data.settings as Record<string, unknown>).imageReferenceOrder).slots.every((slot) => 'missing' in slot)).toBe(true)
    for (const preserveInputConnections of [false, true]) {
      const duplicate = duplicateCanvasNodesForAltDrag(nodes, workflow.edges, { nodeIds: [image.id], preserveInputConnections, createNodeId: (id) => `alt-${id}`, createEdgeId: (id) => `alt-${id}` })
      const slots = parseImageReferenceOrder((duplicate.nodes[0].data.settings as Record<string, unknown>).imageReferenceOrder).slots
      expect(slots.every((slot) => preserveInputConnections ? 'edgeId' in slot && duplicate.edges.some((edge) => edge.id === slot.edgeId) : 'missing' in slot)).toBe(true)
    }
  })
})
